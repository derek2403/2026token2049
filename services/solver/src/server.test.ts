import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { handleRequest, MAX_BODY_BYTES, startServer, type HttpResult, type Quote, type QuoteSource } from "./server";

function source(quote: (n: bigint) => Quote | { error: string }): QuoteSource {
  return { solver: "So1ver111", quote, health: () => ({ ok: true }) };
}

/** A source with RFQ routes that echo what they were given. */
function rfqSource(): QuoteSource & { calls: { route: string; body: unknown }[] } {
  const calls: { route: string; body: unknown }[] = [];
  return {
    ...source(() => ({ outWei: 7n, minOutWei: 6n, validUntil: 1 })),
    calls,
    rfqQuote: async (body): Promise<HttpResult> => {
      calls.push({ route: "quote", body });
      return { status: 200, body: { quote_id: "q", amount_out: "7" } };
    },
    rfqExecute: async (body): Promise<HttpResult> => {
      calls.push({ route: "execute", body });
      return { status: 409, body: { code: "vault_short" } };
    },
  };
}

test("GET /quote returns bigints as strings", async () => {
  const src = source((n) => ({ outWei: n * 50_000_000n, minOutWei: n * 49_000_000n, validUntil: 1_700_000_060 }));
  const r = await handleRequest(src, "GET", "/quote?inLamports=1000000000");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    solver: "So1ver111",
    outWei: "50000000000000000",
    minOutWei: "49000000000000000",
    validUntil: 1_700_000_060,
  });
});

test("GET /quote validates inLamports", async () => {
  const src = source(() => ({ outWei: 1n, minOutWei: 1n, validUntil: 0 }));
  for (const q of ["", "?inLamports=", "?inLamports=0", "?inLamports=-5", "?inLamports=1.5", "?inLamports=18446744073709551616"]) {
    assert.equal((await handleRequest(src, "GET", `/quote${q}`)).status, 400, q);
  }
  assert.equal((await handleRequest(src, "GET", "/quote?inLamports=18446744073709551615")).status, 200);
});

test("GET /quote is 503 when the solver cannot quote", async () => {
  const r = await handleRequest(source(() => ({ error: "no prices" })), "GET", "/quote?inLamports=5");
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { solver: "So1ver111", error: "no prices" });
});

test("health, 404, 405 and CORS preflight", async () => {
  const src = source(() => ({ error: "x" }));
  assert.deepEqual(await handleRequest(src, "GET", "/health"), { status: 200, body: { ok: true } });
  assert.equal((await handleRequest(src, "GET", "/nope")).status, 404);
  assert.equal((await handleRequest(src, "POST", "/quote?inLamports=1")).status, 405);
  assert.equal((await handleRequest(src, "OPTIONS", "/quote")).status, 204);
  // No RFQ support: the routes do not exist.
  assert.equal((await handleRequest(src, "POST", "/rfq/quote", "{}")).status, 404);
});

test("/rfq routes are POST + JSON and coexist with GET /quote and /health", async () => {
  const src = rfqSource();
  const q = await handleRequest(src, "POST", "/rfq/quote", JSON.stringify({ quote_id: "q", exact_amount_in: "5" }));
  assert.deepEqual(q, { status: 200, body: { quote_id: "q", amount_out: "7" } });
  const x = await handleRequest(src, "POST", "/rfq/execute", JSON.stringify({ quote_id: "q" }));
  assert.equal(x.status, 409);
  assert.deepEqual(src.calls, [
    { route: "quote", body: { quote_id: "q", exact_amount_in: "5" } },
    { route: "execute", body: { quote_id: "q" } },
  ]);

  assert.equal((await handleRequest(src, "GET", "/rfq/quote")).status, 405);
  assert.equal((await handleRequest(src, "POST", "/rfq/execute", "not json")).status, 400);
  assert.equal((await handleRequest(src, "POST", "/rfq/nope", "{}")).status, 405);
  assert.equal((await handleRequest(src, "GET", "/quote?inLamports=5")).status, 200);
  assert.equal((await handleRequest(src, "GET", "/health")).status, 200);
  assert.equal(src.calls.length, 2);
});

test("over HTTP: JSON bodies, CORS for POST, 413 on huge bodies", async () => {
  const src = rfqSource();
  const server = startServer(src, 0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const q = await fetch(`${base}/rfq/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quote_id: "abc", exact_amount_in: "100" }),
    });
    assert.equal(q.status, 200);
    assert.deepEqual(await q.json(), { quote_id: "q", amount_out: "7" });
    assert.deepEqual(src.calls[0], { route: "quote", body: { quote_id: "abc", exact_amount_in: "100" } });

    const pre = await fetch(`${base}/rfq/execute`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /content-type/);

    const big = await fetch(`${base}/rfq/execute`, { method: "POST", body: "x".repeat(MAX_BODY_BYTES + 1) });
    assert.equal(big.status, 413);
    assert.equal(src.calls.length, 1);

    const h = await fetch(`${base}/health`);
    assert.deepEqual(await h.json(), { ok: true });
    const g = await fetch(`${base}/quote?inLamports=3`);
    assert.equal(g.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
