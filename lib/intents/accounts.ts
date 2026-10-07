// Account and event decoding for the intents program (HANDOVER §3.3, §3.4, §5.4).

import { Buffer } from "buffer";
import bs58 from "bs58";
import { BorshAccountsCoder, BorshEventCoder, type Idl } from "@coral-xyz/anchor";
import {
  PublicKey,
  type Connection,
  type GetProgramAccountsFilter,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2";
import { hexToBytes } from "@noble/hashes/utils";
import { INTENTS_PROGRAM_ID, IntentStatus } from "./constants";
import { INTENTS_IDL } from "./idl";
import { configPda, solverPda, withdrawalPda } from "./pdas";
import { decodeSigRequest, type SigRequestAccount } from "./payout";

// ---------------------------------------------------------------- types

export type ConfigAccount = {
  admin: PublicKey;
  poolBump: number;
  poolEvmAddr: Uint8Array;
  nextNonce: bigint;
  maxGasPrice: bigint;
  l1FeeBufferWei: bigint;
  paused: boolean;
  witnessProgram: PublicKey;
  /** Floor for fill, solver_withdraw and bump gas prices. */
  minGasPrice: bigint;
};

export type SolverAccount = {
  authority: PublicKey;
  payoutAddr: Uint8Array;
  depositFrom: Uint8Array;
  balanceWei: bigint;
  fills: bigint;
  bump: number;
};

export type IntentAccount = {
  user: PublicKey;
  intentId: bigint;
  inLamports: bigint;
  recipient: Uint8Array;
  startOutWei: bigint;
  minOutWei: bigint;
  auctionStart: bigint;
  auctionDuration: number;
  expiresAt: bigint;
  status: IntentStatus;
  /** The filling solver's authority (wallet). Default pubkey while Open. */
  solver: PublicKey;
  outWei: bigint;
  baseNonce: bigint;
  /** Latest signed gas price; bump_gas overwrites it. */
  gasPrice: bigint;
  filledAt: bigint;
  sigRequests: PublicKey[];
  sigRequestCount: number;
  bump: number;
};

/** A solver_withdraw payout, kept on-chain so it can be bumped like a fill. */
export type WithdrawalAccount = {
  solver: PublicKey;
  payoutAddr: Uint8Array;
  amountWei: bigint;
  baseNonce: bigint;
  gasPrice: bigint;
  createdAt: bigint;
  sigRequests: PublicKey[];
  sigRequestCount: number;
  bump: number;
};

export type Keyed<T> = { pubkey: PublicKey; account: T };

// Layout facts (8-byte discriminator + Borsh), checked against the IDL in tests.
export const CONFIG_SIZE = 126;
export const WITHDRAWAL_SIZE = 230;
export const SOLVER_SIZE = 105;
export const INTENT_SIZE = 331;
/** Phase 2 `Credit` at ["credit", tx_hash]: rent paid by whoever submits the credit. */
export const CREDIT_SIZE = 129;
export const INTENT_USER_OFFSET = 8;
export const INTENT_STATUS_OFFSET = 128;

/** sha256("account:<Name>")[..8] */
export function accountDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`account:${name}`)).slice(0, 8);
}

/** sha256("event:<Name>")[..8] */
export function eventDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`event:${name}`)).slice(0, 8);
}

// ---------------------------------------------------------------- coders

let coders: { accounts: BorshAccountsCoder; events: BorshEventCoder } | null = null;

export function intentsCoders(idl: Idl = INTENTS_IDL) {
  if (idl !== INTENTS_IDL) return { accounts: new BorshAccountsCoder(idl), events: new BorshEventCoder(idl) };
  coders ??= { accounts: new BorshAccountsCoder(idl), events: new BorshEventCoder(idl) };
  return coders;
}

type Raw = Record<string, unknown>;

// The 0.30+ IDL keeps Rust's snake_case; accept camelCase too.
function f(raw: Raw, snake: string): unknown {
  if (snake in raw) return raw[snake];
  const camel = snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  if (camel in raw) return raw[camel];
  throw new Error(`decoded account/event is missing field ${snake}`);
}
const big = (v: unknown) => BigInt((v as { toString(): string }).toString());
const num = (v: unknown) => Number(big(v));
const bytes = (v: unknown) => Uint8Array.from(v as ArrayLike<number>);
const key = (v: unknown) => (v instanceof PublicKey ? v : new PublicKey(v as string));

function toBuffer(data: Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export function decodeConfig(data: Uint8Array): ConfigAccount {
  const r = intentsCoders().accounts.decode<Raw>("Config", toBuffer(data));
  return {
    admin: key(f(r, "admin")),
    poolBump: num(f(r, "pool_bump")),
    poolEvmAddr: bytes(f(r, "pool_evm_addr")),
    nextNonce: big(f(r, "next_nonce")),
    maxGasPrice: big(f(r, "max_gas_price")),
    l1FeeBufferWei: big(f(r, "l1_fee_buffer_wei")),
    paused: Boolean(f(r, "paused")),
    witnessProgram: key(f(r, "witness_program")),
    minGasPrice: big(f(r, "min_gas_price")),
  };
}

export function decodeSolver(data: Uint8Array): SolverAccount {
  const r = intentsCoders().accounts.decode<Raw>("Solver", toBuffer(data));
  return {
    authority: key(f(r, "authority")),
    payoutAddr: bytes(f(r, "payout_addr")),
    depositFrom: bytes(f(r, "deposit_from")),
    balanceWei: big(f(r, "balance_wei")),
    fills: big(f(r, "fills")),
    bump: num(f(r, "bump")),
  };
}

export function decodeIntent(data: Uint8Array): IntentAccount {
  const r = intentsCoders().accounts.decode<Raw>("Intent", toBuffer(data));
  return {
    user: key(f(r, "user")),
    intentId: big(f(r, "intent_id")),
    inLamports: big(f(r, "in_lamports")),
    recipient: bytes(f(r, "recipient")),
    startOutWei: big(f(r, "start_out_wei")),
    minOutWei: big(f(r, "min_out_wei")),
    auctionStart: big(f(r, "auction_start")),
    auctionDuration: num(f(r, "auction_duration")),
    expiresAt: big(f(r, "expires_at")),
    status: num(f(r, "status")) as IntentStatus,
    solver: key(f(r, "solver")),
    outWei: big(f(r, "out_wei")),
    baseNonce: big(f(r, "base_nonce")),
    gasPrice: big(f(r, "gas_price")),
    filledAt: big(f(r, "filled_at")),
    sigRequests: (f(r, "sig_requests") as unknown[]).map(key),
    sigRequestCount: num(f(r, "sig_request_count")),
    bump: num(f(r, "bump")),
  };
}

export function decodeWithdrawal(data: Uint8Array): WithdrawalAccount {
  const r = intentsCoders().accounts.decode<Raw>("Withdrawal", toBuffer(data));
  return {
    solver: key(f(r, "solver")),
    payoutAddr: bytes(f(r, "payout_addr")),
    amountWei: big(f(r, "amount_wei")),
    baseNonce: big(f(r, "base_nonce")),
    gasPrice: big(f(r, "gas_price")),
    createdAt: big(f(r, "created_at")),
    sigRequests: (f(r, "sig_requests") as unknown[]).map(key),
    sigRequestCount: num(f(r, "sig_request_count")),
    bump: num(f(r, "bump")),
  };
}

/** A withdrawal in the shape buildCandidates takes (its payout_addr is the recipient). */
export function withdrawalPayoutFields(w: WithdrawalAccount) {
  return {
    recipient: w.payoutAddr,
    outWei: w.amountWei,
    baseNonce: w.baseNonce,
    gasPrice: w.gasPrice,
    sigRequests: w.sigRequests,
    sigRequestCount: w.sigRequestCount,
  };
}

// ---------------------------------------------------------------- fetching

export function intentFilters(opts: { user?: PublicKey; status?: IntentStatus } = {}): GetProgramAccountsFilter[] {
  // Config.admin, Solver.authority and Intent.user all sit at offset 8, so the
  // discriminator filter is what makes the user filter mean "Intent.user".
  const filters: GetProgramAccountsFilter[] = [
    { memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator("Intent")) } },
  ];
  if (opts.user) filters.push({ memcmp: { offset: INTENT_USER_OFFSET, bytes: opts.user.toBase58() } });
  if (opts.status !== undefined) {
    filters.push({ memcmp: { offset: INTENT_STATUS_OFFSET, bytes: bs58.encode([opts.status]) } });
  }
  return filters;
}

export async function fetchConfig(
  conn: Connection,
  programId: PublicKey = INTENTS_PROGRAM_ID,
): Promise<ConfigAccount | null> {
  const info = await conn.getAccountInfo(configPda(programId)[0]);
  return info ? decodeConfig(info.data) : null;
}

export async function fetchSolver(
  conn: Connection,
  authority: PublicKey,
  programId: PublicKey = INTENTS_PROGRAM_ID,
): Promise<SolverAccount | null> {
  const info = await conn.getAccountInfo(solverPda(authority, programId)[0]);
  return info ? decodeSolver(info.data) : null;
}

export async function fetchIntent(conn: Connection, intent: PublicKey): Promise<IntentAccount | null> {
  const info = await conn.getAccountInfo(intent);
  return info ? decodeIntent(info.data) : null;
}

async function fetchIntents(
  conn: Connection,
  filters: GetProgramAccountsFilter[],
  programId: PublicKey,
): Promise<Keyed<IntentAccount>[]> {
  const rows = await conn.getProgramAccounts(programId, { filters });
  return rows.map(({ pubkey, account }) => ({ pubkey, account: decodeIntent(account.data) }));
}

/** The Activity panel's query (§5.4). Closed intents are gone from it. */
export function fetchIntentsByUser(
  conn: Connection,
  user: PublicKey,
  programId: PublicKey = INTENTS_PROGRAM_ID,
): Promise<Keyed<IntentAccount>[]> {
  return fetchIntents(conn, intentFilters({ user }), programId);
}

/** The solver bot's polling fallback (§3.6). */
export function fetchOpenIntents(
  conn: Connection,
  programId: PublicKey = INTENTS_PROGRAM_ID,
): Promise<Keyed<IntentAccount>[]> {
  return fetchIntents(conn, intentFilters({ status: IntentStatus.Open }), programId);
}

/**
 * Withdrawals at pool nonces [from, to), read by PDA. Nonces taken by fills
 * have no Withdrawal and are skipped.
 */
export async function fetchWithdrawalsInRange(
  conn: Connection,
  from: bigint,
  to: bigint,
  programId: PublicKey = INTENTS_PROGRAM_ID,
): Promise<Keyed<WithdrawalAccount>[]> {
  const keys: PublicKey[] = [];
  for (let n = from; n < to; n++) keys.push(withdrawalPda(n, programId)[0]);
  const out: Keyed<WithdrawalAccount>[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(keys.slice(i, i + 100));
    infos.forEach((info, j) => {
      if (info) out.push({ pubkey: keys[i + j], account: decodeWithdrawal(info.data) });
    });
  }
  return out;
}

/** Decoded SigRequests in the same order as `keys`; null where the account does not exist yet. */
export async function fetchSigRequests(
  conn: Connection,
  keys: PublicKey[],
): Promise<(SigRequestAccount | null)[]> {
  if (keys.length === 0) return [];
  const infos = await conn.getMultipleAccountsInfo(keys);
  return infos.map((info) => (info ? decodeSigRequest(info.data) : null));
}

/** An intent's live sig_requests (only the first sig_request_count entries). */
export function fetchIntentSigRequests(
  conn: Connection,
  intent: IntentAccount,
): Promise<(SigRequestAccount | null)[]> {
  return fetchSigRequests(conn, intent.sigRequests.slice(0, intent.sigRequestCount));
}

// ---------------------------------------------------------------- events

export const ETH_TX_REQUESTED_DISCRIMINATOR = hexToBytes("b19f579d04a22205");

export type EthTxRequestedEvent = {
  name: "EthTxRequested";
  sigRequest: PublicKey;
  chainId: bigint;
  unsignedRlp: Uint8Array;
};

export type IntentOpenedEvent = {
  name: "IntentOpened";
  intent: PublicKey;
  user: PublicKey;
  intentId: bigint;
  inLamports: bigint;
  recipient: Uint8Array;
  startOutWei: bigint;
  minOutWei: bigint;
  auctionStart: bigint;
  auctionDuration: number;
  expiresAt: bigint;
};

export type IntentFilledEvent = {
  name: "IntentFilled";
  intent: PublicKey;
  user: PublicKey;
  solver: PublicKey;
  inLamports: bigint;
  outWei: bigint;
  baseNonce: bigint;
  gasPrice: bigint;
  sigRequest: PublicKey;
  filledAt: bigint;
};

export type GasBumpedEvent = {
  name: "GasBumped";
  intent: PublicKey;
  caller: PublicKey;
  solver: PublicKey;
  baseNonce: bigint;
  oldGasPrice: bigint;
  newGasPrice: bigint;
  sigRequest: PublicKey;
  sigRequestCount: number;
};

export type IntentCancelledEvent = {
  name: "IntentCancelled";
  intent: PublicKey;
  user: PublicKey;
  refundedLamports: bigint;
};

/** Any other event in the IDL (SolverCredited, SolverWithdrew), with raw field names. */
export type OtherIntentsEvent = { name: "Other"; eventName: string; data: Record<string, unknown> };

export type IntentsEvent =
  | EthTxRequestedEvent
  | IntentOpenedEvent
  | IntentFilledEvent
  | GasBumpedEvent
  | IntentCancelledEvent
  | OtherIntentsEvent;

/**
 * EthTxRequested decoded by hand from its fixed discriminator and layout
 * (Pubkey, u64, Vec<u8>), the shape frontier's relayer matches on.
 */
export function decodeEthTxRequested(data: Uint8Array): EthTxRequestedEvent | null {
  for (let i = 0; i < 8; i++) if (data[i] !== ETH_TX_REQUESTED_DISCRIMINATOR[i]) return null;
  if (data.length < 8 + 32 + 8 + 4) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = dv.getUint32(48, true);
  if (data.length < 52 + len) return null;
  return {
    name: "EthTxRequested",
    sigRequest: new PublicKey(data.slice(8, 40)),
    chainId: dv.getBigUint64(40, true),
    unsignedRlp: data.slice(52, 52 + len),
  };
}

/** Decode one `Program data:` payload (base64, without the prefix). */
export function decodeIntentsEvent(base64: string): IntentsEvent | null {
  const data = Uint8Array.from(Buffer.from(base64, "base64"));
  const eth = decodeEthTxRequested(data);
  if (eth) return eth;
  const ev = intentsCoders().events.decode(base64);
  if (!ev) return null;
  const r = ev.data as Raw;
  switch (ev.name) {
    case "EthTxRequested":
      return null; // handled above; unreachable unless the IDL disagrees
    case "IntentOpened":
      return {
        name: "IntentOpened",
        intent: key(f(r, "intent")),
        user: key(f(r, "user")),
        intentId: big(f(r, "intent_id")),
        inLamports: big(f(r, "in_lamports")),
        recipient: bytes(f(r, "recipient")),
        startOutWei: big(f(r, "start_out_wei")),
        minOutWei: big(f(r, "min_out_wei")),
        auctionStart: big(f(r, "auction_start")),
        auctionDuration: num(f(r, "auction_duration")),
        expiresAt: big(f(r, "expires_at")),
      };
    case "IntentFilled":
      return {
        name: "IntentFilled",
        intent: key(f(r, "intent")),
        user: key(f(r, "user")),
        solver: key(f(r, "solver")),
        inLamports: big(f(r, "in_lamports")),
        outWei: big(f(r, "out_wei")),
        baseNonce: big(f(r, "base_nonce")),
        gasPrice: big(f(r, "gas_price")),
        sigRequest: key(f(r, "sig_request")),
        filledAt: big(f(r, "filled_at")),
      };
    case "GasBumped":
      return {
        name: "GasBumped",
        intent: key(f(r, "intent")),
        caller: key(f(r, "caller")),
        solver: key(f(r, "solver")),
        baseNonce: big(f(r, "base_nonce")),
        oldGasPrice: big(f(r, "old_gas_price")),
        newGasPrice: big(f(r, "new_gas_price")),
        sigRequest: key(f(r, "sig_request")),
        sigRequestCount: num(f(r, "sig_request_count")),
      };
    case "IntentCancelled":
      return {
        name: "IntentCancelled",
        intent: key(f(r, "intent")),
        user: key(f(r, "user")),
        refundedLamports: big(f(r, "refunded_lamports")),
      };
    default:
      return { name: "Other", eventName: ev.name, data: r };
  }
}

const INVOKE_RE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT_RE = /^Program (\w+) (success|failed)/;
const DATA_PREFIX = "Program data: ";

/**
 * Events from a transaction's log messages, keeping only `Program data:` lines
 * emitted while the intents program is the innermost frame. That drops soda's
 * own SigRequested (emitted inside the CPI) and anything another program emits
 * with a colliding name.
 */
export function parseIntentsLogs(
  logs: readonly string[],
  programId: PublicKey = INTENTS_PROGRAM_ID,
): IntentsEvent[] {
  const id = programId.toBase58();
  const stack: string[] = [];
  const out: IntentsEvent[] = [];
  for (const line of logs) {
    const inv = INVOKE_RE.exec(line);
    if (inv) {
      stack.push(inv[1]);
      continue;
    }
    if (EXIT_RE.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith(DATA_PREFIX) && stack[stack.length - 1] === id) {
      const ev = decodeIntentsEvent(line.slice(DATA_PREFIX.length));
      if (ev) out.push(ev);
    }
  }
  return out;
}

/** Every gas price an intent's payout was signed at, for buildCandidates' hints. */
export function gasPricesFromEvents(events: IntentsEvent[], intent: PublicKey): bigint[] {
  const out: bigint[] = [];
  for (const e of events) {
    if (e.name === "IntentFilled" && e.intent.equals(intent)) out.push(e.gasPrice);
    if (e.name === "GasBumped" && e.intent.equals(intent)) out.push(e.oldGasPrice, e.newGasPrice);
  }
  return [...new Set(out)];
}

/** sig_request (base58) → unsigned RLP, from EthTxRequested events. */
export function unsignedRlpBySigRequest(events: IntentsEvent[]): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const e of events) if (e.name === "EthTxRequested") out.set(e.sigRequest.toBase58(), e.unsignedRlp);
  return out;
}
