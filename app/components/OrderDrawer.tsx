"use client";

import { useEffect, useState } from "react";
import { basescanTx, requiredOutForIntent, solanaExplorerAddress, solanaExplorerTx } from "@/lib/intents";
import type { PayoutResponse } from "@/app/lib/api-types";
import { formatClock, formatCountdown, formatDuration, formatEthAmount, formatSol, shortAddr } from "@/app/lib/format";
import { withMeasuredTimes, type OrderView } from "@/app/hooks/useOrder";
import { ChainBadge, EthMark, SolMark } from "./icons";
import { StatusPill } from "./StatusPill";

const STEP_TITLE: Record<string, string> = {
  open: "Intent opened",
  matched: "Solver matched",
  signing: "Committee signing",
  signed: "Signature verified",
  broadcast: "Sent on Base",
  completed: "Received on Base",
  expired: "Expired",
  cancelled: "Refunded",
};

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [active]);
  return now;
}

export function OrderDrawer({
  intent,
  order,
  onClose,
  onCancel,
  onCloseIntent,
}: {
  intent: string;
  order: OrderView;
  onClose: () => void;
  onCancel: (intent: string) => Promise<boolean>;
  onCloseIntent: (intent: string) => Promise<boolean>;
}) {
  const { data, closed, error, local } = order;
  const [busy, setBusy] = useState<"cancel" | "close" | null>(null);
  const now = useNow(data?.status === "open" || (!!data?.closableAt && !data.closable));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (kind: "cancel" | "close") => {
    setBusy(kind);
    const ok = await (kind === "cancel" ? onCancel(intent) : onCloseIntent(intent));
    setBusy(null);
    if (ok) order.refresh();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-stretch md:justify-end">
      <button aria-label="Close order" className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <aside
        role="dialog"
        aria-label="Order status"
        className="drawer-panel relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-[28px] border border-line bg-card md:h-full md:max-h-none md:w-[440px] md:rounded-none md:rounded-l-[28px]"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">Order</h2>
              {data ? <StatusPill status={data.status} /> : closed ? <StatusPill status="closed" /> : null}
            </div>
            <a
              href={solanaExplorerAddress(intent)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs text-faint hover:text-muted"
            >
              {shortAddr(intent, 6, 6)} ↗
            </a>
          </div>
          <button aria-label="Close" onClick={onClose} className="h-9 w-9 rounded-full bg-panel text-muted hover:text-fg">
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!data && !closed && !error && <DrawerSkeleton />}
          {closed && !data && (
            <p className="rounded-2xl bg-panel p-4 text-sm text-muted">
              This intent account is closed (its rent went back to the owner), so it no longer appears on chain.
            </p>
          )}
          {error && !data && <p className="rounded-2xl bg-bad-soft p-4 text-sm text-bad">{error}</p>}

          {data && (
            <>
              <Summary data={data} />
              <Banner data={data} now={now} busy={busy} onCancel={() => run("cancel")} />
              <ol className="mt-5">
                {withMeasuredTimes(data.steps, local).map((s, i, all) => (
                  <li key={s.id} className="relative flex gap-3 pb-5 last:pb-0">
                    {i < all.length - 1 && (
                      <span
                        className={`absolute top-6 left-[11px] h-[calc(100%-20px)] w-px ${
                          s.state === "done" ? "bg-good/50" : "bg-line"
                        }`}
                      />
                    )}
                    <StepDot state={s.state} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`text-sm font-medium ${s.state === "todo" ? "text-faint" : "text-fg"}`}>
                          {STEP_TITLE[s.id] ?? s.id}
                        </span>
                        <ChainBadge chain={s.chain} />
                      </div>
                      {s.state !== "todo" && <p className="mt-0.5 text-sm text-muted">{s.label}</p>}
                      {s.state !== "todo" && (s.timestamp !== undefined || s.txHash) && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-faint">
                          {s.timestamp !== undefined && (
                            <span className="font-mono">
                              {formatClock(s.timestamp)}
                              {!s.measured && " (block time)"}
                            </span>
                          )}
                          {s.elapsedMs !== undefined && (
                            <span className="rounded bg-panel px-1.5 py-0.5 font-mono text-muted">
                              {s.id === "open" ? "confirmed in " : "+"}
                              {formatDuration(s.elapsedMs, s.chain === "solana")}
                            </span>
                          )}
                          {s.txHash && (
                            <a
                              href={s.chain === "solana" ? solanaExplorerTx(s.txHash) : basescanTx(s.txHash)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-accent hover:text-accent-hover"
                            >
                              {s.chain === "solana" ? "Explorer" : "Basescan"} ↗
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>

              {data.candidates.length > 1 && (
                <div className="mt-5 rounded-2xl bg-panel p-3 text-xs text-muted">
                  <p className="mb-2 text-fg">Speeding up: {data.candidates.length} signed payouts at Base nonce {data.intent.baseNonce}</p>
                  {data.candidates.map((c) => (
                    <div key={c.sigRequest} className="flex justify-between gap-2 font-mono">
                      <span>
                        #{c.index} · {c.gasPrice ? `${(Number(c.gasPrice) / 1e9).toFixed(3)} gwei` : "gas ?"}
                      </span>
                      {c.txHash ? (
                        <a className="text-accent" href={basescanTx(c.txHash)} target="_blank" rel="noreferrer">
                          {shortAddr(c.txHash, 6, 4)} ↗
                        </a>
                      ) : (
                        <span>{c.completed ? "signed" : "signing…"}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {!data.base.ok && data.candidates.some((c) => c.txHash) && (
                <p className="mt-4 rounded-2xl bg-warn-soft p-3 text-xs text-warn">
                  Base receipts unavailable right now ({data.base.error}). The Basescan link above shows the payout.
                </p>
              )}

              {(data.intent.status === "cancelled" || data.closableAt) && (
                <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl bg-panel p-3 text-sm">
                  <span className="text-muted">
                    {data.closable
                      ? "Close the intent to reclaim its rent."
                      : `Rent can be reclaimed in ${formatCountdown((data.closableAt ?? 0) - now / 1000)}.`}
                  </span>
                  <button
                    disabled={!data.closable || busy !== null}
                    onClick={() => run("close")}
                    className="shrink-0 rounded-full bg-accent-soft px-3 py-1.5 font-medium text-accent hover:bg-accent hover:text-white disabled:opacity-40 disabled:hover:bg-accent-soft disabled:hover:text-accent"
                  >
                    {busy === "close" ? "Closing…" : "Close"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-line bg-panel/50 px-5 py-3 text-sm text-good">
          <span aria-hidden>✓</span>
          Safe to close this tab. Track it in Activity.
        </footer>
      </aside>
    </div>
  );
}

function Summary({ data }: { data: PayoutResponse }) {
  const i = data.intent;
  const filled = i.status === "filled";
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-panel p-4">
      <SolMark size={28} />
      <div className="min-w-0">
        <div className="text-sm font-medium tabular-nums">{formatSol(BigInt(i.inLamports))} SOL</div>
        <div className="text-xs text-faint">Solana</div>
      </div>
      <span className="mx-auto text-faint">→</span>
      <div className="min-w-0 text-right">
        <div className="text-sm font-medium tabular-nums">
          {filled ? "" : "≥ "}
          {formatEthAmount(BigInt(filled ? i.outWei : i.minOutWei))} ETH
        </div>
        <div className="truncate font-mono text-xs text-faint" title={i.recipient}>
          to {shortAddr(i.recipient, 6, 4)}
        </div>
      </div>
      <EthMark size={28} />
    </div>
  );
}

function Banner({
  data,
  now,
  busy,
  onCancel,
}: {
  data: PayoutResponse;
  now: number;
  busy: string | null;
  onCancel: () => void;
}) {
  const i = data.intent;
  if (data.status === "open") {
    const nowSec = BigInt(Math.floor(now / 1000));
    const required = requiredOutForIntent(
      {
        startOutWei: BigInt(i.startOutWei),
        minOutWei: BigInt(i.minOutWei),
        auctionStart: BigInt(i.auctionStart),
        auctionDuration: i.auctionDuration,
      },
      nowSec,
    );
    const auctionLeft = i.auctionStart + i.auctionDuration - now / 1000;
    const total = BigInt(i.startOutWei) - BigInt(i.minOutWei);
    const pct = total > 0n ? Number(((BigInt(i.startOutWei) - required) * 1000n) / total) / 10 : 100;
    return (
      <div className="mt-4 rounded-2xl border border-accent/30 bg-accent-soft p-4">
        <p className="text-sm text-fg">SOL locked in escrow. Finding a solver…</p>
        <div className="mt-3 flex items-end justify-between">
          <div>
            <div className="text-xs text-muted">Required now</div>
            <div className="text-lg font-semibold tabular-nums">{formatEthAmount(required)} ETH</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-muted">{auctionLeft > 0 ? "Auction ends in" : "Expires in"}</div>
            <div className="font-mono text-lg tabular-nums">
              {formatCountdown(auctionLeft > 0 ? auctionLeft : i.expiresAt - now / 1000)}
            </div>
          </div>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg/60">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-faint">
          <span>{formatEthAmount(BigInt(i.startOutWei))}</span>
          <span>min {formatEthAmount(BigInt(i.minOutWei))}</span>
        </div>
        <button
          onClick={onCancel}
          disabled={busy !== null}
          className="mt-3 text-xs text-muted underline-offset-2 hover:text-fg hover:underline disabled:opacity-40"
        >
          {busy === "cancel" ? "Cancelling…" : "Cancel and refund"}
        </button>
      </div>
    );
  }
  if (data.status === "expired") {
    return (
      <div className="mt-4 rounded-2xl border border-warn/30 bg-warn-soft p-4">
        <p className="text-sm text-fg">No solver filled in time. Cancel to get your SOL back.</p>
        <p className="mt-1 text-xs text-muted">Cancelling is one Solana transaction; it returns the escrowed SOL.</p>
        <button
          onClick={onCancel}
          disabled={busy !== null}
          className="mt-3 h-10 w-full rounded-2xl bg-warn font-semibold text-black hover:opacity-90 disabled:opacity-50"
        >
          {busy === "cancel" ? "Cancelling…" : `Cancel and refund ${formatSol(BigInt(i.inLamports))} SOL`}
        </button>
      </div>
    );
  }
  if (data.status === "completed" && data.delivered) {
    return (
      <div className="mt-4 rounded-2xl border border-good/30 bg-good-soft p-4">
        <p className="text-sm font-medium text-good">
          Received {formatEthAmount(BigInt(i.outWei))} ETH
          {data.surplusWei && BigInt(data.surplusWei) > 0n
            ? ` (+${formatEthAmount(BigInt(data.surplusWei))} above minimum)`
            : ""}
        </p>
        <a
          href={basescanTx(data.delivered.txHash)}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-xs text-accent hover:text-accent-hover"
        >
          View on Basescan ↗
        </a>
      </div>
    );
  }
  if (data.status === "reverted") {
    return (
      <div className="mt-4 rounded-2xl border border-bad/30 bg-bad-soft p-4 text-sm text-bad">
        The payout was mined but reverted on Base. The recipient likely runs code on receive.
      </div>
    );
  }
  return null;
}

function StepDot({ state }: { state: "done" | "active" | "todo" | "failed" }) {
  if (state === "done")
    return (
      <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-good text-xs text-black">
        ✓
      </span>
    );
  if (state === "failed")
    return (
      <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bad text-xs text-black">
        ✕
      </span>
    );
  if (state === "active")
    return (
      <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-accent bg-card">
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
      </span>
    );
  return <span className="relative z-10 h-6 w-6 shrink-0 rounded-full border-2 border-line bg-card" />;
}

function DrawerSkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-16 animate-pulse rounded-2xl bg-panel" />
      <div className="h-24 animate-pulse rounded-2xl bg-panel" />
      {[0, 1, 2, 3].map((k) => (
        <div key={k} className="h-10 animate-pulse rounded-xl bg-panel/60" />
      ))}
    </div>
  );
}
