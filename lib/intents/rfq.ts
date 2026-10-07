// RFQ-lite, NEAR Intents style (programs/programs/intents/src/rfq.rs): the user
// signs a canonical text message in Phantom and the winning solver submits it
// with execute_signed_intent. renderIntentMessage must produce the bytes the
// program renders; lib/intents/rfq-vectors.json pins both sides.

import { Buffer } from "buffer";
import bs58 from "bs58";
import { PublicKey, type Connection } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { INTENTS_PROGRAM_ID, IntentStatus } from "./constants";
import { intentsCoders, type IntentAccount } from "./accounts";
import { intentPda } from "./pdas";

/** The program refuses a deadline more than this far past its own clock. */
export const RFQ_MAX_DEADLINE_SECS = 600n;
/** UserVault: 8 discriminator + owner 32 + sol 8 + bump 1. */
export const USER_VAULT_SIZE = 49;

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

/** What the user signs. out_wei and the Base nonce are the solver's and not signed. */
export type IntentMessageFields = {
  user: PublicKey;
  nonce: bigint;
  deadline: bigint;
  sellLamports: bigint;
  minOutWei: bigint;
  recipient: Uint8Array;
};

export type ParsedIntentMessage = IntentMessageFields & { programId: PublicKey };

function inRange(v: bigint, lo: bigint, hi: bigint, what: string): string {
  if (v < lo || v > hi) throw new Error(`${what} ${v} out of range`);
  return v.toString();
}

/**
 * The canonical "SODA Intents v1" message, UTF-8, eight '\n'-separated lines
 * and no trailing newline. Byte-identical to rfq::render_message.
 */
export function renderIntentMessage(m: IntentMessageFields, programId: PublicKey = INTENTS_PROGRAM_ID): Uint8Array {
  if (m.recipient.length !== 20) throw new Error(`recipient must be 20 bytes, got ${m.recipient.length}`);
  const text = [
    "SODA Intents v1",
    `verifier: ${programId.toBase58()} devnet`,
    `signer: ${m.user.toBase58()}`,
    `nonce: ${inRange(m.nonce, 0n, U64_MAX, "nonce")}`,
    `deadline: ${inRange(m.deadline, I64_MIN, I64_MAX, "deadline")}`,
    `sell: ${inRange(m.sellLamports, 0n, U64_MAX, "sell_lamports")} lamports SOL`,
    `receive at least: ${inRange(m.minOutWei, 0n, U128_MAX, "min_out_wei")} wei ETH`,
    `to: 0x${bytesToHex(m.recipient)} on base-sepolia (84532)`,
  ].join("\n");
  return new TextEncoder().encode(text);
}

const DEC = "(0|[1-9][0-9]*)";
const B58 = "([1-9A-HJ-NP-Za-km-z]{32,44})";
const LINES: RegExp[] = [
  /^SODA Intents v1$/,
  new RegExp(`^verifier: ${B58} devnet$`),
  new RegExp(`^signer: ${B58}$`),
  new RegExp(`^nonce: ${DEC}$`),
  /^deadline: (0|-?[1-9][0-9]*)$/,
  new RegExp(`^sell: ${DEC} lamports SOL$`),
  new RegExp(`^receive at least: ${DEC} wei ETH$`),
  /^to: 0x([0-9a-f]{40}) on base-sepolia \(84532\)$/,
];

function canonicalKey(s: string, what: string): PublicKey {
  const k = new PublicKey(bs58.decode(s));
  if (k.toBase58() !== s) throw new Error(`${what} is not a canonical base58 public key`);
  return k;
}

/**
 * Strict inverse of renderIntentMessage: anything it would not have rendered
 * (extra spaces, leading zeros, uppercase hex, a trailing newline, out-of-range
 * numbers) throws. Takes the signed bytes or their text.
 */
export function parseIntentMessage(message: Uint8Array | string): ParsedIntentMessage {
  const text = typeof message === "string" ? message : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(message);
  const lines = text.split("\n");
  if (lines.length !== LINES.length) throw new Error(`intent message must have ${LINES.length} lines, got ${lines.length}`);
  const g = lines.map((line, i) => {
    const m = LINES[i].exec(line);
    if (!m) throw new Error(`intent message line ${i + 1} is malformed: ${JSON.stringify(line.slice(0, 80))}`);
    return m[1];
  });
  const parsed: ParsedIntentMessage = {
    programId: canonicalKey(g[1], "verifier"),
    user: canonicalKey(g[2], "signer"),
    nonce: BigInt(g[3]),
    deadline: BigInt(g[4]),
    sellLamports: BigInt(g[5]),
    minOutWei: BigInt(g[6]),
    recipient: hexToBytes(g[7]),
  };
  // Range checks, and proof the round trip is exact.
  const again = renderIntentMessage(parsed, parsed.programId);
  const original = typeof message === "string" ? new TextEncoder().encode(message) : message;
  if (Buffer.compare(Buffer.from(again), Buffer.from(original)) !== 0) {
    throw new Error("intent message is not canonical");
  }
  return parsed;
}

/** Ed25519 over the raw message bytes, as Phantom signMessage and the precompile do. */
export function verifyIntentSignature(message: Uint8Array, signature: Uint8Array, publicKey: PublicKey | Uint8Array): boolean {
  const pk = publicKey instanceof PublicKey ? publicKey.toBytes() : publicKey;
  if (signature.length !== 64 || pk.length !== 32) return false;
  try {
    return ed25519.verify(signature, message, pk, { zip215: false });
  } catch {
    return false;
  }
}

/**
 * Wire form of a signed intent (relay publish_intent, solver /rfq/execute):
 * message and signature base64, public key base58.
 */
export type SignedIntentWire = { message: string; public_key: string; signature: string };

export type SignedIntent = {
  fields: ParsedIntentMessage;
  message: Uint8Array;
  signature: Uint8Array;
};

/**
 * Decodes, parses and verifies a signed intent: the signature is valid, the
 * signer line names the signing key, and the verifier is `programId`. Deadline,
 * amounts and quote checks are the caller's.
 */
export function decodeSignedIntent(w: SignedIntentWire, programId: PublicKey = INTENTS_PROGRAM_ID): SignedIntent {
  const message = Uint8Array.from(Buffer.from(w.message, "base64"));
  const signature = Uint8Array.from(Buffer.from(w.signature, "base64"));
  const publicKey = canonicalKey(w.public_key, "public_key");
  const fields = parseIntentMessage(message);
  if (!fields.programId.equals(programId)) throw new Error(`intent is for verifier ${fields.programId.toBase58()}, not ${programId.toBase58()}`);
  if (!fields.user.equals(publicKey)) throw new Error("signer line does not match public_key");
  if (!verifyIntentSignature(message, signature, publicKey)) throw new Error("invalid signature");
  return { fields, message, signature };
}

export function encodeSignedIntent(message: Uint8Array, signature: Uint8Array, publicKey: PublicKey): SignedIntentWire {
  return {
    message: Buffer.from(message).toString("base64"),
    public_key: publicKey.toBase58(),
    signature: Buffer.from(signature).toString("base64"),
  };
}

// ---------------------------------------------------------------- RFQ wire types

/** Solver POST /rfq/quote. */
export type RfqQuoteRequest = { quote_id: string; exact_amount_in: string; recipient?: string };
export type RfqQuoteResponse = { quote_id: string; solver: string; amount_out: string; expiration_time: number };

/** Solver POST /rfq/execute: the signed intent plus its fields as decimal strings and 0x hex. */
export type RfqExecuteRequest = SignedIntentWire & {
  quote_id: string;
  user: string;
  nonce: string;
  deadline: string;
  sell_lamports: string;
  min_out_wei: string;
  recipient: string;
};
export type RfqExecuteResponse = { signature: string; intent: string };

/** Relay (POST /api/rfq) quote results, best first. */
export type RelayQuote = { quote_hash: string; solver: string; amount_out: string; expiration_time: number };
/**
 * `pending`: the solver may have sent the transaction but it was not confirmed
 * in time; track `intent` with get_status (`tx` may be empty).
 */
export type RelayPublishResponse = { intent: string; tx: string; pending?: boolean };
export type RelayStatus = "PENDING" | "TX_BROADCASTED" | "SETTLED" | "NOT_FOUND_OR_NOT_VALID";

export function rfqExecuteRequest(quoteId: string, f: IntentMessageFields, w: SignedIntentWire): RfqExecuteRequest {
  return {
    quote_id: quoteId,
    ...w,
    user: f.user.toBase58(),
    nonce: f.nonce.toString(),
    deadline: f.deadline.toString(),
    sell_lamports: f.sellLamports.toString(),
    min_out_wei: f.minOutWei.toString(),
    recipient: `0x${bytesToHex(f.recipient)}`,
  };
}

// ---------------------------------------------------------------- vault

export type UserVaultAccount = {
  owner: PublicKey;
  /** Lamports held above rent, spendable by signed intents. */
  sol: bigint;
  bump: number;
};

export function vaultPda(owner: PublicKey, programId: PublicKey = INTENTS_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("vault"), owner.toBytes()], programId);
}

export function decodeUserVault(data: Uint8Array): UserVaultAccount {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const r = intentsCoders().accounts.decode<Record<string, unknown>>("UserVault", buf);
  const big = (v: unknown) => BigInt((v as { toString(): string }).toString());
  return { owner: r.owner as PublicKey, sol: big(r.sol), bump: Number(big(r.bump)) };
}

export async function fetchUserVault(
  conn: Pick<Connection, "getAccountInfo">,
  owner: PublicKey,
  programId: PublicKey = INTENTS_PROGRAM_ID,
): Promise<UserVaultAccount | null> {
  const info = await conn.getAccountInfo(vaultPda(owner, programId)[0]);
  return info ? decodeUserVault(info.data) : null;
}

// ---------------------------------------------------------------- nonce

function randomU64(): bigint {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return new DataView(b.buffer).getBigUint64(0, true);
}

/**
 * A random nonzero u64 whose Intent PDA does not exist yet. RFQ nonces share
 * the ["intent", user, id] namespace with open_intent ids (millisecond
 * timestamps), so random ones avoid those as well as each other.
 */
export async function newIntentNonce(
  conn: Pick<Connection, "getAccountInfo">,
  user: PublicKey,
  programId: PublicKey = INTENTS_PROGRAM_ID,
  random: () => bigint = randomU64,
): Promise<bigint> {
  for (let i = 0; i < 5; i++) {
    const n = BigInt.asUintN(64, random());
    if (n === 0n) continue;
    if (!(await conn.getAccountInfo(intentPda(user, n, programId)[0]))) return n;
  }
  throw new Error("could not find an unused intent nonce");
}

// ---------------------------------------------------------------- intent records

/**
 * An execute_signed_intent record: created Filled with auction_duration 0 in
 * the same second. (open_intent also accepts a zero duration, but its fill
 * lands in a later transaction.)
 */
export function isRfqIntent(i: Pick<IntentAccount, "auctionDuration" | "status" | "auctionStart" | "filledAt">): boolean {
  return i.auctionDuration === 0 && i.status === IntentStatus.Filled && i.auctionStart === i.filledAt;
}

export function shortKey(k: PublicKey | string, head = 4, tail = 4): string {
  const s = typeof k === "string" ? k : k.toBase58();
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}
