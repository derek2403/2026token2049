// PDAs for the intents program and the soda SigRequest it creates (HANDOVER §3.3, §3.4).

import { PublicKey } from "@solana/web3.js";
import { deriveEthAddress, EVM_CHAIN_TAG } from "../soda";
import { GROUP_PK, INTENTS_PROGRAM_ID, SODA_PROGRAM_ID } from "./constants";

const enc = (s: string) => new TextEncoder().encode(s);

export function u64Le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt.asUintN(64, n), true);
  return out;
}

export function configPda(programId: PublicKey = INTENTS_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc("config")], programId);
}

/** The SODA requester for every payout. Holds no data and no lamports. */
export function poolPda(programId: PublicKey = INTENTS_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc("pool")], programId);
}

export function solverPda(
  authority: PublicKey,
  programId: PublicKey = INTENTS_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc("solver"), authority.toBytes()], programId);
}

export function intentPda(
  user: PublicKey,
  intentId: bigint,
  programId: PublicKey = INTENTS_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [enc("intent"), user.toBytes(), u64Le(intentId)],
    programId,
  );
}

/** One per solver_withdraw, keyed by the pool nonce it took. */
export function withdrawalPda(
  baseNonce: bigint,
  programId: PublicKey = INTENTS_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc("withdrawal"), u64Le(baseNonce)], programId);
}

/**
 * Phase 2: one per credited Base deposit, ["credit", tx_hash]. Keyed by the tx
 * rather than the claim, so two solvers' claims on one deposit credit once.
 */
export function creditPda(
  txHash: Uint8Array,
  programId: PublicKey = INTENTS_PROGRAM_ID,
): [PublicKey, number] {
  if (txHash.length !== 32) throw new Error(`tx hash must be 32 bytes, got ${txHash.length}`);
  return PublicKey.findProgramAddressSync([enc("credit"), txHash], programId);
}

/**
 * What `deposit_from` personal_signs (EIP-191) for register_solver:
 * "intents register" || program id || solver authority (80 bytes).
 */
export function depositProofMessage(
  authority: PublicKey,
  programId: PublicKey = INTENTS_PROGRAM_ID,
): Uint8Array {
  const m = new Uint8Array(80);
  m.set(enc("intents register"), 0);
  m.set(programId.toBytes(), 16);
  m.set(authority.toBytes(), 48);
  return m;
}

/** soda creates SigRequest at ["sig", requester, payload] under the soda program. */
export function sigRequestPda(
  requester: PublicKey,
  payload: Uint8Array,
  sodaProgramId: PublicKey = SODA_PROGRAM_ID,
): [PublicKey, number] {
  if (payload.length !== 32) throw new Error(`payload must be 32 bytes, got ${payload.length}`);
  return PublicKey.findProgramAddressSync(
    [enc("sig"), requester.toBytes(), payload],
    sodaProgramId,
  );
}

/** The pool's Base address: deriveEthAddress(group_pk, pool, [], EVM_CHAIN_TAG). */
export function poolEvmAddress(
  groupPk: Uint8Array = GROUP_PK,
  programId: PublicKey = INTENTS_PROGRAM_ID,
): Uint8Array {
  const [pool] = poolPda(programId);
  return deriveEthAddress(groupPk, pool.toBytes(), new Uint8Array(0), EVM_CHAIN_TAG).ethAddress;
}

/** A wallet's own SODA-derived Base address (the page's default recipient). */
export function walletEvmAddress(wallet: PublicKey, groupPk: Uint8Array = GROUP_PK): Uint8Array {
  return deriveEthAddress(groupPk, wallet.toBytes(), new Uint8Array(0), EVM_CHAIN_TAG).ethAddress;
}
