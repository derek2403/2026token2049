// Server-only helpers for /api/demo/* (the cross-chain signing demo).

import { PublicKey } from "@solana/web3.js";
import { decodeSigRequest, SODA_PROGRAM_ID, type SigRequestAccount } from "@/lib/intents";
import { serverConnection } from "./solana";

export function parsePubkey(s: unknown): PublicKey | null {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return null;
  try {
    return new PublicKey(s);
  } catch {
    return null;
  }
}

export function isAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

/** Decoded soda SigRequest, or null if the account does not exist (yet). */
export async function readSigRequest(pda: PublicKey): Promise<SigRequestAccount | null> {
  const info = await serverConnection().getAccountInfo(pda);
  if (!info) return null;
  if (!info.owner.equals(SODA_PROGRAM_ID)) throw new Error("account is not owned by soda");
  return decodeSigRequest(info.data);
}

export function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}
