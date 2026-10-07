// RFQ-lite, NEAR Intents style: POST /rfq/quote binds a price to a quote_id and
// an amount for QUOTE_TTL_MS; POST /rfq/execute takes the user's signed message
// for that quote, checks it off-chain (re-rendered, ed25519, against the quote,
// the vault and the ledger) and settles it with execute_signed_intent, the
// solver signing and paying. Delivery is the normal Filled-intent path.

import type { Program } from "@coral-xyz/anchor";
import { type Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  RFQ_MAX_DEADLINE_SECS,
  configPda,
  decodeConfig,
  decodeSignedIntent,
  decodeSolver,
  decodeUserVault,
  intentPda,
  payoutCost,
  renderIntentMessage,
  solanaExplorerTx,
  solverPda,
  vaultPda,
  type IntentMessageFields,
  type RfqExecuteResponse,
  type RfqQuoteResponse,
} from "../../../lib/intents";
import { buildExecuteTx, decodeClockUnixTimestamp, FILL_COMPUTE_UNITS, sendIxs, TxError } from "./chain";
import type { HttpResult } from "./server";

/** What the solver's pricing offers for `inLamports` right now. */
export type RfqPrice =
  | {
      /** The quote: spread, Base gas, L1 buffer and every SOL cost taken off. */
      outWei: bigint;
      /** The same with no spread: paying more than this loses money. */
      breakEvenWei: bigint;
      gasPrice: bigint;
    }
  | { error: string };

export type RfqExecuted = {
  signature: string;
  intent: PublicKey;
  sigRequest: PublicKey;
  unsignedRlp: Uint8Array;
  baseNonce: bigint;
  gasPrice: bigint;
  outWei: bigint;
  sellLamports: bigint;
};

export type RfqDeps = {
  conn: Connection;
  program: Program;
  keypair: Keypair;
  programId: PublicKey;
  price(inLamports: bigint): RfqPrice;
  /** false: the recipient has code; "retry": Base could not be asked. */
  recipientOk(recipient: Uint8Array): Promise<boolean | "retry">;
  /** Runs `fn` with no other nonce-taking submission of this bot in flight. Default: the desk's own queue. */
  serial?<T>(fn: () => Promise<T>): Promise<T>;
  onExecuted?(e: RfqExecuted): void;
  quoteTtlMs?: number;
  priorityMicroLamports?: number;
  /** Wall clock for quote expiry (tests). */
  now?: () => number;
  log?: (msg: string) => void;
};

type StoredQuote = {
  inLamports: bigint;
  amountOut: bigint;
  /** Lowercase 0x hex when the quote asked for one. */
  recipient?: string;
  expiresAtMs: number;
  state: "open" | "executing" | "used";
};

export const DEFAULT_QUOTE_TTL_MS = 30_000;
/** A deadline closer than this to cluster time may pass before the transaction lands. */
export const MIN_DEADLINE_MARGIN_SEC = 5n;
const MAX_QUOTES = 10_000;
const NONCE_RETRIES = 3;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

const QUOTE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const INT_RE = /^(0|-?[1-9][0-9]*)$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

class BadRequest extends Error {}

const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): HttpResult => ({
  status,
  body: { code, error, ...extra },
});

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function obj(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body must be a JSON object");
  return body as Record<string, unknown>;
}

function str(o: Record<string, unknown>, name: string, re?: RegExp): string {
  const v = o[name];
  if (typeof v !== "string" || (re && !re.test(v))) throw new BadRequest(`${name} is missing or malformed`);
  return v;
}

function int(o: Record<string, unknown>, name: string, lo: bigint, hi: bigint, re = UINT_RE): bigint {
  const s = str(o, name, re);
  if (s.length > 40) throw new BadRequest(`${name} out of range`);
  const v = BigInt(s);
  if (v < lo || v > hi) throw new BadRequest(`${name} out of range`);
  return v;
}

function recipientOf(o: Record<string, unknown>, name: string): Uint8Array {
  const r = hexToBytes(str(o, name, ADDR_RE).slice(2).toLowerCase());
  if (r.every((b) => b === 0)) throw new BadRequest(`${name} is the zero address`);
  return r;
}

function pubkey(o: Record<string, unknown>, name: string): PublicKey {
  const s = str(o, name);
  try {
    const k = new PublicKey(s);
    if (k.toBase58() === s) return k;
  } catch {
    // fall through
  }
  throw new BadRequest(`${name} is not a base58 public key`);
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export class RfqDesk {
  private readonly quotes = new Map<string, StoredQuote>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  readonly solver: string;
  readonly stats = { quotes: 0, executed: 0, refused: 0 };

  constructor(private readonly d: RfqDeps) {
    this.ttlMs = d.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((m) => console.log(`${new Date().toISOString()} ${m}`));
    this.solver = d.keypair.publicKey.toBase58();
  }

  /** Quotes held (open, executing or used) until they expire. */
  get size(): number {
    return this.quotes.size;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.d.serial) return this.d.serial(fn);
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private prune(): void {
    const now = this.now();
    for (const [k, q] of this.quotes) if (q.expiresAtMs < now && q.state !== "executing") this.quotes.delete(k);
    // No FIFO eviction: a flood must not push out live quotes. quote() refuses when full instead.
  }

  // ------------------------------------------------------------ POST /rfq/quote

  async quote(body: unknown): Promise<HttpResult> {
    let quoteId: string, inLamports: bigint, recipient: Uint8Array | undefined;
    try {
      const o = obj(body);
      quoteId = str(o, "quote_id", QUOTE_ID_RE);
      inLamports = int(o, "exact_amount_in", 1n, U64_MAX);
      recipient = o.recipient === undefined || o.recipient === null ? undefined : recipientOf(o, "recipient");
    } catch (e) {
      if (e instanceof BadRequest) return fail(400, "bad_request", e.message);
      throw e;
    }
    this.prune();
    // A quote_id is bound once: a second request cannot rebind it to another amount.
    if (this.quotes.has(quoteId)) return fail(409, "quote_id_taken", "quote_id already used");
    if (this.quotes.size >= MAX_QUOTES) return fail(503, "busy", "too many open quotes, retry shortly");
    const p = this.d.price(inLamports);
    if ("error" in p) return fail(503, "cannot_quote", p.error, { solver: this.solver });
    if (recipient) {
      const ok = await this.d.recipientOk(recipient);
      if (ok === "retry") return fail(503, "recipient_check_unavailable", "cannot check the recipient on Base right now");
      if (!ok) return fail(400, "recipient_has_code", "recipient has code: a 21000-gas payout would revert");
    }
    const expiresAtMs = this.now() + this.ttlMs;
    this.quotes.set(quoteId, {
      inLamports,
      amountOut: p.outWei,
      recipient: recipient && `0x${bytesToHex(recipient)}`,
      expiresAtMs,
      state: "open",
    });
    this.stats.quotes++;
    const res: RfqQuoteResponse = {
      quote_id: quoteId,
      solver: this.solver,
      amount_out: p.outWei.toString(),
      expiration_time: expiresAtMs,
    };
    return { status: 200, body: res };
  }

  // ------------------------------------------------------------ POST /rfq/execute

  async execute(body: unknown): Promise<HttpResult> {
    const r = await this.executeInner(body);
    if (r.status !== 200) {
      this.stats.refused++;
      const b = r.body as { code?: string; error?: string };
      this.log(`rfq execute refused (${r.status} ${b.code}): ${b.error}`);
    }
    return r;
  }

  private async executeInner(body: unknown): Promise<HttpResult> {
    let quoteId: string;
    let f: IntentMessageFields;
    let signature: Uint8Array;
    try {
      const o = obj(body);
      quoteId = str(o, "quote_id", QUOTE_ID_RE);
      // The fields the caller says it signed, rendered here and compared byte for byte.
      f = {
        user: pubkey(o, "user"),
        nonce: int(o, "nonce", 0n, U64_MAX),
        deadline: int(o, "deadline", I64_MIN, I64_MAX, INT_RE),
        sellLamports: int(o, "sell_lamports", 1n, U64_MAX),
        minOutWei: int(o, "min_out_wei", 1n, U128_MAX),
        recipient: recipientOf(o, "recipient"),
      };
      const wire = { message: str(o, "message"), public_key: str(o, "public_key"), signature: str(o, "signature") };
      let signed;
      try {
        signed = decodeSignedIntent(wire, this.d.programId);
      } catch (e) {
        return fail(400, "invalid_signed_intent", errMsg(e));
      }
      if (!sameBytes(renderIntentMessage(f, this.d.programId), signed.message)) {
        return fail(400, "message_mismatch", "message does not match the intent fields");
      }
      signature = signed.signature;
    } catch (e) {
      if (e instanceof BadRequest) return fail(400, "bad_request", e.message);
      throw e;
    }

    const q = this.quotes.get(quoteId);
    if (!q) return fail(404, "unknown_quote", "no such quote from this solver");
    if (this.now() > q.expiresAtMs) return fail(410, "quote_expired", "quote expired");
    if (q.state !== "open") return fail(409, "quote_used", q.state === "used" ? "quote already executed" : "quote is being executed");
    if (f.sellLamports !== q.inLamports) {
      return fail(409, "amount_mismatch", `signed sell ${f.sellLamports} lamports, quoted ${q.inLamports}`);
    }
    if (q.recipient && q.recipient !== `0x${bytesToHex(f.recipient)}`) {
      return fail(409, "recipient_mismatch", "signed recipient differs from the quoted one");
    }
    if (f.minOutWei > q.amountOut) {
      return fail(409, "min_out_above_quote", `signed min_out ${f.minOutWei} wei > quoted ${q.amountOut}`);
    }

    q.state = "executing";
    try {
      const r = await this.serial(() => this.settle(quoteId, q, f, signature));
      // 504 "unconfirmed": sent, and it may still land, so the quote is never reopened.
      q.state = r.status === 200 || r.status === 504 ? "used" : "open";
      return r;
    } catch (e) {
      q.state = "open";
      return fail(500, "internal", errMsg(e));
    }
  }

  /** Inside the bot's submission queue: fresh chain state, the last checks, then the transaction. */
  private async settle(quoteId: string, q: StoredQuote, f: IntentMessageFields, signature: Uint8Array): Promise<HttpResult> {
    const pid = this.d.programId;
    const me = this.d.keypair.publicKey;
    const [intent] = intentPda(f.user, f.nonce, pid);
    const [clockInfo, cfgInfo, solverInfo, vaultInfo, intentInfo] = await this.d.conn.getMultipleAccountsInfo([
      SYSVAR_CLOCK_PUBKEY,
      configPda(pid)[0],
      solverPda(me, pid)[0],
      vaultPda(f.user, pid)[0],
      intent,
    ]);
    if (!clockInfo || !cfgInfo || !solverInfo) return fail(503, "chain_unavailable", "cannot read Clock, Config or Solver");
    let config = decodeConfig(cfgInfo.data);
    const ledger = decodeSolver(solverInfo.data);
    const now = decodeClockUnixTimestamp(clockInfo.data);

    if (config.paused) return fail(503, "paused", "intents program is paused");
    if (intentInfo) return fail(409, "already_executed", `intent ${intent.toBase58()} already exists`, { intent: intent.toBase58() });
    if (f.deadline < now + MIN_DEADLINE_MARGIN_SEC) return fail(409, "deadline_passed", `deadline ${f.deadline} is past or too close (cluster time ${now})`);
    if (f.deadline > now + RFQ_MAX_DEADLINE_SECS) return fail(400, "deadline_too_far", `deadline more than ${RFQ_MAX_DEADLINE_SECS} s ahead`);
    const vaultSol = vaultInfo ? decodeUserVault(vaultInfo.data).sol : 0n;
    if (vaultSol < f.sellLamports) {
      return fail(409, "vault_short", `vault holds ${vaultSol} lamports, intent sells ${f.sellLamports}`, { vault_lamports: vaultSol.toString() });
    }

    const p = this.d.price(f.sellLamports);
    if ("error" in p) return fail(503, "cannot_quote", p.error);
    const outWei = q.amountOut;
    if (p.breakEvenWei < outWei) return fail(409, "price_moved", "the quote is no longer profitable at current prices and gas");
    const cost = payoutCost(outWei, p.gasPrice, config.l1FeeBufferWei);
    if (ledger.balanceWei < cost) return fail(503, "insufficient_inventory", `ledger ${ledger.balanceWei} wei < payout cost ${cost}`);
    const ok = await this.d.recipientOk(f.recipient);
    if (ok === "retry") return fail(503, "recipient_check_unavailable", "cannot check the recipient on Base right now");
    if (!ok) return fail(400, "recipient_has_code", "recipient has code: a 21000-gas payout would revert");

    let nonce = config.nextNonce;
    for (let attempt = 0; attempt < NONCE_RETRIES; attempt++) {
      const built = await buildExecuteTx(
        this.d.program,
        me,
        { ...f, outWei, expectedNonce: nonce, gasPrice: p.gasPrice },
        signature,
        { computeUnits: FILL_COMPUTE_UNITS, priorityMicroLamports: this.d.priorityMicroLamports },
      );
      const t0 = this.now();
      try {
        const sig = await sendIxs(this.d.conn, this.d.keypair, built.ixs, pid);
        this.stats.executed++;
        this.d.onExecuted?.({
          signature: sig,
          intent: built.intent,
          sigRequest: built.sigRequest,
          unsignedRlp: built.unsignedRlp,
          baseNonce: nonce,
          gasPrice: p.gasPrice,
          outWei,
          sellLamports: f.sellLamports,
        });
        this.log(
          `RFQ EXECUTED ${quoteId}: ${f.sellLamports} lamports from ${f.user.toBase58()} → ${outWei} wei to 0x${bytesToHex(f.recipient)} at nonce ${nonce}, ${this.now() - t0} ms ${solanaExplorerTx(sig)}`,
        );
        const res: RfqExecuteResponse & { out_wei: string; base_nonce: string } = {
          signature: sig,
          intent: built.intent.toBase58(),
          out_wei: outWei.toString(),
          base_nonce: nonce.toString(),
        };
        return { status: 200, body: res };
      } catch (e) {
        const name = e instanceof TxError ? e.errorName : undefined;
        if (name === "NonceMoved") {
          const info = await this.d.conn.getAccountInfo(configPda(pid)[0]);
          if (!info) break;
          config = decodeConfig(info.data);
          nonce = config.nextNonce;
          this.log(`rfq ${quoteId}: nonce moved, retrying at ${nonce}`);
          continue;
        }
        // Sent but unconfirmed: it may still land, and the Intent PDA stops a second one.
        if (e instanceof TxError && e.signature && /not confirmed in time/.test(e.message)) {
          return fail(504, "unconfirmed", errMsg(e), { signature: e.signature, intent: built.intent.toBase58() });
        }
        return fail(409, name ? `program_${name}` : "send_failed", errMsg(e).slice(0, 300), name ? { program_error: name } : {});
      }
    }
    return fail(503, "nonce_contention", `the pool nonce kept moving (${NONCE_RETRIES} tries)`);
  }
}
