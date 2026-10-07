// "Start above market" for the Dutch auction (demo option).
//
// A solver's quote is the most it will pay right now (its maxOut), and a solver
// fills as soon as required_out <= maxOut. With start_out = best quote, the
// requirement is already at the solver's price at t = 0, so the fill is
// immediate. That is expected, not a bug.
//
// Starting N bps above the best quote makes the auction visibly decay first:
//   start_out = quote × (1 + N/10_000)
//   min_out   = quote × (1 − preset tolerance)        (unchanged)
// A solver fills when required_out reaches its price, at roughly
//   t ≈ duration × N / (N + toleranceBps)
// e.g. preset "fair" (60 s, 100 bps) with N = 100 → ≈ 30 s.
// The best-priced solver crosses first, which is the competitive auction.

import { presetParams, SPEED_PRESETS, type SpeedPreset, type SpeedPresetId } from "@/lib/intents";

/** Upper bound for the premium; above this the auction just times out. */
export const MAX_START_PREMIUM_BPS = 1_000;

export function startWithPremium(quoteWei: bigint, premiumBps: number): bigint {
  if (!Number.isInteger(premiumBps) || premiumBps < 0 || premiumBps > MAX_START_PREMIUM_BPS) {
    throw new Error(`start premium must be an integer 0..${MAX_START_PREMIUM_BPS} bps`);
  }
  return (quoteWei * BigInt(10_000 + premiumBps)) / 10_000n;
}

/**
 * presetParams with an optional premium: min_out still comes from the quote,
 * only start_out is raised. premiumBps = 0 is exactly presetParams(preset, quote, now).
 */
export function presetParamsWithPremium(
  preset: SpeedPresetId | SpeedPreset,
  quoteWei: bigint,
  nowSec: bigint,
  premiumBps = 0,
): ReturnType<typeof presetParams> & { premiumBps: number; expectedFillAfterSec: number } {
  const p = presetParams(preset, quoteWei, nowSec);
  const tol = (typeof preset === "string" ? SPEED_PRESETS[preset] : preset).toleranceBps;
  return {
    ...p,
    startOutWei: startWithPremium(quoteWei, premiumBps),
    premiumBps,
    expectedFillAfterSec: premiumBps === 0 ? 0 : Math.round((p.auctionDuration * premiumBps) / (premiumBps + tol)),
  };
}
