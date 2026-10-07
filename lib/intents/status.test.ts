import { test } from "node:test";
import assert from "node:assert/strict";
import { IntentStatus } from "./constants";
import { buildCandidates, type EthReceipt } from "./payout";
import { formatEth, intentStatus, type StatusResult } from "./status";
import { filledIntent, openIntent, sigRequestsFor } from "./testutil";

const NO_RECEIPTS = new Map<string, EthReceipt | null>();
const states = (r: StatusResult) => r.steps.map((s) => `${s.id}:${s.state}`);

test("open: required amount and countdowns", () => {
  const intent = openIntent(); // start 1e15, min 0.99e15, 60 s auction, expires +120
  const r = intentStatus({ intent, sigRequests: [], receipts: NO_RECEIPTS, now: intent.auctionStart + 30n });
  assert.equal(r.status, "open");
  assert.equal(r.requiredOutWei, 995_000_000_000_000n);
  assert.equal(r.auctionEndsIn, 30);
  assert.equal(r.expiresIn, 90);
  assert.deepEqual(states(r), ["open:active", "matched:todo", "signing:todo", "signed:todo", "broadcast:todo", "completed:todo"]);
  assert.equal(r.steps[0].timestamp, Number(intent.auctionStart) * 1000);
});

test("expired: from expires_at itself (fill needs now < expires_at)", () => {
  const intent = openIntent();
  const before = intentStatus({ intent, sigRequests: [], receipts: NO_RECEIPTS, now: intent.expiresAt - 1n });
  assert.equal(before.status, "open");
  assert.equal(before.auctionEndsIn, 0);
  const r = intentStatus({ intent, sigRequests: [], receipts: NO_RECEIPTS, now: intent.expiresAt });
  assert.equal(r.status, "expired");
  assert.deepEqual(states(r), ["open:done", "expired:active", "cancelled:todo"]);
});

test("cancelled", () => {
  const intent = openIntent({ status: IntentStatus.Cancelled });
  const r = intentStatus({
    intent,
    sigRequests: [],
    receipts: NO_RECEIPTS,
    now: intent.expiresAt + 100n,
    refs: { cancelled: { txHash: "5sig", timestamp: Number(intent.auctionStart) * 1000 + 5_000 } },
  });
  assert.equal(r.status, "cancelled");
  assert.deepEqual(states(r), ["open:done", "cancelled:done"]);
  assert.equal(r.steps[1].txHash, "5sig");
  assert.equal(r.steps[1].elapsedMs, 5_000);
});

test("filled → matched → signing → signed → broadcast → completed", () => {
  const prices = [1_000_000n];
  const intent = filledIntent(prices);
  const now = intent.filledAt + 5n;

  const matched = intentStatus({ intent, sigRequests: [null], receipts: NO_RECEIPTS, now });
  assert.equal(matched.status, "matched");
  assert.equal(matched.surplusWei, 5_000_000_000_000n);
  assert.equal(matched.steps[1].elapsedMs, 30_000); // auction_start → filled_at

  const pending = sigRequestsFor(intent, prices, [false]);
  const signing = intentStatus({ intent, sigRequests: pending, receipts: NO_RECEIPTS, now });
  assert.equal(signing.status, "signing");
  assert.equal(signing.steps[2].timestamp, Number(intent.filledAt) * 1000); // expires_at − 300

  const done = sigRequestsFor(intent, prices, [true]);
  const broadcast = intentStatus({ intent, sigRequests: done, receipts: NO_RECEIPTS, now });
  assert.equal(broadcast.status, "broadcast");
  assert.equal(broadcast.speedingUp, false);
  const hash = broadcast.candidates[0].signed!.txHash;
  assert.equal(broadcast.steps[4].txHash, hash);
  assert.equal(broadcast.steps[4].chain, "base");
  assert.deepEqual(states(broadcast), ["open:done", "matched:done", "signing:done", "signed:done", "broadcast:active", "completed:todo"]);

  const receipts = new Map([[hash, { txHash: hash, status: 1 as const, blockNumber: 5n, gasUsed: 21000n, effectiveGasPrice: null }]]);
  const completed = intentStatus({ intent, sigRequests: done, receipts, now });
  assert.equal(completed.status, "completed");
  assert.equal(completed.delivered!.txHash, hash);
  assert.equal(completed.steps[5].txHash, hash);
  assert.equal(completed.steps[5].state, "done");
  assert.match(completed.steps[5].label, /Received 0\.000995 ETH \(\+0\.000005 above minimum\)/);
});

test("signed but not rebuildable (bumped gas price unknown) stays 'signed'", () => {
  const prices = [1_000_000n, 1_100_000n];
  const intent = filledIntent(prices);
  const srs = sigRequestsFor(intent, prices, [true, false]);
  const r = intentStatus({ intent, sigRequests: srs, receipts: NO_RECEIPTS, now: intent.filledAt + 40n });
  assert.equal(r.status, "signed");
  assert.equal(r.speedingUp, true);
});

test("after a bump, a receipt for the ORIGINAL payout completes the order", () => {
  const prices = [1_000_000n, 1_100_000n];
  const intent = filledIntent(prices);
  const srs = sigRequestsFor(intent, prices, [true, true]);
  const candidates = buildCandidates(intent, srs, { gasPriceHints: prices });
  const h0 = candidates[0].signed!.txHash;

  const pending = intentStatus({ intent, sigRequests: srs, candidates, receipts: NO_RECEIPTS, now: intent.filledAt + 40n });
  assert.equal(pending.status, "broadcast");
  assert.equal(pending.steps[4].txHash, candidates[1].signed!.txHash); // newest shown while pending
  assert.match(pending.steps[4].label, /Speeding up/);

  const receipts = new Map([[h0, { txHash: h0, status: 1 as const, blockNumber: 5n, gasUsed: 21000n, effectiveGasPrice: null }]]);
  const r = intentStatus({ intent, sigRequests: srs, candidates, receipts, now: intent.filledAt + 50n });
  assert.equal(r.status, "completed");
  assert.equal(r.delivered!.index, 0);
  assert.equal(r.steps[5].txHash, h0);
});

test("receipt status 0 → reverted", () => {
  const prices = [1_000_000n];
  const intent = filledIntent(prices);
  const srs = sigRequestsFor(intent, prices, [true]);
  const h = buildCandidates(intent, srs)[0].signed!.txHash;
  const receipts = new Map([[h, { txHash: h, status: 0 as const, blockNumber: 5n, gasUsed: 21000n, effectiveGasPrice: null }]]);
  const r = intentStatus({ intent, sigRequests: srs, receipts, now: intent.filledAt + 10n });
  assert.equal(r.status, "reverted");
  assert.equal(r.steps[5].state, "failed");
});

test("formatEth", () => {
  assert.equal(formatEth(10n ** 18n), "1");
  assert.equal(formatEth(1_234_567_000_000_000_000n), "1.234567");
  assert.equal(formatEth(995_000_000_000_000n), "0.000995");
  assert.equal(formatEth(0n), "0");
  assert.equal(formatEth(1n), "<0.000001");
  assert.equal(formatEth(-(10n ** 18n) / 2n), "-0.5");
});
