// RFQ relay (NEAR's Message Bus, research §3.7): fans a quote request out to
// every solver's POST /rfq/quote, keeps the answers in memory for their TTL,
// checks the user's signed message against the chosen quote off-chain, and
// forwards it to that solver's POST /rfq/execute. The relay holds no key and
// sends no transaction: the winning solver signs and pays.

import { randomUUID, createHash } from "node:crypto";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { bytesToHex } from "@noble/hashes/utils";
import {
  INTENTS_PROGRAM_ID,
  RFQ_MAX_DEADLINE_SECS,
  decodeSignedIntent,
  intentPda,
  rfqExecuteRequest,
  type RelayPublishResponse,
  type RelayQuote,
  type RelayStatus,
  type RfqExecuteResponse,
  type RfqQuoteResponse,
} from "@/lib/intents";
import { loadPayout } from "@/app/lib/server/payout";
import { publicError, serverConnection } from "@/app/lib/server/solana";

/** After the first answer, wait this long for slower solvers (NEAR's min_wait_ms). */
export const MIN_WAIT_MS = 500;
/** Hard close of the quote window (NEAR's max_wait_ms). */
export const MAX_WAIT_MS = 3000;
/**
 * Longer than anything the solver can spend on one execute (queue wait, 60 s
 * confirmation, retries) and than the 120 s signed deadline, so the relay does
 * not give up on a trade that may still land.
 */
const EXECUTE_TIMEOUT_MS = 200_000;
/** A published intent not yet visible on-chain reads as PENDING for this long... */
const PUBLISHED_GRACE_MS = 90_000;
/** ...or until this long past its signed deadline (cluster clock lag), whichever is later. */
const DEADLINE_GRACE_MS = 90_000;
const MAX_QUOTES = 5000;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public httpStatus = 200,
    public data?: unknown,
  ) {
    super(message);
  }
}

// JSON-RPC error codes: -32602 invalid params, -32000.. server-defined.
const invalid = (msg: string) => new RpcError(-32602, msg, 400);

type StoredQuote = RelayQuote & {
  quoteId: string;
  /** Solver base URL (never returned to the browser). */
  base: string;
  amountIn: bigint;
  /** Lowercase 0x hex, when the request named one. */
  recipient?: string;
  state: "open" | "publishing" | "used";
};

type Published = { intent: string; tx: string; quoteHash: string; at: number; pendingUntil: number };

// On globalThis so dev-mode module reloads keep quotes alive.
const g = globalThis as typeof globalThis & {
  __rfqRelay?: { quotes: Map<string, StoredQuote>; published: Map<string, Published> };
};
const store = (g.__rfqRelay ??= { quotes: new Map(), published: new Map() });

function prune() {
  const now = Date.now();
  for (const [k, q] of store.quotes) if (q.expiration_time < now && q.state !== "publishing") store.quotes.delete(k);
  // No FIFO eviction: a flood must not push out quotes users hold. quote() refuses when full instead.
  for (const [k, p] of store.published) if (now - p.at > 3_600_000) store.published.delete(k);
}

/** SOLVER_URLS entries as bases: "https://x.up.railway.app/quote" → "https://x.up.railway.app". */
export function solverBases(env = process.env.SOLVER_URLS): string[] {
  return (env ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, "").replace(/\/quote$/, ""))
    .filter(Boolean);
}

const hostOf = (base: string) => {
  try {
    return new URL(base).host;
  } catch {
    return "solver";
  }
};

async function postJson<T>(url: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const out = (await resp.json().catch(() => null)) as (T & { error?: unknown; code?: unknown }) | null;
  if (!resp.ok || !out || typeof out.error === "string") {
    const msg = typeof out?.error === "string" ? out.error : `HTTP ${resp.status}`;
    throw Object.assign(new Error(msg), {
      code: typeof out?.code === "string" ? out.code : undefined,
      httpStatus: resp.status,
      body: out,
    });
  }
  return out;
}

const UINT_RE = /^(0|[1-9][0-9]*)$/;

function uint(v: unknown, name: string, max: bigint, min = 0n): bigint {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== "string" || s.length > 40 || !UINT_RE.test(s)) throw invalid(`${name} must be a decimal integer string`);
  const n = BigInt(s);
  if (n < min || n > max) throw invalid(`${name} out of range`);
  return n;
}

function recipientParam(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw invalid("recipient must be a 0x address");
  const lower = v.toLowerCase();
  if (/^0x0{40}$/.test(lower)) throw invalid("recipient is the zero address");
  return lower;
}

function quoteHash(base: string, q: RfqQuoteResponse, amountIn: bigint): string {
  const h = createHash("sha256")
    .update(JSON.stringify([base, q.quote_id, q.solver, amountIn.toString(), q.amount_out, q.expiration_time]))
    .digest();
  return bs58.encode(h);
}

function validQuote(q: unknown, quoteId: string): RfqQuoteResponse {
  const r = q as Partial<RfqQuoteResponse> | null;
  if (!r || r.quote_id !== quoteId) throw new Error("answered a different quote_id");
  if (typeof r.amount_out !== "string" || !UINT_RE.test(r.amount_out) || BigInt(r.amount_out) === 0n || BigInt(r.amount_out) > U128_MAX) {
    throw new Error("bad amount_out");
  }
  if (typeof r.expiration_time !== "number" || r.expiration_time <= Date.now()) throw new Error("quote already expired");
  if (typeof r.solver !== "string") throw new Error("no solver key");
  new PublicKey(r.solver);
  return r as RfqQuoteResponse;
}

export type QuoteParams = { exact_amount_in: unknown; recipient?: unknown };
export type QuoteResult = RelayQuote[];

/**
 * Fan out, collect for MIN_WAIT_MS after the first answer (or until every
 * solver answered), never past MAX_WAIT_MS. Best amount_out first.
 */
export async function quote(params: QuoteParams): Promise<QuoteResult> {
  const amountIn = uint(params.exact_amount_in, "exact_amount_in", U64_MAX, 1n);
  const recipient = recipientParam(params.recipient);
  const bases = solverBases();
  if (bases.length === 0) {
    throw new RpcError(-32001, "No solvers configured: set SOLVER_URLS to the solver base URLs (comma-separated)", 503);
  }
  prune();
  if (store.quotes.size + bases.length > MAX_QUOTES) {
    throw new RpcError(-32003, "Relay busy: too many open quotes, retry shortly", 503);
  }

  const quoteId = randomUUID();
  const got: StoredQuote[] = [];
  const failed: { solver: string; error: string }[] = [];
  const ctrl = new AbortController();
  await new Promise<void>((resolve) => {
    let pending = bases.length;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const hard = setTimeout(done, MAX_WAIT_MS);
    function done() {
      clearTimeout(hard);
      clearTimeout(graceTimer);
      resolve();
    }
    for (const base of bases) {
      const body = { quote_id: quoteId, exact_amount_in: amountIn.toString(), ...(recipient ? { recipient } : {}) };
      postJson<RfqQuoteResponse>(`${base}/rfq/quote`, body, MAX_WAIT_MS, ctrl.signal)
        .then((raw) => {
          const q = validQuote(raw, quoteId);
          got.push({
            quote_hash: quoteHash(base, q, amountIn),
            solver: q.solver,
            amount_out: q.amount_out,
            expiration_time: q.expiration_time,
            quoteId,
            base,
            amountIn,
            recipient,
            state: "open",
          });
          graceTimer ??= setTimeout(done, MIN_WAIT_MS);
        })
        .catch((e: unknown) => failed.push({ solver: hostOf(base), error: publicError(e) }))
        .finally(() => {
          if (--pending === 0) done();
        });
    }
  });
  ctrl.abort(); // late answers are dropped

  if (got.length === 0) {
    const why = failed.length > 0 ? failed.map((f) => `${f.solver}: ${f.error}`).join("; ") : "no answer within 3 s";
    throw new RpcError(-32002, `No solver quoted (${bases.length} asked): ${why}`, 503, { failed });
  }
  for (const q of got) store.quotes.set(q.quote_hash, q);
  got.sort((a, b) => (BigInt(b.amount_out) > BigInt(a.amount_out) ? 1 : BigInt(b.amount_out) < BigInt(a.amount_out) ? -1 : 0));
  return got.map(({ quote_hash, solver, amount_out, expiration_time }) => ({ quote_hash, solver, amount_out, expiration_time }));
}

export type PublishParams = { quote_hash: unknown; message: unknown; public_key: unknown; signature: unknown };

/**
 * Verifies the signed intent against the stored quote, then forwards it to the
 * quoting solver. The quote is single use once the solver accepts it.
 */
export async function publishIntent(p: PublishParams): Promise<RelayPublishResponse> {
  for (const k of ["quote_hash", "message", "public_key", "signature"] as const) {
    if (typeof p[k] !== "string" || p[k] === "") throw invalid(`${k} is required`);
  }
  const wire = { message: p.message as string, public_key: p.public_key as string, signature: p.signature as string };
  prune();
  const q = store.quotes.get(p.quote_hash as string);
  if (!q) throw new RpcError(-32010, "Unknown or expired quote_hash: request a new quote", 410);
  if (q.state === "used") throw new RpcError(-32011, "Quote already used", 409);
  if (q.state === "publishing") throw new RpcError(-32011, "Quote is being published", 409);
  if (q.expiration_time <= Date.now()) throw new RpcError(-32010, "Quote expired: request a new quote", 410);

  let signed;
  try {
    signed = decodeSignedIntent(wire, INTENTS_PROGRAM_ID);
  } catch (e) {
    throw new RpcError(-32012, `Invalid signed intent: ${publicError(e)}`, 400);
  }
  const f = signed.fields;
  const mismatch = (what: string) => new RpcError(-32013, `Signed intent does not match the quote: ${what}`, 400);
  if (f.sellLamports !== q.amountIn) throw mismatch(`sell ${f.sellLamports} ≠ quoted amount_in ${q.amountIn}`);
  if (f.minOutWei !== BigInt(q.amount_out)) throw mismatch(`receive at least ${f.minOutWei} ≠ quoted amount_out ${q.amount_out}`);
  if (q.recipient && `0x${bytesToHex(f.recipient)}` !== q.recipient) throw mismatch("recipient differs from the quoted one");
  if (/^0x0{40}$/.test(`0x${bytesToHex(f.recipient)}`)) throw mismatch("zero recipient");
  // Wall clock here; the program re-checks against cluster time.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (f.deadline <= nowSec) throw mismatch("deadline already passed");
  if (f.deadline > nowSec + RFQ_MAX_DEADLINE_SECS + 30n) throw mismatch(`deadline more than ${RFQ_MAX_DEADLINE_SECS} s away`);

  const want = intentPda(f.user, f.nonce, INTENTS_PROGRAM_ID)[0].toBase58();
  const remember = (tx: string) => {
    const at = Date.now();
    const pendingUntil = Math.max(at + PUBLISHED_GRACE_MS, Number(f.deadline) * 1000 + DEADLINE_GRACE_MS);
    store.published.set(want, { intent: want, tx, quoteHash: q.quote_hash, at, pendingUntil });
  };
  q.state = "publishing";
  let res: RfqExecuteResponse;
  try {
    res = await postJson<RfqExecuteResponse>(`${q.base}/rfq/execute`, rfqExecuteRequest(q.quoteId, f, wire), EXECUTE_TIMEOUT_MS);
  } catch (e) {
    if (outcomeUnknown(e)) {
      // It may still land: never reopen the quote, and hand back the intent to track.
      q.state = "used";
      const sig = (e as { body?: { signature?: unknown } }).body?.signature;
      const tx = typeof sig === "string" ? sig : "";
      remember(tx);
      return { intent: want, tx, pending: true };
    }
    q.state = "open"; // the solver refused before sending: the quote may be retried until it expires
    const code = (e as { code?: string }).code;
    throw new RpcError(-32020, `Solver ${hostOf(q.base)} did not settle: ${publicError(e)}`, 502, code ? { solver_code: code } : undefined);
  }
  q.state = "used";
  if (res.intent !== want) throw new RpcError(-32021, `Solver returned intent ${res.intent}, expected ${want}`, 502);
  remember(res.signature);
  return { intent: want, tx: res.signature };
}

/** Network codes that prove the request never reached the solver. */
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * True when the solver may have sent execute_signed_intent: it said
 * "unconfirmed" (504), a proxy answered for it (502), a 2xx came back
 * unreadable, or no HTTP answer came back at all (timeout, dropped connection)
 * for a request that reached it. Every other solver answer is a refusal made
 * before sending.
 */
function outcomeUnknown(e: unknown): boolean {
  const err = e as { code?: string; httpStatus?: number; cause?: { code?: string } };
  const st = err.httpStatus;
  if (st !== undefined) return st === 502 || st === 504 || err.code === "unconfirmed" || (st >= 200 && st < 300);
  return !NOT_SENT.has(err.cause?.code ?? "");
}

export type StatusResult = {
  intent: string;
  status: RelayStatus;
  /** The drawer's finer-grained status (open, matched, signing, signed, broadcast, completed, ...). */
  order_status?: string;
  /** execute_signed_intent tx, when this relay published it. */
  tx?: string;
  /** Base payout tx, once mined. */
  base_tx?: string;
};

/** NEAR's get_status, derived from the same status machine as /api/payout. */
export async function getStatus(params: { intent?: unknown; intent_hash?: unknown }): Promise<StatusResult> {
  const raw = params.intent ?? params.intent_hash;
  let address: PublicKey;
  try {
    address = new PublicKey(typeof raw === "string" ? raw : "");
  } catch {
    throw invalid("intent must be a base58 account address");
  }
  const intent = address.toBase58();
  const pub = store.published.get(intent);
  const r = await loadPayout(serverConnection(), address);
  if (!r.ok) {
    if (r.status === 400) return { intent, status: "NOT_FOUND_OR_NOT_VALID" };
    if (r.status !== 404) throw new RpcError(-32030, r.error, 502);
    const recent = pub && Date.now() < pub.pendingUntil;
    return { intent, status: recent ? "PENDING" : "NOT_FOUND_OR_NOT_VALID", tx: pub?.tx };
  }
  const s = r.body.status;
  const status: RelayStatus =
    s === "completed"
      ? "SETTLED"
      : s === "broadcast"
        ? "TX_BROADCASTED"
        : s === "reverted" || s === "cancelled" || s === "expired"
          ? "NOT_FOUND_OR_NOT_VALID"
          : "PENDING";
  return {
    intent,
    status,
    order_status: s,
    tx: pub?.tx ?? r.body.steps.find((x) => x.id === "open")?.txHash,
    base_tx: r.body.delivered?.txHash,
  };
}
