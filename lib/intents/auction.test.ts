import { test } from "node:test";
import assert from "node:assert/strict";
import { payoutCost, requiredOut, requiredOutForIntent } from "./auction";
import { GAS_LIMIT, presetParams } from "./constants";

// Same vectors as the program's required_out unit tests.
const START = 1_000_000_000_000_000_000n;
const MIN = 900_000_000_000_000_000n;
const T0 = 1_700_000_000n;
const DUR = 120n;

test("requiredOut before and at start is start_out", () => {
  assert.equal(requiredOut(START, MIN, T0, DUR, T0 - 10n), START);
  assert.equal(requiredOut(START, MIN, T0, DUR, T0), START);
});

test("requiredOut mid-auction is linear with floor on the decay", () => {
  assert.equal(requiredOut(START, MIN, T0, DUR, T0 + 60n), 950_000_000_000_000_000n);
  // 100e15 * 1 / 120 = 833333333333333.33.. → decay floors, requirement rounds up.
  assert.equal(requiredOut(START, MIN, T0, DUR, T0 + 1n), START - 833_333_333_333_333n);
  assert.equal(requiredOut(10n, 0n, 0n, 3n, 1n), 10n - 3n); // 10*1/3 = 3.33 → 3
});

test("requiredOut at and after end is min_out", () => {
  assert.equal(requiredOut(START, MIN, T0, DUR, T0 + DUR), MIN);
  assert.equal(requiredOut(START, MIN, T0, DUR, T0 + 10_000n), MIN);
});

test("requiredOut zero duration and flat auctions", () => {
  assert.equal(requiredOut(START, MIN, T0, 0n, T0), START);
  assert.equal(requiredOut(START, MIN, T0, 0n, T0 + 1n), MIN);
  assert.equal(requiredOut(MIN, MIN, T0, DUR, T0 + 30n), MIN);
});

test("requiredOut throws where the program returns None", () => {
  const U128_MAX = (1n << 128n) - 1n;
  assert.throws(() => requiredOut(U128_MAX, 0n, T0, 4_294_967_295n, T0 + 1_000_000n));
});

test("requiredOutForIntent and payoutCost", () => {
  const intent = { startOutWei: START, minOutWei: MIN, auctionStart: T0, auctionDuration: 120 };
  assert.equal(requiredOutForIntent(intent, T0 + 60n), 950_000_000_000_000_000n);
  assert.equal(payoutCost(1_000n, 2n, 5n), 1_000n + 2n * GAS_LIMIT + 5n);
});

test("speed presets", () => {
  const fast = presetParams("fast", 1_000_000n, 100n);
  assert.deepEqual(fast, { startOutWei: 1_000_000n, minOutWei: 995_000n, auctionDuration: 30, expiresAt: 190n });
  assert.equal(presetParams("fair", 1_000_000n, 0n).minOutWei, 990_000n);
  const auction = presetParams("auction", 1_000_000n, 0n);
  assert.equal(auction.minOutWei, 980_000n);
  assert.equal(auction.expiresAt, 180n);
});
