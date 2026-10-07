// Shared constants for SODA Intents (HANDOVER §1.2, §3.3, §5.2).

import { PublicKey } from "@solana/web3.js";
import { hexToBytes } from "@noble/hashes/utils";

export const DEFAULT_INTENTS_PROGRAM_ID = "BV9KfzKwXPp9hQZEyhoVm9STbDy7gCGCmKcKpCDr8jXA";
export const DEFAULT_SODA_PROGRAM_ID = "CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J";

// Literal process.env.NEXT_PUBLIC_* reads so Next.js inlines them client-side.
export const INTENTS_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_INTENTS_PROGRAM_ID ||
    process.env.INTENTS_PROGRAM_ID ||
    DEFAULT_INTENTS_PROGRAM_ID,
);

export const SODA_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_SODA_PROGRAM_ID || DEFAULT_SODA_PROGRAM_ID,
);

/** soda Committee PDA (seeds ["committee"] under soda). */
export const COMMITTEE_PDA = new PublicKey("9mX3oHUmsrYvzXjCo35HhfXufrGZT3hjsLoC74xbA6SS");

/** Committee group_pk as of 2026-10-07. The page should prefer /api/group-pk (live). */
export const GROUP_PK_HEX = "039e4c1ac3a50367eefb5d05d1a18620037b20f2f52fc434bb7c7363081e21c5c5";
export const GROUP_PK: Uint8Array = hexToBytes(GROUP_PK_HEX);

/** Base Sepolia. */
export const CHAIN_ID = 84532n;
/** Plain ETH transfer, empty calldata. */
export const GAS_LIMIT = 21000n;
/** Intent.sig_requests capacity: the original payout plus up to 3 gas bumps. */
export const MAX_SIG_REQUESTS = 4;
/** soda sets SigRequest.expires_at = request time + 300; the committee never signs after. */
export const SIG_REQUEST_TTL_SEC = 300n;
/**
 * An unsigned SigRequest this long past expires_at is "dead": bump_gas may reuse
 * its slot once all MAX_SIG_REQUESTS are taken (pass it as a remaining account).
 */
export const DEAD_SIG_REQUEST_AFTER_SEC = 60n;
/** close_intent on a filled intent (admin only) is allowed once now > filled_at + this. */
export const CLOSE_AFTER_FILL_SEC = 600n;
/** bump_gas by anyone (not just the filling solver) once now > filled_at + this. */
export const OPEN_BUMP_AFTER_SEC = 60n;
/** The filling solver bumps its own payout after this long unmined. */
export const SELF_BUMP_AFTER_SEC = 30n;

/** Minimum gas price bump_gas accepts: gas_price * 110 / 100 (floor, as on-chain). */
export function minBumpGasPrice(gasPrice: bigint): bigint {
  return (gasPrice * 110n) / 100n;
}

export enum IntentStatus {
  Open = 0,
  Filled = 1,
  Cancelled = 2,
}

export type SpeedPresetId = "fast" | "fair" | "auction";

export type SpeedPreset = {
  id: SpeedPresetId;
  label: string;
  durationSec: number;
  /** min_out = start_out * (10_000 - toleranceBps) / 10_000 */
  toleranceBps: number;
};

export const SPEED_PRESETS: Record<SpeedPresetId, SpeedPreset> = {
  fast: { id: "fast", label: "Fast", durationSec: 30, toleranceBps: 50 },
  fair: { id: "fair", label: "Fair", durationSec: 60, toleranceBps: 100 },
  auction: { id: "auction", label: "Auction", durationSec: 120, toleranceBps: 200 },
};

/** expires_at = now + duration + EXPIRY_GRACE_SEC. */
export const EXPIRY_GRACE_SEC = 60;

/** open_intent arguments a preset implies, given the best quote as start_out_wei. */
export function presetParams(
  preset: SpeedPresetId | SpeedPreset,
  startOutWei: bigint,
  nowSec: bigint,
): { startOutWei: bigint; minOutWei: bigint; auctionDuration: number; expiresAt: bigint } {
  const p = typeof preset === "string" ? SPEED_PRESETS[preset] : preset;
  const minOutWei = (startOutWei * BigInt(10_000 - p.toleranceBps)) / 10_000n;
  return {
    startOutWei,
    minOutWei,
    auctionDuration: p.durationSec,
    expiresAt: nowSec + BigInt(p.durationSec + EXPIRY_GRACE_SEC),
  };
}

export const DEFAULT_BASE_RPC_URL = "https://sepolia.base.org";

export function basescanTx(hash: string): string {
  return `https://sepolia.basescan.org/tx/${hash}`;
}

export function basescanAddress(addr: string): string {
  return `https://sepolia.basescan.org/address/${addr}`;
}

export function solanaExplorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

export function solanaExplorerAddress(addr: string): string {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}
