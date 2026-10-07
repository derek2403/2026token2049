// GET /api/payout?intent=<pubkey>: the order's status (HANDOVER §3.5, §5.3).
// Reads the intent and all its SigRequests, rebuilds every candidate Base tx
// hash, and looks up receipts through BASE_RPC_URL. Read-only: no rebroadcast.

import type { NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  IntentStatus,
  buildCandidates,
  decodeIntent,
  fetchIntentSigRequests,
  gasPricesFromEvents,
  getReceipt,
  intentStatus,
  unsignedRlpBySigRequest,
  type EthReceipt,
  type IntentAccount,
} from "@/lib/intents";
import type { ApiError, IntentJson, PayoutResponse } from "@/app/lib/api-types";
import { toChecksumAddress } from "@/app/lib/eth";
import { BASE_RPC_MISSING, getBaseRpc } from "@/app/lib/server/base";
import { cachedIntentHistory, finalizeRef } from "@/app/lib/server/history";
import { publicError, serverConnection } from "@/app/lib/server/solana";

const err = (error: string, status: number, extra: object = {}) =>
  Response.json({ error, ...extra } satisfies ApiError, { status, headers: { "cache-control": "no-store" } });

const STATUS_NAME = { [IntentStatus.Open]: "open", [IntentStatus.Filled]: "filled", [IntentStatus.Cancelled]: "cancelled" } as const;

function intentJson(address: PublicKey, i: IntentAccount): IntentJson {
  return {
    address: address.toBase58(),
    user: i.user.toBase58(),
    intentId: i.intentId.toString(),
    inLamports: i.inLamports.toString(),
    recipient: toChecksumAddress(i.recipient),
    startOutWei: i.startOutWei.toString(),
    minOutWei: i.minOutWei.toString(),
    auctionStart: Number(i.auctionStart),
    auctionDuration: i.auctionDuration,
    expiresAt: Number(i.expiresAt),
    status: STATUS_NAME[i.status],
    solver: i.solver.toBase58(),
    outWei: i.outWei.toString(),
    baseNonce: i.baseNonce.toString(),
    gasPrice: i.gasPrice.toString(),
    filledAt: Number(i.filledAt),
    sigRequestCount: i.sigRequestCount,
  };
}

export async function GET(req: NextRequest) {
  let address: PublicKey;
  try {
    address = new PublicKey(req.nextUrl.searchParams.get("intent") ?? "");
  } catch {
    return err("intent must be a base58 account address", 400);
  }

  const conn = serverConnection();
  try {
    const info = await conn.getAccountInfo(address);
    if (!info) return err("Intent account not found (never opened, or closed)", 404, { closed: true });
    const intent = decodeIntent(info.data);
    const nowSec = Math.floor(Date.now() / 1000);
    const now = BigInt(nowSec);

    const [sigRequests, history] = await Promise.all([
      fetchIntentSigRequests(conn, intent),
      cachedIntentHistory(conn, address, `${intent.status}:${intent.sigRequestCount}`).catch(() => null),
    ]);

    const candidates =
      intent.status === IntentStatus.Filled
        ? buildCandidates(intent, sigRequests, {
            gasPriceHints: history ? gasPricesFromEvents(history.events, address) : [],
            unsignedBySigRequest: history ? unsignedRlpBySigRequest(history.events) : undefined,
          })
        : [];

    const refs = { ...history?.refs };
    const firstCompleted = candidates.find((c) => c.completed);
    if (firstCompleted && history) {
      const fin = await finalizeRef(conn, firstCompleted.sigRequest, history.creatorTxs).catch(() => undefined);
      if (fin) refs.signed = fin;
    }

    // Receipts for every signed candidate: after a gas bump either one can land.
    const receipts = new Map<string, EthReceipt | null>();
    const signed = candidates.filter((c) => c.signed);
    let base: PayoutResponse["base"] = { ok: true };
    if (signed.length > 0) {
      const rpc = getBaseRpc();
      if (!rpc) base = { ok: false, error: BASE_RPC_MISSING };
      else {
        const errors: string[] = [];
        await Promise.all(
          signed.map(async (c) => {
            try {
              receipts.set(c.signed!.txHash, await getReceipt(rpc, c.signed!.txHash));
            } catch (e) {
              errors.push(publicError(e));
            }
          }),
        );
        if (errors.length === signed.length) base = { ok: false, error: `Base RPC error: ${errors[0]}` };
      }
    }

    const s = intentStatus({ intent, sigRequests, receipts, now, candidates, refs });
    // The user closes only Cancelled intents; a Filled one is the admin's to close.
    const closableAt = undefined;
    const closable = intent.status === IntentStatus.Cancelled;

    const body: PayoutResponse = {
      intent: intentJson(address, intent),
      status: s.status,
      steps: s.steps,
      candidates: s.candidates.map((c) => ({
        index: c.index,
        sigRequest: c.sigRequest.toBase58(),
        gasPrice: c.gasPrice?.toString() ?? null,
        completed: c.completed,
        txHash: c.signed?.txHash ?? null,
      })),
      requiredOutWei: s.requiredOutWei?.toString(),
      auctionEndsIn: s.auctionEndsIn,
      expiresIn: s.expiresIn,
      delivered: s.delivered && {
        index: s.delivered.index,
        txHash: s.delivered.txHash,
        status: s.delivered.status,
        blockNumber: s.delivered.blockNumber.toString(),
      },
      surplusWei: s.surplusWei?.toString(),
      speedingUp: s.speedingUp,
      closable,
      closableAt,
      base,
      serverTime: Date.now(),
    };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return err(`Could not read the intent: ${publicError(e)}`, 502);
  }
}
