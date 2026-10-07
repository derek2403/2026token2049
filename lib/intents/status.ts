// Order status machine for the drawer (HANDOVER §5.3), as a pure function.
//   open → matched → signing → signed → broadcast → completed
//   side paths: open → expired → cancelled; open → cancelled
// "reverted" is added for a mined payout with receipt status 0 (a recipient
// whose code ran out of the 21000 gas); the spec's table has no row for it.

import { requiredOutForIntent } from "./auction";
import { IntentStatus, SIG_REQUEST_TTL_SEC } from "./constants";
import type { IntentAccount } from "./accounts";
import { isRfqIntent, shortKey } from "./rfq";
import {
  buildCandidates,
  findDelivered,
  type Delivered,
  type EthReceipt,
  type PayoutCandidate,
  type SigRequestAccount,
} from "./payout";

export type StepId =
  | "open"
  | "matched"
  | "signing"
  | "signed"
  | "broadcast"
  | "completed"
  | "expired"
  | "cancelled";

export type OrderStatus = StepId | "reverted";

export type StepState = "done" | "active" | "todo" | "failed";

export type StepRef = { txHash?: string; timestamp?: number /* ms */ };

export type Step = {
  id: StepId;
  label: string;
  state: StepState;
  chain: "solana" | "base";
  txHash?: string;
  /** ms since epoch; on-chain times have second precision. */
  timestamp?: number;
  /** ms since the previous step that has a timestamp. */
  elapsedMs?: number;
};

export type StatusInput = {
  intent: IntentAccount;
  /** Same order as intent.sigRequests; null where not fetched or not created yet. */
  sigRequests: (SigRequestAccount | null)[];
  /** Keyed by lowercase 0x tx hash. */
  receipts: Map<string, EthReceipt | null>;
  /** Unix seconds (cluster time). */
  now: bigint;
  /** Precomputed candidates (e.g. built with gas price hints); otherwise built here. */
  candidates?: PayoutCandidate[];
  /** Tx signatures / hashes and measured times known from events or the client. */
  refs?: Partial<Record<StepId, StepRef>>;
};

export type StatusResult = {
  status: OrderStatus;
  steps: Step[];
  candidates: PayoutCandidate[];
  /** While open: the amount a solver must deliver right now. */
  requiredOutWei?: bigint;
  /** While open: seconds until the auction reaches min_out_wei, and until expiry. */
  auctionEndsIn?: number;
  expiresIn?: number;
  delivered?: Delivered;
  /** out_wei − min_out_wei, once filled. */
  surplusWei?: bigint;
  /** A gas bump was requested (sig_request_count > 1). */
  speedingUp: boolean;
};

const MAIN: StepId[] = ["open", "matched", "signing", "signed", "broadcast", "completed"];

export function formatEth(wei: bigint, maxDecimals = 6): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, "0").slice(0, maxDecimals).replace(/0+$/, "");
  if (whole === 0n && frac === "" && abs !== 0n) return `${neg ? "-" : ""}<0.${"0".repeat(maxDecimals - 1)}1`;
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export function intentStatus(input: StatusInput): StatusResult {
  const { intent, sigRequests, receipts, now } = input;
  const candidates =
    input.candidates ?? (intent.status === IntentStatus.Filled ? buildCandidates(intent, sigRequests) : []);
  const speedingUp = intent.sigRequestCount > 1;
  const sec = (s: bigint) => Number(s) * 1000;
  // RFQ: the solver settled the user's signed message, so open and matched are one transaction.
  const rfq = isRfqIntent(intent);

  const labels: Record<StepId, string> = {
    open: rfq ? `Signed intent settled by solver ${shortKey(intent.solver)}` : "SOL locked in escrow. Finding a solver…",
    matched: `Solver matched: delivering ${formatEth(intent.outWei)} ETH`,
    signing: "Committee signing the Base payout",
    signed: "Signature verified on Solana (secp256k1_recover). Safe to close this tab.",
    broadcast: speedingUp ? "ETH sent on Base. Speeding up" : "ETH sent on Base",
    completed: `Received ${formatEth(intent.outWei)} ETH (+${formatEth(intent.outWei - intent.minOutWei)} above minimum)`,
    expired: "No solver filled in time. Cancel to get your SOL back.",
    cancelled: "SOL refunded. Close to reclaim rent.",
  };
  const chain = (id: StepId): Step["chain"] => (id === "broadcast" || id === "completed" ? "base" : "solana");

  const auto: Partial<Record<StepId, StepRef>> = { open: { timestamp: sec(intent.auctionStart) } };
  if (intent.status === IntentStatus.Filled) {
    auto.matched = { timestamp: sec(intent.filledAt) };
    const first = sigRequests[0];
    if (first) auto.signing = { timestamp: sec(first.expiresAt - SIG_REQUEST_TTL_SEC) };
  }

  // Hashes we computed (extra) win over caller refs; caller refs win over on-chain times.
  const build = (
    path: StepId[],
    current: StepId,
    currentState: StepState,
    extra: Partial<Record<StepId, StepRef>> = {},
  ): Step[] => {
    const at = path.indexOf(current);
    let prevTs: number | undefined;
    return path.map((id, i) => {
      const ref = { ...auto[id], ...input.refs?.[id], ...extra[id] };
      if (rfq && id === "matched") delete ref.timestamp; // same tx as open: no fake +0 ms
      const state: StepState = i < at ? "done" : i === at ? currentState : "todo";
      const step: Step = { id, label: labels[id], state, chain: chain(id) };
      if (state !== "todo") {
        if (ref.txHash) step.txHash = ref.txHash;
        if (ref.timestamp !== undefined) {
          step.timestamp = ref.timestamp;
          if (prevTs !== undefined) step.elapsedMs = ref.timestamp - prevTs;
          prevTs = ref.timestamp;
        }
      }
      return step;
    });
  };

  if (intent.status === IntentStatus.Cancelled) {
    return { status: "cancelled", steps: build(["open", "cancelled"], "cancelled", "done"), candidates, speedingUp };
  }

  if (intent.status === IntentStatus.Open) {
    // fill requires now < expires_at, so expiry starts at expires_at itself.
    if (now >= intent.expiresAt) {
      return {
        status: "expired",
        steps: build(["open", "expired", "cancelled"], "expired", "active"),
        candidates,
        speedingUp,
        expiresIn: 0,
      };
    }
    const auctionEnd = intent.auctionStart + BigInt(intent.auctionDuration);
    return {
      status: "open",
      steps: build(MAIN, "open", "active"),
      candidates,
      speedingUp,
      requiredOutWei: requiredOutForIntent(intent, now),
      auctionEndsIn: Math.max(0, Number(auctionEnd - now)),
      expiresIn: Number(intent.expiresAt - now),
    };
  }

  // Filled.
  const surplusWei = intent.outWei - intent.minOutWei;
  const base = { candidates, speedingUp, surplusWei };
  const delivered = findDelivered(candidates, receipts);
  if (delivered) {
    const reverted = delivered.status === 0;
    const steps = build(MAIN, "completed", reverted ? "failed" : "done", {
      broadcast: { txHash: delivered.txHash },
      completed: { txHash: delivered.txHash },
    });
    if (reverted) steps[steps.length - 1].label = "Payout reverted on Base";
    return { ...base, status: reverted ? "reverted" : "completed", steps, delivered };
  }

  const signed = candidates.filter((c) => c.signed);
  if (signed.length > 0) {
    const newest = signed[signed.length - 1].signed!.txHash;
    return { ...base, status: "broadcast", steps: build(MAIN, "broadcast", "active", { broadcast: { txHash: newest } }) };
  }
  if (sigRequests.some((s) => s?.completed)) {
    return { ...base, status: "signed", steps: build(MAIN, "signed", "active") };
  }
  if (sigRequests.some((s) => s)) {
    return { ...base, status: "signing", steps: build(MAIN, "signing", "active") };
  }
  return { ...base, status: "matched", steps: build(MAIN, "matched", "active") };
}

