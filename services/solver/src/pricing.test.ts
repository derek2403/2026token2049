import { test } from "node:test";
import assert from "node:assert/strict";
import { GAS_LIMIT } from "../../../lib/intents";
import { parseUsd18 } from "./pyth";
import { Pricer, cpApply, cpOut, maxOutWei, virtualReserves, type QuoteCosts } from "./pricing";

const SOL = parseUsd18("150");
const ETH = parseUsd18("3000");
const ONE_ETH = 10n ** 18n;
const ONE_SOL = 10n ** 9n;
const free: QuoteCosts = { spreadBps: 0n, gasPrice: 0n, l1FeeBufferWei: 0n, solCostLamports: 0n };

test("virtual reserves price at the oracle rate (1 SOL = 0.05 ETH)", () => {
  const r = virtualReserves(SOL, ETH, ONE_ETH, 10n);
  assert.equal(r.ethWei, 10n * ONE_ETH);
  assert.equal(r.solLamports, 200n * ONE_SOL); // 10 ETH worth of SOL at 0.05 ETH/SOL
  // A tiny trade gets ~the oracle price.
  const out = cpOut(r, 1_000_000n); // 0.001 SOL
  assert.ok(out <= 50_000_000_000_000n && out > 49_999_000_000_000n, `${out}`);
});

test("constant product: bigger trades and repeated fills get worse prices", () => {
  const r = virtualReserves(SOL, ETH, ONE_ETH, 10n);
  const small = cpOut(r, ONE_SOL);
  const big = cpOut(r, 20n * ONE_SOL);
  assert.ok(big < 20n * small);
  // 20 SOL into 200 SOL / 10 ETH: 10 * 20 / 220 = 0.909… ETH
  assert.equal(big, (10n * ONE_ETH * 20n) / 220n);
  const after = cpApply(r, ONE_SOL);
  assert.ok(cpOut(after, ONE_SOL) < small);
  assert.ok(after.solLamports * after.ethWei <= r.solLamports * r.ethWei);
});

test("maxOutWei subtracts spread, Base gas, L1 buffer and SOL costs", () => {
  const r = virtualReserves(SOL, ETH, ONE_ETH, 10n);
  const gross = cpOut(r, ONE_SOL);
  assert.equal(maxOutWei(r, ONE_SOL, free), gross);
  const withSpread = maxOutWei(r, ONE_SOL, { ...free, spreadBps: 30n });
  assert.equal(withSpread, (gross * 9_970n) / 10_000n);
  const c: QuoteCosts = { spreadBps: 30n, gasPrice: 1_000_000n, l1FeeBufferWei: 20_000_000_000_000n, solCostLamports: 2_418_000n };
  const expected = (cpOut(r, ONE_SOL - 2_418_000n) * 9_970n) / 10_000n - 1_000_000n * GAS_LIMIT - 20_000_000_000_000n;
  assert.equal(maxOutWei(r, ONE_SOL, c), expected);
  // Dust that cannot cover costs quotes zero.
  assert.equal(maxOutWei(r, 2_000_000n, c), 0n);
});

test("Pricer: no inventory means not ready; fills move the curve until re-anchor", () => {
  const p = new Pricer(10n);
  assert.equal(p.ready, false);
  assert.equal(p.maxOut(ONE_SOL, free), 0n);
  p.reanchor({ solUsd18: SOL, ethUsd18: ETH, inventoryWei: 0n, atMs: 0, sources: { sol: "pyth", eth: "pyth" } });
  assert.equal(p.ready, false);
  p.reanchor({ solUsd18: SOL, ethUsd18: ETH, inventoryWei: ONE_ETH, atMs: 0, sources: { sol: "pyth", eth: "pyth" } });
  assert.equal(p.ready, true);
  assert.equal(p.oracleEthPerSol18(), ONE_ETH / 20n);
  const before = p.maxOut(ONE_SOL, free);
  p.applyFill(5n * ONE_SOL, 0n);
  assert.ok(p.maxOut(ONE_SOL, free) < before);
  p.reanchor({ solUsd18: SOL, ethUsd18: ETH, inventoryWei: ONE_ETH, atMs: 1, sources: { sol: "pyth", eth: "pyth" } });
  assert.equal(p.maxOut(ONE_SOL, free), before);
});
