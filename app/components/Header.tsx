"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { INTENTS_PROGRAM_ID, SODA_PROGRAM_ID, solanaExplorerAddress } from "@/lib/intents";
import { BaseChainMark, BellIcon, CloseIcon, GridIcon, SolanaChainMark } from "./icons";
import type { ToastKind } from "./Toasts";
import { WalletButton } from "./WalletButton";

const REPO_URL = "https://github.com/derek2403/2026token2049";

export type Notice = {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  /** The intent it is about; clicking opens its details. */
  intent: string;
  at: number;
};

export function Header({
  notices,
  unread,
  onReadAll,
  onNotice,
  onAccount,
  onActivity,
}: {
  notices: Notice[];
  unread: number;
  onReadAll: () => void;
  onNotice: (intent: string) => void;
  onAccount: () => void;
  onActivity: () => void;
}) {
  return (
    <header className="sticky top-0 z-40 flex h-[72px] items-center justify-between gap-2 px-2 backdrop-blur-[25px] sm:px-5">
      <Logo />
      <div className="flex items-center gap-2">
        <WalletButton onOpen={onAccount} />
        <NotificationBell notices={notices} unread={unread} onOpen={onReadAll} onNotice={onNotice} />
        <OverlayMenu onActivity={onActivity} />
      </div>
    </header>
  );
}

function Logo() {
  return (
    <Link href="/" className="flex items-start text-fg" aria-label="SODA Intents home">
      <span className="text-[28px] leading-none font-medium tracking-[-0.02em]">soda</span>
      {/* Two square bubbles rising off the "a". */}
      <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden className="-mt-0.5 ml-0.5">
        <rect x="1" y="7" width="4" height="4" fill="currentColor" />
        <rect x="7" y="1" width="3" height="3" fill="var(--accent)" />
      </svg>
    </Link>
  );
}

function RoundButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      aria-expanded={active}
      className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-fg transition ${
        active ? "bg-pill-hover" : "bg-panel-hover hover:bg-pill-hover"
      }`}
    >
      {children}
    </button>
  );
}

function useDismiss(open: boolean, setOpen: (o: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open, setOpen]);
  return ref;
}

const NOTICE_DOT: Record<ToastKind, string> = {
  info: "bg-accent",
  success: "bg-good",
  warn: "bg-warn",
  error: "bg-bad",
};

function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** Bell with a red unread badge and a 360px "Notifications" dropdown. */
function NotificationBell({
  notices,
  unread,
  onOpen,
  onNotice,
}: {
  notices: Notice[];
  unread: number;
  onOpen: () => void;
  onNotice: (intent: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(0);
  const ref = useDismiss(open, setOpen);

  return (
    <div ref={ref} className="relative">
      <RoundButton
        label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        active={open}
        onClick={() => {
          if (!open) {
            setNow(Date.now());
            onOpen();
          }
          setOpen(!open);
        }}
      >
        <BellIcon />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-bad px-1 text-[10px] leading-3 font-medium text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </RoundButton>
      {open && (
        <div className="pop-in absolute top-full right-0 z-40 mt-2 flex w-[360px] max-w-[92vw] flex-col gap-3 bg-subtle p-4 shadow-2xl shadow-black ring-1 ring-line max-sm:-right-12">
          <div className="text-base font-medium">Notifications</div>
          {notices.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No notifications yet</p>
          ) : (
            <ul className="-mx-2 flex max-h-[60vh] flex-col overflow-y-auto">
              {[...notices].reverse().map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => {
                      setOpen(false);
                      onNotice(n.intent);
                    }}
                    className="flex w-full items-start gap-3 px-2 py-2.5 text-left transition hover:bg-panel-hover"
                  >
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${NOTICE_DOT[n.kind]}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{n.title}</span>
                      {n.body && <span className="block text-xs text-muted">{n.body}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-faint">{age(now - n.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-line pt-3 text-xs text-faint">
            Order updates for this browser session. Settlement continues if you close the tab.
          </p>
        </div>
      )}
    </div>
  );
}

/** The 3x3 button opens a full-screen menu, as 1inch's overlay menu. */
function OverlayMenu({ onActivity }: { onActivity: () => void }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", esc);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <RoundButton label="Open menu" onClick={() => setOpen(true)}>
        <GridIcon />
      </RoundButton>
      {/* Portalled: the header's backdrop blur would otherwise clip a fixed overlay to its own box. */}
      {open &&
        createPortal(
          <div role="dialog" aria-label="Menu" className="overlay-in fixed inset-0 z-[70] overflow-y-auto bg-bg">
            <div className="flex h-[72px] items-center justify-between px-2 sm:px-5">
              <Logo />
              <button
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-panel-hover text-fg transition hover:bg-pill-hover"
              >
                <CloseIcon />
              </button>
            </div>
            <div className="mx-auto grid max-w-5xl gap-10 px-6 pt-10 pb-16 sm:grid-cols-3 sm:pt-20">
              <MenuColumn title="Product">
                <MenuItem onClick={() => setOpen(false)}>Swap</MenuItem>
                <MenuItem
                  onClick={() => {
                    setOpen(false);
                    onActivity();
                  }}
                >
                  Activity
                </MenuItem>
              </MenuColumn>
              <MenuColumn title="On chain">
                <MenuItem href={solanaExplorerAddress(INTENTS_PROGRAM_ID.toBase58())}>Intents program</MenuItem>
                <MenuItem href={solanaExplorerAddress(SODA_PROGRAM_ID.toBase58())}>SODA committee</MenuItem>
              </MenuColumn>
              <MenuColumn title="Need help?">
                <MenuItem href={`${REPO_URL}#readme`}>Documentation</MenuItem>
                <MenuItem href={REPO_URL}>GitHub</MenuItem>
              </MenuColumn>
            </div>
            <div className="mx-auto max-w-5xl px-6 pb-16">
              <div className="bg-card p-6">
                <div className="flex flex-wrap items-center gap-2 text-base font-medium">
                  <SolanaChainMark size={16} /> Solana devnet
                  <span className="text-faint">→</span>
                  <BaseChainMark size={16} /> Base Sepolia
                </div>
                <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
                  Your SOL sits in an on-chain escrow until a solver fills. The fill pays the solver and asks the SODA
                  committee to sign your Base payout in the same Solana transaction. No bridge, no wrapped tokens.
                </p>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function MenuColumn({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-sm text-muted">{title}</div>
      <ul className="mt-4 flex flex-col gap-3">{children}</ul>
    </div>
  );
}

function MenuItem({ href, onClick, children }: { href?: string; onClick?: () => void; children: ReactNode }) {
  const cls = "text-2xl leading-8 font-[450] text-fg transition hover:text-accent";
  return (
    <li>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className={cls}>
          {children} <span className="text-base text-faint">↗</span>
        </a>
      ) : (
        <button onClick={onClick} className={cls}>
          {children}
        </button>
      )}
    </li>
  );
}
