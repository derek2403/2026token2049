// Ported from frontier apps/web/lib/solana-confirm.ts (prior work).
//
// Send through the connected wallet and poll getSignatureStatuses over HTTP
// instead of confirmTransaction, whose signatureSubscribe websocket some
// providers reject (the tx lands, the page hangs for 30 s).

import type { Connection, PublicKey, Transaction } from "@solana/web3.js";

type SigningWallet = {
  publicKey: PublicKey;
  signTransaction: <T extends Transaction>(tx: T) => Promise<T>;
};

export async function sendViaWallet(
  connection: Connection,
  wallet: SigningWallet,
  tx: Transaction,
  what = "transaction",
  timeoutMs = 60_000,
): Promise<{ signature: string; slot: number | null }> {
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = blockhash;

  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 5,
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) {
      throw new Error(`${what} ${signature} failed on-chain: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus) return { signature, slot: status.slot ?? null };
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `${what} ${signature} was sent but never appeared within ${timeoutMs / 1000}s. ` +
      `Check Solana Explorer rather than retrying: a retry builds the same SigRequest PDA.`,
  );
}
