"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Connection } from "@solana/web3.js";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import {
  SPEED_PRESETS,
  basescanAddress,
  presetParams,
  solanaExplorerTx,
  walletEvmAddress,
  type SpeedPresetId,
} from "@/lib/intents";
import { checkEvmAddress, toChecksumAddress } from "@/app/lib/eth";
import {
  formatEthAmount,
  formatSol,
  formatUsd,
  parseSol,
  shortAddr,
  solInputString,
  toFloat,
} from "@/app/lib/format";
import { programErrorMessage, randomIntentId } from "@/app/lib/program";
import {
  useConfig,
  useGroupPk,
  useIntentRent,
  usePrices,
  useQuote,
  useRecipientCheck,
  useSolBalance,
} from "@/app/hooks/data";
import { useIntentActions } from "@/app/hooks/useIntentActions";
import { destChain, type DestChainId } from "@/app/lib/chains";
import { ArrowDown, ChainMark, CloseIcon, InfoIcon, PenIcon, PlusIcon, RefreshIcon, SwitchIcon, WalletIcon } from "./icons";
import { TokenPicker } from "./TokenPicker";
import { useToasts } from "./Toasts";

/** Fee headroom (base fee plus a possible priority fee) on top of rent. */
const FEE_BUFFER_LAMPORTS = 50_000n;
/** Rent-exempt minimum of the wallet itself (0-byte system account); a tx may not leave it below this. */
const WALLET_RENT_LAMPORTS = 890_880n;
/** Max keeps at least this much SOL back (HANDOVER §5.2: about 0.003 SOL). */
const MIN_RESERVE_LAMPORTS = 3_000_000n;
/** Added to cluster time for expires_at: covers the Phantom approval and blockhash lifetime. */
const APPROVAL_MARGIN_SEC = 90;

type Phase = "idle" | "wallet" | "confirming";

/**
 * open_intent checks expires_at against cluster time when the tx lands, so base it
 * on cluster time (never earlier than the local clock), not on the browser clock alone.
 */
async function clusterNowSec(connection: Connection): Promise<bigint> {
  const clusterSec = await connection
    .getSlot("confirmed")
    .then((slot) => connection.getBlockTime(slot))
    .catch(() => null);
  const localSec = Math.floor(Date.now() / 1000);
  return BigInt(Math.max(clusterSec ?? localSec, localSec));
}

export function SwapForm({ onOpened }: { onOpened: (intent: string, confirmed: boolean) => void }) {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { push } = useToasts();
  const actions = useIntentActions();

  const [amount, setAmount] = useState("");
  const [preset, setPreset] = useState<SpeedPresetId>("fair");
  /** null: pay out to the wallet's own Base address; a string: the custom receiver field is open. */
  const [recipientInput, setRecipientInput] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  /** What the sign dialog describes, frozen when signing starts so a quote refresh can't change it. */
  const [signing, setSigning] = useState<{ sol: bigint; eth: bigint } | null>(null);
  /** Destination network; empty until picked, as 1inch's "SELECT TOKEN". */
  const [destId, setDestId] = useState<DestChainId | null>(null);
  const [picker, setPicker] = useState(false);
  const dest = destId ? destChain(destId) : null;

  const { groupPk, live: groupPkLive } = useGroupPk();
  const { lamports: balance, refresh: refreshBalance } = useSolBalance(publicKey);
  const rent = useIntentRent();
  const { config, missing: configMissing } = useConfig();
  const prices = usePrices();

  const inLamports = parseSol(amount);
  // Solvers quote the live route only.
  const quote = useQuote(dest?.live ? inLamports : null);
  // Ignore a quote for a previous amount until the new one arrives.
  const best = quote.quote && quote.quote.inLamports === inLamports?.toString() ? quote.quote.best : null;
  const startOut = best ? BigInt(best.outWei) : null;
  const p = SPEED_PRESETS[preset];
  const minOut = startOut !== null ? presetParams(preset, startOut, 0n).minOutWei : null;

  const needed = rent + WALLET_RENT_LAMPORTS + FEE_BUFFER_LAMPORTS;
  const reserve = needed > MIN_RESERVE_LAMPORTS ? needed : MIN_RESERVE_LAMPORTS;
  const maxLamports = balance !== null && balance > reserve ? balance - reserve : 0n;

  const ownAddr = useMemo(
    () => (publicKey ? toChecksumAddress(walletEvmAddress(publicKey, groupPk)) : null),
    [publicKey, groupPk],
  );
  const customOpen = recipientInput !== null;
  const recipient = recipientInput ?? ownAddr ?? "";
  const recipientCheck = checkEvmAddress(recipient);
  const isOwn = !!ownAddr && recipientCheck.ok && recipientCheck.checksummed === ownAddr;
  const code = useRecipientCheck(recipientCheck.ok ? recipientCheck.checksummed : null);
  // eth_getCode came back 0x for exactly this address (HANDOVER §3.4); anything else blocks submit.
  const recipientPlain = recipientCheck.ok && code.state === "plain" && code.address === recipientCheck.checksummed;

  const payUsd = inLamports && prices.solUsd ? toFloat(inLamports, 9) * prices.solUsd : null;
  const receiveUsd = startOut && prices.ethUsd ? toFloat(startOut, 18) * prices.ethUsd : null;
  const rateWei = startOut && inLamports ? (startOut * 1_000_000_000n) / inLamports : null;

  // Primary button state machine (§5.2), worded as on 1inch.
  let label = "Swap";
  let disabled = false;
  let onClick: () => void = () => void submit();
  if (!connected) {
    label = "Connect wallet";
    onClick = () => setVisible(true);
  } else if (phase === "wallet") {
    label = "Sign in your wallet";
    disabled = true;
  } else if (phase === "confirming") {
    label = "Opening order…";
    disabled = true;
  } else if (!dest) {
    label = "Select token";
    onClick = () => setPicker(true);
  } else if (!dest.live) {
    label = `${dest.name} route coming soon`;
    disabled = true;
  } else if (!inLamports || inLamports === 0n) {
    label = "Enter amount";
    disabled = true;
  } else if (balance === null) {
    label = "Loading";
    disabled = true;
  } else if (inLamports + reserve > balance) {
    label = "Insufficient balance";
    disabled = true;
  } else if (!recipientCheck.ok) {
    label = recipient === "" ? "Enter address" : "Invalid address";
    disabled = true;
  } else if (code.state === "contract" && code.address === recipientCheck.checksummed) {
    label = "Receiver can't be a contract";
    disabled = true;
  } else if (!recipientPlain) {
    label =
      code.state === "unavailable" && code.address === recipientCheck.checksummed
        ? "Cannot verify receiver address"
        : "Loading";
    disabled = true;
  } else if (configMissing) {
    label = "Intents program not initialised";
    disabled = true;
  } else if (config?.paused) {
    label = "Temporarily unavailable";
    disabled = true;
  } else if (!best) {
    label = quote.loading ? "Loading" : quote.error ? "Quote unavailable" : "Insufficient liquidity";
    disabled = true;
  }

  async function submit() {
    if (!inLamports || !startOut || !recipientCheck.ok || !recipientPlain) return;
    setPhase("wallet");
    setSigning({ sol: inLamports, eth: startOut });
    try {
      const nowSec = (await clusterNowSec(connection)) + BigInt(APPROVAL_MARGIN_SEC);
      const params = presetParams(preset, startOut, nowSec);
      const r = await actions.open(
        { intentId: randomIntentId(), inLamports, recipient: recipientCheck.bytes, ...params },
        () => setPhase("confirming"),
      );
      setAmount("");
      refreshBalance();
      onOpened(r.intent, true);
    } catch (e) {
      const sent = e as { intent?: string; signature?: string } | null;
      const sentIntent = sent?.intent;
      if (sentIntent) {
        // Sent, but confirmation errored: the intent may well exist, so track it.
        push({
          kind: "warn",
          title: "open_intent sent; confirmation timed out",
          body: "Check Activity before opening another intent.",
          link: sent?.signature ? { href: solanaExplorerTx(sent.signature), label: "Explorer" } : undefined,
        });
        setAmount("");
        refreshBalance();
        onOpened(sentIntent, false);
      } else {
        push({ kind: "error", title: "Could not open intent", body: programErrorMessage(e) });
      }
    } finally {
      setPhase("idle");
      setSigning(null);
    }
  }

  const fill = (lamports: bigint) => setAmount(lamports > 0n ? solInputString(lamports) : "0");

  return (
    <div className="flex w-full flex-col items-center">
      <div className="flex w-full flex-col gap-0.5">
        {/* Pay */}
        <section className="group relative flex flex-col gap-8 bg-card py-5 pr-6 pl-4">
          <div className="flex h-5 items-center gap-4 pl-2 text-sm text-muted">
            <span>Pay on Solana</span>
            {connected && balance !== null && (
              <span className="hidden items-center gap-3 text-accent group-focus-within:flex group-hover:flex [@media(hover:none)]:flex">
                <QuickFill
                  onClick={() => fill(maxLamports)}
                  title={`Keeps ${formatSol(reserve, 4)} SOL for fees, the intent account rent and the wallet's own rent minimum`}
                >
                  Max {formatSol(maxLamports)}
                </QuickFill>
                <QuickFill onClick={() => fill(maxLamports / 2n)}>50%</QuickFill>
                <QuickFill onClick={() => fill(maxLamports / 4n)}>25%</QuickFill>
              </span>
            )}
          </div>
          <div className="flex items-center justify-between gap-4">
            <label
              className={`flex h-8 min-w-0 cursor-text items-center gap-3 leading-8 font-[450] sm:h-10 sm:leading-10 ${amountSize(amount)}`}
            >
              {/* The hidden copy sizes the input to its value, so the ticker sits right after the number. */}
              <span className="inline-grid min-w-0 pl-2">
                <span aria-hidden className="invisible col-start-1 row-start-1 overflow-hidden whitespace-pre tabular-nums">
                  {amount || "0"}
                </span>
                <input
                  size={1}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  value={amount}
                  onChange={(e) => {
                    const v = e.target.value.replace(",", ".");
                    if (/^\d*\.?\d{0,9}$/.test(v)) setAmount(v);
                  }}
                  className="col-start-1 row-start-1 w-0 min-w-full bg-transparent p-0 tabular-nums caret-accent outline-none placeholder:text-faint"
                  aria-label="SOL amount"
                />
              </span>
              <span className="font-normal text-muted transition group-hover:text-accent">SOL</span>
            </label>
            <span className="shrink-0 text-sm text-accent tabular-nums">{formatUsd(payUsd) ?? ""}</span>
          </div>
          <div
            className="absolute bottom-0 left-1/2 z-10 flex h-10 w-10 -translate-x-1/2 translate-y-[calc(50%+1px)] items-center justify-center rounded-full bg-panel-hover text-faint"
            title="SOL → ETH only. ETH → SOL arrives with SODA Witness (Phase 2)."
          >
            <ArrowDown />
          </div>
        </section>

        {/* Receive */}
        {dest ? (
          <section className="group flex flex-col gap-8 bg-card py-5 pr-6 pl-4">
            <button
              onClick={() => setPicker(true)}
              className="flex h-5 items-center gap-1.5 self-start pl-2 text-sm text-muted transition hover:text-fg"
              title="Change network"
            >
              Receive on {dest.name}
              <ChainMark chain={dest.id} size={14} />
            </button>
            <div className="flex items-center justify-between gap-4">
              <div
                className={`group/amount relative flex h-8 min-w-0 items-center gap-3 pl-2 leading-8 font-[450] sm:h-10 sm:leading-10 ${amountSize(startOut !== null ? formatEthAmount(startOut) : "0")}`}
              >
                {startOut !== null ? (
                  <span className="truncate tabular-nums">{formatEthAmount(startOut)}</span>
                ) : quote.loading && inLamports ? (
                  <span className="inline-block h-7 w-28 animate-pulse bg-panel-hover" />
                ) : (
                  <span className="text-faint">0</span>
                )}
                <button
                  onClick={() => setPicker(true)}
                  className="font-normal text-muted transition group-hover:text-accent"
                  title="Change token"
                >
                  {dest.token}
                </button>
                {startOut !== null && minOut !== null && (
                  <AmountGuarantee min={minOut} estimated={startOut} durationSec={p.durationSec} />
                )}
              </div>
              <span className="shrink-0 text-sm text-accent tabular-nums">{formatUsd(receiveUsd) ?? ""}</span>
            </div>
            {!dest.live ? (
              <p className="-mt-5 pl-2 text-sm text-muted">
                Payouts on {dest.network} are not live yet. Pick Base to swap today.
              </p>
            ) : quote.error && inLamports ? (
              <p className="-mt-5 pl-2 text-sm text-warn">{quote.error}</p>
            ) : null}
          </section>
        ) : (
          <section className="flex flex-col gap-8 bg-card px-6 py-5">
            <div className="flex h-5 items-center text-sm text-muted">Receive</div>
            <button
              onClick={() => setPicker(true)}
              className="-mt-1 flex h-10 items-center gap-2 self-start text-[24px] leading-8 font-medium uppercase transition hover:text-accent sm:text-[32px] sm:leading-10"
            >
              Select token
              <PlusIcon />
            </button>
          </section>
        )}

        {/* Receive to another wallet */}
        {customOpen && (
          <section className="relative bg-card py-5 pr-6 pl-6">
            <button
              aria-label="Stop receiving to another wallet"
              title="Use my own address"
              onClick={() => setRecipientInput(null)}
              className="absolute top-5 right-4 flex h-10 w-10 items-center justify-center rounded-full bg-panel-hover text-muted transition hover:text-fg min-[724px]:top-1/2 min-[724px]:right-auto min-[724px]:-left-16 min-[724px]:h-12 min-[724px]:w-12 min-[724px]:-translate-y-1/2"
            >
              <CloseIcon />
            </button>
            <div className="text-sm text-muted">Receiver on {dest?.name ?? "Base"}</div>
            <div className="mt-3 flex items-center gap-3 pr-12 min-[724px]:pr-0">
              <input
                autoFocus
                value={recipientInput}
                onChange={(e) => setRecipientInput(e.target.value.trim())}
                placeholder="Enter receiver address"
                spellCheck={false}
                autoComplete="off"
                className="min-w-0 flex-1 bg-transparent font-mono text-base outline-none placeholder:font-sans placeholder:text-faint sm:text-lg"
                aria-label="Receiver address"
              />
              <button
                onClick={() =>
                  navigator.clipboard
                    ?.readText()
                    .then((t) => setRecipientInput(t.trim()))
                    .catch(() => {})
                }
                className="shrink-0 text-sm text-accent transition hover:opacity-70"
              >
                Paste
              </button>
            </div>
            <RecipientHint
              empty={recipient === ""}
              isOwn={isOwn}
              check={recipientCheck}
              code={code}
              groupPkLive={groupPkLive}
            />
          </section>
        )}
      </div>

      {/* Button row: the wallet button sits left of the pill, which stays centred on the card. */}
      <div
        className={`sticky bottom-0 z-20 mt-4 flex w-full items-center justify-center gap-2 bg-bg py-2 sm:static sm:w-auto sm:bg-transparent sm:py-0 ${connected && !customOpen ? "sm:-ml-16" : ""}`}
      >
        {connected && !customOpen && (
          <button
            aria-label="Receive to another wallet"
            title="Receive to another wallet"
            onClick={() => setRecipientInput("")}
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-fg text-card transition hover:bg-white/90"
          >
            <WalletIcon />
          </button>
        )}
        <button
          onClick={onClick}
          disabled={disabled}
          className={`h-14 min-w-[148px] flex-1 rounded-full px-6 text-base leading-6 font-[450] transition sm:min-w-[262px] sm:flex-none ${
            disabled ? "cursor-not-allowed bg-white/[0.09] text-white/20" : "bg-fg text-card hover:bg-white/90"
          }`}
        >
          {label}
        </button>
      </div>

      {/* Paying out to the wallet's own address: surface only what needs attention. */}
      {!customOpen && connected && ownAddr && dest?.live && (!groupPkLive || (code.state === "unavailable" && code.address === ownAddr)) && (
        <p className="mt-3 text-center text-xs text-warn">
          {!groupPkLive && "Your Base address uses the cached committee key"}
          {!groupPkLive && code.state === "unavailable" && code.address === ownAddr && " · "}
          {code.state === "unavailable" && code.address === ownAddr && "Could not check it for contract code"}
        </p>
      )}

      {best && startOut !== null && minOut !== null && rateWei !== null && inLamports ? (
        <RateLine
          rateWei={rateWei}
          solUsd={prices.solUsd}
          ethUsd={prices.ethUsd}
          solvers={quote.quote?.quotes.length ?? 0}
          loading={quote.loading}
          onRefresh={quote.refresh}
          bestSolver={best.solver}
          preset={preset}
          setPreset={setPreset}
          startOut={startOut}
          minOut={minOut}
          rent={rent}
          receiver={recipientCheck.ok ? recipientCheck.checksummed : recipient}
          receiverIsOwn={isOwn}
        />
      ) : null}

      {phase !== "idle" && signing && (
        <SignDialog
          title={phase === "wallet" ? "Sign order in your wallet" : "Opening order"}
          body={`${formatSol(signing.sol)} SOL on Solana to ${formatEthAmount(signing.eth)} ETH on Base Sepolia`}
        />
      )}

      {picker && (
        <TokenPicker
          selected={destId}
          onSelect={(id) => {
            setDestId(id);
            setPicker(false);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}

/** Long amounts step the font down, as 1inch's swap numbers do. */
function amountSize(value: string): string {
  const digits = value.replace(/[^0-9]/g, "").length;
  if (digits <= 8) return "text-2xl sm:text-[32px]";
  if (digits <= 10) return "text-2xl sm:text-[28px]";
  if (digits <= 12) return "text-xl sm:text-2xl";
  return "text-lg sm:text-xl";
}

function QuickFill({ onClick, title, children }: { onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={title} className="leading-[18px] tabular-nums transition hover:opacity-70">
      {children}
    </button>
  );
}

/** Hover card on the receive amount, after 1inch's "Amount Guarantee". */
function AmountGuarantee({ min, estimated, durationSec }: { min: bigint; estimated: bigint; durationSec: number }) {
  return (
    <div className="pointer-events-none invisible absolute top-full left-0 z-30 mt-3 w-[300px] max-w-[calc(100vw-3rem)] bg-subtle ring-1 ring-line p-4 text-sm leading-5 font-normal opacity-0 shadow-2xl shadow-black transition group-hover/amount:visible group-hover/amount:opacity-100">
      <div className="text-base font-medium">Amount guarantee</div>
      <dl className="mt-3 space-y-1.5">
        <Row k="Minimum" v={`${formatEthAmount(min)} ETH`} />
        <Row k="Estimated" v={`${formatEthAmount(estimated)} ETH`} />
      </dl>
      <p className="mt-3 text-xs text-muted">
        You&apos;re guaranteed at least the minimum. Your order starts at the best solver quote and eases toward the
        minimum over {durationSec}s until a solver fills it.
      </p>
    </div>
  );
}

/** Small rate line under the button; click opens "Rates and fees" (and the auction speed). */
function RateLine({
  rateWei,
  solUsd,
  ethUsd,
  solvers,
  loading,
  onRefresh,
  bestSolver,
  preset,
  setPreset,
  startOut,
  minOut,
  rent,
  receiver,
  receiverIsOwn,
}: {
  rateWei: bigint;
  solUsd: number | null;
  ethUsd: number | null;
  solvers: number;
  loading: boolean;
  onRefresh: () => void;
  bestSolver: string;
  preset: SpeedPresetId;
  setPreset: (p: SpeedPresetId) => void;
  startOut: bigint;
  minOut: bigint;
  rent: bigint;
  receiver: string;
  receiverIsOwn: boolean;
}) {
  const [inverted, setInverted] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const p = SPEED_PRESETS[preset];

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
  }, [open]);

  const ethPerSol = formatEthAmount(rateWei, 8);
  const solPerEth = rateWei > 0n ? formatSol((10n ** 27n) / rateWei, 4) : "–";
  const solUsdStr = formatUsd(solUsd);
  const ethUsdStr = formatUsd(ethUsd);

  return (
    <div ref={ref} className="relative mt-8 flex justify-center">
      <div className="flex items-center gap-1 text-xs">
        <span className="text-fg">1 {inverted ? "ETH" : "SOL"}</span>
        <button
          aria-label="Invert the rate"
          onClick={() => setInverted((i) => !i)}
          className="flex h-5 w-5 items-center justify-center text-muted transition hover:text-fg"
        >
          <SwitchIcon size={12} />
        </button>
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1" aria-expanded={open}>
          <span className="text-fg tabular-nums">{inverted ? `${solPerEth} SOL` : `${ethPerSol} ETH`}</span>
          {(inverted ? ethUsdStr : solUsdStr) && (
            <span className="text-muted tabular-nums">({inverted ? ethUsdStr : solUsdStr})</span>
          )}
          <span className="text-muted">
            <InfoIcon />
          </span>
        </button>
      </div>

      {open && (
        <div className="pop-in absolute bottom-full z-30 mb-3 flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-4 bg-subtle p-4 text-xs shadow-2xl shadow-black ring-1 ring-line">
          <div className="flex items-center justify-between">
            <span className="text-base leading-6 font-medium">Rates and fees</span>
            <button
              onClick={onRefresh}
              className="flex items-center gap-1.5 text-muted transition hover:text-fg"
              title="Refresh quote"
            >
              {solvers} solver{solvers === 1 ? "" : "s"}
              <span className={loading ? "animate-spin" : ""}>
                <RefreshIcon size={14} />
              </span>
            </button>
          </div>
          <dl className="space-y-2">
            <Row k={`1 SOL = ${ethPerSol} ETH`} v={<span className="text-muted">{solUsdStr ?? ""}</span>} light />
            <Row k={`1 ETH = ${solPerEth} SOL`} v={<span className="text-muted">{ethUsdStr ?? ""}</span>} light />
          </dl>
          <div>
            <div className="text-muted">Auction speed</div>
            <div className="mt-2 grid grid-cols-3 gap-0.5 bg-bg p-0.5">
              {Object.values(SPEED_PRESETS).map((s) => (
                <button
                  key={s.id}
                  onClick={() => setPreset(s.id)}
                  className={`px-2 py-2 text-center transition ${
                    preset === s.id ? "bg-panel-hover text-fg" : "bg-subtle text-muted hover:text-fg"
                  }`}
                  aria-pressed={preset === s.id}
                >
                  <div className="text-sm font-medium">{s.label}</div>
                  <div className="text-[11px] text-faint">
                    {s.durationSec}s · {(s.toleranceBps / 100).toFixed(1)}%
                  </div>
                </button>
              ))}
            </div>
          </div>
          <dl className="space-y-2">
            <Row k="Minimum receive" v={`${formatEthAmount(minOut)} ETH`} />
            <Row k="Auction" v={`${formatEthAmount(startOut)} → ${formatEthAmount(minOut)} ETH, ${p.durationSec}s`} />
            <Row k="Expires" v={`${p.durationSec + 60}s+ after opening if unfilled`} />
            <Row k="Base gas" v={<span className="text-good">Free, paid by solver</span>} />
            <Row
              k="Solana fee + rent"
              v={`≈ ${formatSol(rent + 5000n, 4)} SOL`}
              sub="Rent returned when you close the intent"
            />
            <Row k="Best quote" v={bestSolver.length > 20 ? shortAddr(bestSolver) : bestSolver} />
            <Row
              k="Receiver"
              v={
                <a href={basescanAddress(receiver)} target="_blank" rel="noreferrer" className="hover:text-accent">
                  {shortAddr(receiver, 6, 4)} ↗
                </a>
              }
              sub={receiverIsOwn ? "Your Base address" : "Custom address"}
            />
            <Row k="Route" v="Solver → SODA committee → Base" />
          </dl>
        </div>
      )}
    </div>
  );
}

/** Non-interactive wallet prompt, shown while Phantom is open (as 1inch's "Sign order in your wallet"). */
function SignDialog({ title, body }: { title: string; body: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4" role="dialog" aria-label={title}>
      <div className="pop-in flex w-full max-w-[400px] flex-col items-center gap-4 bg-subtle px-6 py-8 text-center">
        <PenIcon />
        <div className="text-xl font-medium">{title}</div>
        <p className="text-sm text-muted">{body}</p>
      </div>
    </div>
  );
}

function Row({ k, v, sub, light }: { k: string; v: ReactNode; sub?: string; light?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className={light ? "text-fg tabular-nums" : "text-muted"}>{k}</dt>
      <dd className="text-right">
        <div className="tabular-nums">{v}</div>
        {sub && <div className="text-[11px] text-faint">{sub}</div>}
      </dd>
    </div>
  );
}

function RecipientHint({
  empty,
  isOwn,
  check,
  code,
  groupPkLive,
}: {
  empty: boolean;
  isOwn: boolean;
  check: ReturnType<typeof checkEvmAddress>;
  code: ReturnType<typeof useRecipientCheck>;
  groupPkLive: boolean;
}) {
  if (empty) return null;
  if (!check.ok) return <p className="mt-3 text-[13px] text-bad">{check.error}</p>;
  const state = code.address === check.checksummed ? code.state : "checking";
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[13px]">
      {isOwn ? (
        <span className="flex items-center gap-1.5 text-good">
          <span>●</span> Your Base address (owned by this Phantom wallet)
          {!groupPkLive && <span className="text-warn">· cached committee key</span>}
        </span>
      ) : (
        <span className="text-muted">
          Custom address{!check.hasChecksum && <span className="text-warn"> · no checksum, double-check it</span>}
        </span>
      )}
      <span className="flex items-center gap-3">
        {state === "checking" && <span className="text-faint">Checking…</span>}
        {state === "contract" && <span className="text-bad">Has contract code: payouts would revert</span>}
        {code.state === "unavailable" && state === "unavailable" && (
          <span className="text-warn" title={code.error}>
            Could not check for contract code
          </span>
        )}
        <a href={basescanAddress(check.checksummed)} target="_blank" rel="noreferrer" className="text-muted hover:text-fg">
          Basescan ↗
        </a>
      </span>
    </div>
  );
}
