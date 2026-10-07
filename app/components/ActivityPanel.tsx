"use client";

import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  IntentStatus,
  basescanTx,
  fetchIntentsByUser,
  solanaExplorerAddress,
  type IntentAccount,
  type Keyed,
} from "@/lib/intents";
import type { PayoutResponse } from "@/app/lib/api-types";
import { formatDateTime, formatEthAmount, formatSol } from "@/app/lib/format";
import { EthMark, SolMark } from "./icons";
import { StatusPill } from "./StatusPill";

export function ActivityPanel({
  refreshKey,
  onSelect,
  onCancel,
  onCloseIntent,
}: {
  refreshKey: number;
  onSelect: (intent: string) => void;
  onCancel: (intent: string) => Promise<boolean>;
  onCloseIntent: (intent: string) => Promise<boolean>;
}) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  // Tagged with the wallet they belong to, so a disconnect or switch hides them at once.
  const [loaded, setLoaded] = useState<{ owner: string; rows: Keyed<IntentAccount>[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!publicKey) return;
    let alive = true;
    // getProgramAccounts: Intent discriminator at 0 and user at 8 (§5.4).
    fetchIntentsByUser(connection, publicKey)
      .then((r) => {
        if (!alive) return;
        const rows = r.sort((a, b) => Number(b.account.auctionStart - a.account.auctionStart));
        setLoaded({ owner: publicKey.toBase58(), rows });
        setError(null);
      })
      .catch((e: Error) => alive && setError(e.message));
    const i = setInterval(reload, 20_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, [connection, publicKey, tick, refreshKey, reload]);
  const rows = publicKey && loaded?.owner === publicKey.toBase58() ? loaded.rows : null;

  return (
    <section id="activity" className="w-full rounded-[28px] border border-line bg-card p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">Activity</h2>
        {publicKey && (
          <button onClick={reload} className="text-xs text-muted hover:text-fg">
            Refresh
          </button>
        )}
      </div>
      {!publicKey && <p className="py-6 text-center text-sm text-muted">Connect a wallet to see your intents.</p>}
      {publicKey && error && <p className="py-4 text-sm text-bad">Could not load intents: {error}</p>}
      {publicKey && !error && rows === null && (
        <div className="space-y-2">
          {[0, 1].map((k) => (
            <div key={k} className="h-16 animate-pulse rounded-2xl bg-panel" />
          ))}
        </div>
      )}
      {rows && rows.length === 0 && (
        <p className="py-6 text-center text-sm text-muted">No open intents. Closed intents leave no account behind.</p>
      )}
      {rows && rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((r) => (
            <ActivityRow
              key={r.pubkey.toBase58()}
              row={r}
              refreshKey={refreshKey + tick}
              onSelect={onSelect}
              onAction={async (kind) => {
                const ok = await (kind === "cancel" ? onCancel : onCloseIntent)(r.pubkey.toBase58());
                if (ok) reload();
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ActivityRow({
  row,
  refreshKey,
  onSelect,
  onAction,
}: {
  row: Keyed<IntentAccount>;
  refreshKey: number;
  onSelect: (intent: string) => void;
  onAction: (kind: "cancel" | "close") => Promise<void>;
}) {
  const a = row.account;
  const address = row.pubkey.toBase58();
  const filled = a.status === IntentStatus.Filled;
  const [payout, setPayout] = useState<PayoutResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [nowSec, setNowSec] = useState<number | null>(null);

  // Read the clock after hydration (not during render) so server and client markup match.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNowSec(Math.floor(Date.now() / 1000));
  }, [refreshKey]);

  // Filled rows need the Base side (§3.5) for their pill and Basescan link.
  useEffect(() => {
    if (!filled || payout?.status === "completed") return;
    let alive = true;
    fetch(`/api/payout?intent=${address}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<PayoutResponse>) : null))
      .then((p) => alive && p && setPayout(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, filled, refreshKey]);

  const expired = a.status === IntentStatus.Open && nowSec !== null && nowSec >= Number(a.expiresAt);
  const status =
    a.status === IntentStatus.Cancelled ? "cancelled" : a.status === IntentStatus.Open ? (expired ? "expired" : "open") : payout?.status ?? "filled";
  // A Filled intent holds the state bump_gas needs, so only the admin closes it.
  const closable = a.status === IntentStatus.Cancelled;
  const baseHash = payout?.delivered?.txHash ?? [...(payout?.candidates ?? [])].reverse().find((c) => c.txHash)?.txHash;

  const act = async (e: MouseEvent, kind: "cancel" | "close") => {
    e.stopPropagation();
    setBusy(true);
    await onAction(kind);
    setBusy(false);
  };

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(address)}
        onKeyDown={(e) => e.key === "Enter" && onSelect(address)}
        className="flex cursor-pointer flex-col gap-2 rounded-2xl bg-panel p-3 transition hover:bg-panel-hover sm:flex-row sm:items-center sm:gap-4"
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex -space-x-2">
            <SolMark size={24} />
            <EthMark size={24} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 text-sm font-medium tabular-nums">
              <span>{formatSol(a.inLamports)} SOL</span>
              <span className="text-faint">→</span>
              <span>
                {filled ? "" : "≥ "}
                {formatEthAmount(filled ? a.outWei : a.minOutWei)} ETH
              </span>
            </div>
            <div className="text-xs text-faint">{formatDateTime(Number(a.auctionStart) * 1000)} · SOL → ETH</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <StatusPill status={status} />
          <a
            href={solanaExplorerAddress(address)}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-muted hover:text-fg"
          >
            Explorer ↗
          </a>
          {baseHash && (
            <a
              href={basescanTx(baseHash)}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-muted hover:text-fg"
            >
              Basescan ↗
            </a>
          )}
          {a.status === IntentStatus.Open && (
            <button
              disabled={busy}
              onClick={(e) => act(e, "cancel")}
              className={`rounded-full px-2.5 py-1 font-medium disabled:opacity-40 ${
                expired ? "bg-warn text-black" : "bg-bg/60 text-muted hover:text-fg"
              }`}
            >
              {busy ? "…" : "Cancel"}
            </button>
          )}
          {closable && (
            <button
              disabled={busy}
              onClick={(e) => act(e, "close")}
              className="rounded-full bg-accent-soft px-2.5 py-1 font-medium text-accent hover:bg-accent hover:text-white disabled:opacity-40"
            >
              {busy ? "…" : "Close"}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
