// Linear Dutch auction (HANDOVER §3.3). Mirrors programs/intents required_out:
// floor division on the decay, so the requirement rounds up by < 1 wei.

import { GAS_LIMIT } from "./constants";

const U128_MAX = (1n << 128n) - 1n;

/** Throws where the program returns None (u128 overflow, start < min). */
export function requiredOut(
  startOutWei: bigint,
  minOutWei: bigint,
  auctionStart: bigint,
  auctionDuration: bigint,
  now: bigint,
): bigint {
  if (now <= auctionStart) return startOutWei;
  const elapsed = now - auctionStart;
  if (elapsed >= auctionDuration) return minOutWei;
  const spread = startOutWei - minOutWei;
  if (spread < 0n) throw new Error("requiredOut: start_out_wei < min_out_wei");
  const product = spread * elapsed;
  if (product > U128_MAX) throw new Error("requiredOut: u128 overflow");
  return startOutWei - product / auctionDuration;
}

export function requiredOutForIntent(
  intent: {
    startOutWei: bigint;
    minOutWei: bigint;
    auctionStart: bigint;
    auctionDuration: number | bigint;
  },
  now: bigint,
): bigint {
  return requiredOut(
    intent.startOutWei,
    intent.minOutWei,
    intent.auctionStart,
    BigInt(intent.auctionDuration),
    now,
  );
}

/** What a payout debits from the solver ledger: value + gas_price·GAS_LIMIT + L1 buffer. */
export function payoutCost(valueWei: bigint, gasPrice: bigint, l1FeeBufferWei: bigint): bigint {
  return valueWei + gasPrice * GAS_LIMIT + l1FeeBufferWei;
}
