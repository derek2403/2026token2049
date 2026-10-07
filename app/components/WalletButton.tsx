"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { solanaExplorerAddress } from "@/lib/intents";
import { shortAddr } from "@/app/lib/format";

export function WalletButton() {
  const { publicKey, wallet, connecting, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  if (!publicKey) {
    return (
      <button
        onClick={() => setVisible(true)}
        className="h-10 rounded-full bg-accent-soft px-4 text-sm font-medium text-accent transition hover:bg-accent hover:text-white"
      >
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }

  const addr = publicKey.toBase58();
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setMenu((m) => !m)}
        className="flex h-10 items-center gap-2 rounded-full border border-line bg-panel px-3 text-sm font-medium hover:bg-panel-hover"
      >
        {wallet?.adapter.icon && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={wallet.adapter.icon} alt="" width={18} height={18} className="rounded" />
        )}
        <span className="font-mono">{shortAddr(addr)}</span>
      </button>
      {menu && (
        <div className="absolute right-0 z-40 mt-2 w-48 overflow-hidden rounded-2xl border border-line bg-panel py-1 text-sm shadow-2xl shadow-black/40">
          <button
            className="block w-full px-4 py-2 text-left hover:bg-panel-hover"
            onClick={() => {
              navigator.clipboard?.writeText(addr).catch(() => {});
              setMenu(false);
            }}
          >
            Copy address
          </button>
          <a
            className="block px-4 py-2 hover:bg-panel-hover"
            href={solanaExplorerAddress(addr)}
            target="_blank"
            rel="noreferrer"
          >
            View on Explorer ↗
          </a>
          <button
            className="block w-full px-4 py-2 text-left text-bad hover:bg-panel-hover"
            onClick={() => {
              setMenu(false);
              disconnect().catch(() => {});
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
