// JSON shapes the API routes return. Bigints travel as decimal strings.

import type { OrderStatus, Step } from "@/lib/intents";

export type QuoteJson = {
  solver: string;
  outWei: string;
  minOutWei?: string;
  validUntil?: number;
  /** Host of the solver endpoint that answered. */
  source: string;
};

export type QuotesResponse = {
  inLamports: string;
  best: QuoteJson;
  quotes: QuoteJson[];
  failed: { source: string; error: string }[];
};

export type GroupPkResponse = {
  groupPk: string;
  committee: string;
  fetchedAt: number;
};

export type PricesResponse = {
  solUsd: number | null;
  ethUsd: number | null;
  publishTime: number | null;
};

export type RecipientCheckResponse = {
  address: string;
  plain: boolean;
  codeSize: number;
};

export type IntentJson = {
  address: string;
  user: string;
  intentId: string;
  inLamports: string;
  recipient: string;
  startOutWei: string;
  minOutWei: string;
  auctionStart: number;
  auctionDuration: number;
  expiresAt: number;
  status: "open" | "filled" | "cancelled";
  solver: string;
  outWei: string;
  baseNonce: string;
  gasPrice: string;
  filledAt: number;
  sigRequestCount: number;
};

/** A Step plus where it landed on Solana (Base steps carry no slot). */
export type PayoutStep = Step & {
  /** Slot of the step's Solana transaction. */
  slot?: number;
  /** "signed" step only: slots from the tx that created the SigRequest to its finalize tx. */
  signingSlots?: number;
  /** signingSlots × 400 ms (Solana's target slot time); an estimate, not a wall-clock measurement. */
  signingMsApprox?: number;
};

/** Committee signing measured in slots, not whole-second block times. */
export type SigningTiming = {
  /** The fill / execute_signed_intent (or bump_gas) tx that created the SigRequest. */
  fromSlot: number;
  fromTx: string;
  /** The finalize_signature tx (signature verified on Solana). */
  toSlot: number;
  toTx: string;
  slots: number;
  msApprox: number;
  /** e.g. "≈2.8 s (7 slots)". */
  label: string;
};

export type PayoutResponse = {
  intent: IntentJson;
  status: OrderStatus;
  steps: PayoutStep[];
  /** Settled from a signed message by execute_signed_intent (auction_duration 0), not a Dutch auction. */
  isRfq: boolean;
  /** Set once the first SigRequest is signed and both txs are found. */
  signing?: SigningTiming;
  candidates: {
    index: number;
    sigRequest: string;
    gasPrice: string | null;
    completed: boolean;
    txHash: string | null;
  }[];
  requiredOutWei?: string;
  auctionEndsIn?: number;
  expiresIn?: number;
  delivered?: { index: number; txHash: string; status: 0 | 1; blockNumber: string };
  surplusWei?: string;
  speedingUp: boolean;
  /** close_intent would succeed now. */
  closable: boolean;
  /** Unix seconds when the user can close the intent. Unset: a Filled intent is closed by the admin. */
  closableAt?: number;
  /** Base receipt lookups: ok, or why they could not run. */
  base: { ok: boolean; error?: string };
  serverTime: number;
};

export type ApiError = { error: string };
