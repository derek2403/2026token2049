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

export type PayoutResponse = {
  intent: IntentJson;
  status: OrderStatus;
  steps: Step[];
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
