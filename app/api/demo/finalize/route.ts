// POST /api/demo/finalize
//   { sigRequest, to, valueWei, dataHex, nonce, gasPriceWei, gasLimit }
//
// Ported from frontier apps/web/pages/api/finalize.ts (prior work), minus the
// signing: this route holds no signer key. The committee signs (driven by the
// SODA MPC subscriber or by Chainlink CRE) and soda::finalize_signature stores
// the verified (r, s, v) on Solana. Once the SigRequest is completed this
// route rebuilds the exact unsigned RLP, checks keccak(RLP) == the payload
// soda stored, joins it with the RECORDED signature and broadcasts on Base.
// The mpc relayer broadcasts the same bytes, so "already known" is success.
//
// While the request is still pending it answers { pending: true } after a
// short wait; the page keeps polling.

import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { baseRpc, signedFromSigRequest } from "@/lib/intents";
import { bigintToBe } from "@/lib/soda";
import { DEMO_CHAIN, type DemoFinalizeResponse } from "@/app/lib/demo/config";
import { isAddress, jsonError, parsePubkey, readSigRequest } from "@/app/lib/server/demo";
import { attributeFinalize } from "@/app/lib/server/signer-attribution";
import { publicError, serverConnection } from "@/app/lib/server/solana";

const WAIT_MS = 6_000;

const dec = (v: unknown): bigint | null =>
  typeof v === "string" && /^\d{1,30}$/.test(v) ? BigInt(v) : null;

export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return jsonError("body must be JSON", 400);
  }
  const pda = parsePubkey(b.sigRequest);
  const nonce = dec(b.nonce);
  const gasPriceWei = dec(b.gasPriceWei);
  const gasLimit = dec(b.gasLimit);
  const valueWei = dec(b.valueWei);
  const dataHex = typeof b.dataHex === "string" ? b.dataHex.replace(/^0x/, "") : "";
  if (!pda || !isAddress(b.to) || nonce == null || gasPriceWei == null || gasLimit == null || valueWei == null) {
    return jsonError("missing or malformed fields", 400);
  }
  if (dataHex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(dataHex) || dataHex.length > 4096) {
    return jsonError("dataHex must be even-length hex", 400);
  }

  try {
    const deadline = Date.now() + WAIT_MS;
    let sr = await readSigRequest(pda);
    while ((!sr || !sr.completed) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700));
      sr = await readSigRequest(pda);
    }
    if (!sr) return jsonError("SigRequest not found on Solana", 404);
    if (!sr.completed) {
      const pending: DemoFinalizeResponse = {
        pending: true,
        attribution: { via: "pending", finalizeTx: null, slot: null, label: "Waiting for the SODA MPC committee" },
      };
      return Response.json(pending, { status: 202 });
    }

    const unsigned = {
      nonce,
      gasPriceWei,
      gasLimit,
      to: hexToBytes((b.to as string).slice(2).toLowerCase()),
      valueWeiBe: bigintToBe(valueWei, 16),
      data: hexToBytes(dataHex.toLowerCase()),
      chainId: DEMO_CHAIN.chainId,
    };
    // Throws if the params do not hash to the payload soda stored.
    const signed = signedFromSigRequest(unsigned, sr);
    if (!signed) throw new Error("SigRequest not completed");

    let alreadyBroadcast = false;
    try {
      await baseRpc().sendRawTransaction(signed.signedHex);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/already known|ALREADY_EXISTS|nonce too low/i.test(msg)) alreadyBroadcast = true;
      else throw e;
    }

    const ethAddress = "0x" + bytesToHex(keccak_256(sr.foreignPkXy).subarray(12));
    const attribution = await attributeFinalize(serverConnection(), pda);
    const out: DemoFinalizeResponse = {
      pending: false,
      ethTxHash: signed.txHash,
      signedHex: signed.signedHex,
      ethAddress,
      alreadyBroadcast,
      attribution,
    };
    return Response.json(out);
  } catch (e) {
    return jsonError(publicError(e), 502);
  }
}
