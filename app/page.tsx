"use client";

import { useCallback, useState } from "react";
import { basescanTx, type OrderStatus } from "@/lib/intents";
import type { PayoutResponse } from "@/app/lib/api-types";
import { formatEthAmount, formatSol } from "@/app/lib/format";
import { useOrder } from "@/app/hooks/useOrder";
import { useIntentActions } from "@/app/hooks/useIntentActions";
import { ActivityPanel } from "@/app/components/ActivityPanel";
import { OrderDrawer } from "@/app/components/OrderDrawer";
import { SwapForm } from "@/app/components/SwapForm";
import { useToasts } from "@/app/components/Toasts";
import { WalletButton } from "@/app/components/WalletButton";

export default function Home() {
  const [active, setActive] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activityKey, setActivityKey] = useState(0);
  const { push } = useToasts();
  const actions = useIntentActions();

  const cancel = useCallback(
    async (intent: string) => {
      const ok = await actions.cancel(intent);
      if (ok) setActivityKey((k) => k + 1);
      return ok;
    },
    [actions],
  );
  const close = useCallback(
    async (intent: string) => {
      const ok = await actions.close(intent);
      if (ok) setActivityKey((k) => k + 1);
      return ok;
    },
    [actions],
  );

  // Toasts for the tracked order, even with the drawer closed (§5.3).
  const onTransition = useCallback(
    (prev: OrderStatus | null, next: PayoutResponse) => {
      if (prev === null) return;
      setActivityKey((k) => k + 1);
      const i = next.intent;
      if (next.status === "completed" && next.delivered) {
        push({
          kind: "success",
          title: `Received ${formatEthAmount(BigInt(i.outWei))} ETH on Base`,
          body: `For ${formatSol(BigInt(i.inLamports))} SOL`,
          link: { href: basescanTx(next.delivered.txHash), label: "Basescan" },
        });
      } else if (next.status === "expired") {
        push({
          kind: "warn",
          title: "No solver filled in time",
          body: `Cancel to get your ${formatSol(BigInt(i.inLamports))} SOL back.`,
          action: { label: "Cancel and refund", onClick: () => void cancel(i.address) },
        });
      } else if (next.status === "matched" || next.status === "signing") {
        push({ kind: "info", title: "Solver matched", body: `Delivering ${formatEthAmount(BigInt(i.outWei))} ETH` });
      }
    },
    [push, cancel],
  );
  const order = useOrder(active, onTransition);

  const select = useCallback((intent: string) => {
    setActive(intent);
    setDrawerOpen(true);
  }, []);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-sm font-bold text-white">
            S
          </span>
          <span className="font-semibold tracking-tight">SODA Intents</span>
          <span className="hidden rounded-full border border-line px-2 py-0.5 text-[11px] text-muted sm:inline">
            Devnet → Base Sepolia
          </span>
        </div>
        <div className="flex items-center gap-2">
          {active && !drawerOpen && (
            <button
              onClick={() => setDrawerOpen(true)}
              className="h-10 rounded-full border border-line bg-panel px-3 text-sm text-muted hover:text-fg"
            >
              Order
            </button>
          )}
          <a href="#activity" className="hidden h-10 items-center px-2 text-sm text-muted hover:text-fg sm:flex">
            Activity
          </a>
          <WalletButton />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col items-center gap-8 px-4 pt-4 pb-16 sm:pt-10">
        <SwapForm onOpened={select} />
        <ActivityPanel refreshKey={activityKey} onSelect={select} onCancel={cancel} onCloseIntent={close} />
        <p className="max-w-sm text-center text-xs leading-relaxed text-faint">
          Your SOL sits in an on-chain escrow until a solver fills. The fill pays the solver and asks the SODA committee
          to sign your Base payout in the same Solana transaction.
        </p>
      </main>

      {active && drawerOpen && (
        <OrderDrawer
          intent={active}
          order={order}
          onClose={() => setDrawerOpen(false)}
          onCancel={cancel}
          onCloseIntent={close}
        />
      )}
    </div>
  );
}
