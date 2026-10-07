// POST /api/demo/fund { address, minWei? }
//
// Ported from frontier apps/web/pages/api/fund.ts (prior work). Gas on Base is
// paid by the transaction's `from`, so a SODA-derived address needs ETH before
// it can transact. This tops it up from BOT_ID (a funded Base Sepolia key,
// server-only). Capped at 0.002 ETH per request and idempotent: an address that
// already holds the target gets nothing.

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { baseRpc } from "@/lib/intents";
import { bigintToBe, eip155V, encodeSignedLegacy, encodeUnsignedLegacy, ethAddressFromPk } from "@/lib/soda";
import { DEMO_CHAIN } from "@/app/lib/demo/config";
import { isAddress, jsonError } from "@/app/lib/server/demo";
import { publicError } from "@/app/lib/server/solana";

const FUNDING_THRESHOLD_WEI = 200_000_000_000_000n; // 0.0002 ETH
const MAX_TOPUP_WEI = 2_000_000_000_000_000n; // 0.002 ETH
const TOPUP_HEADROOM = 4n;

export async function POST(req: Request) {
  let body: { address?: unknown; minWei?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError("body must be JSON", 400);
  }
  if (!isAddress(body.address)) return jsonError("address must be 0x + 40 hex", 400);
  const target = body.address;
  let threshold = FUNDING_THRESHOLD_WEI;
  if (typeof body.minWei === "string" && /^\d{1,30}$/.test(body.minWei)) {
    const requested = BigInt(body.minWei);
    threshold = requested > MAX_TOPUP_WEI ? MAX_TOPUP_WEI : requested;
  }

  const raw = (process.env.BOT_ID ?? "").trim().replace(/^0x/, "");
  if (!raw) return jsonError("Faucet not configured (BOT_ID unset). Fund the address from a Base Sepolia faucet.", 503);
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return jsonError("Faucet key is not a 32-byte hex key", 500);

  try {
    const rpc = baseRpc();
    const current = await rpc.getBalance(target);
    if (current >= threshold) return Response.json({ funded: true, balanceWei: current.toString() });

    const sk = hexToBytes(raw);
    const funder = "0x" + bytesToHex(ethAddressFromPk(secp256k1.getPublicKey(sk, false)));
    const need = threshold * TOPUP_HEADROOM - current;
    const topUp = need > MAX_TOPUP_WEI ? MAX_TOPUP_WEI : need;
    const gasPriceWei = (await rpc.getGasPrice()) * 2n;
    const gasLimit = 21_000n;
    const funderBal = await rpc.getBalance(funder);
    if (funderBal < topUp + gasPriceWei * gasLimit) {
      return jsonError(`faucet ${funder} is low (${funderBal} wei)`, 503);
    }

    const to = hexToBytes(target.slice(2).toLowerCase());
    const valueWeiBe = bigintToBe(topUp, 16);
    const nonce = await rpc.getNonce(funder);
    const tx = { nonce, gasPriceWei, gasLimit, to, valueWeiBe, data: new Uint8Array(0), chainId: DEMO_CHAIN.chainId };
    const sig = secp256k1.sign(keccak_256(encodeUnsignedLegacy(tx)), sk, { lowS: true });
    const signed = encodeSignedLegacy(
      tx,
      eip155V(sig.recovery as 0 | 1, DEMO_CHAIN.chainId),
      bigintToBe(sig.r, 32),
      bigintToBe(sig.s, 32),
    );
    const txHash = await rpc.sendRawTransaction("0x" + bytesToHex(signed));

    // Wait for the balance itself: that is what the next step depends on.
    let balance = current;
    for (let i = 0; i < 80; i++) {
      balance = await rpc.getBalance(target).catch(() => balance);
      if (balance >= threshold) {
        return Response.json({ funded: true, txHash, topUpWei: topUp.toString(), balanceWei: balance.toString() });
      }
      await new Promise((r) => setTimeout(r, 750));
    }
    return Response.json({ error: "faucet tx did not confirm in time", txHash }, { status: 504 });
  } catch (e) {
    return jsonError(`Base Sepolia: ${publicError(e)}`, 502);
  }
}
