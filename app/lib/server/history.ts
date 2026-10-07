// Intent history from Solana transaction logs: the tx signature behind each
// step, plus the gas prices and unsigned RLPs payout candidates need after a
// gas bump. Transactions are immutable, so each is fetched once and cached.

import { PublicKey, type Connection } from "@solana/web3.js";
import { parseIntentsLogs, type IntentsEvent, type StepId, type StepRef } from "@/lib/intents";

type TxEvents = { signature: string; slot: number; blockTime: number | null; events: IntentsEvent[] };

/** A step's tx with its slot: block times are whole seconds, slots are ~400 ms. */
export type SlotRef = StepRef & { txHash: string; slot: number };

const txCache = new Map<string, TxEvents>();
const finalizeCache = new Map<string, SlotRef>();

export type IntentHistory = {
  txs: TxEvents[];
  events: IntentsEvent[];
  refs: Partial<Record<StepId, StepRef>>;
  /** Signatures of the txs that created each SigRequest (fill, execute_signed_intent, bump_gas). */
  creatorTxs: Set<string>;
  /** SigRequest (base58) → the tx that created it. */
  creatorBySigRequest: Map<string, SlotRef>;
  /** Tx signature → slot, for every tx in `txs`. */
  slotByTx: Map<string, number>;
};

const historyCache = new Map<string, { at: number; value: IntentHistory }>();
const HISTORY_TTL_MS = 20_000;

/**
 * Cached per intent state: a new key (status or sig_request_count changed)
 * refetches at once; otherwise the signature list is re-read every 20 s.
 */
export async function cachedIntentHistory(conn: Connection, intent: PublicKey, stateKey: string): Promise<IntentHistory> {
  const key = `${intent.toBase58()}:${stateKey}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.value;
  const value = await intentHistory(conn, intent);
  historyCache.set(key, { at: Date.now(), value });
  if (historyCache.size > 500) historyCache.delete(historyCache.keys().next().value!);
  return value;
}

export async function intentHistory(conn: Connection, intent: PublicKey): Promise<IntentHistory> {
  const sigs = (await conn.getSignaturesForAddress(intent, { limit: 25 })).filter((s) => !s.err);
  const missing = sigs.filter((s) => !txCache.has(s.signature)).map((s) => s.signature);
  if (missing.length > 0) {
    const txs = await conn.getTransactions(missing, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    txs.forEach((tx, i) => {
      if (!tx) return; // not yet visible at this commitment; retried next poll
      txCache.set(missing[i], {
        signature: missing[i],
        slot: tx.slot,
        blockTime: tx.blockTime ?? null,
        events: parseIntentsLogs(tx.meta?.logMessages ?? []),
      });
    });
  }
  // Oldest first.
  const txs = sigs
    .map((s) => txCache.get(s.signature))
    .filter((t): t is TxEvents => !!t)
    .reverse();

  const refs: Partial<Record<StepId, StepRef>> = {};
  const creatorTxs = new Set<string>();
  const creatorBySigRequest = new Map<string, SlotRef>();
  const at = (t: TxEvents): SlotRef => ({
    txHash: t.signature,
    slot: t.slot,
    timestamp: t.blockTime != null ? t.blockTime * 1000 : undefined,
  });
  const self = intent.toBase58();
  for (const t of txs) {
    for (const e of t.events) {
      // RFQ: execute_signed_intent opens and fills in one transaction.
      if (e.name === "Other" && e.eventName === "SignedIntentExecuted" && String(e.data.intent) === self) {
        refs.open = at(t);
      }
      if (!("intent" in e) || !e.intent.equals(intent)) continue;
      if (e.name === "IntentOpened") refs.open = at(t);
      if (e.name === "IntentFilled") {
        refs.matched = at(t);
        refs.signing = at(t); // the fill CPI creates the first SigRequest
        creatorTxs.add(t.signature);
        creatorBySigRequest.set(e.sigRequest.toBase58(), at(t));
      }
      if (e.name === "GasBumped") {
        creatorTxs.add(t.signature);
        creatorBySigRequest.set(e.sigRequest.toBase58(), at(t));
      }
      if (e.name === "IntentCancelled") refs.cancelled = at(t);
    }
  }
  const slotByTx = new Map(txs.map((t) => [t.signature, t.slot]));
  return { txs, events: txs.flatMap((t) => t.events), refs, creatorTxs, creatorBySigRequest, slotByTx };
}

/** The finalize_signature tx for a completed SigRequest: its newest tx that did not create it. */
export async function finalizeRef(
  conn: Connection,
  sigRequest: PublicKey,
  creatorTxs: Set<string>,
): Promise<SlotRef | undefined> {
  const key = sigRequest.toBase58();
  const hit = finalizeCache.get(key);
  if (hit) return hit;
  const sigs = await conn.getSignaturesForAddress(sigRequest, { limit: 10 });
  const fin = sigs.find((s) => !s.err && !creatorTxs.has(s.signature));
  if (!fin) return undefined;
  const ref: SlotRef = {
    txHash: fin.signature,
    slot: fin.slot,
    timestamp: fin.blockTime != null ? fin.blockTime * 1000 : undefined,
  };
  finalizeCache.set(key, ref);
  if (finalizeCache.size > 2000) finalizeCache.delete(finalizeCache.keys().next().value!);
  return ref;
}
