// The solver loop (HANDOVER §3.6): watch open intents, price them, fill the ones
// that clear our curve, then deliver every pending Base payout (fills and
// solver withdrawals) and bump gas on stuck ones (§3.5).

import type { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import {
  DEAD_SIG_REQUEST_AFTER_SEC,
  MAX_SIG_REQUESTS,
  OPEN_BUMP_AFTER_SEC,
  PayoutTracker,
  basescanTx,
  buildCandidates,
  configPda,
  decodeConfig,
  decodeSolver,
  fetchSigRequests,
  fetchWithdrawalsInRange,
  formatEth,
  getReceipt,
  isPlainAddress,
  minBumpGasPrice,
  parseIntentsLogs,
  payoutCost,
  payoutRpc,
  poolEvmAddress,
  requiredOutForIntent,
  solanaExplorerTx,
  solverPda,
  withdrawalPayoutFields,
  type ConfigAccount,
  type IntentAccount,
  type IntentsEvent,
  type PayoutCandidate,
  type PayoutIntentFields,
  type SolverAccount,
  type TrackState,
  type WithdrawalAccount,
} from "../../../lib/intents";
import type { EthRpc } from "../../../lib/soda";
import {
  bumpGasIx,
  bumpWithdrawalGasIx,
  decodeClockUnixTimestamp,
  fillIx,
  sendIxs,
  TxError,
  FILL_COMPUTE_UNITS,
} from "./chain";
import { hexAddr } from "./evm";
import { intentHistory } from "./history";
import { Pricer, SIG_REQUEST_RENT_LAMPORTS, SOLANA_BASE_FEE_LAMPORTS, type QuoteCosts } from "./pricing";
import { fetchPythPrices } from "./pyth";
import type { Quote, QuoteSource } from "./server";
import { ProgramWatcher, type OpenIntentFields, type WatchedTx } from "./watcher";

export type SolverSettings = {
  programId: PublicKey;
  spreadBps: bigint;
  depthMult: bigint;
  priceMaxAgeSec: bigint;
  solUsdFallback18?: bigint;
  ethUsdFallback18?: bigint;
  tickMs: number;
  pollMs: number;
  deliverMs: number;
  anchorMs: number;
  /** Seconds subtracted from cluster time before computing required_out. */
  clockSkewSec: bigint;
  priorityMicroLamports: number;
  /** Margin over eth_gasPrice for new payouts, in bps. */
  gasMarginBps: bigint;
  gasFloorWei: bigint;
  /** Extra over the program's +10% minimum when bumping, in bps of the old price. */
  bumpExtraBps: bigint;
  selfBumpAfterMs: number;
  otherBumpAfterMs: number;
  includeSigRent: boolean;
  checkRecipientCode: boolean;
};

type OpenIntent = OpenIntentFields;

/** What delivery and bumps need from a filled Intent or a Withdrawal. */
type Payout = PayoutIntentFields & {
  /** The solver whose ledger pays bumps. */
  solver: PublicKey;
  /** filled_at or created_at: anyone may bump 60 s after it. */
  since: bigint;
};

type Tracked = {
  key: PublicKey;
  kind: "intent" | "withdrawal";
  payout: Payout;
  mine: boolean;
  tracker: PayoutTracker;
  hints: Set<bigint>;
  lastState?: TrackState;
  historyAt?: number;
  lastBumpAt?: number;
  bumpBlockedLogged?: boolean;
  done: boolean;
  reportTries: number;
  /** The account was closed with its payout unmined: rebroadcast what is signed; no bumps possible. */
  closed?: boolean;
};

const intentPayout = (i: IntentAccount): Payout => ({ ...i, since: i.filledAt });
const withdrawalPayout = (w: WithdrawalAccount): Payout => ({
  ...withdrawalPayoutFields(w),
  solver: w.solver,
  since: w.createdAt,
});

/** Withdrawals ahead in the pool's queue that one delivery pass looks at. */
const WITHDRAWAL_SCAN = 64n;
/** How long a recipient that passed the code check stays trusted. */
const RECIPIENT_OK_TTL_MS = 10 * 60_000;

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const short = (k: PublicKey | string) => {
  const s = typeof k === "string" ? k : k.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Solver implements QuoteSource {
  readonly solver: string;
  private readonly me: PublicKey;
  private readonly solverKey: PublicKey;
  private readonly poolHex: string;
  private readonly pricer: Pricer;
  private readonly open = new Map<string, { key: PublicKey; intent: OpenIntent; skipUntil: number }>();
  private readonly tracked = new Map<string, Tracked>();
  private readonly unsignedBySigRequest = new Map<string, Uint8Array>();
  private readonly plainRecipient = new Map<string, { ok: boolean; at: number }>();
  private readonly timers: NodeJS.Timeout[] = [];
  private subscription: number | null = null;
  /** Signatures already handled, so the websocket and the watcher do not double-log. */
  private readonly handledSigs = new Set<string>();
  private busy = { tick: false, deliver: false, poll: false, anchor: false };

  private config: ConfigAccount | null = null;
  private ledger: SolverAccount | null = null;
  private gasPrice: bigint;
  /** Raw eth_gasPrice from the last re-anchor (no margin). */
  private marketGasPrice: bigint | null = null;
  private overCapLogged = false;
  private fills = 0;
  private readonly startedAt = Date.now();

  readonly watcher: ProgramWatcher;

  constructor(
    private readonly conn: Connection,
    /** Optional logsSubscribe connection; null means the watcher alone discovers intents. */
    private readonly wsConn: Connection | null,
    private readonly program: Program,
    private readonly keypair: Keypair,
    private readonly base: EthRpc | null,
    private readonly s: SolverSettings,
    watcher?: ProgramWatcher,
  ) {
    this.watcher = watcher ?? new ProgramWatcher(conn, { programId: s.programId, log });
    this.me = keypair.publicKey;
    this.solver = this.me.toBase58();
    this.solverKey = solverPda(this.me, s.programId)[0];
    this.poolHex = hexAddr(poolEvmAddress(undefined, s.programId));
    this.pricer = new Pricer(s.depthMult);
    this.gasPrice = s.gasFloorWei;
  }

  // ------------------------------------------------------------ lifecycle

  /** Resolves once the watcher's first backfill attempt is done and open intents were read. */
  ready: Promise<void> = Promise.resolve();

  async start(): Promise<void> {
    await this.reanchor();
    if (this.wsConn) this.subscribe();
    // A long history takes a while to replay; quoting and the server do not wait
    // for it. Open intents are read as soon as the backfill has rebuilt the index.
    let firstPoll: Promise<void> | undefined;
    this.ready = this.watcher
      .start(
        (tx) => this.onWatched(tx),
        () => {
          firstPoll = this.pollOpen();
        },
      )
      .then(() => firstPoll);
    const every = (ms: number, fn: () => Promise<void>) => this.timers.push(setInterval(() => void fn(), ms));
    every(this.s.tickMs, () => this.tick());
    every(this.s.pollMs, () => this.pollOpen());
    every(this.s.deliverMs, () => this.deliver());
    every(this.s.anchorMs, () => this.reanchor());
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    await this.watcher.stop();
    if (this.subscription !== null && this.wsConn) await this.wsConn.removeOnLogsListener(this.subscription).catch(() => {});
  }

  /** Optional fast path: logsSubscribe, when SOLANA_WS_URL names a WebSocket that serves it. */
  private subscribe(): void {
    this.subscription = this.wsConn!.onLogs(
      this.s.programId,
      ({ logs, err, signature }) => {
        if (err) return;
        this.onEvents(parseIntentsLogs(logs, this.s.programId), signature, false);
      },
      "confirmed",
    );
  }

  private onWatched(tx: WatchedTx): void {
    this.onEvents(tx.events, tx.signature, tx.backfill);
  }

  /**
   * One transaction's events, from the watcher or the websocket. Backfilled
   * history only seeds payout data: pollOpen reads which intents are still Open.
   */
  private onEvents(events: IntentsEvent[], signature: string, backfill: boolean): void {
    if (this.handledSigs.has(signature)) return;
    this.handledSigs.add(signature);
    if (this.handledSigs.size > 2_000) this.handledSigs.delete(this.handledSigs.values().next().value as string);
    for (const ev of events) {
      const k = "intent" in ev && ev.intent instanceof PublicKey ? ev.intent.toBase58() : "";
      switch (ev.name) {
        case "IntentOpened":
          if (!backfill && !this.open.has(k)) {
            this.open.set(k, { key: ev.intent, intent: ev, skipUntil: 0 });
            log(`intent ${short(k)} opened: ${formatEth(ev.startOutWei)} → ${formatEth(ev.minOutWei)} ETH for ${ev.inLamports} lamports (${signature})`);
            void this.tick();
          }
          break;
        case "IntentFilled":
          this.open.delete(k);
          if (!backfill && !ev.solver.equals(this.me)) log(`intent ${short(k)} filled by ${short(ev.solver)} at ${formatEth(ev.outWei)} ETH`);
          this.tracked.get(k)?.hints.add(ev.gasPrice);
          break;
        case "IntentCancelled":
          this.open.delete(k);
          break;
        case "GasBumped": {
          const t = this.tracked.get(k);
          t?.hints.add(ev.oldGasPrice);
          t?.hints.add(ev.newGasPrice);
          break;
        }
        case "EthTxRequested":
          this.unsignedBySigRequest.set(ev.sigRequest.toBase58(), ev.unsignedRlp);
          break;
      }
    }
  }

  // ------------------------------------------------------------ pricing

  private costs(gasPrice: bigint): QuoteCosts {
    const priority = (BigInt(this.s.priorityMicroLamports) * BigInt(FILL_COMPUTE_UNITS)) / 1_000_000n;
    return {
      spreadBps: this.s.spreadBps,
      gasPrice,
      l1FeeBufferWei: this.config?.l1FeeBufferWei ?? 0n,
      solCostLamports: SOLANA_BASE_FEE_LAMPORTS + priority + (this.s.includeSigRent ? SIG_REQUEST_RENT_LAMPORTS : 0n),
    };
  }

  /** Gas price for a new payout: market + margin, within Config's [min_gas_price, max_gas_price]. */
  private payoutGasPrice(): bigint {
    let g = this.gasPrice;
    if (this.config && g < this.config.minGasPrice) g = this.config.minGasPrice;
    if (this.config && g > this.config.maxGasPrice) g = this.config.maxGasPrice;
    return g;
  }

  /**
   * Base's own price is above Config.max_gas_price, so a payout at the cap
   * would never be mined and would block the pool's nonce queue. Only the raw
   * market price counts: clamping the margin alone is harmless.
   */
  private overCap(): boolean {
    const cap = this.config?.maxGasPrice;
    return cap !== undefined && this.marketGasPrice !== null && this.marketGasPrice > cap;
  }

  /** A price anchor no older than three re-anchor intervals (two may fail). */
  private priced(): boolean {
    const a = this.pricer.anchor;
    return this.pricer.ready && !!a && Date.now() - a.atMs <= this.s.anchorMs * 3;
  }

  private async reanchor(): Promise<void> {
    if (this.busy.anchor) return;
    this.busy.anchor = true;
    try {
      const [clockInfo, cfgInfo, solverInfo] = await this.conn.getMultipleAccountsInfo([
        SYSVAR_CLOCK_PUBKEY,
        configPda(this.s.programId)[0],
        this.solverKey,
      ]);
      const now = clockInfo ? decodeClockUnixTimestamp(clockInfo.data) : BigInt(Math.floor(Date.now() / 1000));
      if (cfgInfo) this.config = decodeConfig(cfgInfo.data);
      if (solverInfo) this.ledger = decodeSolver(solverInfo.data);

      if (this.base) {
        try {
          const g = await this.base.getGasPrice();
          this.marketGasPrice = g;
          const withMargin = (g * (10_000n + this.s.gasMarginBps)) / 10_000n;
          this.gasPrice = withMargin > this.s.gasFloorWei ? withMargin : this.s.gasFloorWei;
        } catch (e) {
          log(`base gas price unavailable, keeping ${this.gasPrice} wei: ${errMsg(e)}`);
        }
      }

      const { sol, eth } = await fetchPythPrices(this.conn, now, this.s.priceMaxAgeSec, {
        solUsd18: this.s.solUsdFallback18,
        ethUsd18: this.s.ethUsdFallback18,
      });
      for (const [name, p] of [["SOL/USD", sol], ["ETH/USD", eth]] as const) {
        if (p?.warning) log(`${name} ${p.source}: ${p.warning}`);
      }
      if (!sol || !eth) {
        this.pricer.invalidate();
        log("no usable SOL/USD or ETH/USD price (set SOL_USD_FALLBACK / ETH_USD_FALLBACK); not quoting");
        return;
      }
      const inventoryWei = this.ledger?.balanceWei ?? 0n;
      this.pricer.reanchor({
        solUsd18: sol.usd18,
        ethUsd18: eth.usd18,
        inventoryWei,
        atMs: Date.now(),
        sources: { sol: sol.source, eth: eth.source },
      });
      const rate = this.pricer.oracleEthPerSol18()!;
      log(
        `anchored: 1 SOL = ${formatEth(rate, 8)} ETH (${sol.source}/${eth.source}), ledger ${formatEth(inventoryWei)} ETH, gas ${this.gasPrice} wei`,
      );
    } catch (e) {
      // The old anchor stays usable until priced() ages it out.
      log(`re-anchor failed: ${errMsg(e)}`);
    } finally {
      this.busy.anchor = false;
    }
  }

  quote(inLamports: bigint): Quote | { error: string } {
    if (!this.priced() || !this.pricer.anchor) return { error: "no fresh prices or no inventory" };
    if (this.config?.paused) return { error: "intents program is paused" };
    if (this.overCap()) return { error: "Base gas price is above max_gas_price" };
    const gas = this.payoutGasPrice();
    const outWei = this.pricer.maxOut(inLamports, this.costs(gas));
    if (outWei === 0n) return { error: "amount too small to cover fees" };
    const l1 = this.config?.l1FeeBufferWei ?? 0n;
    if (payoutCost(outWei, gas, l1) > (this.ledger?.balanceWei ?? 0n)) return { error: "exceeds solver inventory" };
    // The floor this solver still fills at if Base gas doubles before the intent lands.
    const cap = this.config?.maxGasPrice ?? gas * 2n;
    const worstGas = gas * 2n < cap ? gas * 2n : cap;
    const minOutWei = this.pricer.maxOut(inLamports, this.costs(worstGas));
    return { outWei, minOutWei, validUntil: Math.floor((this.pricer.anchor.atMs + this.s.anchorMs) / 1000) };
  }

  health(): Record<string, unknown> {
    const rate = this.pricer.oracleEthPerSol18();
    return {
      ok: this.priced() && !!this.config,
      solver: this.solver,
      solverPda: this.solverKey.toBase58(),
      program: this.s.programId.toBase58(),
      pool: this.poolHex,
      ledgerWei: this.ledger?.balanceWei.toString() ?? null,
      spreadBps: Number(this.s.spreadBps),
      ethPerSol: rate !== null ? formatEth(rate, 8) : null,
      priceSources: this.pricer.anchor?.sources ?? null,
      anchoredAt: this.pricer.anchor ? new Date(this.pricer.anchor.atMs).toISOString() : null,
      gasPriceWei: this.payoutGasPrice().toString(),
      marketGasPriceWei: this.marketGasPrice?.toString() ?? null,
      overCap: this.overCap(),
      paused: this.config?.paused ?? null,
      nextNonce: this.config?.nextNonce.toString() ?? null,
      openIntents: this.open.size,
      watcher: {
        ready: this.watcher.ready,
        open: this.watcher.openKeys().length,
        filled: this.watcher.filledKeys().length,
        rpcCalls: this.watcher.stats.calls,
        pollErrors: this.watcher.stats.pollErrors,
        recovered: this.watcher.stats.recovered,
        lost: this.watcher.stats.lost,
        ...this.watcher.queueStats(),
      },
      pendingPayouts: [...this.tracked.values()].filter((t) => !t.done).length,
      fills: this.fills,
      baseRpc: !!this.base,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  // ------------------------------------------------------------ watching

  private async pollOpen(): Promise<void> {
    if (this.busy.poll) return;
    this.busy.poll = true;
    try {
      // The watcher's open index plus anything the websocket added, read by key.
      const extra = [...this.open.values()].map((v) => v.key);
      const rows = await this.watcher.fetchOpen(extra);
      const seen = new Set<string>();
      for (const { pubkey, account } of rows) {
        const k = pubkey.toBase58();
        seen.add(k);
        const prev = this.open.get(k);
        this.open.set(k, { key: pubkey, intent: account, skipUntil: prev?.skipUntil ?? 0 });
      }
      // Drop entries that are no longer Open, but keep ones younger than a poll
      // interval in case the RPC node lags the event that announced them.
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      for (const [k, v] of this.open) {
        if (!seen.has(k) && nowSec - v.intent.auctionStart > BigInt(Math.ceil(this.s.pollMs / 1000)) + 5n) {
          this.open.delete(k);
        }
      }
    } catch (e) {
      log(`open-intent poll failed: ${errMsg(e)}`);
    } finally {
      this.busy.poll = false;
    }
  }

  // ------------------------------------------------------------ filling

  private async tick(): Promise<void> {
    if (this.busy.tick || this.open.size === 0 || !this.priced()) return;
    this.busy.tick = true;
    try {
      const [clockInfo, cfgInfo, solverInfo] = await this.conn.getMultipleAccountsInfo([
        SYSVAR_CLOCK_PUBKEY,
        configPda(this.s.programId)[0],
        this.solverKey,
      ]);
      if (!clockInfo || !cfgInfo || !solverInfo) return;
      this.config = decodeConfig(cfgInfo.data);
      this.ledger = decodeSolver(solverInfo.data);
      if (this.config.paused) return;
      if (this.overCap()) {
        if (!this.overCapLogged) {
          log(`Base gas ${this.marketGasPrice} wei > max_gas_price ${this.config.maxGasPrice}; not filling until the admin runs set-max-gas`);
        }
        this.overCapLogged = true;
        return;
      }
      this.overCapLogged = false;
      const clusterNow = decodeClockUnixTimestamp(clockInfo.data);
      const now = clusterNow - this.s.clockSkewSec;
      const gas = this.payoutGasPrice();
      const costs = this.costs(gas);

      const candidates = [...this.open.values()].sort((a, b) => Number(a.intent.expiresAt - b.intent.expiresAt));
      for (const o of candidates) {
        const k = o.key.toBase58();
        if (clusterNow >= o.intent.expiresAt) {
          // Unfillable from now on; the watcher stops re-reading it too. Only its
          // open entry: a stale read may have put a just-filled intent back here.
          this.open.delete(k);
          this.watcher.forgetOpen(k);
          continue;
        }
        if (Date.now() < o.skipUntil) continue;
        const required = requiredOutForIntent(o.intent, now);
        const maxOut = this.pricer.maxOut(o.intent.inLamports, costs);
        if (maxOut < required) continue;
        const cost = payoutCost(required, gas, this.config.l1FeeBufferWei);
        if (this.ledger.balanceWei < cost) {
          o.skipUntil = Date.now() + 10_000;
          log(`intent ${short(k)} clears our price but ledger ${formatEth(this.ledger.balanceWei)} < cost ${formatEth(cost)} ETH`);
          continue;
        }
        const recipientOk = await this.recipientOk(o.intent.recipient);
        if (recipientOk === "retry") {
          o.skipUntil = Date.now() + 3_000;
          continue;
        }
        if (!recipientOk) {
          o.skipUntil = Number.MAX_SAFE_INTEGER;
          log(`intent ${short(k)} skipped: recipient ${hexAddr(o.intent.recipient)} has code (21000 gas payout would revert)`);
          continue;
        }
        await this.fill(o.key, o.intent, required, gas);
        break; // next_nonce moved; re-read state on the next tick
      }
    } catch (e) {
      log(`tick failed: ${errMsg(e)}`);
    } finally {
      this.busy.tick = false;
    }
  }

  /**
   * Fails closed: "retry" when Base cannot be asked, since a contract recipient
   * would revert the 21000-gas payout after the user's SOL is gone. The page
   * checks too.
   */
  private async recipientOk(recipient: Uint8Array): Promise<boolean | "retry"> {
    if (!this.s.checkRecipientCode || !this.base) return true;
    const k = hexAddr(recipient);
    const cached = this.plainRecipient.get(k);
    // A pass expires: an address can gain code later (EIP-7702 delegation).
    if (cached && (!cached.ok || Date.now() - cached.at < RECIPIENT_OK_TTL_MS)) return cached.ok;
    try {
      const ok = await isPlainAddress(this.base, k);
      this.plainRecipient.set(k, { ok, at: Date.now() });
      return ok;
    } catch (e) {
      log(`recipient ${k} code check failed, will retry: ${errMsg(e)}`);
      return "retry";
    }
  }

  private async fill(key: PublicKey, intent: OpenIntent, outWei: bigint, gasPrice: bigint): Promise<void> {
    const k = key.toBase58();
    let nonce = this.config!.nextNonce;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { ix, sigRequest, unsignedRlp } = fillIx(this.program, this.me, key, intent, nonce, outWei, gasPrice);
      const t0 = Date.now();
      try {
        const sig = await sendIxs(this.conn, this.keypair, [await ix], this.s.programId, {
          computeUnits: FILL_COMPUTE_UNITS,
          priorityMicroLamports: this.s.priorityMicroLamports,
        });
        this.fills++;
        this.open.delete(k);
        this.unsignedBySigRequest.set(sigRequest.toBase58(), unsignedRlp);
        this.pricer.applyFill(intent.inLamports, this.costs(gasPrice).solCostLamports);
        this.track(key, "intent", null, true).hints.add(gasPrice);
        this.watcher.noteFilled(key, gasPrice, nonce);
        log(
          `FILLED intent ${short(k)}: ${formatEth(outWei)} ETH to ${hexAddr(intent.recipient)} at nonce ${nonce}, gas ${gasPrice} wei, ${Date.now() - t0} ms ${solanaExplorerTx(sig)}`,
        );
        return;
      } catch (e) {
        const name = e instanceof TxError ? e.errorName : undefined;
        if (name === "NonceMoved") {
          const info = await this.conn.getAccountInfo(configPda(this.s.programId)[0]);
          if (!info) return;
          this.config = decodeConfig(info.data);
          nonce = this.config.nextNonce;
          log(`intent ${short(k)}: nonce moved, retrying at ${nonce}`);
          continue;
        }
        const o = this.open.get(k);
        if (name === "IntentNotOpen" || name === "IntentExpired") {
          this.open.delete(k);
          log(`intent ${short(k)}: lost (${name})`);
        } else if (name === "BelowRequiredOut") {
          if (o) o.skipUntil = Date.now() + 1_000;
          log(`intent ${short(k)}: BelowRequiredOut, will re-price`);
        } else {
          if (o) o.skipUntil = Date.now() + 5_000;
          log(`intent ${short(k)}: fill failed (${name ?? "unknown"}): ${errMsg(e).slice(0, 300)}`);
        }
        return;
      }
    }
  }

  // ------------------------------------------------------------ delivery

  private track(key: PublicKey, kind: Tracked["kind"], payout: Payout | null, mine: boolean): Tracked {
    const k = key.toBase58();
    let t = this.tracked.get(k);
    if (!t) {
      t = {
        key,
        kind,
        payout: payout as Payout,
        mine,
        tracker: new PayoutTracker(payoutRpc(this.base ?? nullRpc())),
        hints: new Set(),
        done: false,
        reportTries: 0,
      };
      this.tracked.set(k, t);
    }
    if (payout) t.payout = payout;
    return t;
  }

  private async deliver(): Promise<void> {
    if (this.busy.deliver || !this.base) return;
    this.busy.deliver = true;
    try {
      const poolMined = BigInt(await this.base.call<string>("eth_getTransactionCount", [this.poolHex, "latest"]));
      const [clockInfo, cfgInfo] = await this.conn.getMultipleAccountsInfo([
        SYSVAR_CLOCK_PUBKEY,
        configPda(this.s.programId)[0],
      ]);
      if (!clockInfo) throw new Error("Clock sysvar not found");
      const clusterNow = decodeClockUnixTimestamp(clockInfo.data);
      if (cfgInfo) this.config = decodeConfig(cfgInfo.data);

      const live = new Set<string>();
      const step = async (t: Tracked) => {
        if (t.done) return;
        try {
          if (t.payout.baseNonce < poolMined) await this.reportMined(t);
          else await this.deliverOne(t, poolMined, clusterNow);
        } catch (e) {
          log(`deliver ${t.kind} ${short(t.key)} failed: ${errMsg(e)}`);
        }
      };

      // Filled intents from the watcher's index, read by key (no getProgramAccounts).
      for (const { pubkey, account: intent } of await this.watcher.fetchFilled()) {
        const k = pubkey.toBase58();
        live.add(k);
        const t = this.track(pubkey, "intent", intentPayout(intent), intent.solver.equals(this.me));
        t.closed = false;
        for (const g of this.watcher.gasHints(k)) t.hints.add(g);
        await step(t);
        // Mined and reported: nothing left to do for it.
        if (t.done) this.watcher.forget(k);
      }

      // Withdrawals share the pool's nonce queue, so a stuck one blocks every fill behind it.
      const next = this.config?.nextNonce ?? poolMined;
      const upTo = next < poolMined + WITHDRAWAL_SCAN ? next : poolMined + WITHDRAWAL_SCAN;
      const liveWithdrawals = new Set<bigint>();
      for (const { pubkey, account } of await fetchWithdrawalsInRange(this.conn, poolMined, upTo, this.s.programId)) {
        live.add(pubkey.toBase58());
        liveWithdrawals.add(account.baseNonce);
        await step(this.track(pubkey, "withdrawal", withdrawalPayout(account), account.solver.equals(this.me)));
      }

      // Every nonce in flight must belong to a payout we know, above all the head
      // (poolMined): an unknown head is never bumped and blocks the whole queue.
      // After a restart its IntentFilled can be older than the backfill, so the
      // watcher pages further back for any nonce nothing has indexed.
      const unknown: bigint[] = [];
      for (let n = poolMined; n < upTo; n++) {
        if (!liveWithdrawals.has(n) && !this.watcher.knowsNonce(n)) unknown.push(n);
      }
      if (this.watcher.ready) this.watcher.seekNonces(unknown);

      // Accounts gone with their payout unmined: keep rebroadcasting the signed candidates.
      for (const [k, t] of this.tracked) {
        if (live.has(k)) continue;
        // Our own fill before its account has been read: the next pass loads it.
        if (!t.payout) continue;
        // Still indexed as Filled: the read was stale (Open), not a closed account.
        if (t.kind === "intent" && this.watcher.hasFilled(k)) continue;
        if (t.done || t.payout.baseNonce < poolMined) {
          this.tracked.delete(k);
          continue;
        }
        if (!t.closed) log(`${t.kind} ${short(k)} closed with nonce ${t.payout.baseNonce} unmined; still rebroadcasting`);
        t.closed = true;
        await step(t);
      }
      this.watcher.forgetWithdrawalsBelow(poolMined);
      if (this.unsignedBySigRequest.size > 5_000) this.unsignedBySigRequest.clear();
    } catch (e) {
      log(`deliver loop failed: ${errMsg(e)}`);
    } finally {
      this.busy.deliver = false;
    }
  }

  private async candidates(t: Tracked): Promise<PayoutCandidate[]> {
    const p = t.payout;
    const srs = await fetchSigRequests(this.conn, p.sigRequests.slice(0, p.sigRequestCount));
    const build = () =>
      buildCandidates(p, srs, {
        gasPriceHints: [...t.hints],
        unsignedBySigRequest: this.unsignedBySigRequest,
        programId: this.s.programId,
      });
    let cands = build();
    // Older candidates need their gas price; recover it from the account's own logs.
    if (cands.some((c) => !c.unsigned) && (!t.historyAt || Date.now() - t.historyAt > 60_000)) {
      t.historyAt = Date.now();
      const h = await intentHistory(this.conn, t.key, this.s.programId);
      for (const g of h.gasPriceHints) t.hints.add(g);
      for (const [sr, rlp] of h.unsignedBySigRequest) this.unsignedBySigRequest.set(sr, rlp);
      cands = build();
    }
    return cands;
  }

  /** The pool's nonce is past this payout: find which candidate landed, once, for the log. */
  private async reportMined(t: Tracked): Promise<void> {
    if (!t.mine || t.reportTries >= 3) {
      t.done = true;
      return;
    }
    t.reportTries++;
    for (const c of await this.candidates(t)) {
      if (!c.signed) continue;
      const r = await getReceipt(this.base!, c.signed.txHash);
      if (r) {
        t.done = true;
        log(`DELIVERED ${t.kind} ${short(t.key)}: ${r.status === 1 ? "ok" : "REVERTED"} ${basescanTx(c.signed.txHash)}`);
        return;
      }
    }
  }

  private async deliverOne(t: Tracked, poolMined: bigint, clusterNow: bigint): Promise<void> {
    const cands = await this.candidates(t);
    const res = await t.tracker.track(cands);
    if (res.state !== t.lastState) {
      const newest = [...cands].reverse().find((c) => c.signed)?.signed?.txHash;
      log(
        `payout ${t.kind} ${short(t.key)} (${t.mine ? "ours" : "other"}, nonce ${t.payout.baseNonce}): ${res.state}${newest ? " " + basescanTx(newest) : ""}`,
      );
      t.lastState = res.state;
    }
    if (res.state === "delivered") {
      t.done = true;
      const d = res.delivered!;
      if (t.mine) log(`DELIVERED ${t.kind} ${short(t.key)}: ${d.status === 1 ? "ok" : "REVERTED"} ${basescanTx(d.txHash)}`);
      return;
    }
    for (const a of res.attempts) {
      if (a.outcome === "error" || a.outcome === "underpriced") log(`broadcast ${a.txHash}: ${a.outcome} ${a.error ?? ""}`);
    }
    // Only the head of the pool's nonce queue can unblock anything.
    if (t.payout.baseNonce === poolMined) await this.maybeBump(t, cands, clusterNow);
  }

  private blocked(t: Tracked, msg: string): void {
    if (!t.bumpBlockedLogged) log(`payout ${t.kind} ${short(t.key)} ${msg}`);
    t.bumpBlockedLogged = true;
  }

  private async maybeBump(t: Tracked, cands: PayoutCandidate[], clusterNow: bigint): Promise<void> {
    const p = t.payout;
    if (t.closed) return this.blocked(t, "cannot be bumped: its account is closed");
    if (t.lastBumpAt && Date.now() - t.lastBumpAt < 15_000) return;
    if (!t.mine && clusterNow <= p.since + OPEN_BUMP_AFTER_SEC) return;

    // Bumps raise the price, so the newest candidate is the one at the stored price.
    const newest = cands.find((c) => c.gasPrice === p.gasPrice) ?? cands[cands.length - 1];
    const waitMs = t.mine ? this.s.selfBumpAfterMs : this.s.otherBumpAfterMs;
    const pending = t.tracker.pendingForMs(cands);
    const stuck = !!newest?.signed && pending !== null && pending >= waitMs;
    // The committee never signs a request older than 300 s; only a new one helps.
    const unsignable = !!newest?.account && !newest.completed && newest.account.expiresAt < clusterNow;
    if (!stuck && !unsignable) return;

    // All slots taken: the program reuses one whose request expired unsigned.
    let reuse: PublicKey[] = [];
    if (p.sigRequestCount >= MAX_SIG_REQUESTS) {
      reuse = cands
        .filter((c) => c.account && !c.completed && c.account.expiresAt + DEAD_SIG_REQUEST_AFTER_SEC < clusterNow)
        .map((c) => c.sigRequest);
      if (reuse.length === 0) {
        return this.blocked(t, `has ${MAX_SIG_REQUESTS} signatures and none expired unsigned; the admin can bump it, reusing a slot`);
      }
    }

    const cap = this.config?.maxGasPrice ?? 0n;
    const floor = this.config?.minGasPrice ?? 0n;
    let min = minBumpGasPrice(p.gasPrice) + 1n;
    if (min < floor) min = floor;
    const withExtra = (p.gasPrice * (11_000n + this.s.bumpExtraBps)) / 10_000n;
    let next = withExtra > this.gasPrice ? withExtra : this.gasPrice;
    if (next < min) next = min;
    if (next > cap) next = cap;
    if (next < min) return this.blocked(t, `cannot bump: next ${min} wei > max_gas_price ${cap}; admin can raise it`);

    t.lastBumpAt = Date.now();
    const { ix, sigRequest, unsignedRlp } =
      t.kind === "intent"
        ? bumpGasIx(this.program, this.me, t.key, p, next, reuse)
        : bumpWithdrawalGasIx(
            this.program,
            this.me,
            { payoutAddr: p.recipient, amountWei: p.outWei, baseNonce: p.baseNonce, solver: p.solver },
            next,
            reuse,
          );
    try {
      const sig = await sendIxs(this.conn, this.keypair, [await ix], this.s.programId, {
        computeUnits: FILL_COMPUTE_UNITS,
        priorityMicroLamports: this.s.priorityMicroLamports,
      });
      t.hints.add(p.gasPrice);
      t.hints.add(next);
      t.bumpBlockedLogged = false;
      this.unsignedBySigRequest.set(sigRequest.toBase58(), unsignedRlp);
      log(
        `BUMPED ${t.kind} ${short(t.key)} (${t.mine ? "ours" : "other"}) ${p.gasPrice} → ${next} wei${unsignable ? " (signature expired)" : ""}${reuse.length ? " (reused an expired slot)" : ""} ${solanaExplorerTx(sig)}`,
      );
    } catch (e) {
      const name = e instanceof TxError ? e.errorName : undefined;
      log(`bump ${t.kind} ${short(t.key)} failed (${name ?? "unknown"}): ${errMsg(e).slice(0, 300)}`);
    }
  }
}

/** Placeholder when no Base RPC is given (tests); deliver() never runs without one. */
function nullRpc(): EthRpc {
  return {
    sendRawTransaction: () => Promise.reject(new Error("no Base RPC")),
    call: () => Promise.reject(new Error("no Base RPC")),
  } as unknown as EthRpc;
}
