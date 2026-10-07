// POST /api/demo/prepare { from, to, valueWei, dataHex }
//
// Read-only: the nonce and gas price to build the unsigned tx with, plus an
// eth_estimateGas dry run, so an Aave revert surfaces BEFORE Phantom signs
// and the committee spends a signature on it (as frontier's page did).

import { hexToBytes } from "@noble/hashes/utils";
import { baseRpc } from "@/lib/intents";
import type { DemoPrepare } from "@/app/lib/demo/config";
import { isAddress, jsonError } from "@/app/lib/server/demo";
import { publicError } from "@/app/lib/server/solana";

const MIN_GAS_PRICE = 2_000_000_000n; // 2 gwei, as frontier

export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return jsonError("body must be JSON", 400);
  }
  const dataHex = typeof b.dataHex === "string" ? b.dataHex.replace(/^0x/, "") : "";
  const valueWei = typeof b.valueWei === "string" && /^\d{1,30}$/.test(b.valueWei) ? BigInt(b.valueWei) : null;
  if (!isAddress(b.from) || !isAddress(b.to) || valueWei == null || !/^([0-9a-fA-F]{2})*$/.test(dataHex)) {
    return jsonError("missing or malformed fields", 400);
  }
  const rpc = baseRpc();
  try {
    const [nonce, fetched] = await Promise.all([rpc.getNonce(b.from), rpc.getGasPrice()]);
    const bumped = (fetched * 110n) / 100n;
    const gasPriceWei = bumped > MIN_GAS_PRICE ? bumped : MIN_GAS_PRICE;
    let gasEstimate: bigint;
    try {
      gasEstimate = await rpc.estimateGas({ from: b.from, to: b.to, data: hexToBytes(dataHex.toLowerCase()), valueWei });
    } catch (e) {
      return jsonError(`would revert on Base: ${publicError(e)}`, 422);
    }
    const out: DemoPrepare = {
      nonce: nonce.toString(),
      gasPriceWei: gasPriceWei.toString(),
      gasEstimate: gasEstimate.toString(),
    };
    return Response.json(out);
  } catch (e) {
    return jsonError(`Base Sepolia: ${publicError(e)}`, 502);
  }
}
