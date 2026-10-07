// Quote and health endpoints (HANDOVER §3.6 step 4). The page's /api/quotes
// fans out to these. Bigints are sent as decimal strings.

import { createServer, type Server } from "node:http";

export type Quote = { outWei: bigint; minOutWei: bigint; validUntil: number };

export interface QuoteSource {
  solver: string;
  /** `{ error }` when the solver cannot quote right now (no prices or no inventory). */
  quote(inLamports: bigint): Quote | { error: string };
  health(): Record<string, unknown>;
}

export type HttpResult = { status: number; body: unknown };

const U64_MAX = (1n << 64n) - 1n;

export function handleRequest(src: QuoteSource, method: string, rawUrl: string): HttpResult {
  if (method === "OPTIONS") return { status: 204, body: null };
  if (method !== "GET") return { status: 405, body: { error: "method not allowed" } };
  const url = new URL(rawUrl, "http://localhost");

  if (url.pathname === "/health") return { status: 200, body: src.health() };

  if (url.pathname === "/quote") {
    const s = url.searchParams.get("inLamports") ?? "";
    if (!/^\d{1,20}$/.test(s) || BigInt(s) === 0n || BigInt(s) > U64_MAX) {
      return { status: 400, body: { error: "inLamports must be a positive u64 integer" } };
    }
    const q = src.quote(BigInt(s));
    if ("error" in q) return { status: 503, body: { solver: src.solver, error: q.error } };
    return {
      status: 200,
      body: {
        solver: src.solver,
        outWei: q.outWei.toString(),
        minOutWei: q.minOutWei.toString(),
        validUntil: q.validUntil,
      },
    };
  }
  return { status: 404, body: { error: "not found" } };
}

export function startServer(src: QuoteSource, port: number): Server {
  const server = createServer((req, res) => {
    let result: HttpResult;
    try {
      result = handleRequest(src, req.method ?? "GET", req.url ?? "/");
    } catch (e) {
      result = { status: 500, body: { error: e instanceof Error ? e.message : String(e) } };
    }
    res.writeHead(result.status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "cache-control": "no-store",
    });
    res.end(result.body === null ? "" : JSON.stringify(result.body));
  });
  server.listen(port);
  return server;
}
