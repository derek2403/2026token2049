"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { shortAddr } from "@/app/lib/format";
import { AddressAvatar, ChevronDown } from "./icons";

/** Header wallet pill: "Connect wallet" when disconnected, else opens the account box. */
export function WalletButton({ onOpen }: { onOpen: () => void }) {
  const { publicKey, connecting } = useWallet();
  const { setVisible } = useWalletModal();

  if (!publicKey) {
    return (
      <button
        onClick={() => setVisible(true)}
        className="h-10 rounded-full bg-fg px-4 text-base leading-6 font-[450] whitespace-nowrap text-card transition hover:bg-white/90"
      >
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }

  const addr = publicKey.toBase58();
  return (
    <button
      onClick={onOpen}
      aria-label="Open account"
      className="flex h-10 items-center rounded-full bg-panel-hover text-base leading-6 font-[450] transition hover:bg-pill-hover"
    >
      <span className="flex items-center gap-2 pr-3 pl-1.5">
        <AddressAvatar address={addr} size={28} />
        <span className="whitespace-nowrap">
          <span className="sm:hidden">{shortAddr(addr, 4, 4)}</span>
          <span className="max-sm:hidden">{shortAddr(addr, 6, 4)}</span>
        </span>
      </span>
      <span className="flex h-full items-center border-l-2 border-bg px-2.5 text-muted">
        <ChevronDown />
      </span>
    </button>
  );
}
