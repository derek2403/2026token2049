// GET /api/demo/status?sigRequest=<pda>[&tx=<base tx hash>]
//
// Read-only poll for the demo timeline: is the soda SigRequest there, has it
// been finalized, and who finalized it (Chainlink CRE through the forwarder, or
// the SODA MPC subscriber). With `tx`, also the Base receipt.

import { connection as requestTime } from "next/server";
import { baseRpc, getReceipt } from "@/lib/intents";
import type { DemoStatus } from "@/app/lib/demo/config";
import { jsonError, parsePubkey, readSigRequest } from "@/app/lib/server/demo";
import { attributeFinalize } from "@/app/lib/server/signer-attribution";
import { publicError, serverConnection } from "@/app/lib/server/solana";

export async function GET(req: Request) {
  await requestTime();
  const url = new URL(req.url);
  const pda = parsePubkey(url.searchParams.get("sigRequest"));
  if (!pda) return jsonError("sigRequest must be a base58 pubkey", 400);
  const tx = url.searchParams.get("tx");
  if (tx && !/^0x[0-9a-fA-F]{64}$/.test(tx)) return jsonError("tx must be a 32-byte hex hash", 400);

  try {
    const sr = await readSigRequest(pda);
    const attribution = sr?.completed
      ? await attributeFinalize(serverConnection(), pda)
      : { via: "pending" as const, finalizeTx: null, slot: null, label: "Waiting for the SODA MPC committee" };
    let receipt: DemoStatus["receipt"];
    if (tx) {
      const r = await getReceipt(baseRpc(), tx).catch(() => null);
      receipt = r ? { status: r.status, blockNumber: r.blockNumber.toString(), gasUsed: r.gasUsed.toString() } : null;
    }
    const out: DemoStatus = {
      sigRequest: pda.toBase58(),
      exists: !!sr,
      completed: !!sr?.completed,
      attribution,
      crePayload: { sigRequest: pda.toBase58() },
      ...(tx ? { receipt } : {}),
    };
    return Response.json(out);
  } catch (e) {
    return jsonError(publicError(e), 502);
  }
}
