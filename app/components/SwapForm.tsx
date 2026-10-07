"use client";

import { useMemo, useState, type ReactNode } from "react";
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
import { ChainBadge, TokenWithChain } from "./icons";
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

export function SwapForm({ onOpened }: { onOpened: (intent: string) => void }) {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { push } = useToasts();
  const actions = useIntentActions();

  const [amount, setAmount] = useState("");
  const [preset, setPreset] = useState<SpeedPresetId>("fair");
  const [recipientInput, setRecipientInput] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");

  const { groupPk, live: groupPkLive } = useGroupPk();
  const { lamports: balance, refresh: refreshBalance } = useSolBalance(publicKey);
  const rent = useIntentRent();
  const { config, missing: configMissing } = useConfig();
  const prices = usePrices();

  const inLamports = parseSol(amount);
  const quote = useQuote(inLamports);
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
  const recipient = recipientInput ?? ownAddr ?? "";
  const recipientCheck = checkEvmAddress(recipient);
  const isOwn = !!ownAddr && recipientCheck.ok && recipientCheck.checksummed === ownAddr;
  const code = useRecipientCheck(recipientCheck.ok ? recipientCheck.checksummed : null);
  // eth_getCode came back 0x for exactly this address (HANDOVER §3.4); anything else blocks submit.
  const recipientPlain = recipientCheck.ok && code.state === "plain" && code.address === recipientCheck.checksummed;

  const payUsd = inLamports && prices.solUsd ? toFloat(inLamports, 9) * prices.solUsd : null;
  const receiveUsd = startOut && prices.ethUsd ? toFloat(startOut, 18) * prices.ethUsd : null;
  const rateWei = startOut && inLamports ? (startOut * 1_000_000_000n) / inLamports : null;

  // Primary button state machine (§5.2).
  let label = "Open intent";
  let disabled = false;
  let onClick: () => void = () => void submit();
  if (!connected) {
    label = "Connect wallet";
    onClick = () => setVisible(true);
  } else if (!inLamports || inLamports === 0n) {
    label = "Enter amount";
    disabled = true;
  } else if (balance === null) {
    label = "Loading balance…";
    disabled = true;
  } else if (inLamports + reserve > balance) {
    label = "Insufficient SOL";
    disabled = true;
  } else if (!recipientCheck.ok) {
    label = "Enter a valid Base address";
    disabled = true;
  } else if (code.state === "contract" && code.address === recipientCheck.checksummed) {
    label = "Recipient must not be a contract";
    disabled = true;
  } else if (!recipientPlain) {
    label =
      code.state === "unavailable" && code.address === recipientCheck.checksummed
        ? "Cannot verify recipient"
        : "Checking recipient…";
    disabled = true;
  } else if (configMissing) {
    label = "Intents program not initialised";
    disabled = true;
  } else if (config?.paused) {
    label = "Intents paused";
    disabled = true;
  } else if (!best) {
    label = quote.loading ? "Fetching best quote…" : "No quote available";
    disabled = true;
  } else if (phase === "wallet") {
    label = "Confirm in Phantom…";
    disabled = true;
  } else if (phase === "confirming") {
    label = "Opening intent…";
    disabled = true;
  }

  async function submit() {
    if (!inLamports || !startOut || !recipientCheck.ok || !recipientPlain) return;
    setPhase("wallet");
    try {
      const nowSec = (await clusterNowSec(connection)) + BigInt(APPROVAL_MARGIN_SEC);
      const params = presetParams(preset, startOut, nowSec);
      const r = await actions.open(
        { intentId: randomIntentId(), inLamports, recipient: recipientCheck.bytes, ...params },
        () => setPhase("confirming"),
      );
      push({
        kind: "info",
        title: `${formatSol(inLamports)} SOL locked in escrow`,
        body: `open_intent confirmed in ${(r.confirmedAt - r.sentAt).toLocaleString("en-US")} ms. Solvers are bidding.`,
        link: { href: solanaExplorerTx(r.signature), label: "Explorer" },
      });
      setAmount("");
      refreshBalance();
      onOpened(r.intent);
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
        onOpened(sentIntent);
      } else {
        push({ kind: "error", title: "Could not open intent", body: programErrorMessage(e) });
      }
    } finally {
      setPhase("idle");
    }
  }

  return (
    <div className="w-full">
      <div className="rounded-[28px] border border-line bg-card p-2 shadow-2xl shadow-black/40">
        <div className="flex items-center justify-between px-3 pt-2 pb-3">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold">Swap</h1>
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">Intent</span>
          </div>
          <button
            onClick={quote.refresh}
            disabled={!inLamports}
            className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-muted hover:text-fg disabled:opacity-40"
            title="Refresh quote"
          >
            <span className={quote.loading ? "animate-spin" : ""}>↻</span>
            {quote.quote ? `${quote.quote.quotes.length} solver${quote.quote.quotes.length === 1 ? "" : "s"}` : "Quote"}
          </button>
        </div>

        {/* You pay */}
        <section className="rounded-3xl bg-panel p-4">
          <div className="flex items-center justify-between text-sm text-muted">
            <span>You pay</span>
            {balance !== null && (
              <span className="flex items-center gap-2">
                <span>Balance: {formatSol(balance)} SOL</span>
                <button
                  onClick={() => setAmount(maxLamports > 0n ? solInputString(maxLamports) : "0")}
                  className="rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent hover:bg-accent hover:text-white"
                  title={`Keeps ${formatSol(reserve, 4)} SOL for fees, the intent account rent and the wallet's own rent minimum`}
                >
                  Max
                </button>
              </span>
            )}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <TokenSelect token="SOL" chain="solana" />
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={amount}
              onChange={(e) => {
                const v = e.target.value.replace(",", ".");
                if (/^\d*\.?\d{0,9}$/.test(v)) setAmount(v);
              }}
              className="min-w-0 flex-1 bg-transparent text-right text-3xl font-medium tabular-nums outline-none placeholder:text-faint"
              aria-label="SOL amount"
            />
          </div>
          <div className="mt-2 flex justify-between text-sm text-faint">
            <span>Solana devnet</span>
            <span>{formatUsd(payUsd) ?? " "}</span>
          </div>
        </section>

        <div className="relative z-10 -my-3 flex justify-center">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-xl border-4 border-card bg-panel text-muted"
            title="SOL → ETH only. ETH → SOL arrives with SODA Witness (Phase 2)."
          >
            ↓
          </div>
        </div>

        {/* You receive */}
        <section className="rounded-3xl bg-panel p-4">
          <div className="flex items-center justify-between text-sm text-muted">
            <span>You receive</span>
            {minOut !== null && <span>at least {formatEthAmount(minOut)} ETH</span>}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <TokenSelect token="ETH" chain="base" />
            <div className="min-w-0 flex-1 truncate text-right text-3xl font-medium tabular-nums">
              {startOut !== null ? (
                <span>
                  <span className="text-faint">≈ </span>
                  {formatEthAmount(startOut)}
                </span>
              ) : quote.loading ? (
                <span className="inline-block h-8 w-28 animate-pulse rounded-lg bg-panel-hover align-middle" />
              ) : (
                <span className="text-faint">0</span>
              )}
            </div>
          </div>
          <div className="mt-2 flex justify-between text-sm text-faint">
            <span>Base Sepolia · native ETH</span>
            <span>{formatUsd(receiveUsd) ?? " "}</span>
          </div>
          {quote.error && inLamports ? <p className="mt-2 text-sm text-warn">{quote.error}</p> : null}
        </section>

        {/* Recipient */}
        <section className="mt-1 rounded-3xl bg-panel p-4">
          <div className="flex items-center justify-between text-sm text-muted">
            <span>Recipient on Base</span>
            {recipientInput !== null && ownAddr && (
              <button className="text-xs text-accent hover:text-accent-hover" onClick={() => setRecipientInput(null)}>
                Use my Base address
              </button>
            )}
          </div>
          <input
            value={recipient}
            onChange={(e) => setRecipientInput(e.target.value.trim())}
            placeholder={connected ? "0x…" : "Connect a wallet to derive your Base address"}
            spellCheck={false}
            autoComplete="off"
            className="mt-2 w-full rounded-xl border border-line bg-bg/50 px-3 py-2.5 font-mono text-[13px] outline-none focus:border-accent sm:text-sm"
            aria-label="Recipient Base address"
          />
          <RecipientHint
            empty={recipient === ""}
            isOwn={isOwn}
            check={recipientCheck}
            code={code}
            groupPkLive={groupPkLive}
          />
        </section>

        {/* Speed */}
        <section className="mt-1 rounded-3xl bg-panel p-4">
          <div className="text-sm text-muted">Auction speed</div>
          <div className="mt-2 grid grid-cols-3 gap-1 rounded-2xl bg-bg/50 p-1">
            {Object.values(SPEED_PRESETS).map((s) => (
              <button
                key={s.id}
                onClick={() => setPreset(s.id)}
                className={`rounded-xl px-2 py-2 text-center transition ${
                  preset === s.id ? "bg-panel-hover text-fg shadow" : "text-muted hover:text-fg"
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
        </section>

        {/* Quote details */}
        {best && startOut !== null && minOut !== null && inLamports ? (
          <section className="mt-1 rounded-3xl bg-panel px-4 py-3 text-sm">
            <button className="flex w-full items-center justify-between text-muted" onClick={() => setDetails((d) => !d)}>
              <span>
                1 SOL = {rateWei !== null ? formatEthAmount(rateWei, 8) : "–"} ETH
              </span>
              <span className="flex items-center gap-2">
                <span className="text-good">Base gas free</span>
                <span className={`transition ${details ? "rotate-180" : ""}`}>⌄</span>
              </span>
            </button>
            {details && (
              <dl className="mt-3 space-y-2 border-t border-line pt-3">
                <Row k="You receive at least" v={`${formatEthAmount(minOut)} ETH`} />
                <Row
                  k="Auction"
                  v={`${formatEthAmount(startOut)} → ${formatEthAmount(minOut)} ETH over ${p.durationSec}s`}
                />
                <Row k="Expires" v={`At least ${p.durationSec + 60}s after opening if unfilled`} />
                <Row k="Base gas" v={<span className="text-good">Free (paid by solver)</span>} />
                <Row
                  k="Solana fee + account rent"
                  v={`≈ ${formatSol(rent + 5000n, 4)} SOL`}
                  sub="Rent returned when you close the intent"
                />
                <Row k="Best quote" v={`${best.solver.length > 20 ? shortAddr(best.solver) : best.solver}`} />
                <Row k="Route" v="Solver → SODA committee → Base" />
              </dl>
            )}
          </section>
        ) : null}

        <button
          onClick={onClick}
          disabled={disabled}
          className="mt-2 h-14 w-full rounded-3xl bg-accent text-base font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-panel disabled:text-faint"
        >
          {label}
        </button>
      </div>

      <p className="mt-4 text-center text-xs text-muted">
        No bridge · No wrapped tokens · Native ETH on Base · Settled on Solana
      </p>
    </div>
  );
}

function TokenSelect({ token, chain }: { token: "SOL" | "ETH"; chain: "solana" | "base" }) {
  return (
    <div className="flex shrink-0 items-center gap-2 rounded-full bg-bg/60 py-1.5 pr-3 pl-1.5">
      <TokenWithChain token={token} />
      <div className="leading-tight">
        <div className="text-base font-semibold">{token}</div>
        <ChainBadge chain={chain} />
      </div>
    </div>
  );
}

function Row({ k, v, sub }: { k: string; v: ReactNode; sub?: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right">
        <div className="tabular-nums">{v}</div>
        {sub && <div className="text-xs text-faint">{sub}</div>}
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
  if (!check.ok) return <p className="mt-2 text-xs text-bad">{check.error}</p>;
  const state = code.address === check.checksummed ? code.state : "checking";
  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
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
