// GET /api/quotes?inLamports=: fans out to every SOLVER_URLS endpoint
// (`GET <url>/quote?inLamports=`, HANDOVER §3.6) and returns the best outWei.

import type { NextRequest } from "next/server";
import type { ApiError, QuoteJson, QuotesResponse } from "@/app/lib/api-types";
import { publicError } from "@/app/lib/server/solana";

const TIMEOUT_MS = 4000;
const U64_MAX = (1n << 64n) - 1n;

const err = (error: string, status: number) => Response.json({ error } satisfies ApiError, { status });

function solverUrls(): string[] {
  return (process.env.SOLVER_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function quoteUrl(base: string, inLamports: bigint): URL {
  const u = new URL(base);
  if (!u.pathname.replace(/\/+$/, "").endsWith("/quote")) u.pathname = u.pathname.replace(/\/+$/, "") + "/quote";
  u.searchParams.set("inLamports", inLamports.toString());
  return u;
}

const isUint = (v: unknown): v is string | number =>
  (typeof v === "string" && /^\d+$/.test(v)) || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);

async function fetchQuote(base: string, inLamports: bigint): Promise<QuoteJson> {
  const url = quoteUrl(base, inLamports);
  const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  if (!resp.ok) {
    const body = (await resp.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${resp.status}`);
  }
  const q = (await resp.json()) as Record<string, unknown>;
  if (!isUint(q.outWei) || BigInt(q.outWei) === 0n) throw new Error("quote has no outWei");
  if (q.validUntil !== undefined && typeof q.validUntil === "number" && q.validUntil * 1000 < Date.now()) {
    throw new Error("quote already expired");
  }
  return {
    solver: typeof q.solver === "string" ? q.solver : url.host,
    outWei: BigInt(q.outWei).toString(),
    minOutWei: isUint(q.minOutWei) ? BigInt(q.minOutWei).toString() : undefined,
    validUntil: typeof q.validUntil === "number" ? q.validUntil : undefined,
    source: url.host,
  };
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("inLamports") ?? "";
  if (!/^\d+$/.test(raw) || BigInt(raw) === 0n || BigInt(raw) > U64_MAX) {
    return err("inLamports must be a positive u64", 400);
  }
  const inLamports = BigInt(raw);
  const urls = solverUrls();
  if (urls.length === 0) return err("No solvers configured: set SOLVER_URLS to the solver quote endpoints", 503);

  const results = await Promise.allSettled(urls.map((u) => fetchQuote(u, inLamports)));
  const quotes: QuoteJson[] = [];
  const failed: QuotesResponse["failed"] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") quotes.push(r.value);
    else {
      let source = `solver ${i + 1}`;
      try {
        source = new URL(urls[i]).host;
      } catch {}
      failed.push({ source, error: publicError(r.reason) });
    }
  });
  if (quotes.length === 0) {
    return err(`All ${urls.length} solver${urls.length > 1 ? "s" : ""} failed to quote; try again shortly`, 503);
  }
  quotes.sort((a, b) => (BigInt(b.outWei) > BigInt(a.outWei) ? 1 : BigInt(b.outWei) < BigInt(a.outWei) ? -1 : 0));
  const body: QuotesResponse = { inLamports: inLamports.toString(), best: quotes[0], quotes, failed };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
