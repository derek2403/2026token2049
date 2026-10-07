// Who finalized a soda SigRequest: Chainlink CRE (through Chainlink's
// forwarder into soda_cre_signer, which CPIs soda::finalize_signature) or the
// SODA MPC subscriber (a direct soda::finalize_signature).
//
// Read-only. Shared by /api/demo/* and anything else that wants to label the
// signing step (e.g. /api/payout's `signing.via`).

import { Connection, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { decodeSigRequest, solanaExplorerTx } from "../../../lib/intents";

/** Chainlink keystone forwarder used by `cre workflow simulate --broadcast` on devnet. */
export const MOCK_FORWARDER_ID = "7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK";
/** Chainlink's production keystone forwarder. */
export const PRODUCTION_FORWARDER_ID = "CXsKEJcs25TQEYU2e5jZ8QTPE3ffMLZhH6BWHrdcCCB5";
/** soda_cre_signer: on_report CPIs soda::finalize_signature. */
export const SODA_CRE_SIGNER_ID = "2cgtuK2Y9BQ8uMbVpYwM9FZ7TVkSqu9xegNTyBp3taxM";

const FORWARDERS = new Set([MOCK_FORWARDER_ID, PRODUCTION_FORWARDER_ID]);

export type SignerVia = "chainlink-cre" | "mpc-subscriber" | "pending";

export type FinalizeAttribution = {
  via: SignerVia;
  /** The Solana transaction that ran soda::finalize_signature (null while pending). */
  finalizeTx: string | null;
  slot: number | null;
  /** Human label for the signing step. */
  label: string;
  /** Which forwarder, when via = chainlink-cre. */
  forwarder?: "mock" | "production";
  explorer?: string;
};

const PENDING: FinalizeAttribution = {
  via: "pending",
  finalizeTx: null,
  slot: null,
  label: "Waiting for the SODA MPC committee",
};

// A finalized request never changes hands, so the answer is cached for good.
const cache = new Map<string, FinalizeAttribution>();

function accountKeysOf(tx: VersionedTransactionResponse): string[] {
  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const loaded = tx.meta?.loadedAddresses;
  if (loaded) {
    keys.push(...loaded.writable.map((k) => k.toBase58()), ...loaded.readonly.map((k) => k.toBase58()));
  }
  return keys;
}

function isFinalize(tx: VersionedTransactionResponse): boolean {
  return (tx.meta?.logMessages ?? []).some((l) => l.includes("Instruction: FinalizeSignature"));
}

/** Classify one finalize transaction. */
export function classifyFinalizeTx(tx: VersionedTransactionResponse, signature: string): FinalizeAttribution {
  const keys = accountKeysOf(tx);
  const forwarder = keys.find((k) => FORWARDERS.has(k));
  const viaCre = !!forwarder && keys.includes(SODA_CRE_SIGNER_ID);
  return viaCre
    ? {
        via: "chainlink-cre",
        finalizeTx: signature,
        slot: tx.slot,
        label: "Signed via Chainlink CRE → SODA MPC",
        forwarder: forwarder === PRODUCTION_FORWARDER_ID ? "production" : "mock",
        explorer: solanaExplorerTx(signature),
      }
    : {
        via: "mpc-subscriber",
        finalizeTx: signature,
        slot: tx.slot,
        label: "Signed via SODA MPC subscriber",
        explorer: solanaExplorerTx(signature),
      };
}

/**
 * Who finalized `sigRequest`. 'pending' while the SigRequest is not completed
 * (or does not exist yet). Scans the newest successful transactions touching
 * the PDA for the one that logged soda's FinalizeSignature.
 */
export async function attributeFinalize(
  conn: Connection,
  sigRequest: PublicKey | string,
): Promise<FinalizeAttribution> {
  const pda = typeof sigRequest === "string" ? new PublicKey(sigRequest) : sigRequest;
  const key = pda.toBase58();
  const hit = cache.get(key);
  if (hit) return hit;

  const info = await conn.getAccountInfo(pda);
  if (info) {
    const sr = decodeSigRequest(info.data);
    if (!sr.completed) return PENDING;
  }
  // Closed accounts fall through: the transaction history still tells.

  const sigs = await conn.getSignaturesForAddress(pda, { limit: 10 });
  for (const s of sigs.filter((x) => x.err === null).slice(0, 5)) {
    const tx = await conn.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx || !isFinalize(tx)) continue;
    const out = classifyFinalizeTx(tx, s.signature);
    cache.set(key, out);
    return out;
  }
  return PENDING;
}
