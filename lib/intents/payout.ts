// Base payout construction and tracking (HANDOVER §3.5), shared by the solver
// bot and the page's /api/payout route. Everything above PayoutTracker is pure.

import { PublicKey } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  bigintToBe,
  decodeUnsignedLegacy,
  eip155V,
  encodeSignedLegacy,
  encodeUnsignedLegacy,
  type LegacyTx,
} from "../soda";
import { CHAIN_ID, GAS_LIMIT, INTENTS_PROGRAM_ID, SODA_PROGRAM_ID } from "./constants";
import { poolPda, sigRequestPda } from "./pdas";

// ---------------------------------------------------------------- building

export type PayoutParams = {
  recipient: Uint8Array; // 20 bytes
  outWei: bigint;
  baseNonce: bigint;
  gasPrice: bigint;
};

/** Same fields as the program's build_payout: GAS_LIMIT, empty calldata, chain 84532. */
export function buildPayoutTx(p: PayoutParams): LegacyTx {
  if (p.recipient.length !== 20) throw new Error(`recipient must be 20 bytes, got ${p.recipient.length}`);
  return {
    nonce: p.baseNonce,
    gasPriceWei: p.gasPrice,
    gasLimit: GAS_LIMIT,
    to: p.recipient,
    valueWeiBe: bigintToBe(p.outWei, 16),
    data: new Uint8Array(0),
    chainId: CHAIN_ID,
  };
}

export function payoutUnsignedRlp(p: PayoutParams): Uint8Array {
  return encodeUnsignedLegacy(buildPayoutTx(p));
}

/** The 32-byte digest soda signs: keccak256(unsigned RLP). */
export function payloadOf(unsignedRlp: Uint8Array): Uint8Array {
  return keccak_256(unsignedRlp);
}

/** Everything a client needs to pass `sig_request` to fill / bump_gas / solver_withdraw. */
export function payoutSigRequest(
  p: PayoutParams,
  programId: PublicKey = INTENTS_PROGRAM_ID,
  sodaProgramId: PublicKey = SODA_PROGRAM_ID,
): { unsignedRlp: Uint8Array; payload: Uint8Array; sigRequest: PublicKey } {
  const unsignedRlp = payoutUnsignedRlp(p);
  const payload = payloadOf(unsignedRlp);
  const [pool] = poolPda(programId);
  const [sigRequest] = sigRequestPda(pool, payload, sodaProgramId);
  return { unsignedRlp, payload, sigRequest };
}

// ---------------------------------------------------------------- SigRequest (§1.4)

export const SIG_REQUEST_DISCRIMINATOR = hexToBytes("3617d2807be9f1e9");
export const SIG_REQUEST_SIZE = 347;

export type SigRequestAccount = {
  bump: number;
  requester: PublicKey;
  committee: PublicKey;
  foreignPkXy: Uint8Array; // 64
  derivationSeeds: Uint8Array;
  payload: Uint8Array; // 32
  chainTag: Uint8Array; // 32
  domainId: number;
  expiresAt: bigint;
  completed: boolean;
  signature: Uint8Array; // 64, r || s
  recoveryId: number;
};

export function decodeSigRequest(data: Uint8Array): SigRequestAccount {
  for (let i = 0; i < 8; i++) {
    if (data[i] !== SIG_REQUEST_DISCRIMINATOR[i]) throw new Error("not a soda SigRequest account");
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8;
  const take = (n: number) => {
    if (o + n > data.length) throw new Error("SigRequest data too short");
    const out = data.slice(o, o + n);
    o += n;
    return out;
  };
  const bump = take(1)[0];
  const requester = new PublicKey(take(32));
  const committee = new PublicKey(take(32));
  const foreignPkXy = take(64);
  const seedsLen = dv.getUint32(o, true);
  o += 4;
  const derivationSeeds = take(seedsLen);
  const payload = take(32);
  const chainTag = take(32);
  const domainId = dv.getUint32(o, true);
  o += 4;
  const expiresAt = dv.getBigInt64(o, true);
  o += 8;
  const completed = take(1)[0] !== 0;
  const signature = take(64);
  const recoveryId = take(1)[0];
  return {
    bump, requester, committee, foreignPkXy, derivationSeeds, payload, chainTag,
    domainId, expiresAt, completed, signature, recoveryId,
  };
}

// ---------------------------------------------------------------- signed tx

export type SignedPayout = {
  v: bigint;
  signedRaw: Uint8Array;
  signedHex: string; // 0x-prefixed, for eth_sendRawTransaction
  txHash: string; // 0x-prefixed, lowercase
};

/** §3.5: v = eip155V(recovery_id, chainId), r = sig[0..32], s = sig[32..64]. */
export function assembleSigned(
  unsigned: LegacyTx,
  signature: Uint8Array,
  recoveryId: number,
): SignedPayout {
  if (signature.length !== 64) throw new Error(`signature must be 64 bytes, got ${signature.length}`);
  if (recoveryId > 1) throw new Error(`unexpected recovery id ${recoveryId}`);
  const v = eip155V(recoveryId, unsigned.chainId);
  const signedRaw = encodeSignedLegacy(unsigned, v, signature.subarray(0, 32), signature.subarray(32, 64));
  return {
    v,
    signedRaw,
    signedHex: "0x" + bytesToHex(signedRaw),
    txHash: "0x" + bytesToHex(keccak_256(signedRaw)),
  };
}

/** Signed payout for a completed SigRequest, or null while the committee is still signing. */
export function signedFromSigRequest(unsigned: LegacyTx, sr: SigRequestAccount): SignedPayout | null {
  if (!equalBytes(payloadOf(encodeUnsignedLegacy(unsigned)), sr.payload)) {
    throw new Error("unsigned tx does not match SigRequest.payload");
  }
  if (!sr.completed) return null;
  return assembleSigned(unsigned, sr.signature, sr.recoveryId);
}

// ---------------------------------------------------------------- candidates

/** The Intent fields payout candidates depend on (a decoded IntentAccount fits). */
export type PayoutIntentFields = {
  recipient: Uint8Array;
  outWei: bigint;
  baseNonce: bigint;
  /** The latest signed gas price only: bump_gas overwrites it. */
  gasPrice: bigint;
  sigRequests: PublicKey[];
  sigRequestCount: number;
};

export type PayoutCandidate = {
  index: number;
  sigRequest: PublicKey;
  /** null when no known gas price reproduces this SigRequest's address. */
  unsigned: LegacyTx | null;
  gasPrice: bigint | null;
  account: SigRequestAccount | null;
  completed: boolean;
  signed: SignedPayout | null;
};

export type CandidateOptions = {
  /**
   * Gas prices of earlier candidates. Intent.gas_price holds only the latest,
   * so older ones come from IntentFilled.gas_price and GasBumped.old/new_gas_price
   * (see gasPricesFromEvents in accounts.ts) or the bot's own memory.
   */
  gasPriceHints?: bigint[];
  /** Unsigned RLP per sig_request (base58), e.g. from EthTxRequested events. */
  unsignedBySigRequest?: Map<string, Uint8Array | LegacyTx>;
  programId?: PublicKey;
  sodaProgramId?: PublicKey;
};

/**
 * One candidate per entry in Intent.sig_requests. A candidate's gas price is
 * accepted only if it rebuilds a payload whose soda PDA equals the stored key,
 * so a wrong hint can never yield a wrong hash.
 */
export function buildCandidates(
  intent: PayoutIntentFields,
  sigRequestAccounts: (SigRequestAccount | null | undefined)[],
  opts: CandidateOptions = {},
): PayoutCandidate[] {
  const [pool] = poolPda(opts.programId ?? INTENTS_PROGRAM_ID);
  const soda = opts.sodaProgramId ?? SODA_PROGRAM_ID;
  const prices = dedupe([intent.gasPrice, ...(opts.gasPriceHints ?? [])]);
  const out: PayoutCandidate[] = [];

  for (let i = 0; i < intent.sigRequestCount; i++) {
    const key = intent.sigRequests[i];
    const account = sigRequestAccounts[i] ?? null;
    const matches = (tx: LegacyTx) => {
      const payload = payloadOf(encodeUnsignedLegacy(tx));
      if (account) return equalBytes(payload, account.payload);
      return sigRequestPda(pool, payload, soda)[0].equals(key);
    };

    let unsigned: LegacyTx | null = null;
    const given = opts.unsignedBySigRequest?.get(key.toBase58());
    if (given) {
      const tx = given instanceof Uint8Array ? decodeUnsignedLegacy(given) : given;
      if (matches(tx)) unsigned = tx;
    }
    for (const gasPrice of prices) {
      if (unsigned) break;
      const tx = buildPayoutTx({ ...intent, gasPrice });
      if (matches(tx)) unsigned = tx;
    }

    const completed = account?.completed ?? false;
    out.push({
      index: i,
      sigRequest: key,
      unsigned,
      gasPrice: unsigned?.gasPriceWei ?? null,
      account,
      completed,
      signed: unsigned && account && completed ? assembleSigned(unsigned, account.signature, account.recoveryId) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- tracking

export type EthReceipt = {
  txHash: string;
  status: 0 | 1;
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint | null;
};

/** The two Base RPC calls the tracker needs; rpc.ts adapts EthRpc to this. */
export interface PayoutRpc {
  sendRawTransaction(signedHex: string): Promise<string>;
  getReceipt(txHash: string): Promise<EthReceipt | null>;
}

export type BroadcastOutcome =
  | "sent"
  | "already_known"
  | "nonce_too_low"
  | "underpriced"
  | "error";

/** Map an eth_sendRawTransaction error to what the tracker does next. */
export function classifyBroadcastError(message: string): BroadcastOutcome {
  const m = message.toLowerCase();
  if (m.includes("already known") || m.includes("known transaction") || m.includes("already imported")) {
    return "already_known";
  }
  if (m.includes("nonce too low") || m.includes("nonce is too low")) {
    return "nonce_too_low";
  }
  if (m.includes("underpriced")) return "underpriced";
  return "error";
}

export type Delivered = {
  index: number;
  sigRequest: PublicKey;
  txHash: string;
  status: 0 | 1;
  blockNumber: bigint;
};

/** Delivered when ANY candidate's hash has a receipt (only one can land per nonce). */
export function findDelivered(
  candidates: PayoutCandidate[],
  receipts: Map<string, EthReceipt | null>,
): Delivered | null {
  for (const c of candidates) {
    if (!c.signed) continue;
    const r = receipts.get(c.signed.txHash);
    if (r) {
      return { index: c.index, sigRequest: c.sigRequest, txHash: c.signed.txHash, status: r.status, blockNumber: r.blockNumber };
    }
  }
  return null;
}

export type TrackState =
  /** A candidate has a receipt (check delivered.status: 0 means reverted). */
  | "delivered"
  /** At least one signed candidate is in flight. */
  | "pending"
  /** Some tx used the nonce but none of our candidates has a receipt yet. Keep waiting; never "delivered". */
  | "nonce_used"
  /** No candidate is signed yet (or none could be rebuilt). */
  | "awaiting_signature";

export type BroadcastAttempt = {
  index: number;
  txHash: string;
  outcome: BroadcastOutcome;
  error?: string;
};

export type TrackResult = {
  state: TrackState;
  delivered: Delivered | null;
  attempts: BroadcastAttempt[];
  /** Candidates whose gas price could not be rebuilt; pass hints to fix. */
  unresolved: number[];
};

/** Pure: the state after one round of receipts and broadcasts. */
export function decideTrackState(
  candidates: PayoutCandidate[],
  receipts: Map<string, EthReceipt | null>,
  attempts: BroadcastAttempt[],
): TrackState {
  if (findDelivered(candidates, receipts)) return "delivered";
  if (!candidates.some((c) => c.signed)) return "awaiting_signature";
  if (attempts.some((a) => a.outcome === "nonce_too_low")) return "nonce_used";
  return "pending";
}

/**
 * Drives delivery for one intent's payout. Each track() call:
 *   1. fetches receipts for every signed candidate; any receipt → delivered;
 *   2. otherwise rebroadcasts every signed candidate ("already known" = pending);
 *   3. on "nonce too low" re-checks every candidate's receipt, and stays
 *      "nonce_used" (not delivered) if none has one.
 * firstSeen records when each hash was first broadcast, for gas-bump timing.
 */
export class PayoutTracker {
  private readonly firstSeen = new Map<string, number>();

  constructor(
    private readonly rpc: PayoutRpc,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async track(candidates: PayoutCandidate[]): Promise<TrackResult> {
    const signed = candidates.filter((c) => c.signed);
    const unresolved = candidates.filter((c) => !c.unsigned).map((c) => c.index);

    let receipts = await this.fetchReceipts(signed);
    let delivered = findDelivered(candidates, receipts);
    if (delivered) return { state: "delivered", delivered, attempts: [], unresolved };

    const attempts: BroadcastAttempt[] = [];
    for (const c of signed) {
      const txHash = c.signed!.txHash;
      try {
        await this.rpc.sendRawTransaction(c.signed!.signedHex);
        attempts.push({ index: c.index, txHash, outcome: "sent" });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        attempts.push({ index: c.index, txHash, outcome: classifyBroadcastError(error), error });
      }
      if (!this.firstSeen.has(txHash)) this.firstSeen.set(txHash, this.clock());
    }

    if (attempts.some((a) => a.outcome === "nonce_too_low")) {
      receipts = await this.fetchReceipts(signed);
      delivered = findDelivered(candidates, receipts);
    }
    const state = delivered ? "delivered" : decideTrackState(candidates, receipts, attempts);
    return { state, delivered, attempts, unresolved };
  }

  /** ms since the newest signed candidate was first broadcast, or null if none yet. */
  pendingForMs(candidates: PayoutCandidate[]): number | null {
    const newest = [...candidates].reverse().find((c) => c.signed && this.firstSeen.has(c.signed.txHash));
    return newest ? this.clock() - this.firstSeen.get(newest.signed!.txHash)! : null;
  }

  private async fetchReceipts(signed: PayoutCandidate[]): Promise<Map<string, EthReceipt | null>> {
    const out = new Map<string, EthReceipt | null>();
    await Promise.all(
      signed.map(async (c) => {
        const h = c.signed!.txHash;
        try {
          out.set(h, await this.rpc.getReceipt(h));
        } catch {
          out.set(h, null);
        }
      }),
    );
    return out;
  }
}

// ---------------------------------------------------------------- utils

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function dedupe(xs: bigint[]): bigint[] {
  return [...new Set(xs)];
}
