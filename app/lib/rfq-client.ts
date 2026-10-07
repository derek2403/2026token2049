"use client";

// Browser side of the RFQ (NEAR-style) flow: relay JSON-RPC calls, the user
// vault's deposit/withdraw transactions, and the data hooks RfqPanel uses.

import { useCallback, useEffect, useRef, useState } from "react";
import { BN, type Program } from "@coral-xyz/anchor";
import { useConnection } from "@solana/wallet-adapter-react";
import { SystemProgram, type Connection, type PublicKey, type Transaction } from "@solana/web3.js";
import {
  configPda,
  decodeUserVault,
  vaultPda,
  type RelayPublishResponse,
  type RelayQuote,
  type RelayStatus,
  type SignedIntentWire,
  type UserVaultAccount,
} from "@/lib/intents";

// ---------------------------------------------------------------- relay

export class RelayError extends Error {
  constructor(
    message: string,
    public code?: number,
    public data?: unknown,
  ) {
    super(message);
  }
}

let rpcId = 0;

export async function relayRpc<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const resp = await fetch("/api/rfq", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal,
    cache: "no-store",
  });
  const body = (await resp.json().catch(() => null)) as
    | { result?: T; error?: { code?: number; message?: string; data?: unknown } }
    | null;
  if (!body || body.error || body.result === undefined) {
    throw new RelayError(body?.error?.message ?? `Relay HTTP ${resp.status}`, body?.error?.code, body?.error?.data);
  }
  return body.result;
}

export const relayQuote = (exactAmountIn: bigint, recipient?: string, signal?: AbortSignal) =>
  relayRpc<RelayQuote[]>("quote", { exact_amount_in: exactAmountIn.toString(), recipient }, signal);

export const relayPublish = (quoteHash: string, wire: SignedIntentWire) =>
  relayRpc<RelayPublishResponse>("publish_intent", { quote_hash: quoteHash, ...wire });

export type RelayStatusResult = { intent: string; status: RelayStatus; order_status?: string; tx?: string; base_tx?: string };

export const relayStatus = (intent: string) => relayRpc<RelayStatusResult>("get_status", { intent });

// ---------------------------------------------------------------- vault transactions

const bn = (v: bigint) => new BN(v.toString());

export function buildDepositSolTx(program: Program, owner: PublicKey, lamports: bigint): Promise<Transaction> {
  return program.methods
    .depositSol(bn(lamports))
    .accountsStrict({
      owner,
      config: configPda(program.programId)[0],
      userVault: vaultPda(owner, program.programId)[0],
      systemProgram: SystemProgram.programId,
    })
    .transaction();
}

/** withdraw_sol ignores pause, so a user can always take their SOL back. */
export function buildWithdrawSolTx(program: Program, owner: PublicKey, lamports: bigint): Promise<Transaction> {
  return program.methods
    .withdrawSol(bn(lamports))
    .accountsStrict({ owner, userVault: vaultPda(owner, program.programId)[0] })
    .transaction();
}

/** Cluster unix time (never earlier than the local clock); the program checks deadlines against it. */
export async function clusterNowSec(connection: Connection): Promise<bigint> {
  const clusterSec = await connection
    .getSlot("confirmed")
    .then((slot) => connection.getBlockTime(slot))
    .catch(() => null);
  const localSec = Math.floor(Date.now() / 1000);
  return BigInt(Math.max(clusterSec ?? localSec, localSec));
}

// ---------------------------------------------------------------- hooks

export type VaultState = {
  /** null: no vault account yet (first deposit creates it). */
  vault: UserVaultAccount | null;
  loaded: boolean;
  refresh: () => void;
};

/** The user's UserVault, live over the websocket. */
export function useUserVault(owner: PublicKey | null): VaultState {
  const { connection } = useConnection();
  const [state, setState] = useState<{ owner: string; vault: UserVaultAccount | null } | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!owner) return;
    let alive = true;
    const key = owner.toBase58();
    const [pda] = vaultPda(owner);
    const set = (data: Uint8Array | null) => {
      if (!alive) return;
      try {
        setState({ owner: key, vault: data ? decodeUserVault(data) : null });
      } catch {
        setState({ owner: key, vault: null });
      }
    };
    connection
      .getAccountInfo(pda, "confirmed")
      .then((info) => set(info?.data ?? null))
      .catch(() => {});
    const sub = connection.onAccountChange(pda, (info) => set(info.data.length > 0 ? info.data : null), {
      commitment: "confirmed",
    });
    return () => {
      alive = false;
      connection.removeAccountChangeListener(sub).catch(() => {});
    };
  }, [connection, owner, tick]);

  const mine = owner && state?.owner === owner.toBase58();
  return { vault: mine ? state.vault : null, loaded: !!mine, refresh };
}

export type QuotesState = {
  quotes: RelayQuote[];
  /** The request the quotes answer. */
  amountIn: bigint | null;
  recipient: string | null;
  fetchedAt: number | null;
  loading: boolean;
  error: string | null;
};

const EMPTY: QuotesState = { quotes: [], amountIn: null, recipient: null, fetchedAt: null, loading: false, error: null };

/** Relay quotes on demand; a new request cancels the one in flight. */
export function useRfqQuotes() {
  const [state, setState] = useState<QuotesState>(EMPTY);
  const ctrl = useRef<AbortController | null>(null);

  const request = useCallback(async (amountIn: bigint, recipient: string) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const quotes = await relayQuote(amountIn, recipient, c.signal);
      if (!c.signal.aborted) setState({ quotes, amountIn, recipient, fetchedAt: Date.now(), loading: false, error: null });
    } catch (e) {
      if (c.signal.aborted) return;
      setState({ ...EMPTY, error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const clear = useCallback(() => {
    ctrl.current?.abort();
    setState(EMPTY);
  }, []);

  useEffect(() => () => ctrl.current?.abort(), []);
  return { ...state, request, clear };
}

/** Date.now(), re-rendered every `ms` while `active`. */
export function useNow(ms = 250, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const i = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(i);
  }, [ms, active]);
  return now;
}
