"use client";

import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SOLANA_RPC_URL, SOLANA_WS_URL } from "./lib/env";
import { ToastProvider } from "./components/Toasts";

export function Providers({ children }: { children: ReactNode }) {
  // Phantom registers itself through wallet-standard; the legacy adapter only
  // supplies the "not installed" entry and is deduped once the standard one appears.
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  return (
    <ConnectionProvider
      endpoint={SOLANA_RPC_URL}
      config={{ commitment: "confirmed", wsEndpoint: SOLANA_WS_URL }}
    >
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <ToastProvider>{children}</ToastProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
