"use client";

// Tracks one intent: polls /api/payout, listens to the intent and its first
// SigRequest over the websocket for fast transitions, and records measured
// client-side times for each step it sees happen live.

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { IntentStatus, decodeIntent, decodeSigRequest, type OrderStatus, type Step } from "@/lib/intents";
import type { ApiError, PayoutResponse } from "@/app/lib/api-types";
import { loadOrder, observe, type LocalOrder, type MeasuredStep } from "@/app/lib/orders";

export type OrderView = {
  data: PayoutResponse | null;
  /** The account is gone: closed by its owner (or never existed). */
  closed: boolean;
  error: string | null;
  local: LocalOrder | null;
  refresh: () => void;
};

const RANK: Record<string, number> = { open: 0, matched: 1, signing: 2, signed: 3, broadcast: 4, completed: 5 };
const TERMINAL: OrderStatus[] = ["completed", "reverted", "cancelled"];

function pollMs(status: OrderStatus | undefined): number | null {
  if (!status) return 3000;
  if (TERMINAL.includes(status)) return null;
  if (status === "expired") return 15_000;
  return 3000;
}

export function useOrder(
  intent: string | null,
  onTransition?: (prev: OrderStatus | null, next: PayoutResponse) => void,
): OrderView {
  const { connection } = useConnection();
  const [data, setData] = useState<PayoutResponse | null>(null);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalOrder | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const lastStatus = useRef<OrderStatus | null>(null);
  const onTransitionRef = useRef(onTransition);
  useEffect(() => {
    onTransitionRef.current = onTransition;
  });

  // Reset when switching orders: during render, so the old order never paints
  // under the new one. intent is null on the server, so localStorage is not read there.
  const [shownIntent, setShownIntent] = useState<string | null>(null);
  if (shownIntent !== intent) {
    setShownIntent(intent);
    setData(null);
    setClosed(false);
    setError(null);
    setLocal(intent ? loadOrder(intent) : null);
  }
  useEffect(() => {
    lastStatus.current = null;
  }, [intent]);

  const record = useCallback(
    (step: MeasuredStep, at = Date.now()) => {
      if (intent) setLocal(observe(intent, step, at));
    },
    [intent],
  );

  // Poll the server route.
  useEffect(() => {
    if (!intent) return;
    let alive = true;
    const ctrl = new AbortController();
    fetch(`/api/payout?intent=${intent}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (resp) => {
        const body = (await resp.json()) as PayoutResponse | (ApiError & { closed?: boolean });
        if (!alive) return;
        if (!resp.ok) {
          if ("closed" in body && body.closed) {
            // Drop the last snapshot so the drawer shows the closed state, not a stale Close button.
            setClosed(true);
            setData(null);
          } else setError((body as ApiError).error);
          return;
        }
        const next = body as PayoutResponse;
        const prev = lastStatus.current;
        // Only a transition seen live counts as a measurement.
        if (prev && prev !== next.status) {
          if ((RANK[next.status] ?? -1) > (RANK[prev] ?? 99)) record(next.status as MeasuredStep);
          if (next.status === "cancelled") record("cancelled");
        }
        if (prev !== next.status) onTransitionRef.current?.(prev, next);
        lastStatus.current = next.status;
        setData(next);
        setError(null);
      })
      .catch((e: Error) => {
        if (alive && e.name !== "AbortError") setError(e.message);
      });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [intent, tick, record]);

  const status = data?.status;
  useEffect(() => {
    const ms = pollMs(status);
    if (!intent || ms === null || closed) return;
    const t = setTimeout(refresh, ms);
    return () => clearTimeout(t);
  }, [intent, status, closed, tick, refresh]);

  // Websocket: the fill lands on the intent account; the signature on the SigRequest.
  const firstSigRequest = data?.candidates[0]?.sigRequest ?? null;
  const isOpen = status === "open";
  useEffect(() => {
    if (!intent || !isOpen) return;
    const sub = connection.onAccountChange(
      new PublicKey(intent),
      (info) => {
        try {
          if (decodeIntent(info.data).status === IntentStatus.Filled) {
            const at = Date.now();
            record("matched", at);
            record("signing", at); // same transaction: the fill CPIs request_signature
          }
        } catch {}
        refresh();
      },
      { commitment: "confirmed" },
    );
    return () => {
      connection.removeAccountChangeListener(sub).catch(() => {});
    };
  }, [connection, intent, isOpen, record, refresh]);

  const waitingForSig = status === "matched" || status === "signing";
  useEffect(() => {
    if (!firstSigRequest || !waitingForSig) return;
    const sub = connection.onAccountChange(
      new PublicKey(firstSigRequest),
      (info) => {
        try {
          if (decodeSigRequest(info.data).completed) record("signed");
        } catch {}
        refresh();
      },
      { commitment: "confirmed" },
    );
    return () => {
      connection.removeAccountChangeListener(sub).catch(() => {});
    };
  }, [connection, firstSigRequest, waitingForSig, record, refresh]);

  return { data, closed, error, local, refresh };
}

/**
 * Server steps carry on-chain times (second precision). Overlay the times this
 * browser measured (ms) where it has them, then recompute the gaps.
 */
export function withMeasuredTimes(steps: Step[], local: LocalOrder | null): (Step & { measured?: boolean })[] {
  let prev: number | undefined;
  return steps.map((s) => {
    const own = local?.observed[s.id as MeasuredStep];
    const out: Step & { measured?: boolean } = { ...s };
    if (s.state !== "todo" && own !== undefined) {
      out.timestamp = own;
      out.measured = true;
    }
    if (s.id === "open" && local?.sentAt && own !== undefined) {
      // Time from Phantom handing over the transaction to confirmation.
      out.elapsedMs = own - local.sentAt;
    } else if (out.timestamp !== undefined && prev !== undefined) {
      out.elapsedMs = Math.max(0, out.timestamp - prev);
    } else {
      delete out.elapsedMs;
    }
    if (out.timestamp !== undefined && s.state !== "todo") prev = out.timestamp;
    return out;
  });
}
