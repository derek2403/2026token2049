// GET /api/recipient-check?addr=0x…: payouts carry 21000 gas, so only a
// recipient with no code (eth_getCode == "0x") is accepted (HANDOVER §3.4).

import type { NextRequest } from "next/server";
import { getCode } from "@/lib/intents";
import type { ApiError, RecipientCheckResponse } from "@/app/lib/api-types";
import { checkEvmAddress } from "@/app/lib/eth";
import { BASE_RPC_MISSING, getBaseRpc } from "@/app/lib/server/base";
import { publicError } from "@/app/lib/server/solana";

const err = (error: string, status: number) => Response.json({ error } satisfies ApiError, { status });

export async function GET(req: NextRequest) {
  const check = checkEvmAddress(req.nextUrl.searchParams.get("addr") ?? "");
  if (!check.ok) return err(check.error, 400);
  const rpc = getBaseRpc();
  if (!rpc) return err(BASE_RPC_MISSING, 503);
  try {
    const code = (await getCode(rpc, check.checksummed.toLowerCase())).trim().toLowerCase();
    const body: RecipientCheckResponse = {
      address: check.checksummed,
      plain: code === "0x",
      codeSize: code === "0x" ? 0 : (code.length - 2) / 2,
    };
    return Response.json(body);
  } catch (e) {
    return err(`Base RPC error: ${publicError(e)}`, 503);
  }
}
