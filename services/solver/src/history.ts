// An intent's transaction history from its own signatures: the gas prices of
// earlier payout candidates (Intent.gas_price keeps only the newest) and the
// Solana tx signatures behind each status step.

import type { Connection, PublicKey } from "@solana/web3.js";
import {
  gasPricesFromEvents,
  parseIntentsLogs,
  unsignedRlpBySigRequest,
  type IntentsEvent,
  type StepId,
  type StepRef,
} from "../../../lib/intents";

export type IntentHistory = {
  events: { event: IntentsEvent; signature: string; blockTimeMs?: number }[];
  gasPriceHints: bigint[];
  unsignedBySigRequest: Map<string, Uint8Array>;
  refs: Partial<Record<StepId, StepRef>>;
};

export async function intentHistory(
  conn: Connection,
  intent: PublicKey,
  programId: PublicKey,
  limit = 25,
): Promise<IntentHistory> {
  const sigs = (await conn.getSignaturesForAddress(intent, { limit }, "confirmed")).filter((s) => !s.err).reverse();
  const txs = sigs.length
    ? await conn.getTransactions(
        sigs.map((s) => s.signature),
        { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      )
    : [];

  const events: IntentHistory["events"] = [];
  const refs: IntentHistory["refs"] = {};
  txs.forEach((tx, i) => {
    const logs = tx?.meta?.logMessages;
    if (!logs) return;
    const signature = sigs[i].signature;
    const blockTimeMs = tx.blockTime ? tx.blockTime * 1000 : undefined;
    for (const event of parseIntentsLogs(logs, programId)) {
      events.push({ event, signature, blockTimeMs });
      const ref = { txHash: signature, timestamp: blockTimeMs };
      if (event.name === "IntentOpened" && event.intent.equals(intent)) refs.open = ref;
      // RFQ: the signed intent opens and fills in one transaction.
      if (event.name === "Other" && event.eventName === "SignedIntentExecuted" && String(event.data.intent) === intent.toBase58()) {
        refs.open = ref;
      }
      if (event.name === "IntentFilled" && event.intent.equals(intent)) refs.matched = ref;
      if (event.name === "IntentCancelled" && event.intent.equals(intent)) refs.cancelled = ref;
    }
  });
  const evs = events.map((e) => e.event);
  return {
    events,
    gasPriceHints: gasPricesFromEvents(evs, intent),
    unsignedBySigRequest: unsignedRlpBySigRequest(evs),
    refs,
  };
}
