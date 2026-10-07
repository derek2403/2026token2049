// Pyth pull-oracle PriceUpdateV2 accounts on Solana devnet, decoded by hand so
// the bot needs no Pyth SDK. Layout (pyth-solana-receiver-sdk, Anchor/Borsh):
//
//   disc [u8;8] = sha256("account:PriceUpdateV2")[..8]
//   write_authority Pubkey
//   verification_level enum { Partial { num_signatures: u8 } = 0, Full = 1 }
//   price_message { feed_id [u8;32], price i64, conf u64, exponent i32,
//                   publish_time i64, prev_publish_time i64, ema_price i64, ema_conf u64 }
//   posted_slot u64
//
// The enum is Borsh-encoded, so Partial takes 2 bytes and Full 1 and every
// later offset shifts with it. Written from the SDK's struct definitions as
// remembered; the discriminator matches, the rest is checked only on synthetic
// bytes in pyth.test.ts.

import { PublicKey, type Connection } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2";

export const SOL_USD_PRICE_ACCOUNT = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
export const ETH_USD_PRICE_ACCOUNT = new PublicKey("42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC");

/** Pyth feed ids, to catch a wrong account; a mismatch is reported, not fatal. */
export const SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
export const ETH_USD_FEED_ID = "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";

export const PRICE_UPDATE_V2_DISCRIMINATOR = sha256(new TextEncoder().encode("account:PriceUpdateV2")).slice(0, 8);

export type PythPrice = {
  feedId: string;
  /** price · 10^exponent USD */
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
  emaPrice: bigint;
  postedSlot: bigint;
  verification: "partial" | "full";
};

export function decodePriceUpdateV2(data: Uint8Array): PythPrice {
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PRICE_UPDATE_V2_DISCRIMINATOR[i]) throw new Error("not a Pyth PriceUpdateV2 account");
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8 + 32;
  const tag = data[o++];
  let verification: PythPrice["verification"];
  if (tag === 0) {
    verification = "partial";
    o += 1; // num_signatures
  } else if (tag === 1) {
    verification = "full";
  } else {
    throw new Error(`unknown Pyth verification level tag ${tag}`);
  }
  if (data.length < o + 32 + 8 * 6 + 4 + 8) throw new Error("PriceUpdateV2 data too short");
  const feedId = Buffer.from(data.subarray(o, o + 32)).toString("hex");
  o += 32;
  const price = dv.getBigInt64(o, true);
  const conf = dv.getBigUint64(o + 8, true);
  const exponent = dv.getInt32(o + 16, true);
  const publishTime = dv.getBigInt64(o + 20, true);
  // prev_publish_time at o + 28
  const emaPrice = dv.getBigInt64(o + 36, true);
  // ema_conf at o + 44
  const postedSlot = dv.getBigUint64(o + 52, true);
  return { feedId, price, conf, exponent, publishTime, emaPrice, postedSlot, verification };
}

/** A USD price as a fixed-point bigint with 18 decimals. */
export const USD_SCALE = 10n ** 18n;

export function toUsd18(p: { price: bigint; exponent: number }): bigint {
  const shift = 18 + p.exponent;
  return shift >= 0 ? p.price * 10n ** BigInt(shift) : p.price / 10n ** BigInt(-shift);
}

/** "123.45" → 123.45e18. */
export function parseUsd18(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(s.trim());
  if (!m) throw new Error(`bad USD price "${s}"`);
  return BigInt(m[1]) * USD_SCALE + BigInt((m[2] ?? "").padEnd(18, "0"));
}

export type UsdPrice = { usd18: bigint; source: "pyth" | "fallback"; publishTime?: bigint; warning?: string };

/**
 * Reads one feed. Falls back to `fallbackUsd18` when the account is missing,
 * undecodable, non-positive or older than maxAgeSec (devnet updates slowly).
 */
export function pickPrice(
  raw: Uint8Array | null,
  expectedFeedId: string,
  nowSec: bigint,
  maxAgeSec: bigint,
  fallbackUsd18: bigint | undefined,
): UsdPrice | null {
  let reason: string;
  if (raw) {
    try {
      const p = decodePriceUpdateV2(raw);
      const usd18 = toUsd18(p);
      const age = nowSec - p.publishTime;
      const warning = p.feedId !== expectedFeedId ? `feed id ${p.feedId} != expected ${expectedFeedId}` : undefined;
      if (usd18 <= 0n) reason = "non-positive price";
      else if (age > maxAgeSec) reason = `stale by ${age}s`;
      else return { usd18, source: "pyth", publishTime: p.publishTime, warning };
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
  } else {
    reason = "account missing";
  }
  return fallbackUsd18 !== undefined ? { usd18: fallbackUsd18, source: "fallback", warning: reason } : null;
}

export async function fetchPythPrices(
  conn: Connection,
  nowSec: bigint,
  maxAgeSec: bigint,
  fallback: { solUsd18?: bigint; ethUsd18?: bigint },
): Promise<{ sol: UsdPrice | null; eth: UsdPrice | null }> {
  const [sol, eth] = await conn.getMultipleAccountsInfo([SOL_USD_PRICE_ACCOUNT, ETH_USD_PRICE_ACCOUNT]);
  return {
    sol: pickPrice(sol?.data ?? null, SOL_USD_FEED_ID, nowSec, maxAgeSec, fallback.solUsd18),
    eth: pickPrice(eth?.data ?? null, ETH_USD_FEED_ID, nowSec, maxAgeSec, fallback.ethUsd18),
  };
}
