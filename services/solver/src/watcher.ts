// Intent discovery without getProgramAccounts or logsSubscribe, which keyed
// free tiers (Alchemy) refuse and keyless public endpoints rate-limit on shared
// IPs. It polls getSignaturesForAddress(program) for new transactions, decodes
// the intents events from each one's logs (getTransaction), and keeps an
// in-memory index of the accounts the solver cares about:
//
//   open        IntentOpened minus IntentFilled / IntentCancelled
//   filled      IntentFilled (plus GasBumped, and SignedIntentExecuted for RFQ
//               settlements), payouts that may still need delivery
//   withdrawals SolverWithdrew (plus WithdrawalGasBumped), by pool nonce
//   nonces      every pool nonce an event (or an account read) has shown in use
//
// On start it backfills the newest BACKFILL_SIGS signatures, then reconciles the
// indexed keys against getMultipleAccountsInfo. Everything here is a read.
//
// Nothing here may lose an event quietly, because nothing else rediscovers it:
//   - New signatures are listed into a backlog (cursor = newest listed) and
//     replayed oldest first. A page that comes back empty right after a full
//     one is retried, not taken as the end of the gap; minContextSlot stops a
//     lagging node from answering at all; a node that does not know the cursor
//     (and returns older history) is cut off at the cursor's slot.
//   - A transaction the node cannot return yet holds the backlog briefly at the
//     normal poll rate (no backoff), then moves to a deferred list that is
//     retried in the background for DEFER_TX_MAX_MS.
//   - Every REWALK_MS the newest REWALK_SIGS signatures are re-listed and any
//     the polls never saw are replayed.
//   - seekNonces(): pool nonces nobody has indexed (the head payout after a
//     restart, say) make the watcher page further back through history until
//     their IntentFilled / SolverWithdrew is found, up to MAX_OLDER_SIGS.

import type {
  ConfirmedSignatureInfo,
  Connection,
  SignaturesForAddressOptions,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import {
  IntentStatus,
  decodeIntent,
  parseIntentsLogs,
  type IntentAccount,
  type IntentsEvent,
  type Keyed,
} from "../../../lib/intents";

/** The RPC methods the watcher uses: all served by Alchemy's free devnet tier. */
export type WatcherConnection = Pick<
  Connection,
  "getSignaturesForAddress" | "getTransaction" | "getMultipleAccountsInfo"
>;

/** What fill() needs from an open intent; IntentOpened carries all of it. */
export type OpenIntentFields = Pick<
  IntentAccount,
  | "user"
  | "intentId"
  | "inLamports"
  | "recipient"
  | "startOutWei"
  | "minOutWei"
  | "auctionStart"
  | "auctionDuration"
  | "expiresAt"
>;

export type OpenEntry = { key: PublicKey; intent: OpenIntentFields };

export type FilledEntry = {
  key: PublicKey;
  solver?: PublicKey;
  baseNonce?: bigint;
  /** Every gas price this payout was signed at (fill and bumps). */
  gasPrices: Set<bigint>;
};

export type WithdrawalEntry = {
  baseNonce: bigint;
  solver?: PublicKey;
  gasPrices: Set<bigint>;
};

/**
 * One transaction's intents events, oldest first. `backfill` is true for
 * history replayed on start and for transactions that arrived late (deferred,
 * re-walked, or older pages): the consumer should re-read state rather than act
 * on them as news.
 */
export type WatchedTx = { signature: string; slot: number; events: IntentsEvent[]; backfill: boolean };
export type WatchHandler = (tx: WatchedTx) => void;

export type WatcherOptions = {
  programId: PublicKey;
  /** Poll interval for new signatures. */
  watchMs?: number;
  /** Signatures replayed on start to rebuild the index. */
  backfillSigs?: number;
  /** getSignaturesForAddress page size while polling. */
  pageSize?: number;
  /** Pages of pageSize one poll walks before it lists the rest of the gap 1000 at a time. */
  maxPagesPerPoll?: number;
  /** Signatures one poll may list; anything older in the gap is skipped (loudly). */
  maxGapSigs?: number;
  /** Backlog transactions fetched per poll; the rest wait for the next one. */
  maxTxPerStep?: number;
  /** getTransaction calls in flight at once. */
  txConcurrency?: number;
  /** getTransaction calls per second (0: unpaced). */
  txPerSec?: number;
  maxBackoffMs?: number;
  /** Cap on each index map (oldest entries go first). */
  maxEntries?: number;
  /** Polls a missing transaction may hold the backlog for... */
  maxTxMisses?: number;
  /** ...or this long, whichever ends first; then it is deferred and the backlog moves on. */
  holdTxMs?: number;
  /** How long a deferred transaction is retried before its events are given up on. */
  deferTxMaxMs?: number;
  /** Re-list the newest rewalkSigs signatures this often and replay any never seen (0: off). */
  rewalkMs?: number;
  rewalkSigs?: number;
  /** Page size when looking further back for unindexed pool nonces. */
  olderPageSize?: number;
  /** Cap on signatures replayed beyond the backfill while looking for nonces. */
  maxOlderSigs?: number;
  /** A nonce must stay unindexed this long before older history is paged for it. */
  seekGraceMs?: number;
  log?: (msg: string) => void;
};

export type WatcherStats = {
  /** RPC calls by method since start. */
  calls: Record<string, number>;
  signatures: number;
  transactions: number;
  failedSkipped: number;
  events: number;
  pollErrors: number;
  /** Transactions replayed late: deferred ones that arrived, and re-walk finds. */
  recovered: number;
  /** Deferred transactions given up on: their events are lost. */
  lost: number;
  /** Signatures replayed from beyond the backfill while seeking nonces. */
  olderSigs: number;
};

type SigInfo = Pick<ConfirmedSignatureInfo, "signature" | "slot" | "err">;
type Deferred = { sig: SigInfo; backfill: boolean; since: number; tries: number; nextTryAt: number };
type ProcessOpts = {
  backfill: boolean;
  /** Hold (stop at) a missing transaction instead of deferring it at once. */
  hold?: boolean;
  /** Add to the seen set; off for older history, so it cannot evict recent signatures. */
  remember?: boolean;
};

const SEEN_CAP = 5_000;
const DEFERRED_CAP = 1_000;
/** An open intent this long past expires_at can never be filled; stop indexing it. */
const OPEN_EXPIRED_GRACE_SEC = 600n;
const GMAI_CHUNK = 100;
const DEFERRED_PER_STEP = 10;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A short, secret-free label for an RPC error, so each kind is logged once per outage. */
export function errorKind(e: unknown): string {
  const msg = errMsg(e);
  if (/\b429\b|too many requests/i.test(msg)) return "rate limited (429)";
  return msg
    .replace(/\b(?:https?|wss?):\/\/\S+/g, "<url>")
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, "<id>")
    .replace(/\d+/g, "N")
    .slice(0, 120);
}

/** The node is behind the slot we asked for: retry at the normal rate, it is not an outage. */
export function isLagError(e: unknown): boolean {
  return /minimum context slot/i.test(errMsg(e));
}

const raw = (r: Record<string, unknown>, snake: string): unknown => {
  if (snake in r) return r[snake];
  const camel = snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return r[camel];
};
const rawBig = (v: unknown) => (v === undefined || v === null ? undefined : BigInt((v as { toString(): string }).toString()));
const rawKey = (v: unknown) =>
  v instanceof PublicKey ? v : v === undefined || v === null ? undefined : new PublicKey(v as string);

export class ProgramWatcher {
  readonly programId: PublicKey;
  readonly watchMs: number;
  readonly backfillSigs: number;
  private readonly pageSize: number;
  private readonly maxPagesPerPoll: number;
  private readonly maxGapSigs: number;
  private readonly maxTxPerStep: number;
  private readonly txConcurrency: number;
  private readonly txIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxEntries: number;
  private readonly maxTxMisses: number;
  private readonly holdTxMs: number;
  private readonly deferTxMaxMs: number;
  private readonly rewalkMs: number;
  private readonly rewalkSigs: number;
  private readonly olderPageSize: number;
  private readonly maxOlderSigs: number;
  private readonly seekGraceMs: number;
  private readonly log: (msg: string) => void;

  private readonly open = new Map<string, OpenEntry>();
  private readonly filled = new Map<string, FilledEntry>();
  private readonly withdrawals = new Map<string, WithdrawalEntry>();
  /** Pool nonce → the intent key (or "withdrawal") that took it. */
  private readonly nonces = new Map<string, string>();
  private readonly seen = new Set<string>();
  private readonly txMisses = new Map<string, { n: number; since: number }>();
  private readonly deferred = new Map<string, Deferred>();
  /** Listed but not yet replayed, oldest first. */
  private backlog: SigInfo[] = [];
  private readonly queued = new Set<string>();
  /** Nonce → when it was first asked for. */
  private readonly seeking = new Map<string, number>();

  private handler: WatchHandler | null = null;
  private onBackfilled: (() => void) | null = null;
  /** Newest signature listed: the cursor for the next poll. */
  private lastSeen: string | undefined;
  private lastSeenSlot: number | undefined;
  /** Oldest signature replayed: the cursor for paging further back. */
  private oldest: SigInfo | undefined;
  /** Slot of the oldest backfilled signature; the re-walk never goes below it. */
  private floorSlot: number | undefined;
  private historyStart = false;
  private emptyOlderPages = 0;
  private seekLogged = "";
  private lastRewalk = 0;
  private nextTxAt = 0;
  private backfilled = false;
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private failures = 0;
  /** Newest blockTime seen: cluster time for pruning expired open intents. */
  private clusterTimeSec: bigint | null = null;
  private readonly loggedKinds = new Set<string>();

  readonly stats: WatcherStats = {
    calls: {},
    signatures: 0,
    transactions: 0,
    failedSkipped: 0,
    events: 0,
    pollErrors: 0,
    recovered: 0,
    lost: 0,
    olderSigs: 0,
  };

  constructor(
    private readonly conn: WatcherConnection,
    opts: WatcherOptions,
  ) {
    this.programId = opts.programId;
    this.watchMs = Math.max(100, opts.watchMs ?? 1_500);
    this.backfillSigs = Math.max(0, opts.backfillSigs ?? 1_000);
    this.pageSize = Math.min(1_000, Math.max(1, opts.pageSize ?? 100));
    this.maxPagesPerPoll = Math.max(1, opts.maxPagesPerPoll ?? 20);
    this.maxGapSigs = Math.max(this.pageSize, opts.maxGapSigs ?? 20_000);
    this.maxTxPerStep = Math.max(1, opts.maxTxPerStep ?? 500);
    this.txConcurrency = Math.max(1, opts.txConcurrency ?? 4);
    this.txIntervalMs = opts.txPerSec && opts.txPerSec > 0 ? 1_000 / opts.txPerSec : 0;
    this.maxBackoffMs = Math.max(this.watchMs, opts.maxBackoffMs ?? 30_000);
    this.maxEntries = Math.max(10, opts.maxEntries ?? 5_000);
    this.maxTxMisses = Math.max(1, opts.maxTxMisses ?? 5);
    this.holdTxMs = Math.max(0, opts.holdTxMs ?? 10_000);
    this.deferTxMaxMs = Math.max(0, opts.deferTxMaxMs ?? 30 * 60_000);
    this.rewalkMs = Math.max(0, opts.rewalkMs ?? 180_000);
    this.rewalkSigs = Math.min(1_000, Math.max(1, opts.rewalkSigs ?? 500));
    this.olderPageSize = Math.min(1_000, Math.max(1, opts.olderPageSize ?? 200));
    this.maxOlderSigs = Math.max(0, opts.maxOlderSigs ?? 20_000);
    this.seekGraceMs = Math.max(0, opts.seekGraceMs ?? 20_000);
    this.log = opts.log ?? ((m) => console.log(`${new Date().toISOString()} ${m}`));
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Tries the backfill once and resolves (a failed one is retried by the poll
   * loop with backoff), then polls every watchMs. `onBackfilled` runs once the
   * backfill and its reconcile have succeeded.
   */
  async start(handler?: WatchHandler, onBackfilled?: () => void): Promise<void> {
    this.handler = handler ?? null;
    this.onBackfilled = onBackfilled ?? null;
    if (!this.stopped) return;
    this.stopped = false;
    await this.step();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
  }

  get ready(): boolean {
    return this.backfilled;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.step(), ms);
  }

  private async step(): Promise<void> {
    if (this.running) return;
    let delay = this.watchMs;
    const run = (async () => {
      try {
        if (!this.backfilled) await this.backfill();
        else {
          await this.pollOnce();
          await this.maintain();
        }
        this.onSuccess();
      } catch (e) {
        // A node behind the requested slot is lag, not an outage: no backoff.
        if (!isLagError(e)) delay = this.onFailure(e);
      }
    })();
    this.running = run;
    await run;
    this.running = null;
    this.schedule(delay);
  }

  private onSuccess(): void {
    if (this.failures > 0) this.log(`watcher: recovered after ${this.failures} failed polls`);
    this.failures = 0;
    this.loggedKinds.clear();
  }

  /** Exponential backoff from watchMs to maxBackoffMs, with jitter; logs each error kind once per outage. */
  private onFailure(e: unknown): number {
    this.failures++;
    this.stats.pollErrors++;
    const kind = errorKind(e);
    const base = Math.min(this.maxBackoffMs, this.watchMs * 2 ** Math.min(this.failures, 16));
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    if (!this.loggedKinds.has(kind)) {
      this.loggedKinds.add(kind);
      this.log(`watcher: ${this.backfilled ? "poll" : "backfill"} failed: ${kind}; backing off (next try in ${delay} ms)`);
    }
    return delay;
  }

  private count(method: string, n = 1): void {
    this.stats.calls[method] = (this.stats.calls[method] ?? 0) + n;
  }

  // ------------------------------------------------------------ signatures

  private async signatures(opts: SignaturesForAddressOptions): Promise<ConfirmedSignatureInfo[]> {
    this.count("getSignaturesForAddress");
    const o: SignaturesForAddressOptions = { ...opts };
    if (o.minContextSlot === undefined) delete o.minContextSlot;
    return this.conn.getSignaturesForAddress(this.programId, o, "confirmed");
  }

  /** Rebuilds the index from the newest backfillSigs signatures, then reconciles it with account state. */
  async backfill(): Promise<void> {
    const all: ConfirmedSignatureInfo[] = [];
    let before: ConfirmedSignatureInfo | undefined;
    // At least one signature, so polling starts from the tip even with BACKFILL_SIGS=0.
    const want = Math.max(1, this.backfillSigs);
    let reachedStart = false;
    while (all.length < want) {
      const limit = Math.min(1_000, want - all.length);
      let page = await this.signatures({ before: before?.signature, limit, minContextSlot: before?.slot });
      // A node that does not know `before` answers [] with no error: ask twice more before believing it.
      for (let retry = 0; page.length === 0 && before && retry < 2; retry++) {
        await sleep(Math.min(this.watchMs, 1_000));
        page = await this.signatures({ before: before.signature, limit, minContextSlot: before.slot });
      }
      all.push(...page);
      if (page.length < limit) {
        if (page.length === 0 && before) {
          this.log(`watcher: backfill stopped after ${all.length} signatures (empty page); older nonces are found on demand`);
        } else {
          reachedStart = true;
        }
        break;
      }
      before = page[page.length - 1];
    }
    const tip = all[0];
    if (tip) {
      this.lastSeen = tip.signature;
      this.lastSeenSlot = tip.slot;
    }
    if (this.backfillSigs === 0) {
      if (tip) this.markSeen(tip.signature);
      all.length = 0;
      this.oldest = tip;
    } else {
      this.oldest = all[all.length - 1];
      this.historyStart = reachedStart;
    }
    this.floorSlot = this.oldest?.slot;
    await this.process(all.reverse(), { backfill: true });
    await this.reconcile();
    this.backfilled = true;
    this.lastRewalk = Date.now();
    this.log(
      `watcher: backfilled ${all.length} signatures: ${this.open.size} open, ${this.filled.size} filled, ${this.withdrawals.size} withdrawals indexed`,
    );
    try {
      this.onBackfilled?.();
    } catch (e) {
      this.log(`watcher: onBackfilled failed: ${errMsg(e)}`);
    }
  }

  /**
   * One poll: lists every signature newer than the cursor into the backlog,
   * then replays the backlog oldest first (up to maxTxPerStep). Returns how many
   * signatures were handled.
   */
  async pollOnce(): Promise<number> {
    await this.listNew();
    return this.drain();
  }

  /** Lists signatures newer than lastSeen. Throws (keeping the cursor) on anything that looks like a lagging node. */
  private async listNew(): Promise<void> {
    const found: ConfirmedSignatureInfo[] = [];
    const floor = this.lastSeenSlot;
    let before: ConfirmedSignatureInfo | undefined;
    let complete = false;
    for (let page = 0; found.length < this.maxGapSigs; page++) {
      const size = page < this.maxPagesPerPoll ? this.pageSize : 1_000;
      const limit = Math.min(size, this.maxGapSigs - found.length);
      // minContextSlot: a node that has not reached the cursor (or `before`) errors instead of answering.
      const batch = await this.signatures({
        until: this.lastSeen,
        before: before?.signature,
        limit,
        minContextSlot: before?.slot ?? floor,
      });
      // A node that does not know `until` answers with older history too: stop at the cursor's slot.
      const cut = floor === undefined ? -1 : batch.findIndex((s) => s.slot < floor);
      found.push(...(cut < 0 ? batch : batch.slice(0, cut)));
      if (cut >= 0) {
        complete = true;
        break;
      }
      if (batch.length < limit) {
        if (batch.length === 0 && before && !(await this.gapClosed(before))) {
          throw new Error("a signature page came back empty after a full one; retrying the gap");
        }
        complete = true;
        break;
      }
      before = batch[batch.length - 1];
    }
    if (!complete) {
      this.log(`watcher: WARNING more than ${found.length} new signatures since the last poll; older ones in the gap were skipped`);
    }
    const tip = found[0];
    if (!tip) return;
    for (let i = found.length - 1; i >= 0; i--) {
      const s = found[i];
      if (this.seen.has(s.signature) || this.queued.has(s.signature) || this.deferred.has(s.signature)) continue;
      this.backlog.push({ signature: s.signature, slot: s.slot, err: s.err });
      this.queued.add(s.signature);
    }
    if (this.lastSeenSlot === undefined || tip.slot >= this.lastSeenSlot) {
      this.lastSeen = tip.signature;
      this.lastSeenSlot = tip.slot;
    }
  }

  /**
   * After a full page, an empty one means either the gap ended exactly there or
   * the node does not know `before`. The signature just before it tells which.
   */
  private async gapClosed(before: ConfirmedSignatureInfo): Promise<boolean> {
    const [prev] = await this.signatures({ before: before.signature, limit: 1, minContextSlot: before.slot });
    if (!prev) return this.lastSeen === undefined;
    return prev.signature === this.lastSeen || (this.lastSeenSlot !== undefined && prev.slot <= this.lastSeenSlot);
  }

  /** Replays the backlog from the front; a missing transaction may hold it there. */
  private async drain(): Promise<number> {
    if (this.backlog.length === 0) return 0;
    const take = this.backlog.slice(0, this.maxTxPerStep);
    const handled = await this.process(take, { backfill: false, hold: true });
    for (const s of this.backlog.splice(0, handled)) this.queued.delete(s.signature);
    return handled;
  }

  /**
   * Fetches and applies `sigs` (oldest first) in chunks. Returns how many were
   * handled from the front. With `hold`, a transaction the node cannot return
   * yet stops the batch there (and is retried at the poll rate) until
   * maxTxMisses polls or holdTxMs pass; then, as always without `hold`, it is
   * deferred and retried in the background.
   */
  private async process(sigs: SigInfo[], opts: ProcessOpts): Promise<number> {
    let handled = 0;
    try {
      for (let i = 0; i < sigs.length; i += this.txConcurrency) {
        const chunk = sigs.slice(i, i + this.txConcurrency);
        const skip = (s: SigInfo) => !!s.err || this.seen.has(s.signature) || this.deferred.has(s.signature);
        const txs = await Promise.all(chunk.map((s) => (skip(s) ? null : this.fetchTx(s.signature))));
        for (let j = 0; j < chunk.length; j++) {
          const s = chunk[j];
          if (!this.seen.has(s.signature) && !this.deferred.has(s.signature)) {
            const tx = txs[j];
            if (s.err) {
              this.stats.failedSkipped++;
              this.stats.signatures++;
              if (opts.remember !== false) this.markSeen(s.signature);
            } else if (tx) {
              this.applyTx(s, tx, opts.backfill, opts.remember !== false);
            } else if (opts.hold && this.hold(s)) {
              return handled;
            } else {
              this.defer(s, opts.backfill);
            }
          }
          handled++;
        }
      }
      return handled;
    } finally {
      this.prune();
    }
  }

  private applyTx(s: SigInfo, tx: VersionedTransactionResponse, backfill: boolean, remember = true): void {
    if (tx.meta?.err) {
      this.stats.failedSkipped++;
    } else {
      this.stats.transactions++;
      if (tx.blockTime && (this.clusterTimeSec === null || BigInt(tx.blockTime) > this.clusterTimeSec)) {
        this.clusterTimeSec = BigInt(tx.blockTime);
      }
      this.apply(s.signature, tx.slot, tx.meta?.logMessages ?? [], backfill);
    }
    this.txMisses.delete(s.signature);
    if (remember) this.markSeen(s.signature);
    this.stats.signatures++;
  }

  /** True while a missing transaction should still hold the backlog. */
  private hold(s: SigInfo): boolean {
    const now = Date.now();
    const m = this.txMisses.get(s.signature) ?? { n: 0, since: now };
    m.n++;
    this.txMisses.set(s.signature, m);
    return m.n < this.maxTxMisses && now - m.since < this.holdTxMs;
  }

  private defer(s: SigInfo, backfill: boolean): void {
    const now = Date.now();
    this.txMisses.delete(s.signature);
    if (this.deferred.size >= DEFERRED_CAP) {
      const [k] = this.deferred.keys();
      this.deferred.delete(k);
      this.stats.lost++;
      this.log(`watcher: WARNING too many deferred transactions; gave up on ${k}`);
    }
    this.deferred.set(s.signature, { sig: s, backfill, since: now, tries: 0, nextTryAt: now + 2_000 });
    this.log(`watcher: the RPC has not returned ${s.signature} yet; moving on and retrying it in the background`);
  }

  /** Retries due deferred transactions; arrivals are applied as late (backfill) events. */
  private async retryDeferred(): Promise<void> {
    const now = Date.now();
    const due = [...this.deferred.values()].filter((d) => d.nextTryAt <= now).slice(0, DEFERRED_PER_STEP);
    for (const d of due) {
      const tx = await this.fetchTx(d.sig.signature);
      if (tx) {
        this.deferred.delete(d.sig.signature);
        this.stats.recovered++;
        this.applyTx(d.sig, tx, true);
        this.log(`watcher: deferred ${d.sig.signature} arrived after ${Math.round((Date.now() - d.since) / 1000)} s; replayed`);
      } else if (now - d.since >= this.deferTxMaxMs) {
        this.deferred.delete(d.sig.signature);
        this.markSeen(d.sig.signature);
        this.stats.lost++;
        this.log(`watcher: WARNING gave up on ${d.sig.signature}: the RPC returned no transaction for ${Math.round((now - d.since) / 60_000)} min; its events are lost`);
      } else {
        d.tries++;
        d.nextTryAt = now + Math.min(30_000, 2_000 * 2 ** d.tries);
      }
    }
    if (due.length) this.prune();
  }

  private async fetchTx(signature: string): Promise<VersionedTransactionResponse | null> {
    if (this.txIntervalMs > 0) {
      const now = Date.now();
      const at = Math.max(now, this.nextTxAt);
      this.nextTxAt = at + this.txIntervalMs;
      if (at > now) await sleep(at - now);
    }
    this.count("getTransaction");
    return this.conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  }

  private markSeen(sig: string): void {
    this.seen.add(sig);
    if (this.seen.size > SEEN_CAP) this.seen.delete(this.seen.values().next().value as string);
  }

  // ------------------------------------------------------------ safety nets

  /** Background work the poll loop runs after each poll: deferred retries, the periodic re-walk, and nonce seeking. */
  async maintain(): Promise<void> {
    if (this.deferred.size) await this.reconcileAfter(() => this.retryDeferred());
    const want = this.wantedNonces();
    // A nonce missing from recent history is likelier a dropped event than an old one: re-walk first.
    const askedAt = want.length ? Math.min(...want.map((n) => this.seeking.get(n.toString())!)) : Infinity;
    if (this.rewalkMs > 0 && (Date.now() - this.lastRewalk >= this.rewalkMs || this.lastRewalk < askedAt)) {
      await this.rewalk();
      return;
    }
    if (want.length) await this.seekOlder(want);
  }

  /** Re-lists the newest rewalkSigs signatures and replays any the polls never saw. */
  async rewalk(): Promise<number> {
    this.lastRewalk = Date.now();
    const tipSlot = this.lastSeenSlot;
    if (tipSlot === undefined) return 0;
    const page = await this.signatures({ limit: this.rewalkSigs });
    const missed = page
      .filter(
        (s) =>
          !s.err &&
          // Strictly below the cursor's slot: newer ones are the next poll's.
          s.slot < tipSlot &&
          (this.floorSlot === undefined || s.slot > this.floorSlot) &&
          !this.seen.has(s.signature) &&
          !this.queued.has(s.signature) &&
          !this.deferred.has(s.signature),
      )
      .reverse();
    if (missed.length === 0) return 0;
    this.log(`watcher: re-walk found ${missed.length} signature(s) the polls never saw; replaying them`);
    const before = this.stats.transactions;
    await this.reconcileAfter(() => this.process(missed, { backfill: true }));
    this.stats.recovered += this.stats.transactions - before;
    return missed.length;
  }

  /** Pool nonces asked for by seekNonces that are still unindexed after the grace period. */
  private wantedNonces(): bigint[] {
    const now = Date.now();
    const out: bigint[] = [];
    for (const [n, at] of this.seeking) {
      if (this.nonces.has(n)) this.seeking.delete(n);
      else if (now - at >= this.seekGraceMs) out.push(BigInt(n));
    }
    return out;
  }

  /** Replays one page of history older than anything replayed so far. */
  private async seekOlder(want: bigint[]): Promise<void> {
    const label = want.join(", ");
    if (!this.oldest || this.historyStart || this.stats.olderSigs >= this.maxOlderSigs) {
      if (this.seekLogged !== label) {
        this.seekLogged = label;
        const why = this.stats.olderSigs >= this.maxOlderSigs ? `the ${this.maxOlderSigs}-signature cap` : "the start of the program's history";
        this.log(
          `watcher: WARNING pool nonce(s) ${label} not found in any event after reaching ${why}; the payout(s) cannot be tracked or bumped and may block the pool's queue`,
        );
      }
      return;
    }
    const limit = Math.min(this.olderPageSize, this.maxOlderSigs - this.stats.olderSigs);
    const page = await this.signatures({ before: this.oldest.signature, limit });
    if (page.length === 0) {
      // Empty can also mean the node does not know `before`: believe it the second time.
      if (++this.emptyOlderPages >= 2) this.historyStart = true;
      return;
    }
    this.emptyOlderPages = 0;
    await this.reconcileAfter(() => this.process([...page].reverse(), { backfill: true, remember: false }));
    this.oldest = page[page.length - 1];
    this.stats.olderSigs += page.length;
    if (page.length < limit) this.historyStart = true;
    const still = want.filter((n) => !this.nonces.has(n.toString()));
    this.log(
      `watcher: looking for pool nonce(s) ${label}: replayed ${this.stats.olderSigs} signatures older than the backfill${still.length ? "" : "; found"}`,
    );
  }

  /** Runs `fn`, then reads the accounts of intents it added to the index. */
  private async reconcileAfter(fn: () => Promise<unknown>): Promise<void> {
    const known = new Set([...this.open.keys(), ...this.filled.keys()]);
    await fn();
    const added = [...this.open.values(), ...this.filled.values()].filter((e) => !known.has(e.key.toBase58())).map((e) => e.key);
    if (added.length) await this.loadIntents(added);
  }

  /**
   * The pool nonces whose payout the caller cannot find (in-flight range, not
   * indexed, not a live withdrawal). Each one that stays unindexed for
   * seekGraceMs makes the watcher page further back for its event. Replaces
   * the previous set.
   */
  seekNonces(nonces: bigint[]): void {
    const now = Date.now();
    const keep = new Set(nonces.map(String));
    for (const k of this.seeking.keys()) if (!keep.has(k)) this.seeking.delete(k);
    for (const k of keep) if (!this.seeking.has(k) && !this.nonces.has(k)) this.seeking.set(k, now);
  }

  /** Whether an event or an account read has shown this pool nonce in use. */
  knowsNonce(nonce: bigint): boolean {
    return this.nonces.has(nonce.toString());
  }

  private noteNonce(nonce: bigint, owner: string): void {
    this.nonces.set(nonce.toString(), owner);
  }

  // ------------------------------------------------------------ index

  private apply(signature: string, slot: number, logs: readonly string[], backfill: boolean): void {
    const events = parseIntentsLogs(logs, this.programId);
    if (events.length === 0) return;
    this.stats.events += events.length;
    for (const ev of events) this.applyEvent(ev);
    if (this.handler) {
      try {
        this.handler({ signature, slot, events, backfill });
      } catch (e) {
        this.log(`watcher: handler failed on ${signature}: ${errMsg(e)}`);
      }
    }
  }

  private filledEntry(key: PublicKey): FilledEntry {
    const k = key.toBase58();
    let f = this.filled.get(k);
    if (!f) {
      f = { key, gasPrices: new Set() };
      this.filled.set(k, f);
    }
    return f;
  }

  private withdrawalEntry(nonce: bigint): WithdrawalEntry {
    const k = nonce.toString();
    let w = this.withdrawals.get(k);
    if (!w) {
      w = { baseNonce: nonce, gasPrices: new Set() };
      this.withdrawals.set(k, w);
    }
    return w;
  }

  private applyEvent(ev: IntentsEvent): void {
    switch (ev.name) {
      case "IntentOpened":
        if (!this.filled.has(ev.intent.toBase58())) this.open.set(ev.intent.toBase58(), { key: ev.intent, intent: ev });
        break;
      case "IntentFilled": {
        this.open.delete(ev.intent.toBase58());
        const f = this.filledEntry(ev.intent);
        f.solver = ev.solver;
        f.baseNonce = ev.baseNonce;
        f.gasPrices.add(ev.gasPrice);
        this.noteNonce(ev.baseNonce, ev.intent.toBase58());
        break;
      }
      case "IntentCancelled":
        this.open.delete(ev.intent.toBase58());
        break;
      case "GasBumped": {
        this.open.delete(ev.intent.toBase58());
        const f = this.filledEntry(ev.intent);
        f.solver ??= ev.solver;
        f.baseNonce ??= ev.baseNonce;
        f.gasPrices.add(ev.oldGasPrice);
        f.gasPrices.add(ev.newGasPrice);
        this.noteNonce(ev.baseNonce, ev.intent.toBase58());
        break;
      }
      case "Other": {
        if (ev.eventName === "SignedIntentExecuted") {
          // RFQ: its IntentFilled comes in the same transaction; this alone is enough to index the payout.
          const intent = rawKey(raw(ev.data, "intent"));
          const nonce = rawBig(raw(ev.data, "base_nonce"));
          if (!intent || nonce === undefined) break;
          this.open.delete(intent.toBase58());
          const f = this.filledEntry(intent);
          f.solver ??= rawKey(raw(ev.data, "solver"));
          f.baseNonce ??= nonce;
          this.noteNonce(nonce, intent.toBase58());
          break;
        }
        if (ev.eventName !== "SolverWithdrew" && ev.eventName !== "WithdrawalGasBumped") break;
        const nonce = rawBig(raw(ev.data, "base_nonce"));
        if (nonce === undefined) break;
        const w = this.withdrawalEntry(nonce);
        w.solver ??= rawKey(raw(ev.data, "solver"));
        for (const name of ["gas_price", "old_gas_price", "new_gas_price"]) {
          const g = rawBig(raw(ev.data, name));
          if (g !== undefined) w.gasPrices.add(g);
        }
        this.noteNonce(nonce, "withdrawal");
        break;
      }
    }
  }

  /** Caps every map and drops open intents long past expiry (by the newest block time seen). */
  private prune(): void {
    const now = this.clusterTimeSec;
    if (now !== null) {
      for (const [k, o] of this.open) {
        if (o.intent.expiresAt + OPEN_EXPIRED_GRACE_SEC < now) this.open.delete(k);
      }
    }
    for (const m of [this.open, this.filled, this.withdrawals] as Map<string, unknown>[]) {
      while (m.size > this.maxEntries) m.delete(m.keys().next().value as string);
    }
    while (this.nonces.size > this.maxEntries * 4) this.nonces.delete(this.nonces.keys().next().value as string);
    if (this.txMisses.size > 1_000) this.txMisses.clear();
  }

  /**
   * Reads `keys` with getMultipleAccountsInfo (100 per call) and corrects the
   * index: closed accounts leave it, and each intent goes where its status says.
   * Returns key → decoded intent, or null when the account is gone. An Open
   * read of an intent the index already knows is Filled is a stale node (Filled
   * never goes back to Open): it is left out of the result and the index.
   */
  async loadIntents(keys: PublicKey[]): Promise<Map<string, IntentAccount | null>> {
    const out = new Map<string, IntentAccount | null>();
    const uniq = [...new Map(keys.map((k) => [k.toBase58(), k])).values()];
    for (let i = 0; i < uniq.length; i += GMAI_CHUNK) {
      const chunk = uniq.slice(i, i + GMAI_CHUNK);
      this.count("getMultipleAccountsInfo");
      const infos = await this.conn.getMultipleAccountsInfo(chunk, "confirmed");
      chunk.forEach((key, j) => {
        const k = key.toBase58();
        const info = infos[j];
        let intent: IntentAccount | null = null;
        if (info && info.owner.equals(this.programId)) {
          try {
            intent = decodeIntent(info.data);
          } catch {
            intent = null;
          }
        }
        if (!intent || intent.status === IntentStatus.Cancelled) {
          out.set(k, intent);
          this.open.delete(k);
          this.filled.delete(k);
        } else if (intent.status === IntentStatus.Open) {
          if (this.filled.has(k)) return;
          out.set(k, intent);
          this.open.set(k, { key, intent });
        } else if (intent.status === IntentStatus.Filled) {
          out.set(k, intent);
          this.open.delete(k);
          const f = this.filledEntry(key);
          f.solver = intent.solver;
          f.baseNonce = intent.baseNonce;
          f.gasPrices.add(intent.gasPrice);
          this.noteNonce(intent.baseNonce, k);
        } else {
          out.set(k, intent);
        }
      });
    }
    return out;
  }

  /** Re-reads every indexed intent (open and filled). */
  async reconcile(): Promise<void> {
    await this.loadIntents([...this.openKeys(), ...this.filledKeys()]);
  }

  /** Indexed intents (plus `extra`) whose account is Open now. One getMultipleAccountsInfo per 100 keys. */
  async fetchOpen(extra: PublicKey[] = []): Promise<Keyed<IntentAccount>[]> {
    const accts = await this.loadIntents([...this.openKeys(), ...extra]);
    return keyed(accts, IntentStatus.Open);
  }

  /** Indexed intents whose account is Filled now. */
  async fetchFilled(): Promise<Keyed<IntentAccount>[]> {
    const accts = await this.loadIntents(this.filledKeys());
    return keyed(accts, IntentStatus.Filled);
  }

  openKeys(): PublicKey[] {
    return [...this.open.values()].map((o) => o.key);
  }

  filledKeys(): PublicKey[] {
    return [...this.filled.values()].map((f) => f.key);
  }

  /** Still in the filled index: its account was not seen closed (a stale read may have hidden it). */
  hasFilled(key: PublicKey | string): boolean {
    return this.filled.has(typeof key === "string" ? key : key.toBase58());
  }

  openEntries(): OpenEntry[] {
    return [...this.open.values()];
  }

  filledEntries(): FilledEntry[] {
    return [...this.filled.values()];
  }

  withdrawalEntries(): WithdrawalEntry[] {
    return [...this.withdrawals.values()].sort((a, b) => (a.baseNonce < b.baseNonce ? -1 : a.baseNonce > b.baseNonce ? 1 : 0));
  }

  /** Backlog, deferred and seeking sizes, for /health. */
  queueStats(): { backlog: number; deferred: number; seekingNonces: string[] } {
    return { backlog: this.backlog.length, deferred: this.deferred.size, seekingNonces: [...this.seeking.keys()] };
  }

  /** Gas prices seen in this intent's IntentFilled / GasBumped events. */
  gasHints(key: PublicKey | string): bigint[] {
    const f = this.filled.get(typeof key === "string" ? key : key.toBase58());
    return f ? [...f.gasPrices] : [];
  }

  /** The solver's own fill, before its IntentFilled event is polled. */
  noteFilled(key: PublicKey, gasPrice?: bigint, baseNonce?: bigint): void {
    this.open.delete(key.toBase58());
    const f = this.filledEntry(key);
    if (gasPrice !== undefined) f.gasPrices.add(gasPrice);
    if (baseNonce !== undefined) {
      f.baseNonce ??= baseNonce;
      this.noteNonce(baseNonce, key.toBase58());
    }
  }

  /** Stop tracking an intent whose payout is done. */
  forget(key: PublicKey | string): void {
    const k = typeof key === "string" ? key : key.toBase58();
    this.open.delete(k);
    this.filled.delete(k);
  }

  /** Stop re-reading an open intent (expired). Leaves a filled entry alone. */
  forgetOpen(key: PublicKey | string): void {
    this.open.delete(typeof key === "string" ? key : key.toBase58());
  }

  /** Drop withdrawals and known nonces the pool has mined past. */
  forgetWithdrawalsBelow(nonce: bigint): void {
    for (const [k, w] of this.withdrawals) if (w.baseNonce < nonce) this.withdrawals.delete(k);
    for (const k of this.nonces.keys()) if (BigInt(k) < nonce) this.nonces.delete(k);
  }
}

function keyed(accts: Map<string, IntentAccount | null>, status: IntentStatus): Keyed<IntentAccount>[] {
  const out: Keyed<IntentAccount>[] = [];
  for (const [k, account] of accts) if (account?.status === status) out.push({ pubkey: new PublicKey(k), account });
  return out;
}
