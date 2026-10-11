// Browser Solana JSON-RPC goes through here. Public devnet endpoints rate-limit
// a page's burst of reads to 429, which left balances stuck at "Loading". This
// forwards an allowlisted set of methods to the keyed SOLANA_RPC_URL (the key
// stays on the server). getProgramAccounts, which Alchemy's free tier refuses,
// goes to keyless endpoints that serve it, behind a short cache.

import { NextResponse } from "next/server";

const KEYED = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const INDEX = [
  process.env.SOLANA_INDEX_RPC_URL || "https://solana-devnet.api.onfinality.io/public",
  "https://api.devnet.solana.com",
];

const ALLOWED = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getBlockTime",
  "getEpochInfo",
  "getFeeForMessage",
  "getGenesisHash",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTransaction",
  "getVersion",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
]);

type RpcCall = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };

// Per-IP budget: generous for one page, tight for a scraper.
const WINDOW_MS = 10_000;
const MAX_CALLS = 120;
const hits = new Map<string, { start: number; n: number }>();
function allow(ip: string, calls: number): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > WINDOW_MS) {
    if (hits.size > 5_000) hits.clear();
    hits.set(ip, { start: now, n: calls });
    return true;
  }
  h.n += calls;
  return h.n <= MAX_CALLS;
}

const gpaCache = new Map<string, { at: number; body: unknown }>();
const GPA_TTL_MS = 15_000;

async function post(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function forward(call: RpcCall): Promise<unknown> {
  if (!call || typeof call.method !== "string" || !ALLOWED.has(call.method)) {
    return rpcError(call?.id, -32601, `method not allowed: ${String(call?.method)}`);
  }
  if (call.method !== "getProgramAccounts") {
    return (await post(KEYED, call)).json ?? rpcError(call.id, -32603, "upstream error");
  }
  const key = JSON.stringify(call.params ?? null);
  const hit = gpaCache.get(key);
  if (hit && Date.now() - hit.at < GPA_TTL_MS) return { ...(hit.body as object), id: call.id };
  let last: unknown = rpcError(call.id, -32603, "no index endpoint answered");
  for (const url of INDEX) {
    try {
      const r = await post(url, call);
      const j = r.json as { error?: unknown } | null;
      if (r.status === 200 && j && !j.error) {
        if (gpaCache.size > 500) gpaCache.clear();
        gpaCache.set(key, { at: Date.now(), body: j });
        return j;
      }
      last = j ?? last;
    } catch {
      // try the next endpoint
    }
  }
  return last;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as RpcCall | RpcCall[] | null;
  if (!body) return NextResponse.json(rpcError(null, -32700, "parse error"), { status: 400 });
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > 20) return NextResponse.json(rpcError(null, -32600, "batch too large"), { status: 400 });
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  if (!allow(ip, calls.length)) {
    return NextResponse.json(rpcError(null, 429, "Too many requests, slow down"), { status: 429 });
  }
  const out = await Promise.all(calls.map(forward));
  return NextResponse.json(Array.isArray(body) ? out : out[0]);
}
