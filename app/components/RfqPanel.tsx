"use client";

// "RFQ · NEAR-style" swap: SOL waits in the user's vault, solvers quote through
// the relay (/api/rfq), the user signs a readable message in Phantom (no
// transaction, no fee), and the winning solver settles it on Solana with
// execute_signed_intent. The host opens its order drawer through onOrder.

import { useMemo, useState } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { Transaction } from "@solana/web3.js";
import {
  RFQ_MAX_DEADLINE_SECS,
  USER_VAULT_SIZE,
  basescanAddress,
  encodeSignedIntent,
  intentPda,
  newIntentNonce,
  renderIntentMessage,
  shortKey,
  solanaExplorerAddress,
  solanaExplorerTx,
  vaultPda,
  verifyIntentSignature,
  walletEvmAddress,
  type IntentMessageFields,
  type RelayQuote,
} from "@/lib/intents";
import { checkEvmAddress, toChecksumAddress } from "@/app/lib/eth";
import { formatEthAmount, formatSol, parseSol, shortAddr, solInputString } from "@/app/lib/format";
import { intentsProgram, programErrorMessage } from "@/app/lib/program";
import { saveOrder } from "@/app/lib/orders";
import {
  buildDepositSolTx,
  buildWithdrawSolTx,
  clusterNowSec,
  RelayError,
  relayPublish,
  useNow,
  useRfqQuotes,
  useUserVault,
} from "@/app/lib/rfq-client";
import { useGroupPk, useRecipientCheck, useSolBalance } from "@/app/hooks/data";

/** What the user signs: valid for this long after cluster time (the program allows up to 600 s). */
const DEADLINE_SEC = 120n;
/** A quote this close to expiry is not offered for signing (Phantom approval + settlement). */
const QUOTE_MARGIN_MS = 3_000;
/** The first deposit also creates the vault: its rent-exempt minimum, (128 + size) bytes × 6960 lamports. */
const USER_VAULT_RENT = BigInt((128 + USER_VAULT_SIZE) * 6960);
/** Fee margin for the deposit transaction, as the CLI uses. */
const DEPOSIT_FEE_MARGIN = 10_000n;

type Phase = "idle" | "deposit" | "withdraw" | "sign" | "publish";
type Notice = { kind: "ok" | "error"; text: string; href?: string };

export function RfqPanel({ onOrder }: { onOrder: (intent: string) => void }) {
  const { connection } = useConnection();
  const { publicKey, connected, signMessage, sendTransaction, wallet } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { setVisible } = useWalletModal();
  const { groupPk } = useGroupPk();
  const { lamports: walletLamports } = useSolBalance(publicKey);
  const { vault, loaded: vaultLoaded, refresh: refreshVault } = useUserVault(publicKey);
  const q = useRfqQuotes();

  const [amount, setAmount] = useState("");
  const [recipientInput, setRecipientInput] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState<Notice | null>(null);
  /** The exact text being signed, shown while Phantom is open. */
  const [signingText, setSigningText] = useState<string | null>(null);

  const program = useMemo(() => (anchorWallet ? intentsProgram(connection, anchorWallet) : null), [connection, anchorWallet]);
  const ownAddr = useMemo(
    () => (publicKey ? toChecksumAddress(walletEvmAddress(publicKey, groupPk)) : null),
    [publicKey, groupPk],
  );
  const recipient = recipientInput ?? ownAddr ?? "";
  const rcheck = checkEvmAddress(recipient);
  const code = useRecipientCheck(rcheck.ok ? rcheck.checksummed : null);
  const recipientPlain = rcheck.ok && code.state === "plain" && code.address === rcheck.checksummed;
  const recipientLower = rcheck.ok ? rcheck.checksummed.toLowerCase() : null;

  const sell = parseSol(amount);
  const vaultSol = vault?.sol ?? 0n;
  const short = sell && sell > vaultSol ? sell - vaultSol : 0n;
  const canSignMessages = !!signMessage;

  // Quotes answer one amount and recipient; anything else is stale.
  const quotesFresh = q.amountIn !== null && q.amountIn === sell && q.recipient === recipientLower;
  const now = useNow(250, quotesFresh && q.quotes.length > 0);
  const quotes = quotesFresh ? q.quotes : [];
  const best = quotes.find((x) => x.expiration_time - now > QUOTE_MARGIN_MS) ?? null;
  const busy = phase !== "idle";

  async function send(tx: Transaction): Promise<string> {
    if (!publicKey) throw new Error("Connect a wallet first");
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.feePayer = publicKey;
    tx.recentBlockhash = blockhash;
    const sig = await sendTransaction(tx, connection);
    const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  }

  async function deposit() {
    if (!program || !publicKey || short <= 0n) return;
    setPhase("deposit");
    setNotice(null);
    try {
      const sig = await send(await buildDepositSolTx(program, publicKey, short));
      setNotice({ kind: "ok", text: `Deposited ${formatSol(short, 9)} SOL into your vault`, href: solanaExplorerTx(sig) });
      refreshVault();
    } catch (e) {
      setNotice({ kind: "error", text: `Deposit failed: ${programErrorMessage(e)}` });
    } finally {
      setPhase("idle");
    }
  }

  async function withdrawAll() {
    if (!program || !publicKey || vaultSol === 0n) return;
    setPhase("withdraw");
    setNotice(null);
    try {
      const sig = await send(await buildWithdrawSolTx(program, publicKey, vaultSol));
      setNotice({ kind: "ok", text: `Withdrew ${formatSol(vaultSol, 9)} SOL to your wallet`, href: solanaExplorerTx(sig) });
      refreshVault();
    } catch (e) {
      setNotice({ kind: "error", text: `Withdraw failed: ${programErrorMessage(e)}` });
    } finally {
      setPhase("idle");
    }
  }

  function getQuotes() {
    if (!sell || !recipientLower) return;
    setNotice(null);
    void q.request(sell, recipientLower);
  }

  async function signAndSwap(quote: RelayQuote) {
    if (!publicKey || !signMessage || !sell || !rcheck.ok) return;
    setPhase("sign");
    setNotice(null);
    let sent: { intent: string; signedAt: number } | null = null;
    try {
      const fields: IntentMessageFields = {
        user: publicKey,
        nonce: await newIntentNonce(connection, publicKey),
        deadline: (await clusterNowSec(connection)) + DEADLINE_SEC,
        sellLamports: sell,
        // The relay requires min_out == the quoted amount_out.
        minOutWei: BigInt(quote.amount_out),
        recipient: rcheck.bytes,
      };
      const message = renderIntentMessage(fields);
      setSigningText(new TextDecoder().decode(message));
      const signature = await signMessage(message);
      const signedAt = nowMs();
      if (!verifyIntentSignature(message, signature, publicKey)) {
        throw new Error("The wallet returned a signature that does not verify over the message");
      }
      setPhase("publish");
      sent = { intent: intentPda(publicKey, fields.nonce)[0].toBase58(), signedAt };
      const r = await relayPublish(quote.quote_hash, encodeSignedIntent(message, signature, publicKey));
      if (r.pending) {
        trackPending(r.intent, signedAt, r.tx);
      } else {
        // Lets the drawer show "signed → settled" as the first measured step.
        saveOrder({ intent: r.intent, openSig: r.tx, sentAt: signedAt, observed: { open: nowMs() } });
        setNotice({ kind: "ok", text: `Settled by solver ${shortKey(quote.solver)}`, href: solanaExplorerTx(r.tx) });
        q.clear();
        refreshVault();
        onOrder(r.intent);
      }
    } catch (e) {
      // A JSON-RPC error from the relay is a definite refusal. Anything else
      // (dropped connection, proxy timeout) after the signature left this page
      // may still settle: track the intent rather than invite a second signature.
      if (sent && !(e instanceof RelayError && e.code !== undefined)) trackPending(sent.intent, sent.signedAt);
      else setNotice({ kind: "error", text: programErrorMessage(e) });
    } finally {
      setSigningText(null);
      setPhase("idle");
    }
  }

  /** The signed intent may still settle: show it in the drawer, which polls until it lands or expires. */
  function trackPending(intent: string, signedAt: number, tx?: string) {
    saveOrder({ intent, openSig: tx || undefined, sentAt: signedAt, observed: {} });
    setNotice({
      kind: "ok",
      text: `Submitted, confirming on Solana. It settles once at most; it expires ${Number(DEADLINE_SEC)} s after signing if it does not land.`,
      href: tx ? solanaExplorerTx(tx) : undefined,
    });
    q.clear();
    refreshVault();
    onOrder(intent);
  }

  // Primary button.
  let label = "Get quotes";
  let disabled = false;
  let onClick: () => void = getQuotes;
  if (!connected) {
    label = "Connect wallet";
    onClick = () => setVisible(true);
  } else if (!canSignMessages) {
    label = "Wallet cannot sign messages";
    disabled = true;
  } else if (phase === "sign") {
    label = "Sign the message in your wallet";
    disabled = true;
  } else if (phase === "publish") {
    label = "Solver settling…";
    disabled = true;
  } else if (!sell || sell === 0n) {
    label = "Enter amount";
    disabled = true;
  } else if (!rcheck.ok) {
    label = recipient === "" ? "Enter receiver" : "Invalid receiver";
    disabled = true;
  } else if (code.state === "contract" && code.address === rcheck.checksummed) {
    label = "Receiver is a contract";
    disabled = true;
  } else if (!recipientPlain) {
    label = code.state === "unavailable" ? "Cannot check receiver" : "Checking receiver…";
    disabled = true;
  } else if (!vaultLoaded) {
    label = "Loading vault…";
    disabled = true;
  } else if (short > 0n) {
    // First trade only: one transaction moves the shortfall into the vault.
    const needed = short + (vault === null ? USER_VAULT_RENT : 0n) + DEPOSIT_FEE_MARGIN;
    if (walletLamports !== null && walletLamports < needed) {
      label = "Not enough SOL in wallet";
      disabled = true;
    } else {
      label = phase === "deposit" ? "Depositing…" : `Deposit ${formatSol(short, 9)} SOL to vault`;
      onClick = () => void deposit();
    }
  } else if (q.loading) {
    label = "Collecting quotes…";
    disabled = true;
  } else if (best) {
    label = "Sign & swap";
    onClick = () => void signAndSwap(best);
  } else if (quotesFresh && quotes.length > 0) {
    label = "Quotes expired: refresh";
  }
  if (busy) disabled = true;

  return (
    <div className="flex w-full flex-col gap-0.5">
      {/* Vault */}
      <section className="flex flex-col gap-2 bg-card px-6 py-5">
        <div className="flex items-center justify-between text-sm text-muted">
          <span>Your intents vault</span>
          {publicKey && (
            <a
              className="text-faint transition hover:text-accent"
              href={solanaExplorerAddress(vaultPda(publicKey)[0].toBase58())}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddr(vaultPda(publicKey)[0].toBase58())}
            </a>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-2xl font-medium tabular-nums">
            {connected ? (vaultLoaded ? formatSol(vaultSol, 6) : "…") : "–"} <span className="text-base text-muted">SOL</span>
          </span>
          {vaultSol > 0n && (
            <button
              onClick={() => void withdrawAll()}
              disabled={busy}
              className="text-sm text-muted underline-offset-4 transition hover:text-accent hover:underline disabled:opacity-50"
            >
              {phase === "withdraw" ? "Withdrawing…" : "Withdraw"}
            </button>
          )}
        </div>
        <p className="text-xs text-faint">
          Deposit once with a transaction; every swap after that is a signed message, with no fee. Withdraw works even
          while the program is paused.
        </p>
      </section>

      {/* Amount */}
      <section className="flex flex-col gap-3 bg-card px-6 py-5">
        <div className="flex items-center justify-between text-sm text-muted">
          <span>Sell</span>
          {walletLamports !== null && (
            <span className="tabular-nums">
              Wallet {formatSol(walletLamports)} SOL
              {vaultSol > 0n && (
                <button className="ml-2 text-accent hover:text-accent-hover" onClick={() => setAmount(solInputString(vaultSol))}>
                  Vault max
                </button>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <input
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(",", "."))}
            className="min-w-0 flex-1 bg-transparent text-[32px] leading-10 font-medium tabular-nums outline-none placeholder:text-faint"
          />
          <span className="text-lg text-muted">SOL</span>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted">Receive ETH on Base Sepolia at</span>
          {recipientInput === null ? (
            <button className="text-faint hover:text-accent" onClick={() => setRecipientInput("")}>
              another address
            </button>
          ) : (
            <button className="text-faint hover:text-accent" onClick={() => setRecipientInput(null)}>
              my address
            </button>
          )}
        </div>
        {recipientInput === null ? (
          <a
            className="truncate font-mono text-sm text-fg hover:text-accent"
            href={ownAddr ? basescanAddress(ownAddr) : undefined}
            target="_blank"
            rel="noreferrer"
            title="Your SODA-derived Base address"
          >
            {ownAddr ?? "Connect a wallet"}
          </a>
        ) : (
          <input
            autoFocus
            value={recipientInput}
            onChange={(e) => setRecipientInput(e.target.value.trim())}
            placeholder="0x…"
            spellCheck={false}
            className="rounded-xl bg-panel px-3 py-2 font-mono text-sm outline-none placeholder:text-faint"
          />
        )}
        {recipient !== "" && !rcheck.ok && <p className="text-xs text-warn">{rcheck.error}</p>}
      </section>

      {/* Quotes */}
      {(q.loading || quotes.length > 0 || q.error) && (
        <section className="flex flex-col gap-2 bg-card px-6 py-5">
          <div className="flex items-center justify-between text-sm text-muted">
            <span>{q.loading ? "Asking every solver…" : `Solver quotes (${quotes.length})`}</span>
            {quotesFresh && !q.loading && (
              <button className="text-faint hover:text-accent" onClick={getQuotes} disabled={busy}>
                Refresh
              </button>
            )}
          </div>
          {q.error && <p className="text-sm text-warn">{q.error}</p>}
          {q.loading && quotes.length === 0 && <div className="h-14 animate-pulse rounded-2xl bg-panel" />}
          {quotes.map((x) => (
            <QuoteRow key={x.quote_hash} quote={x} best={x === best} now={now} />
          ))}
          {quotes.length > 0 && (
            <p className="text-xs text-faint">
              You sign for exactly the best quote as your minimum; the quoting solver settles it. Quotes come from{" "}
              /api/rfq, which collects for 0.5 s after the first answer (3 s max).
            </p>
          )}
        </section>
      )}

      {/* Message being signed */}
      {signingText && (
        <section className="flex flex-col gap-2 bg-card px-6 py-5">
          <span className="text-sm text-muted">Message in your wallet (gasless signature)</span>
          <pre className="overflow-x-auto rounded-xl bg-panel p-3 font-mono text-xs leading-5 whitespace-pre text-fg">{signingText}</pre>
        </section>
      )}

      <section className="flex flex-col gap-3 bg-card px-6 py-5">
        {connected && !canSignMessages && (
          <p className="text-sm text-warn">
            {wallet?.adapter.name ?? "This wallet"} does not support signMessage. Use Phantom, or the Auction tab.
          </p>
        )}
        {notice && (
          <p className={`text-sm ${notice.kind === "ok" ? "text-good" : "text-bad"}`}>
            {notice.text}
            {notice.href && (
              <a className="ml-2 underline underline-offset-4" href={notice.href} target="_blank" rel="noreferrer">
                Explorer
              </a>
            )}
          </p>
        )}
        <button
          onClick={onClick}
          disabled={disabled}
          className="h-14 rounded-full bg-accent text-base font-medium text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-panel disabled:text-faint"
        >
          {label}
        </button>
        <p className="text-center text-xs text-faint">
          Signed intents expire {Number(DEADLINE_SEC)} s after signing (max {Number(RFQ_MAX_DEADLINE_SECS)} s) and can
          settle once.
        </p>
      </section>
    </div>
  );
}

// Outside the component so react-hooks/purity accepts the event-handler use.
const nowMs = () => Date.now();

function QuoteRow({ quote, best, now }: { quote: RelayQuote; best: boolean; now: number }) {
  const left = Math.max(0, quote.expiration_time - now);
  const expired = left <= QUOTE_MARGIN_MS;
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-2xl px-4 py-3 ${
        best ? "bg-accent-soft ring-1 ring-accent" : "bg-panel"
      } ${expired ? "opacity-50" : ""}`}
    >
      <div className="flex min-w-0 flex-col">
        <span className="text-lg font-medium tabular-nums">{formatEthAmount(BigInt(quote.amount_out), 8)} ETH</span>
        <a
          className="truncate font-mono text-xs text-faint hover:text-accent"
          href={solanaExplorerAddress(quote.solver)}
          target="_blank"
          rel="noreferrer"
        >
          solver {shortKey(quote.solver)}
        </a>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
        {best && <span className="rounded-full bg-accent px-2 py-0.5 font-medium text-white">Best</span>}
        <span className={`tabular-nums ${expired ? "text-bad" : "text-muted"}`}>
          {expired ? "expired" : `${(left / 1000).toFixed(1)} s`}
        </span>
      </div>
    </div>
  );
}
