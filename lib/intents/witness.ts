// soda_witness Claim accounts as intents reads them for credit_solver_from_claim
// (HANDOVER §3.7, §4.2). Decoded by hand, mirroring the program's own parser.

import { PublicKey } from "@solana/web3.js";
import { bytesToHex } from "@noble/hashes/utils";
import { CHAIN_ID } from "./constants";
import { accountDiscriminator } from "./accounts";

export const DEFAULT_WITNESS_PROGRAM_ID = "5v97wLYgMzyfQfpZWGQ6uPXTHh4JsJitUXPReYy2uuTp";
/** 8-byte discriminator + 147 bytes of Borsh. */
export const WITNESS_CLAIM_SIZE = 155;
/** Chainlink's production keystone forwarder (checks f+1 DON signatures). */
export const PRODUCTION_FORWARDER_ID = "CXsKEJcs25TQEYU2e5jZ8QTPE3ffMLZhH6BWHrdcCCB5";
/** soda_witness Config: disc, admin, forwarder_program, forwarder_state, workflow_owner 20, workflow_name 10, bump. */
export const WITNESS_CONFIG_SIZE = 135;

export function witnessConfigPda(
  witnessProgram: PublicKey = new PublicKey(DEFAULT_WITNESS_PROGRAM_ID),
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("config")], witnessProgram);
}

/**
 * Mirrors the program's witness_trusted: claims credit without the admin only
 * when the witness takes reports from the production forwarder with
 * workflow_owner pinned. Under the mock forwarder anyone can forge a claim.
 */
export function witnessTrusted(configData: Uint8Array): boolean {
  if (configData.length < WITNESS_CONFIG_SIZE) return false;
  const forwarder = new PublicKey(configData.subarray(40, 72));
  return forwarder.toBase58() === PRODUCTION_FORWARDER_ID && configData.subarray(104, 124).some((b) => b !== 0);
}

export enum ClaimStatus {
  Pending = 0,
  Recorded = 1,
}

export type WitnessClaim = {
  requester: PublicKey;
  chainId: bigint;
  txHash: Uint8Array;
  status: ClaimStatus;
  from: Uint8Array;
  to: Uint8Array;
  valueWei: bigint;
  block: bigint;
  success: boolean;
  recordedAt: bigint;
  bump: number;
};

const CLAIM_DISC = accountDiscriminator("Claim");

export function decodeWitnessClaim(data: Uint8Array): WitnessClaim {
  if (data.length < WITNESS_CLAIM_SIZE) throw new Error(`Claim must be ${WITNESS_CLAIM_SIZE} bytes, got ${data.length}`);
  if (bytesToHex(data.subarray(0, 8)) !== bytesToHex(CLAIM_DISC)) throw new Error("not a soda_witness Claim (discriminator)");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8;
  const take = (n: number) => data.slice(o, (o += n));
  const u64 = () => ((o += 8), v.getBigUint64(o - 8, true));
  const requester = new PublicKey(take(32));
  const chainId = u64();
  const txHash = take(32);
  const status = data[o++] as ClaimStatus;
  const from = take(20);
  const to = take(20);
  const valueWei = u64() | (u64() << 64n);
  const block = u64();
  const success = data[o++];
  if (success > 1) throw new Error("Claim.success is not a bool");
  const recordedAt = ((o += 8), v.getBigInt64(o - 8, true));
  const bump = data[o++];
  return { requester, chainId, txHash, status, from, to, valueWei, block, success: success === 1, recordedAt, bump };
}

/**
 * Why credit_solver_from_claim would reject this claim for this solver, in the
 * program's order (empty when it would pass the fact checks). The Credit PDA
 * and the claim's owner are checked separately.
 */
export function claimCreditProblems(
  claim: WitnessClaim,
  poolEvmAddr: Uint8Array,
  solver: { authority: PublicKey; depositFrom: Uint8Array },
): string[] {
  const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
  const out: string[] = [];
  if (claim.status !== ClaimStatus.Recorded) out.push("ClaimNotRecorded: CRE has not written the report yet");
  else if (!claim.success) out.push("DepositReverted: the Base transaction reverted");
  if (claim.chainId !== CHAIN_ID) out.push(`ClaimWrongChain: chain ${claim.chainId}, want ${CHAIN_ID}`);
  if (claim.status === ClaimStatus.Recorded) {
    if (hex(claim.to) !== hex(poolEvmAddr)) out.push(`DepositNotToPool: to ${hex(claim.to)}, pool is ${hex(poolEvmAddr)}`);
    if (hex(claim.from) !== hex(solver.depositFrom)) {
      out.push(`DepositNotFromSolver: from ${hex(claim.from)}, solver deposit_from is ${hex(solver.depositFrom)}`);
    }
  }
  if (!claim.requester.equals(solver.authority)) {
    out.push(`ClaimNotBySolver: requester ${claim.requester.toBase58()}, solver authority ${solver.authority.toBase58()}`);
  }
  if (claim.status === ClaimStatus.Recorded && claim.valueWei === 0n) out.push("ZeroAmount: the deposit moved no ETH");
  return out;
}
