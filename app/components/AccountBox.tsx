"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { basescanAddress, solanaExplorerAddress, walletEvmAddress } from "@/lib/intents";
import { toChecksumAddress } from "@/app/lib/eth";
import { formatSol, formatUsd, shortAddr, toFloat } from "@/app/lib/format";
import { useGroupPk, usePrices, useSolBalance } from "@/app/hooks/data";
import { ActivityPanel } from "./ActivityPanel";
import { AddressAvatar, CloseIcon, TokenWithChain } from "./icons";

export type AccountTab = "assets" | "activity";

/**
 * The account box that opens from the wallet pill, as on 1inch: a full-height
 * panel with net worth and Assets | Activity tabs.
 */
export function AccountBox({
  tab,
  setTab,
  onClose,
  refreshKey,
  onSelect,
  onCancel,
  onCloseIntent,
}: {
  tab: AccountTab;
  setTab: (t: AccountTab) => void;
  onClose: () => void;
  refreshKey: number;
  onSelect: (intent: string) => void;
  onCancel: (intent: string) => Promise<boolean>;
  onCloseIntent: (intent: string) => Promise<boolean>;
}) {
  const { publicKey, disconnect } = useWallet();
  const { groupPk, live: groupPkLive } = useGroupPk();
  const { lamports } = useSolBalance(publicKey);
  const prices = usePrices();
  const [copied, setCopied] = useState<string | null>(null);
  const baseAddr = useMemo(
    () => (publicKey ? toChecksumAddress(walletEvmAddress(publicKey, groupPk)) : null),
    [publicKey, groupPk],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Disconnected elsewhere (e.g. from Phantom): close rather than reopen on the next connect.
  useEffect(() => {
    if (!publicKey) onClose();
  }, [publicKey, onClose]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  if (!publicKey) return null;
  const addr = publicKey.toBase58();
  const usd = lamports !== null && prices.solUsd ? toFloat(lamports, 9) * prices.solUsd : null;
  const copy = (v: string) => {
    navigator.clipboard?.writeText(v).catch(() => {});
    setCopied(v);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button aria-label="Close account" className="overlay-in absolute inset-0 bg-black/70" onClick={onClose} />
      <aside
        role="dialog"
        aria-label="Account"
        className="drawer-panel relative flex w-full flex-col overflow-hidden bg-card max-md:mt-auto max-md:max-h-[92vh] md:m-2 md:w-[420px]"
      >
        {/* Connection header */}
        <header className="flex h-[72px] shrink-0 items-center gap-3 px-4">
          <AddressAvatar address={addr} size={40} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-medium">{shortAddr(addr, 4, 4)}</div>
            <div className="truncate text-xs text-muted">Solana devnet</div>
          </div>
          <IconBtn label={copied === addr ? "Copied" : "Copy address"} onClick={() => copy(addr)}>
            {copied === addr ? <span className="text-xs">✓</span> : <CopyIcon />}
          </IconBtn>
          <IconBtn label="View on Explorer" href={solanaExplorerAddress(addr)}>
            <ExternalIcon />
          </IconBtn>
          <IconBtn
            label="Disconnect"
            onClick={() => {
              onClose();
              disconnect().catch(() => {});
            }}
          >
            <PowerIcon />
          </IconBtn>
          <IconBtn label="Close" onClick={onClose}>
            <CloseIcon />
          </IconBtn>
        </header>

        {/* Net worth */}
        <div className="px-4 pt-4 pb-5">
          <div className="text-sm text-muted">Net worth</div>
          <div className="mt-1 text-[32px] leading-10 font-[450] tabular-nums">
            {formatUsd(usd) ?? (lamports !== null ? `${formatSol(lamports)} SOL` : "–")}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-4" role="tablist">
          {(["assets", "activity"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`h-10 rounded-full px-4 text-base transition ${
                tab === t ? "bg-panel-hover font-[450] text-fg" : "text-muted hover:text-fg"
              }`}
            >
              {t === "assets" ? "Assets" : "Activity"}
            </button>
          ))}
        </div>

        <div className="mt-3 flex-1 overflow-y-auto px-4 pb-6">
          {tab === "assets" ? (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-3 bg-panel px-4 py-3">
                <TokenWithChain token="SOL" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">SOL</div>
                  <div className="text-xs text-muted">Solana devnet</div>
                </div>
                <div className="text-right tabular-nums">
                  <div>{lamports !== null ? formatSol(lamports) : "–"}</div>
                  <div className="text-xs text-muted">{formatUsd(usd) ?? ""}</div>
                </div>
              </div>
              {baseAddr && (
                <div className="flex items-center gap-3 bg-panel px-4 py-3">
                  <TokenWithChain token="ETH" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">Your Base address</div>
                    <div className="truncate font-mono text-xs text-muted">{shortAddr(baseAddr, 8, 6)}</div>
                    {!groupPkLive && <div className="text-xs text-warn">Derived with the cached committee key</div>}
                  </div>
                  <button onClick={() => copy(baseAddr)} className="text-sm text-accent hover:opacity-70">
                    {copied === baseAddr ? "Copied" : "Copy"}
                  </button>
                  <a
                    href={basescanAddress(baseAddr)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-accent hover:opacity-70"
                  >
                    Basescan ↗
                  </a>
                </div>
              )}
              <p className="mt-3 text-xs leading-relaxed text-faint">
                Your Base address is derived from this Phantom wallet and the SODA committee key. ETH you buy is paid
                out there; only this wallet can move it.
              </p>
            </div>
          ) : (
            <ActivityPanel refreshKey={refreshKey} onSelect={onSelect} onCancel={onCancel} onCloseIntent={onCloseIntent} />
          )}
        </div>
      </aside>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  href,
  children,
}: {
  label: string;
  onClick?: () => void;
  href?: string;
  children: ReactNode;
}) {
  const cls =
    "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-panel-hover text-fg transition hover:bg-pill-hover";
  if (href)
    return (
      <a aria-label={label} title={label} href={href} target="_blank" rel="noreferrer" className={cls}>
        {children}
      </a>
    );
  return (
    <button aria-label={label} title={label} onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

const svg = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "square" as const,
  strokeLinejoin: "miter" as const,
  "aria-hidden": true,
};
const CopyIcon = () => (
  <svg {...svg}>
    <rect x="8" y="8" width="12" height="12" />
    <path d="M16 8V4H4v12h4" />
  </svg>
);
const ExternalIcon = () => (
  <svg {...svg}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />
  </svg>
);
const PowerIcon = () => (
  <svg {...svg}>
    <path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0" />
  </svg>
);
