"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { basescanTx, type OrderStatus } from "@/lib/intents";
import type { PayoutResponse } from "@/app/lib/api-types";
import { formatEthAmount, formatSol } from "@/app/lib/format";
import { useOrder } from "@/app/hooks/useOrder";
import { useIntentActions } from "@/app/hooks/useIntentActions";
import { AccountBox, type AccountTab } from "@/app/components/AccountBox";
import { Header, type Notice } from "@/app/components/Header";
import { OrderDrawer } from "@/app/components/OrderDrawer";
import { OrderTracker } from "@/app/components/OrderTracker";
import { RfqPanel } from "@/app/components/RfqPanel";
import { SwapForm } from "@/app/components/SwapForm";
import { ToastViewport, useToasts } from "@/app/components/Toasts";

export default function Home() {
  const [active, setActive] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [trackerShown, setTrackerShown] = useState(false);
  const [account, setAccount] = useState<AccountTab | null>(null);
  const [mode, setMode] = useState<"auction" | "rfq">("auction");
  const [activityKey, setActivityKey] = useState(0);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const noticeId = useRef(1);
  const { push } = useToasts();
  const actions = useIntentActions();
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();

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

  const notify = useCallback((n: Omit<Notice, "id" | "at">) => {
    setNotices((ns) => [...ns.slice(-19), { ...n, id: noticeId.current++, at: Date.now() }]);
    setUnread((u) => u + 1);
  }, []);

  // The tracker pill reports the tracked order; toasts cover it only when the tracker is hidden (§5.3).
  const trackerRef = useRef(false);
  useEffect(() => {
    trackerRef.current = trackerShown;
  }, [trackerShown]);
  const onTransition = useCallback(
    (prev: OrderStatus | null, next: PayoutResponse) => {
      if (prev === null) return;
      setActivityKey((k) => k + 1);
      const i = next.intent;
      const quiet = trackerRef.current;
      if (next.status === "completed" && next.delivered) {
        const title = `Received ${formatEthAmount(BigInt(i.outWei))} ETH on Base`;
        const body = `For ${formatSol(BigInt(i.inLamports))} SOL`;
        notify({ kind: "success", title, body, intent: i.address });
        if (!quiet)
          push({ kind: "success", title, body, link: { href: basescanTx(next.delivered.txHash), label: "Basescan" } });
      } else if (next.status === "expired") {
        const title = "No solver filled in time";
        const body = `Cancel to get your ${formatSol(BigInt(i.inLamports))} SOL back.`;
        notify({ kind: "warn", title: "Refund available", body, intent: i.address });
        if (!quiet)
          push({
            kind: "warn",
            title,
            body,
            action: { label: "Cancel and refund", onClick: () => void cancel(i.address) },
          });
      } else if (next.status === "reverted") {
        notify({ kind: "error", title: "Payout reverted on Base", intent: i.address });
      } else if (next.status === "matched" || next.status === "signing") {
        const body = `Delivering ${formatEthAmount(BigInt(i.outWei))} ETH`;
        notify({ kind: "info", title: "Order filled", body, intent: i.address });
        if (!quiet) push({ kind: "info", title: "Solver matched", body });
      }
    },
    [push, notify, cancel],
  );
  const order = useOrder(active, onTransition);

  /** An order opened from the form: track it in the bottom pill, as 1inch does. */
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const opened = useCallback(
    (intent: string, confirmed: boolean, via: "auction" | "rfq" = "auction") => {
      setActive(intent);
      setTrackerShown(true);
      setUnconfirmed(confirmed ? null : intent);
      notify(
        via === "rfq"
          ? { kind: "info", title: "Signed intent settled", body: "A solver filled it from your vault. ETH is on its way.", intent }
          : confirmed
            ? { kind: "info", title: "Order submitted", body: "SOL locked in escrow. Solvers are bidding.", intent }
            : { kind: "warn", title: "Order sent, not yet confirmed", body: "Check Activity before opening another.", intent },
      );
    },
    [notify],
  );
  /** An order picked from Activity or a notification: open its details. */
  const select = useCallback(
    (intent: string) => {
      // The tracker pill follows the order this tab opened, not one browsed from history.
      if (intent !== active) setTrackerShown(false);
      setActive(intent);
      setAccount(null);
      setDrawerOpen(true);
    },
    [active],
  );
  const closeOrder = useCallback(() => setDrawerOpen(false), []);
  const closeAccount = useCallback(() => setAccount(null), []);
  const hideTracker = useCallback(() => setTrackerShown(false), []);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <Header
        notices={notices}
        unread={unread}
        onReadAll={() => setUnread(0)}
        onNotice={select}
        onAccount={() => setAccount("assets")}
        onActivity={() => (connected ? setAccount("activity") : setVisible(true))}
      />

      <main className="mx-auto flex w-full max-w-[596px] flex-1 flex-col px-2 pt-4 pb-28 sm:px-0 sm:pt-[84px]">
        {/* Mode tabs, styled as 1inch's header nav pills. */}
        <div className="mb-3 flex gap-1" role="tablist">
          {(
            [
              ["auction", "Auction"],
              ["rfq", "RFQ"],
            ] as const
          ).map(([id, name]) => (
            <button
              key={id}
              role="tab"
              aria-selected={mode === id}
              onClick={() => setMode(id)}
              className={`h-10 rounded-full px-4 text-base transition ${
                mode === id ? "bg-panel-hover font-[450] text-fg" : "text-muted hover:text-fg"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
        {mode === "auction" ? (
          <SwapForm onOpened={opened} />
        ) : (
          <RfqPanel onOrder={(intent) => opened(intent, true, "rfq")} />
        )}
      </main>

      {/* Beside, not over, an open side panel. */}
      <ToastViewport shifted={!!account || drawerOpen}>
        {active && trackerShown && !drawerOpen && !account && (
          <OrderTracker
            key={active}
            order={order}
            unconfirmed={unconfirmed === active}
            onDetails={() => {
              setAccount(null);
              setDrawerOpen(true);
            }}
            onActivity={() => setAccount("activity")}
            onCancel={() => cancel(active)}
            onHide={hideTracker}
          />
        )}
      </ToastViewport>

      {account && connected && (
        <AccountBox
          tab={account}
          setTab={setAccount}
          onClose={closeAccount}
          refreshKey={activityKey}
          onSelect={select}
          onCancel={cancel}
          onCloseIntent={close}
        />
      )}

      {active && drawerOpen && (
        <OrderDrawer
          intent={active}
          order={order}
          onClose={closeOrder}
          onCancel={cancel}
          onCloseIntent={close}
        />
      )}
    </div>
  );
}
