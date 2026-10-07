// Quote, RFQ and health endpoints (HANDOVER §3.6 step 4). The page's /api/quotes
// fans out to GET /quote; the relay's /api/rfq to POST /rfq/quote and
// /rfq/execute (rfq.ts). Bigints are sent as decimal strings.

import { createServer, type Server } from "node:http";

export type Quote = { outWei: bigint; minOutWei: bigint; validUntil: number };

export interface QuoteSource {
  solver: string;
  /** `{ error }` when the solver cannot quote right now (no prices or no inventory). */
  quote(inLamports: bigint): Quote | { error: string };
  health(): Record<string, unknown>;
  /** POST /rfq/quote with the parsed JSON body. */
  rfqQuote?(body: unknown): Promise<HttpResult>;
  /** POST /rfq/execute with the parsed JSON body. */
  rfqExecute?(body: unknown): Promise<HttpResult>;
}

export type HttpResult = { status: number; body: unknown };

const U64_MAX = (1n << 64n) - 1n;
/** A signed intent is well under 2 KB; anything near this is not one. */
export const MAX_BODY_BYTES = 16 * 1024;

/** `body` is the raw request body (POST only); invalid JSON is a 400. */
export async function handleRequest(src: QuoteSource, method: string, rawUrl: string, body?: string): Promise<HttpResult> {
  if (method === "OPTIONS") return { status: 204, body: null };
  const url = new URL(rawUrl, "http://localhost");

  const rfq = url.pathname === "/rfq/quote" ? src.rfqQuote : url.pathname === "/rfq/execute" ? src.rfqExecute : undefined;
  if (url.pathname === "/rfq/quote" || url.pathname === "/rfq/execute") {
    if (!rfq) return { status: 404, body: { error: "not found" } };
    if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };
    let json: unknown;
    try {
      json = JSON.parse(body ?? "");
    } catch {
      return { status: 400, body: { code: "bad_request", error: "body must be JSON" } };
    }
    return rfq.call(src, json);
  }

  if (method !== "GET") return { status: 405, body: { error: "method not allowed" } };

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
    const reply = (result: HttpResult) => {
      res.writeHead(result.status, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "cache-control": "no-store",
      });
      res.end(result.body === null ? "" : JSON.stringify(result.body));
    };
    const method = req.method ?? "GET";
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        // The rest is read and dropped; the reply goes out now.
        res.setHeader("connection", "close");
        reply({ status: 413, body: { error: `body over ${MAX_BODY_BYTES} bytes` } });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) return;
      const body = method === "POST" ? Buffer.concat(chunks).toString("utf8") : undefined;
      handleRequest(src, method, req.url ?? "/", body)
        .catch((e): HttpResult => ({ status: 500, body: { error: e instanceof Error ? e.message : String(e) } }))
        .then(reply);
    });
  });
  server.listen(port);
  return server;
}
