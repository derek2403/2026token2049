"use client";

import { useEffect, useState } from "react";
import { basescanTx, solanaExplorerTx, type OrderStatus } from "@/lib/intents";
import { formatCountdown, formatEthAmount, formatSol } from "@/app/lib/format";
import type { OrderView } from "@/app/hooks/useOrder";
import { STEP_TITLE } from "./OrderDrawer";
import { TOAST_TONE, type ToastKind } from "./Toasts";
import { ChevronDown, CloseIcon } from "./icons";

const TONE: Record<OrderStatus, ToastKind | "neutral"> = {
  open: "info",
  matched: "info",
  signing: "info",
  signed: "info",
  broadcast: "info",
  completed: "success",
  expired: "warn",
  reverted: "error",
  cancelled: "neutral",
};
const TERMINAL: OrderStatus[] = ["completed", "reverted", "cancelled"];
const HIDE_AFTER_MS = 10_000;

/**
 * Live tracker for the order this tab opened, after 1inch's cross-chain toast:
 * a status pill with a percentage that expands into a step list.
 */
export function OrderTracker({
  order,
  unconfirmed,
  onDetails,
  onActivity,
  onCancel,
  onHide,
}: {
  order: OrderView;
  /** open_intent was sent but its confirmation timed out: the account may still land. */
  unconfirmed: boolean;
  onDetails: () => void;
  onActivity: () => void;
  onCancel: () => Promise<boolean>;
  onHide: () => void;
}) {
  const { data, closed } = order;
  // Not on chain (yet) for an order sent from this tab: keep looking instead of calling it closed.
  const landing = unconfirmed && closed && !data;
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const status = data?.status ?? null;
  const terminal = (closed && !landing) || (status !== null && TERMINAL.includes(status));

  // useOrder stops polling once the account reads as closed; re-check for two minutes.
  const { refresh } = order;
  useEffect(() => {
    if (!landing) return;
    let n = 0;
    const i = setInterval(() => (++n > 24 ? clearInterval(i) : refresh()), 5000);
    return () => clearInterval(i);
  }, [landing, refresh]);

  useEffect(() => {
    if (status !== "open") return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [status]);

  // Finished orders hide themselves after 10 s unless the list is open.
  useEffect(() => {
    if (!terminal || expanded) return;
    const t = setTimeout(onHide, HIDE_AFTER_MS);
    return () => clearTimeout(t);
  }, [terminal, expanded, onHide]);

  const tone = status ? TONE[status] : "info";
  const cls = tone === "neutral" ? "bg-panel-hover text-fg" : TOAST_TONE[tone];
  const steps = data?.steps ?? [];
  const done = steps.filter((s) => s.state === "done").length;
  const pct = status === "completed" ? 100 : steps.length ? Math.round((done / steps.length) * 100) : 0;
  const active = steps.find((s) => s.state === "active" || s.state === "failed");

  const i = data?.intent;
  const sol = i ? formatSol(BigInt(i.inLamports)) : null;
  const auctionLeft = i ? i.auctionStart + i.auctionDuration - now / 1000 : 0;
  const expiresLeft = i ? i.expiresAt - now / 1000 : 0;

  let title = sol ? `Swapping ${sol} SOL to ETH` : "Loading order";
  if (landing) title = "Confirming order";
  else if (closed && !data) title = "Order closed";
  else if (status === "completed" && i) title = `Received ${formatEthAmount(BigInt(i.outWei))} ETH`;
  else if (status === "expired") title = "No solver filled in time";
  else if (status === "cancelled") title = `Refunded ${sol} SOL`;
  else if (status === "reverted") title = "Payout reverted on Base";

  let subtitle = landing ? "Not on chain yet. Check Activity before opening another." : active ? STEP_TITLE[active.id] ?? active.id : "";
  if (status === "open") subtitle = `Dutch auction · ${formatCountdown(auctionLeft > 0 ? auctionLeft : expiresLeft)}`;
  else if (status === "completed") subtitle = "Completed";
  else if (status === "expired") subtitle = "Cancel to get your SOL back";

  const cancellable = status === "open" || status === "expired";
  const cancel = async () => {
    setBusy(true);
    const ok = await onCancel();
    setBusy(false);
    if (ok) order.refresh();
  };

  return (
    <div className={`toast-in pointer-events-auto relative overflow-hidden rounded-[36px] ${cls}`}>
      <div className="flex items-center gap-3 px-6 py-4">
        <button
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-base leading-6 font-medium">{title}</p>
            {subtitle && <p className="truncate text-sm leading-5 opacity-80 tabular-nums">{subtitle}</p>}
          </div>
          {!terminal && status !== "expired" && (
            <span className="flex shrink-0 items-center gap-2 text-sm font-medium tabular-nums">
              {pct}%
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent opacity-80" />
            </span>
          )}
          <span className={`shrink-0 opacity-80 transition ${expanded ? "rotate-180" : ""}`}>
            <ChevronDown />
          </span>
        </button>
        <button
          aria-label="Hide"
          onClick={onHide}
          className="-mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full opacity-70 hover:opacity-100"
        >
          <CloseIcon size={16} />
        </button>
      </div>

      {expanded && (
        <div className="px-6 pb-4">
          <ol>
            {steps.map((s, idx) => (
              <li key={s.id} className="relative flex min-h-7 items-center gap-2">
                {idx < steps.length - 1 && (
                  <span className="absolute top-[18px] left-[9px] h-[calc(100%-8px)] w-0.5 bg-current opacity-25" />
                )}
                <Dot state={s.state} />
                <span className={`flex-1 text-sm ${s.state === "todo" ? "opacity-60" : ""}`}>
                  {STEP_TITLE[s.id] ?? s.id}
                </span>
                {s.id === "open" && status === "open" ? (
                  <span className="text-sm font-medium tabular-nums">
                    {formatCountdown(auctionLeft > 0 ? auctionLeft : expiresLeft)}
                  </span>
                ) : s.txHash ? (
                  <a
                    href={s.chain === "solana" ? solanaExplorerTx(s.txHash) : basescanTx(s.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-medium hover:underline"
                  >
                    View
                  </a>
                ) : null}
              </li>
            ))}
          </ol>
          <div className="mt-3 flex gap-2">
            {landing && (
              <button
                onClick={onActivity}
                className="h-10 flex-1 rounded-full bg-black text-sm font-medium text-white transition hover:bg-black/80"
              >
                Activity
              </button>
            )}
            {cancellable && (
              <button
                disabled={busy}
                onClick={cancel}
                className="h-10 flex-1 rounded-full bg-black text-sm font-medium text-white transition hover:bg-black/80 disabled:opacity-50"
              >
                {busy ? "Cancelling…" : "Cancel"}
              </button>
            )}
            <button
              onClick={onDetails}
              className="h-10 flex-1 rounded-full bg-black text-sm font-medium text-white transition hover:bg-black/80"
            >
              Details
            </button>
          </div>
        </div>
      )}

      {terminal && !expanded && (
        <span
          className="toast-timer absolute bottom-0 left-0 h-2 bg-black/15"
          style={{ animationDuration: `${HIDE_AFTER_MS}ms` }}
        />
      )}
    </div>
  );
}

function Dot({ state }: { state: "done" | "active" | "todo" | "failed" }) {
  if (state === "done")
    return (
      <span className="relative z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white text-[11px] font-medium text-black">
        ✓
      </span>
    );
  if (state === "failed")
    return (
      <span className="relative z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white text-[11px] font-medium text-bad">
        ✕
      </span>
    );
  if (state === "active")
    return (
      <span className="relative z-10 h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-white border-t-transparent" />
    );
  return <span className="relative z-10 h-5 w-5 shrink-0 rounded-full bg-white/30" />;
}
