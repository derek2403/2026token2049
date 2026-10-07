// Solana side shared by the solver bot and the operator CLI: the Anchor client
// for idl/intents.json, instruction builders, sending with polling confirmation,
// error names, and the cluster clock.

import { AnchorProvider, BN, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  COMMITTEE_PDA,
  INTENTS_IDL,
  SODA_PROGRAM_ID,
  configPda,
  creditPda,
  intentPda,
  payoutSigRequest,
  poolPda,
  solverPda,
  withdrawalPda,
  witnessConfigPda,
  type IntentAccount,
  type WithdrawalAccount,
} from "../../../lib/intents";

export const FILL_COMPUTE_UNITS = 300_000;

export function connection(rpcUrl: string, wsUrl?: string): Connection {
  return new Connection(rpcUrl, { commitment: "confirmed", wsEndpoint: wsUrl });
}

export function intentsProgram(conn: Connection, signer: Keypair, programId: PublicKey): Program {
  const idl = { ...(INTENTS_IDL as Idl), address: programId.toBase58() } as Idl;
  const provider = new AnchorProvider(conn, new Wallet(signer), { commitment: "confirmed" });
  return new Program(idl, provider);
}

const bn = (v: bigint | number) => new BN(v.toString());
const arrN = (n: number, what: string) => (b: Uint8Array) => {
  if (b.length !== n) throw new Error(`${what} must be ${n} bytes, got ${b.length}`);
  return Array.from(b);
};
const arr20 = arrN(20, "address");
const arr32 = arrN(32, "tx hash");
const arr65 = arrN(65, "signature");

// ---------------------------------------------------------------- clock

/** Clock sysvar: slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64. */
export function decodeClockUnixTimestamp(data: Uint8Array): bigint {
  if (data.length < 40) throw new Error("Clock sysvar data too short");
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(32, true);
}

export async function clusterTime(conn: Connection): Promise<bigint> {
  const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (!info) throw new Error("Clock sysvar not found");
  return decodeClockUnixTimestamp(info.data);
}

// ---------------------------------------------------------------- errors

const IDL_ERRORS = new Map<number, string>(
  ((INTENTS_IDL as Idl).errors ?? []).map((e) => [e.code, e.name]),
);

export class TxError extends Error {
  constructor(
    message: string,
    readonly logs: string[],
    readonly signature?: string,
    /** The intents program's error name (e.g. "NonceMoved"), when it was the one that failed. */
    readonly errorName?: string,
  ) {
    super(message);
  }
}

/**
 * The intents error name from a failed transaction's logs. Anchor logs
 * "Error Code: <Name>." from whichever program threw; the name sets of intents
 * and soda do not overlap. Falls back to "custom program error: 0x…" on a line
 * naming the intents program.
 */
export function intentsErrorName(logs: readonly string[], message: string, programId: PublicKey): string | undefined {
  const all = [...logs, message];
  for (const l of all) {
    const m = /Error Code: (\w+)\./.exec(l);
    if (m) return m[1];
  }
  const id = programId.toBase58();
  for (const l of all) {
    const m = /Program (\w+) failed: custom program error: 0x([0-9a-fA-F]+)/.exec(l);
    if (m && m[1] === id) return IDL_ERRORS.get(parseInt(m[2], 16));
  }
  return undefined;
}

function logsOf(e: unknown): string[] {
  const o = e as { logs?: unknown; transactionLogs?: unknown };
  if (Array.isArray(o?.logs)) return o.logs as string[];
  if (Array.isArray(o?.transactionLogs)) return o.transactionLogs as string[];
  return [];
}

// ---------------------------------------------------------------- sending

export type SendOptions = {
  computeUnits?: number;
  priorityMicroLamports?: number;
  extraSigners?: Keypair[];
  timeoutMs?: number;
};

/**
 * Sends with preflight (so a lost race fails fast with logs) and confirms by
 * polling getSignatureStatuses over HTTP, so no websocket is needed.
 */
export async function sendIxs(
  conn: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
  programId: PublicKey,
  opts: SendOptions = {},
): Promise<string> {
  const pre: TransactionInstruction[] = [];
  if (opts.computeUnits) pre.push(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnits }));
  if (opts.priorityMicroLamports) {
    pre.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.priorityMicroLamports }));
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...pre, ...ixs);
  tx.sign(payer, ...(opts.extraSigners ?? []));

  let signature: string;
  try {
    signature = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 5 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const logs = logsOf(e);
    throw new TxError(message, logs, undefined, intentsErrorName(logs, message, programId));
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (let i = 0; ; i++) {
    const { value } = await conn.getSignatureStatuses([signature]);
    const st = value[0];
    if (st?.err) {
      const t = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const logs = t?.meta?.logMessages ?? [];
      const message = `transaction ${signature} failed: ${JSON.stringify(st.err)}`;
      throw new TxError(message, logs, signature, intentsErrorName(logs, message, programId));
    }
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return signature;
    if (Date.now() > deadline) throw new TxError(`transaction ${signature} not confirmed in time`, [], signature);
    if (i % 10 === 9 && (await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      throw new TxError(`transaction ${signature} expired (blockhash too old)`, [], signature);
    }
    await sleep(400);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- instructions

type Ix = Promise<TransactionInstruction>;

export function initConfigIx(
  program: Program,
  admin: PublicKey,
  poolEvmAddr: Uint8Array,
  maxGasPrice: bigint,
  l1FeeBufferWei: bigint,
  minGasPrice: bigint,
): Ix {
  return program.methods
    .initConfig(arr20(poolEvmAddr), bn(maxGasPrice), bn(l1FeeBufferWei), bn(minGasPrice))
    .accountsStrict({
      admin,
      config: configPda(program.programId)[0],
      pool: poolPda(program.programId)[0],
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** `depositSig`: deposit_from's personal_sign over depositProofMessage(authority) (evm.signDepositProof). */
export function registerSolverIx(
  program: Program,
  authority: PublicKey,
  payoutAddr: Uint8Array,
  depositFrom: Uint8Array,
  depositSig: Uint8Array,
): Ix {
  return program.methods
    .registerSolver(arr20(payoutAddr), arr20(depositFrom), arr65(depositSig))
    .accountsStrict({
      authority,
      solver: solverPda(authority, program.programId)[0],
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/**
 * Admin credit for the deposit `txHash`. Writes the Credit PDA, so the deposit
 * can never also be credited from a claim (or twice by the admin). Amount 0
 * only marks a deposit credited before the marker existed.
 */
export function creditSolverIx(
  program: Program,
  admin: PublicKey,
  solverAuthority: PublicKey,
  amountWei: bigint,
  txHash: Uint8Array,
): Ix {
  return program.methods
    .creditSolver(bn(amountWei), arr32(txHash))
    .accountsStrict({
      admin,
      config: configPda(program.programId)[0],
      solver: solverPda(solverAuthority, program.programId)[0],
      credit: creditPda(txHash, program.programId)[0],
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/**
 * Phase 2: credit a deposit recorded in a soda_witness Claim. The claim's
 * requester must be `solverAuthority`; `txHash` is its tx_hash (it keys the
 * Credit PDA). `admin` must co-sign unless witnessTrusted(witness Config), i.e.
 * always while the witness runs on the mock forwarder.
 */
export function creditSolverFromClaimIx(
  program: Program,
  payer: PublicKey,
  solverAuthority: PublicKey,
  claim: PublicKey,
  txHash: Uint8Array,
  opts: { admin?: PublicKey; witnessProgram?: PublicKey } = {},
): Ix {
  return program.methods
    .creditSolverFromClaim(arr32(txHash))
    .accountsStrict({
      payer,
      // null is Anchor's None (the program id, unsigned); the generic Idl type cannot say so.
      admin: opts.admin ?? (null as unknown as PublicKey),
      config: configPda(program.programId)[0],
      solver: solverPda(solverAuthority, program.programId)[0],
      claim,
      witnessConfig: witnessConfigPda(opts.witnessProgram)[0],
      credit: creditPda(txHash, program.programId)[0],
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export function setPausedIx(program: Program, admin: PublicKey, paused: boolean): Ix {
  return program.methods
    .setPaused(paused)
    .accountsStrict({ admin, config: configPda(program.programId)[0] })
    .instruction();
}

export function setMaxGasPriceIx(program: Program, admin: PublicKey, maxGasPrice: bigint): Ix {
  return program.methods
    .setMaxGasPrice(bn(maxGasPrice))
    .accountsStrict({ admin, config: configPda(program.programId)[0] })
    .instruction();
}

export function setMinGasPriceIx(program: Program, admin: PublicKey, minGasPrice: bigint): Ix {
  return program.methods
    .setMinGasPrice(bn(minGasPrice))
    .accountsStrict({ admin, config: configPda(program.programId)[0] })
    .instruction();
}

export type OpenIntentArgs = {
  intentId: bigint;
  inLamports: bigint;
  recipient: Uint8Array;
  startOutWei: bigint;
  minOutWei: bigint;
  auctionDuration: number;
  expiresAt: bigint;
};

export function openIntentIx(program: Program, user: PublicKey, a: OpenIntentArgs): Ix {
  return program.methods
    .openIntent(
      bn(a.intentId),
      bn(a.inLamports),
      arr20(a.recipient),
      bn(a.startOutWei),
      bn(a.minOutWei),
      a.auctionDuration,
      bn(a.expiresAt),
    )
    .accountsStrict({
      user,
      config: configPda(program.programId)[0],
      intent: intentPda(user, a.intentId, program.programId)[0],
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export function cancelIntentIx(program: Program, user: PublicKey, intent: PublicKey): Ix {
  return program.methods.cancelIntent().accountsStrict({ user, intent }).instruction();
}

/** `closer` is the user for a Cancelled intent, the admin for a Filled one; rent goes to `user`. */
export function closeIntentIx(program: Program, closer: PublicKey, user: PublicKey, intent: PublicKey): Ix {
  return program.methods
    .closeIntent()
    .accountsStrict({ closer, user, config: configPda(program.programId)[0], intent })
    .instruction();
}

/** Remaining accounts offering SigRequest slots for reuse once all four are taken. */
const offered = (keys: PublicKey[]) => keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));

const sodaAccounts = (programId: PublicKey) => ({
  committee: COMMITTEE_PDA,
  pool: poolPda(programId)[0],
  sodaProgram: SODA_PROGRAM_ID,
  systemProgram: SystemProgram.programId,
});

/** fill: the sig_request address comes from the payout RLP rebuilt off-chain. */
export function fillIx(
  program: Program,
  solverAuthority: PublicKey,
  intentKey: PublicKey,
  intent: Pick<IntentAccount, "recipient">,
  expectedNonce: bigint,
  outWei: bigint,
  gasPrice: bigint,
): { ix: Ix; sigRequest: PublicKey; unsignedRlp: Uint8Array } {
  const { sigRequest, unsignedRlp } = payoutSigRequest(
    { recipient: intent.recipient, outWei, baseNonce: expectedNonce, gasPrice },
    program.programId,
  );
  const ix = program.methods
    .fill(bn(expectedNonce), bn(outWei), bn(gasPrice))
    .accountsStrict({
      solverAuthority,
      solver: solverPda(solverAuthority, program.programId)[0],
      config: configPda(program.programId)[0],
      intent: intentKey,
      sigRequest,
      ...sodaAccounts(program.programId),
    })
    .instruction();
  return { ix, sigRequest, unsignedRlp };
}

/** bump_gas re-signs the same payout at the same nonce with a higher gas price. */
export function bumpGasIx(
  program: Program,
  caller: PublicKey,
  intentKey: PublicKey,
  intent: Pick<IntentAccount, "recipient" | "outWei" | "baseNonce" | "solver">,
  newGasPrice: bigint,
  reuse: PublicKey[] = [],
): { ix: Ix; sigRequest: PublicKey; unsignedRlp: Uint8Array } {
  const { sigRequest, unsignedRlp } = payoutSigRequest(
    { recipient: intent.recipient, outWei: intent.outWei, baseNonce: intent.baseNonce, gasPrice: newGasPrice },
    program.programId,
  );
  const ix = program.methods
    .bumpGas(bn(newGasPrice))
    .accountsStrict({
      caller,
      solver: solverPda(intent.solver, program.programId)[0],
      config: configPda(program.programId)[0],
      intent: intentKey,
      sigRequest,
      ...sodaAccounts(program.programId),
    })
    .remainingAccounts(offered(reuse))
    .instruction();
  return { ix, sigRequest, unsignedRlp };
}

/** bump_withdrawal_gas: bump_gas for a solver_withdraw payout. */
export function bumpWithdrawalGasIx(
  program: Program,
  caller: PublicKey,
  withdrawal: Pick<WithdrawalAccount, "payoutAddr" | "amountWei" | "baseNonce" | "solver">,
  newGasPrice: bigint,
  reuse: PublicKey[] = [],
): { ix: Ix; sigRequest: PublicKey; unsignedRlp: Uint8Array } {
  const { sigRequest, unsignedRlp } = payoutSigRequest(
    { recipient: withdrawal.payoutAddr, outWei: withdrawal.amountWei, baseNonce: withdrawal.baseNonce, gasPrice: newGasPrice },
    program.programId,
  );
  const ix = program.methods
    .bumpWithdrawalGas(bn(newGasPrice))
    .accountsStrict({
      caller,
      solver: solverPda(withdrawal.solver, program.programId)[0],
      config: configPda(program.programId)[0],
      withdrawal: withdrawalPda(withdrawal.baseNonce, program.programId)[0],
      sigRequest,
      ...sodaAccounts(program.programId),
    })
    .remainingAccounts(offered(reuse))
    .instruction();
  return { ix, sigRequest, unsignedRlp };
}

export function solverWithdrawIx(
  program: Program,
  solverAuthority: PublicKey,
  payoutAddr: Uint8Array,
  expectedNonce: bigint,
  amountWei: bigint,
  gasPrice: bigint,
): { ix: Ix; sigRequest: PublicKey; unsignedRlp: Uint8Array } {
  const { sigRequest, unsignedRlp } = payoutSigRequest(
    { recipient: payoutAddr, outWei: amountWei, baseNonce: expectedNonce, gasPrice },
    program.programId,
  );
  const ix = program.methods
    .solverWithdraw(bn(expectedNonce), bn(amountWei), bn(gasPrice))
    .accountsStrict({
      solverAuthority,
      solver: solverPda(solverAuthority, program.programId)[0],
      config: configPda(program.programId)[0],
      withdrawal: withdrawalPda(expectedNonce, program.programId)[0],
      sigRequest,
      ...sodaAccounts(program.programId),
    })
    .instruction();
  return { ix, sigRequest, unsignedRlp };
}
