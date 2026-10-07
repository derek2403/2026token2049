"use client";

import { useEffect, useState } from "react";
import { DEST_CHAINS, type DestChain, type DestChainId } from "@/app/lib/chains";
import { ChainMark, CloseIcon, DestTokenMark } from "./icons";

/** Destination picker, after 1inch's token picker: search, network chips, token rows. */
export function TokenPicker({
  selected,
  onSelect,
  onClose,
}: {
  selected: DestChainId | null;
  onSelect: (id: DestChainId) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [network, setNetwork] = useState<DestChainId | "all">("all");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const rows = DEST_CHAINS.filter(
    (c) =>
      (network === "all" || c.id === network) &&
      (!q || [c.token, c.tokenName, c.name, c.network].some((s) => s.toLowerCase().includes(q))),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:px-4" role="dialog" aria-label="Select token">
      <button aria-label="Close token picker" className="overlay-in absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="pop-in relative flex max-h-[85vh] w-full flex-col bg-subtle sm:max-w-[440px]">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-xl leading-7 font-medium">Select token</h2>
          <button
            aria-label="Close"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-panel-hover text-fg transition hover:bg-pill-hover"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="px-5 pt-4">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or network"
            className="h-12 w-full bg-card px-4 text-base caret-accent outline-none placeholder:text-faint focus:ring-1 focus:ring-accent"
            aria-label="Search tokens"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto px-5 pt-3 pb-1">
          <Chip active={network === "all"} onClick={() => setNetwork("all")}>
            All networks
          </Chip>
          {DEST_CHAINS.map((c) => (
            <Chip key={c.id} active={network === c.id} onClick={() => setNetwork(c.id)}>
              <ChainMark chain={c.id} size={16} />
              {c.name}
            </Chip>
          ))}
        </div>
        <ul className="mt-2 flex-1 overflow-y-auto pb-3">
          {rows.length === 0 && <li className="px-5 py-8 text-center text-sm text-muted">No tokens found</li>}
          {rows.map((c) => (
            <li key={c.id}>
              <TokenRow chain={c} selected={selected === c.id} onClick={() => onSelect(c.id)} />
            </li>
          ))}
        </ul>
        <p className="border-t border-line px-5 py-3 text-xs text-faint">
          Live today: Base Sepolia. Other networks are listed and selectable; their payout routes are not deployed yet.
        </p>
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm whitespace-nowrap transition ${
        active ? "bg-fg text-card" : "bg-panel-hover text-fg hover:bg-pill-hover"
      }`}
    >
      {children}
    </button>
  );
}

function TokenRow({ chain, selected, onClick }: { chain: DestChain; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-5 py-3 text-left transition hover:bg-panel-hover ${selected ? "bg-panel-hover" : ""}`}
    >
      <DestTokenMark token={chain.token} chain={chain.id} ring="ring-subtle" />
      <span className="min-w-0 flex-1">
        <span className="block text-base font-medium">{chain.token}</span>
        <span className="block truncate text-sm text-muted">
          {chain.tokenName} · {chain.network}
        </span>
      </span>
      {chain.live ? (
        <span className="rounded-full bg-good-soft px-2.5 py-0.5 text-xs font-medium text-good">Live</span>
      ) : (
        <span className="rounded-full bg-panel-hover px-2.5 py-0.5 text-xs text-muted">Soon</span>
      )}
    </button>
  );
}
