// GET /api/prices: SOL/USD and ETH/USD from Pyth devnet price accounts, for
// the form's USD hints only. Never used for amounts.

import { connection as requestTime } from "next/server";
import { PublicKey } from "@solana/web3.js";
import type { PricesResponse } from "@/app/lib/api-types";
import { serverConnection } from "@/app/lib/server/solana";

// Pyth push-oracle PriceUpdateV2 accounts, shard 0 (HANDOVER §3.6).
const SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const ETH_USD = new PublicKey("42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC");
const TTL_MS = 30_000;

let cached: { at: number; body: PricesResponse } | null = null;

// PriceUpdateV2: disc(8) | write_authority(32) | verification_level (enum: Partial{u8} | Full)
// | feed_id(32) | price i64 | conf u64 | exponent i32 | publish_time i64 | …
function decodePrice(data: Buffer | null | undefined): { price: number; publishTime: number } | null {
  if (!data || data.length < 100) return null;
  const variant = data[40];
  const msg = variant === 0 ? 42 : variant === 1 ? 41 : -1;
  if (msg < 0) return null;
  const price = data.readBigInt64LE(msg + 32);
  const expo = data.readInt32LE(msg + 48);
  const publishTime = Number(data.readBigInt64LE(msg + 52));
  const value = Number(price) * 10 ** expo;
  return Number.isFinite(value) && value > 0 ? { price: value, publishTime } : null;
}

export async function GET() {
  await requestTime();
  if (cached && Date.now() - cached.at < TTL_MS) return Response.json(cached.body);
  try {
    const [sol, eth] = await serverConnection().getMultipleAccountsInfo([SOL_USD, ETH_USD]);
    const s = decodePrice(sol?.data);
    const e = decodePrice(eth?.data);
    const body: PricesResponse = {
      solUsd: s?.price ?? null,
      ethUsd: e?.price ?? null,
      publishTime: s && e ? Math.min(s.publishTime, e.publishTime) : (s ?? e)?.publishTime ?? null,
    };
    cached = { at: Date.now(), body };
    return Response.json(body);
  } catch {
    return Response.json(cached?.body ?? ({ solUsd: null, ethUsd: null, publishTime: null } satisfies PricesResponse));
  }
}
