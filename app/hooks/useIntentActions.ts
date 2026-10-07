"use client";

// open / cancel / close, each one Phantom transaction.

import { useCallback, useMemo } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, type Transaction } from "@solana/web3.js";
import { solanaExplorerTx } from "@/lib/intents";
import {
  buildCancelIntentTx,
  buildCloseIntentTx,
  buildOpenIntentTx,
  intentsProgram,
  programErrorMessage,
  type OpenIntentArgs,
} from "@/app/lib/program";
import { observe, saveOrder, updateOrder } from "@/app/lib/orders";
import { useToasts } from "@/app/components/Toasts";

export type SendResult = { signature: string; sentAt: number; confirmedAt: number };

export function useIntentActions() {
  const { connection } = useConnection();
  const { sendTransaction, publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { push } = useToasts();

  const program = useMemo(
    () => (anchorWallet ? intentsProgram(connection, anchorWallet) : null),
    [connection, anchorWallet],
  );

  const send = useCallback(
    async (tx: Transaction, onSent?: (signature: string, sentAt: number) => void): Promise<SendResult> => {
      if (!publicKey) throw new Error("Connect a wallet first");
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.feePayer = publicKey;
      tx.recentBlockhash = blockhash;
      const signature = await sendTransaction(tx, connection);
      const sentAt = Date.now();
      onSent?.(signature, sentAt);
      const res = await connection
        .confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed")
        .catch((e: unknown) => {
          // RPC error or blockhash expiry while waiting: the tx may still have landed.
          throw Object.assign(e instanceof Error ? e : new Error(String(e)), { signature, unconfirmed: true });
        });
      if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`);
      return { signature, sentAt, confirmedAt: Date.now() };
    },
    [connection, publicKey, sendTransaction],
  );

  const open = useCallback(
    async (args: OpenIntentArgs, onSent?: () => void): Promise<{ intent: string } & SendResult> => {
      if (!program || !publicKey) throw new Error("Connect a wallet first");
      const { tx, intent } = await buildOpenIntentTx(program, publicKey, args);
      const id = intent.toBase58();
      try {
        // Record the order as soon as it has a signature, so a failed confirmation still tracks it.
        const r = await send(tx, (openSig, sentAt) => {
          saveOrder({ intent: id, openSig, sentAt, observed: {} });
          onSent?.();
        });
        observe(id, "open", r.confirmedAt);
        return { intent: id, ...r };
      } catch (e) {
        if ((e as { unconfirmed?: boolean }).unconfirmed) throw Object.assign(e as Error, { intent: id });
        throw e;
      }
    },
    [program, publicKey, send],
  );

  const cancel = useCallback(
    async (intent: string): Promise<boolean> => {
      if (!program || !publicKey) return false;
      try {
        const r = await send(await buildCancelIntentTx(program, publicKey, new PublicKey(intent)));
        updateOrder(intent, (o) => ({ ...o, cancelSig: r.signature }));
        observe(intent, "cancelled", r.confirmedAt);
        push({
          kind: "success",
          title: "Intent cancelled. SOL refunded",
          body: `Confirmed in ${(r.confirmedAt - r.sentAt).toLocaleString("en-US")} ms`,
          link: { href: solanaExplorerTx(r.signature), label: "Explorer" },
        });
        return true;
      } catch (e) {
        push({ kind: "error", title: "Cancel failed", body: programErrorMessage(e) });
        return false;
      }
    },
    [program, publicKey, send, push],
  );

  const close = useCallback(
    async (intent: string): Promise<boolean> => {
      if (!program || !publicKey) return false;
      try {
        const r = await send(await buildCloseIntentTx(program, publicKey, new PublicKey(intent)));
        updateOrder(intent, (o) => ({ ...o, closeSig: r.signature }));
        push({
          kind: "success",
          title: "Intent closed. Rent returned",
          link: { href: solanaExplorerTx(r.signature), label: "Explorer" },
        });
        return true;
      } catch (e) {
        push({ kind: "error", title: "Close failed", body: programErrorMessage(e) });
        return false;
      }
    },
    [program, publicKey, send, push],
  );

  return { ready: !!program, open, cancel, close };
}
