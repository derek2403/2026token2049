// GET /api/payout?intent=<pubkey>: the order's status (HANDOVER §3.5, §5.3).
// The work is in app/lib/server/payout.ts, shared with the RFQ relay's get_status.

import type { NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import type { ApiError } from "@/app/lib/api-types";
import { loadPayout } from "@/app/lib/server/payout";
import { serverConnection } from "@/app/lib/server/solana";

const err = (error: string, status: number, extra: object = {}) =>
  Response.json({ error, ...extra } satisfies ApiError, { status, headers: { "cache-control": "no-store" } });

export async function GET(req: NextRequest) {
  let address: PublicKey;
  try {
    address = new PublicKey(req.nextUrl.searchParams.get("intent") ?? "");
  } catch {
    return err("intent must be a base58 account address", 400);
  }
  const r = await loadPayout(serverConnection(), address);
  if (!r.ok) return err(r.error, r.status, r.closed ? { closed: true } : {});
  return Response.json(r.body, { headers: { "cache-control": "no-store" } });
}
