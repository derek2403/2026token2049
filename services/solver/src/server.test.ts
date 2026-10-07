import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest, type Quote, type QuoteSource } from "./server";

function source(quote: (n: bigint) => Quote | { error: string }): QuoteSource {
  return { solver: "So1ver111", quote, health: () => ({ ok: true }) };
}

test("GET /quote returns bigints as strings", () => {
  const src = source((n) => ({ outWei: n * 50_000_000n, minOutWei: n * 49_000_000n, validUntil: 1_700_000_060 }));
  const r = handleRequest(src, "GET", "/quote?inLamports=1000000000");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    solver: "So1ver111",
    outWei: "50000000000000000",
    minOutWei: "49000000000000000",
    validUntil: 1_700_000_060,
  });
});

test("GET /quote validates inLamports", () => {
  const src = source(() => ({ outWei: 1n, minOutWei: 1n, validUntil: 0 }));
  for (const q of ["", "?inLamports=", "?inLamports=0", "?inLamports=-5", "?inLamports=1.5", "?inLamports=18446744073709551616"]) {
    assert.equal(handleRequest(src, "GET", `/quote${q}`).status, 400, q);
  }
  assert.equal(handleRequest(src, "GET", "/quote?inLamports=18446744073709551615").status, 200);
});

test("GET /quote is 503 when the solver cannot quote", () => {
  const r = handleRequest(source(() => ({ error: "no prices" })), "GET", "/quote?inLamports=5");
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { solver: "So1ver111", error: "no prices" });
});

test("health, 404, 405 and CORS preflight", () => {
  const src = source(() => ({ error: "x" }));
  assert.deepEqual(handleRequest(src, "GET", "/health"), { status: 200, body: { ok: true } });
  assert.equal(handleRequest(src, "GET", "/nope").status, 404);
  assert.equal(handleRequest(src, "POST", "/quote?inLamports=1").status, 405);
  assert.equal(handleRequest(src, "OPTIONS", "/quote").status, 204);
});
