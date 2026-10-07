// An order's full status (HANDOVER §3.5, §5.3), shared by /api/payout and the
// RFQ relay's get_status. Reads the intent and all its SigRequests, rebuilds
// every candidate Base tx hash, and looks up receipts through BASE_RPC_URL.
// Read-only: no rebroadcast.

import { PublicKey, type Connection } from "@solana/web3.js";
import {
  IntentStatus,
  buildCandidates,
  decodeIntent,
  fetchIntentSigRequests,
  gasPricesFromEvents,
  getReceipt,
  intentStatus,
  isRfqIntent,
  unsignedRlpBySigRequest,
  type EthReceipt,
  type IntentAccount,
} from "@/lib/intents";
import type { IntentJson, PayoutResponse, PayoutStep, SigningTiming } from "@/app/lib/api-types";
import { toChecksumAddress } from "@/app/lib/eth";
import { BASE_RPC_MISSING, getBaseRpc } from "@/app/lib/server/base";
import { cachedIntentHistory, finalizeRef, type SlotRef } from "@/app/lib/server/history";
import { publicError } from "@/app/lib/server/solana";

/** Solana's target slot time; real slots run a little slower. */
export const SLOT_MS = 400;

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

export function signingLabel(slots: number): string {
  if (slots <= 0) return "same slot (<0.4 s)";
  return `≈${((slots * SLOT_MS) / 1000).toFixed(1)} s (${slots} slot${slots === 1 ? "" : "s"})`;
}

function signingTiming(from: SlotRef, to: SlotRef): SigningTiming {
  const slots = Math.max(0, to.slot - from.slot);
  return {
    fromSlot: from.slot,
    fromTx: from.txHash,
    toSlot: to.slot,
    toTx: to.txHash,
    slots,
    msApprox: slots * SLOT_MS,
    label: signingLabel(slots),
  };
}

export type PayoutResult = { ok: true; body: PayoutResponse } | { ok: false; status: number; error: string; closed?: boolean };

export async function loadPayout(conn: Connection, address: PublicKey): Promise<PayoutResult> {
  try {
    const info = await conn.getAccountInfo(address);
    if (!info) return { ok: false, status: 404, error: "Intent account not found (never opened, or closed)", closed: true };
    let intent: IntentAccount;
    try {
      intent = decodeIntent(info.data);
    } catch {
      return { ok: false, status: 400, error: "Not an intent account" };
    }
    const now = BigInt(Math.floor(Date.now() / 1000));

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
    let signing: SigningTiming | undefined;
    let finalizeSlot: SlotRef | undefined;
    if (firstCompleted && history) {
      const fin = await finalizeRef(conn, firstCompleted.sigRequest, history.creatorTxs).catch(() => undefined);
      if (fin) {
        refs.signed = fin;
        finalizeSlot = fin;
        const from = history.creatorBySigRequest.get(firstCompleted.sigRequest.toBase58());
        if (from) signing = signingTiming(from, fin);
      }
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
    const closable = intent.status === IntentStatus.Cancelled;

    const slotOf = (txHash?: string): number | undefined => {
      if (!txHash) return undefined;
      if (finalizeSlot?.txHash === txHash) return finalizeSlot.slot;
      return history?.slotByTx.get(txHash);
    };
    const steps: PayoutStep[] = s.steps.map((step) => {
      const out: PayoutStep = { ...step };
      const slot = step.chain === "solana" ? slotOf(step.txHash) : undefined;
      if (slot !== undefined) out.slot = slot;
      if (step.id === "signed" && signing && step.state !== "todo") {
        out.signingSlots = signing.slots;
        out.signingMsApprox = signing.msApprox;
      }
      return out;
    });

    const body: PayoutResponse = {
      intent: intentJson(address, intent),
      status: s.status,
      steps,
      isRfq: isRfqIntent(intent),
      signing,
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
      closableAt: undefined,
      base,
      serverTime: Date.now(),
    };
    return { ok: true, body };
  } catch (e) {
    return { ok: false, status: 502, error: `Could not read the intent: ${publicError(e)}` };
  }
}
