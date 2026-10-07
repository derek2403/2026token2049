// Test fixtures shared by lib/intents/*.test.ts. Not exported from index.ts.

import { PublicKey } from "@solana/web3.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { EVM_CHAIN_TAG } from "../soda";
import { COMMITTEE_PDA, IntentStatus, MAX_SIG_REQUESTS } from "./constants";
import type { IntentAccount } from "./accounts";
import { payoutSigRequest, SIG_REQUEST_DISCRIMINATOR, type SigRequestAccount } from "./payout";
import { poolPda } from "./pdas";

/** A SigRequest as soda would store it; signed with `privKey` when completed. */
export function fakeSigRequest(
  payload: Uint8Array,
  opts: { privKey?: Uint8Array; completed?: boolean; expiresAt?: bigint } = {},
): SigRequestAccount {
  const privKey = opts.privKey ?? secp256k1.utils.randomPrivateKey();
  const completed = opts.completed ?? true;
  const sig = secp256k1.sign(payload, privKey);
  return {
    bump: 255,
    requester: poolPda()[0],
    committee: COMMITTEE_PDA,
    foreignPkXy: secp256k1.getPublicKey(privKey, false).slice(1),
    derivationSeeds: new Uint8Array(0),
    payload,
    chainTag: EVM_CHAIN_TAG,
    domainId: 0,
    expiresAt: opts.expiresAt ?? 1_700_000_300n,
    completed,
    signature: completed ? sig.toCompactRawBytes() : new Uint8Array(64),
    recoveryId: completed ? sig.recovery : 0,
  };
}

/** Borsh-encode a SigRequest (soda allocates 347 bytes; seeds ≤ 64 leave zero padding). */
export function encodeSigRequest(sr: SigRequestAccount, size = 347): Uint8Array {
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let o = 0;
  const put = (b: Uint8Array) => {
    out.set(b, o);
    o += b.length;
  };
  put(SIG_REQUEST_DISCRIMINATOR);
  put(Uint8Array.of(sr.bump));
  put(sr.requester.toBytes());
  put(sr.committee.toBytes());
  put(sr.foreignPkXy);
  dv.setUint32(o, sr.derivationSeeds.length, true);
  o += 4;
  put(sr.derivationSeeds);
  put(sr.payload);
  put(sr.chainTag);
  dv.setUint32(o, sr.domainId, true);
  o += 4;
  dv.setBigInt64(o, sr.expiresAt, true);
  o += 8;
  put(Uint8Array.of(sr.completed ? 1 : 0));
  put(sr.signature);
  put(Uint8Array.of(sr.recoveryId));
  return out;
}

export const RECIPIENT = Uint8Array.from({ length: 20 }, (_, i) => 0xa0 + i);
export const USER = new PublicKey("D5pwjGzqvgvuFt4rtMVf1ta4RKXWyGGfG2ekh5KuDfZw");
export const SOLVER = new PublicKey("9mX3oHUmsrYvzXjCo35HhfXufrGZT3hjsLoC74xbA6SS");

export function openIntent(overrides: Partial<IntentAccount> = {}): IntentAccount {
  return {
    user: USER,
    intentId: 1n,
    inLamports: 1_000_000_000n,
    recipient: RECIPIENT,
    startOutWei: 1_000_000_000_000_000n,
    minOutWei: 990_000_000_000_000n,
    auctionStart: 1_700_000_000n,
    auctionDuration: 60,
    expiresAt: 1_700_000_120n,
    status: IntentStatus.Open,
    solver: PublicKey.default,
    outWei: 0n,
    baseNonce: 0n,
    gasPrice: 0n,
    filledAt: 0n,
    sigRequests: Array.from({ length: MAX_SIG_REQUESTS }, () => PublicKey.default),
    sigRequestCount: 0,
    bump: 255,
    ...overrides,
  };
}

/** A filled intent whose sig_requests are the real PDAs for `gasPrices` (original, then bumps). */
export function filledIntent(gasPrices: bigint[], overrides: Partial<IntentAccount> = {}): IntentAccount {
  const base = openIntent({
    status: IntentStatus.Filled,
    solver: SOLVER,
    outWei: 995_000_000_000_000n,
    baseNonce: 7n,
    filledAt: 1_700_000_030n,
    ...overrides,
  });
  const sigRequests = [...base.sigRequests];
  gasPrices.forEach((gasPrice, i) => {
    sigRequests[i] = payoutSigRequest({ ...base, gasPrice }).sigRequest;
  });
  return { ...base, gasPrice: gasPrices[gasPrices.length - 1], sigRequests, sigRequestCount: gasPrices.length };
}

/** Matching fake SigRequests for filledIntent(gasPrices); `completed[i]` per candidate. */
export function sigRequestsFor(intent: IntentAccount, gasPrices: bigint[], completed: boolean[]): SigRequestAccount[] {
  return gasPrices.map((gasPrice, i) =>
    fakeSigRequest(payoutSigRequest({ ...intent, gasPrice }).payload, {
      completed: completed[i],
      expiresAt: intent.filledAt + 300n,
    }),
  );
}
