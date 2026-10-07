// Client-side intents program calls via Anchor, signed and sent by Phantom.

import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { PublicKey, type Connection, type Transaction } from "@solana/web3.js";
import { INTENTS_IDL, INTENTS_PROGRAM_ID, configPda, intentPda } from "@/lib/intents";

export function intentsProgram(connection: Connection, wallet: AnchorWallet): Program {
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  // The IDL's own address must match the program the env points at.
  return new Program({ ...INTENTS_IDL, address: INTENTS_PROGRAM_ID.toBase58() }, provider);
}

/** A random u64 intent id (the PDA seed), so two tabs never collide. */
export function randomIntentId(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return new DataView(b.buffer).getBigUint64(0, true);
}

const bn = (v: bigint | number) => new BN(v.toString());

export type OpenIntentArgs = {
  intentId: bigint;
  inLamports: bigint;
  recipient: Uint8Array;
  startOutWei: bigint;
  minOutWei: bigint;
  auctionDuration: number;
  expiresAt: bigint;
};

export async function buildOpenIntentTx(
  program: Program,
  user: PublicKey,
  a: OpenIntentArgs,
): Promise<{ tx: Transaction; intent: PublicKey }> {
  const [intent] = intentPda(user, a.intentId, program.programId);
  const tx = await program.methods
    .openIntent(
      bn(a.intentId),
      bn(a.inLamports),
      Array.from(a.recipient),
      bn(a.startOutWei),
      bn(a.minOutWei),
      a.auctionDuration,
      bn(a.expiresAt),
    )
    .accountsPartial({ user, intent })
    .transaction();
  return { tx, intent };
}

export function buildCancelIntentTx(program: Program, user: PublicKey, intent: PublicKey): Promise<Transaction> {
  return program.methods.cancelIntent().accountsPartial({ user, intent }).transaction();
}

/** The user can close only a Cancelled intent; a Filled one is closed by the admin. */
export function buildCloseIntentTx(program: Program, user: PublicKey, intent: PublicKey): Promise<Transaction> {
  return program.methods
    .closeIntent()
    .accountsPartial({ closer: user, user, config: configPda(program.programId)[0], intent })
    .transaction();
}

/** Anchor error code → the program's error name, for readable failures. */
export function programErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/user rejected|rejected the request/i.test(msg)) return "Request rejected in wallet";
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(msg) ?? /"Custom":(\d+)/.exec(msg);
  if (m) {
    const code = m[0].includes("0x") ? parseInt(m[1], 16) : Number(m[1]);
    const named = (INTENTS_IDL.errors ?? []).find((x) => x.code === code);
    if (named) return named.msg ? `${named.name}: ${named.msg}` : named.name;
  }
  return msg.length > 160 ? msg.slice(0, 160) + "…" : msg;
}
