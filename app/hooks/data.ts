"use client";

// Small data hooks for the swap form: committee key, balance, quotes, prices,
// recipient check, intent rent.

import { useCallback, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { hexToBytes } from "@noble/hashes/utils";
import { GROUP_PK_HEX, INTENT_SIZE, fetchConfig, type ConfigAccount } from "@/lib/intents";
import type {
  ApiError,
  GroupPkResponse,
  PricesResponse,
  QuotesResponse,
  RecipientCheckResponse,
} from "@/app/lib/api-types";

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(url, { signal, cache: "no-store" });
  const body = (await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }))) as T | ApiError;
  if (!resp.ok) throw new Error((body as ApiError).error ?? `HTTP ${resp.status}`);
  return body as T;
}

/** Live committee group_pk; falls back to the pinned constant if the route fails. */
export function useGroupPk(): { groupPk: Uint8Array; live: boolean } {
  const [state, setState] = useState<{ groupPk: Uint8Array; live: boolean }>(() => ({
    groupPk: hexToBytes(GROUP_PK_HEX),
    live: false,
  }));
  useEffect(() => {
    let alive = true;
    getJson<GroupPkResponse>("/api/group-pk")
      .then((r) => alive && setState({ groupPk: hexToBytes(r.groupPk), live: true }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

export function useSolBalance(owner: PublicKey | null): { lamports: bigint | null; refresh: () => void } {
  const { connection } = useConnection();
  // Tagged with the owner it belongs to, so a wallet switch never shows the old balance.
  const [balance, setBalance] = useState<{ owner: string; lamports: bigint } | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!owner) return;
    let alive = true;
    const set = (lamports: number) => alive && setBalance({ owner: owner.toBase58(), lamports: BigInt(lamports) });
    connection
      .getBalance(owner, "confirmed")
      .then(set)
      .catch(() => {});
    const sub = connection.onAccountChange(owner, (info) => set(info.lamports), { commitment: "confirmed" });
    return () => {
      alive = false;
      connection.removeAccountChangeListener(sub).catch(() => {});
    };
  }, [connection, owner, tick]);

  const lamports = owner && balance?.owner === owner.toBase58() ? balance.lamports : null;
  return { lamports, refresh };
}

/** Rent for a new Intent account; the max-amount and quote details reserve it. */
export function useIntentRent(): bigint {
  const { connection } = useConnection();
  // Local estimate until the RPC answers: (size + 128) * 3480 * 2.
  const [rent, setRent] = useState<bigint>(BigInt((INTENT_SIZE + 128) * 6960));
  useEffect(() => {
    connection
      .getMinimumBalanceForRentExemption(INTENT_SIZE)
      .then((r) => setRent(BigInt(r)))
      .catch(() => {});
  }, [connection]);
  return rent;
}

export function useConfig(): { config: ConfigAccount | null; missing: boolean } {
  const { connection } = useConnection();
  const [state, setState] = useState<{ config: ConfigAccount | null; missing: boolean }>({
    config: null,
    missing: false,
  });
  useEffect(() => {
    fetchConfig(connection)
      .then((config) => setState({ config, missing: config === null }))
      .catch(() => {});
  }, [connection]);
  return state;
}

export type QuoteState = {
  quote: QuotesResponse | null;
  loading: boolean;
  error: string | null;
  /** ms since epoch of the last successful quote. */
  fetchedAt: number | null;
};

const QUOTE_REFRESH_MS = 15_000;

type QuoteResult = Omit<QuoteState, "loading"> & { key: string; tick: number };

/** Best solver quote for `inLamports`, debounced and refreshed while shown. */
export function useQuote(inLamports: bigint | null): QuoteState & { refresh: () => void } {
  // The last answer, tagged with the amount and refresh tick it answers; loading is derived.
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const key = inLamports && inLamports > 0n ? inLamports.toString() : null;

  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      getJson<QuotesResponse>(`/api/quotes?inLamports=${key}`, ctrl.signal)
        .then((quote) => setResult({ key, tick, quote, error: null, fetchedAt: Date.now() }))
        .catch((e: Error) => {
          if (e.name === "AbortError") return;
          setResult({ key, tick, quote: null, error: e.message, fetchedAt: null });
        });
    }, 350);
    const interval = setInterval(refresh, QUOTE_REFRESH_MS);
    return () => {
      ctrl.abort();
      clearTimeout(t);
      clearInterval(interval);
    };
  }, [key, tick, refresh]);

  if (!key) return { quote: null, loading: false, error: null, fetchedAt: null, refresh };
  // A refresh keeps showing the current amount's quote; a new amount starts empty.
  const same = result?.key === key;
  return {
    quote: same ? result.quote : null,
    loading: !same || result.tick !== tick,
    error: same ? result.error : null,
    fetchedAt: same ? result.fetchedAt : null,
    refresh,
  };
}

export function usePrices(): PricesResponse {
  const [p, setP] = useState<PricesResponse>({ solUsd: null, ethUsd: null, publishTime: null });
  useEffect(() => {
    const load = () => getJson<PricesResponse>("/api/prices").then(setP).catch(() => {});
    load();
    const i = setInterval(load, 60_000);
    return () => clearInterval(i);
  }, []);
  return p;
}

export type RecipientCheck = { address: string | null } & (
  | { state: "idle" }
  | { state: "checking" }
  | { state: "plain" }
  | { state: "contract"; codeSize: number }
  | { state: "unavailable"; error: string }
);

// Definite answers (plain or contract) per address, shared by every hook instance.
const recipientCache = new Map<string, RecipientCheck>();

/**
 * eth_getCode through /api/recipient-check, cached per address. `address` says
 * which address the state belongs to, so callers can ignore a stale result.
 */
export function useRecipientCheck(address: string | null): RecipientCheck {
  const [check, setCheck] = useState<RecipientCheck>({ state: "idle", address: null });
  useEffect(() => {
    if (!address || recipientCache.has(address)) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      getJson<RecipientCheckResponse>(`/api/recipient-check?addr=${address}`, ctrl.signal)
        .then((r) => {
          const c: RecipientCheck = r.plain
            ? { state: "plain", address }
            : { state: "contract", codeSize: r.codeSize, address };
          recipientCache.set(address, c);
          setCheck(c);
        })
        .catch((e: Error) => {
          if (e.name !== "AbortError") setCheck({ state: "unavailable", error: e.message, address });
        });
    }, 300);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [address]);
  if (!address) return { state: "idle", address: null };
  const hit = recipientCache.get(address);
  if (hit) return hit;
  return check.address === address ? check : { state: "checking", address };
}

export { getJson };
