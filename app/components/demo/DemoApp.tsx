"use client";

// Cross-chain signing demo, ported from frontier apps/web/pages/index.tsx
// (prior work) into this app's look. One Phantom approval on Solana moves a
// Base Sepolia account that no private key controls. The committee signs
// (driven by the SODA MPC subscriber or by Chainlink CRE), Solana verifies
// the signature, and only then is it broadcast on Base.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { basescanAddress, basescanTx, solanaExplorerAddress, solanaExplorerTx } from "@/lib/intents";
import { deriveEthAddress, EVM_CHAIN_TAG } from "@/lib/soda";
import {
  ACTIONS,
  AAVE,
  DEMO_CHAIN,
  formatEth,
  fromHex,
  hex0x,
  MAX_SEEDS_LEN,
  parseEth,
  type ActionKey,
  type DemoAccount,
} from "@/app/lib/demo/config";
import { runPipeline, type PipelineUpdate } from "@/app/lib/demo/run-pipeline";
import { ActorPill, CHAINLINK_BLUE } from "./ActorPill";
import { DemoTimeline, INITIAL_TIMELINE, type TimelineKey, type TimelineRow } from "./DemoTimeline";
import { WhatRunsWhere } from "./WhatRunsWhere";

type Run = PipelineUpdate & { action: ActionKey; addr: string };

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent transition hover:opacity-70">
      {children}
    </a>
  );
}

const short = (s: string, n = 6) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

export function DemoApp() {
  const { publicKey, connected, disconnect } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();

  const [groupPk, setGroupPk] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [accountRaw, setAccount] = useState<DemoAccount | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [timelineRaw, setTimeline] = useState(INITIAL_TIMELINE);
  const [runRaw, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState<ActionKey | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [xferTo, setXferTo] = useState("");
  const [xferAmount, setXferAmount] = useState("0.0001");
  const [copied, setCopied] = useState(false);
  // /api/demo/cre-sign runs the CRE simulator locally; it 404s unless DEMO_LOCAL_CRE=1.
  const [creLocal, setCreLocal] = useState(false);
  const [creRunning, setCreRunning] = useState(false);
  const [creMsg, setCreMsg] = useState<string | null>(null);
  const accountTick = useRef(0);

  useEffect(() => {
    fetch("/api/demo/cre-sign")
      .then((r) => setCreLocal(r.ok))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/group-pk")
      .then((r) => r.json())
      .then((d: { groupPk?: string; error?: string }) => (d.groupPk ? setGroupPk(d.groupPk) : setError(d.error ?? "no group key")))
      .catch((e) => setError(`Could not load the committee key: ${(e as Error).message}`));
  }, []);

  const pathBytes = useMemo(() => new TextEncoder().encode(path), [path]);
  const pathTooLong = pathBytes.length > MAX_SEEDS_LEN;

  const derived = useMemo(() => {
    if (!groupPk || !publicKey || pathTooLong) return null;
    try {
      const d = deriveEthAddress(fromHex(groupPk), publicKey.toBytes(), pathBytes, EVM_CHAIN_TAG);
      return { address: hex0x(d.ethAddress), bytes: d.ethAddress, tweak: hex0x(d.tweak) };
    } catch {
      return null;
    }
  }, [groupPk, publicKey, pathBytes, pathTooLong]);
  const ethAddress = derived?.address ?? null;
  // Everything below is per address: a salt or wallet change hides the old run.
  const account = accountRaw?.address === ethAddress ? accountRaw : null;
  const run = runRaw?.addr === ethAddress ? runRaw : null;
  const timeline = run ? timelineRaw : INITIAL_TIMELINE;

  const refreshAccount = useCallback(async () => {
    if (!ethAddress) return;
    const tick = ++accountTick.current;
    try {
      const res = await fetch(`/api/demo/account?address=${ethAddress}`);
      const body = (await res.json()) as DemoAccount & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `account ${res.status}`);
      if (tick === accountTick.current) {
        setAccount(body);
        setAccountError(null);
      }
    } catch (e) {
      if (tick === accountTick.current) setAccountError((e as Error).message);
    }
  }, [ethAddress]);

  useEffect(() => {
    if (!ethAddress) return;
    const t0 = setTimeout(refreshAccount, 250);
    const id = setInterval(refreshAccount, 8_000);
    return () => {
      clearTimeout(t0);
      clearInterval(id);
    };
  }, [ethAddress, refreshAccount]);

  const xfer = useMemo((): { to?: Uint8Array; valueWei?: bigint; error?: string } => {
    const t = xferTo.trim();
    if (!t) return { error: "Enter a recipient address." };
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return { error: "Recipient must be 0x + 40 hex characters." };
    const wei = parseEth(xferAmount);
    if (wei == null || wei <= 0n) return { error: "Amount must be a number above zero." };
    if (wei > 1_000_000_000_000_000n) return { error: "Keep it at 0.001 ETH or less on the demo." };
    return { to: fromHex(t), valueWei: wei };
  }, [xferTo, xferAmount]);

  const runAction = async (key: ActionKey) => {
    if (busy) return;
    if (!anchorWallet || !publicKey) return setError("Connect Phantom first.");
    if (!derived || !ethAddress) return setError("The committee key is not loaded yet.");
    if (key === "transfer" && xfer.error) return setError(xfer.error);
    const spec = ACTIONS[key].build(derived.bytes, {
      to: xfer.to ?? new Uint8Array(20),
      valueWei: xfer.valueWei ?? 0n,
    });
    setBusy(key);
    setError(null);
    setNote(null);
    setRun({ action: key, addr: ethAddress });
    setTimeline(INITIAL_TIMELINE);
    try {
      await runPipeline(
        {
          connection,
          wallet: anchorWallet,
          owner: publicKey,
          ethAddress,
          pathBytes,
          spec,
          balanceWei: account ? BigInt(account.balanceWei) : null,
        },
        {
          step: (k, st) => setTimeline((p) => ({ ...p, [k]: st })),
          update: (u) => setRun((r) => (r ? { ...r, ...u } : r)),
          note: setNote,
        },
      );
    } catch (e) {
      setError((e as Error).message ?? String(e));
      setNote(null);
      setTimeline((p) => {
        const n = { ...p };
        (Object.keys(n) as TimelineKey[]).forEach((k) => {
          if (n[k] === "active") n[k] = "error";
        });
        return n;
      });
    } finally {
      setBusy(null);
      void refreshAccount();
    }
  };

  const via = run?.attribution?.via;
  const viaCre = via === "chainlink-cre";
  const rows: TimelineRow[] = [
    {
      key: "request",
      label: "eth_demo::sign_eth_transfer",
      sub: "Your one approval. The program builds the Base tx on-chain and keccaks it.",
      actors: [{ actor: "solana" }],
      extra: run?.requestTx ? <ExtLink href={solanaExplorerTx(run.requestTx)}>Solana tx {short(run.requestTx)}</ExtLink> : null,
    },
    {
      key: "sigRequested",
      label: "soda: SigRequest + SigRequested",
      sub: "soda derives your Base key from the signer itself and stores the payload in a PDA.",
      actors: [{ actor: "solana" }],
      extra: run?.sigRequest ? (
        <ExtLink href={solanaExplorerAddress(run.sigRequest)}>SigRequest {short(run.sigRequest)}</ExtLink>
      ) : null,
    },
    {
      key: "sign",
      label: "Committee signs (2-party ECDSA)",
      sub: viaCre
        ? "Chainlink CRE read the SigRequest and called the MPC coordinator; DON consensus on (r, s, v)."
        : "Both nodes re-read the SigRequest from Solana and sign; neither holds the key.",
      actors: viaCre ? [{ actor: "cre", label: "Chainlink CRE →" }, { actor: "mpc" }] : [{ actor: "mpc" }],
      extra: run?.attribution && run.attribution.via !== "pending" ? (
        <span className="text-muted">
          {run.attribution.label}
          {run.signMs != null ? ` · ${(run.signMs / 1000).toFixed(1)} s` : ""}
        </span>
      ) : timeline.sign === "active" ? (
        <span className="text-muted">Waiting for the SODA MPC subscriber, or for a Chainlink CRE run (see below)…</span>
      ) : null,
    },
    {
      key: "finalize",
      label: "soda::finalize_signature (secp256k1_recover)",
      sub: viaCre
        ? "Written through Chainlink's forwarder → soda_cre_signer, which CPIs soda. Solana checks the signature."
        : "Solana recovers the signer and checks it is your derived key before anything is broadcast.",
      actors: viaCre ? [{ actor: "cre", label: "Chainlink forwarder" }, { actor: "solana" }] : [{ actor: "solana" }],
      extra: run?.attribution?.finalizeTx ? (
        <ExtLink href={solanaExplorerTx(run.attribution.finalizeTx)}>
          finalize tx {short(run.attribution.finalizeTx)}
          {viaCre ? ` (${run.attribution.forwarder} forwarder)` : " (MPC subscriber)"}
        </ExtLink>
      ) : null,
    },
    {
      key: "broadcast",
      label: "Broadcast on Base Sepolia",
      sub: "The recorded signature + the same RLP. The mpc relayer sends the same bytes; either is fine.",
      actors: [{ actor: "base" }],
      extra: run?.ethTxHash ? <ExtLink href={basescanTx(run.ethTxHash)}>Basescan {short(run.ethTxHash, 8)}</ExtLink> : null,
    },
    {
      key: "receipt",
      label: "Receipt",
      sub: "A plain transaction from your derived address. No contract or bridge on Base.",
      actors: [{ actor: "base" }],
      extra: run?.receipt ? (
        <span className={run.receipt.status === 1 ? "text-good" : "text-bad"}>
          {run.receipt.status === 1 ? "Success" : "Reverted"} in block {run.receipt.blockNumber}
          {run.totalMs != null ? ` · ${(run.totalMs / 1000).toFixed(1)} s since click` : ""}
        </span>
      ) : null,
    },
  ];

  const creCmd = run?.sigRequest
    ? `cd cre && echo '{"sigRequest":"${run.sigRequest}"}' > payloads/sign.json && cre workflow simulate soda-signer --target simulation-settings --non-interactive --trigger-index 0 --http-payload ./payloads/sign.json --broadcast`
    : null;

  const runCre = async (sigRequest: string) => {
    setCreRunning(true);
    setCreMsg("Chainlink CRE simulator running: reading the SigRequest, calling the MPC coordinator, writing through the forwarder…");
    try {
      const res = await fetch("/api/demo/cre-sign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sigRequest }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setCreMsg(res.ok ? "CRE run finished. The pipeline picks up the finalize below." : `CRE run failed: ${body.error ?? res.status}`);
    } catch (e) {
      setCreMsg(`CRE run failed: ${(e as Error).message}`);
    } finally {
      setCreRunning(false);
    }
  };

  const disabled = !connected || !ethAddress || !!busy;
  const btn = (key: ActionKey, label: string) => (
    <button
      type="button"
      disabled={disabled || (key === "transfer" && !!xfer.error)}
      onClick={() => void runAction(key)}
      className="mt-4 h-12 w-full rounded-full bg-fg text-card font-[450] transition hover:opacity-90 disabled:bg-white/[0.09] disabled:text-white/20"
    >
      {busy === key ? "Running…" : label}
    </button>
  );

  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="flex items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-base font-medium">
            SODA
          </Link>
          <nav className="flex gap-1 text-sm">
            <Link href="/" className="rounded-full px-3 py-1.5 text-muted transition hover:bg-panel hover:text-fg">
              Swap
            </Link>
            <span className="rounded-full bg-panel px-3 py-1.5">Signing demo</span>
          </nav>
        </div>
        {connected && publicKey ? (
          <button
            type="button"
            onClick={() => disconnect().catch(() => {})}
            className="rounded-full bg-panel px-4 py-2 font-mono text-sm transition hover:bg-panel-hover"
            title="Disconnect"
          >
            {short(publicKey.toBase58(), 4)}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setVisible(true)}
            className="rounded-full bg-fg px-4 py-2 text-sm font-[450] text-card transition hover:opacity-90"
          >
            Connect wallet
          </button>
        )}
      </header>

      <main className="mx-auto w-full max-w-[1120px] px-4 pb-16 sm:px-6">
        <div className="py-6">
          <h1 className="text-[28px] leading-tight font-medium sm:text-[36px]">
            A Solana wallet signing on Base, with no bridge and no private key.
          </h1>
          <p className="mt-3 max-w-[760px] text-muted">
            Your Phantom wallet owns an address on Base Sepolia, derived by the soda program. One approval on
            Solana commits the exact Base transaction; the SODA MPC committee signs it, Solana verifies the
            signature, and it is broadcast. The signing can be driven by the MPC subscriber or by Chainlink CRE,
            and each step below says which one ran.
          </p>
        </div>

        <WhatRunsWhere />

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div className="space-y-4">
            {/* Step 1 + 2: wallet and derived address */}
            <section className="bg-card p-5 sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-medium">1 · Your Base address, derived from Solana</h2>
                <ActorPill actor="solana" />
              </div>
              {!connected ? (
                <div className="mt-4">
                  <p className="text-sm text-muted">Connect Phantom on devnet. Its public key is the owner of the address.</p>
                  <button
                    type="button"
                    onClick={() => setVisible(true)}
                    className="mt-4 h-12 min-w-[220px] rounded-full bg-fg px-6 text-card font-[450] transition hover:opacity-90"
                  >
                    Connect Phantom
                  </button>
                </div>
              ) : (
                <div className="mt-4 space-y-0.5">
                  <div className="bg-panel p-4">
                    <div className="text-sm text-muted">Derived Base Sepolia address</div>
                    <div className="mt-1 font-mono text-base break-all sm:text-lg">
                      {ethAddress ? (
                        <a href={basescanAddress(ethAddress)} target="_blank" rel="noreferrer" className="hover:text-accent">
                          {ethAddress}
                        </a>
                      ) : groupPk ? (
                        "—"
                      ) : (
                        "loading the committee key…"
                      )}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[13px]">
                      <span className="text-muted">
                        Balance{" "}
                        <span className="text-fg tabular-nums">
                          {account ? `${formatEth(account.balanceWei)} ETH` : accountError ? "unavailable" : "…"}
                        </span>
                      </span>
                      <span className="text-faint">
                        owner {publicKey ? short(publicKey.toBase58(), 4) : ""} · chain {DEMO_CHAIN.chainId.toString()}
                      </span>
                    </div>
                  </div>
                  <div className="bg-panel p-4">
                    <label htmlFor="salt" className="text-sm text-muted">
                      Salt (derivation path) · empty is your default address, the one the swap page pays to
                    </label>
                    <input
                      id="salt"
                      value={path}
                      onChange={(e) => setPath(e.target.value)}
                      placeholder="(empty)"
                      spellCheck={false}
                      className="mt-2 w-full bg-subtle px-3 py-2 font-mono text-sm outline-none placeholder:text-faint"
                    />
                    {pathTooLong ? <p className="mt-1 text-xs text-warn">At most {MAX_SEEDS_LEN} bytes.</p> : null}
                    <p className="mt-2 text-xs text-faint">
                      address = keccak(group_pk + tweak·G), tweak = sha256(&quot;SODA-v1&quot; ‖ wallet ‖ salt ‖
                      &quot;evm&quot;). soda recomputes it on-chain from whoever signs, so you cannot ask for an address
                      you do not own.
                    </p>
                  </div>
                </div>
              )}
            </section>

            {/* Step 2: actions */}
            <section className="bg-card p-5 sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-medium">2 · Sign a Base transaction from Phantom</h2>
                <span className="text-[11px] text-faint">gas is topped up from the demo faucet</span>
              </div>
              <div className="mt-4 grid gap-0.5 bg-bg p-0.5 md:grid-cols-3">
                <div className="flex flex-col bg-panel p-4">
                  <div className="text-sm font-medium">{ACTIONS.transfer.title}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-faint">{ACTIONS.transfer.callName}</div>
                  <p className="mt-2 text-xs text-muted">{ACTIONS.transfer.description}</p>
                  <input
                    value={xferTo}
                    onChange={(e) => setXferTo(e.target.value)}
                    placeholder="Recipient 0x…"
                    spellCheck={false}
                    className="mt-3 w-full bg-subtle px-3 py-2 font-mono text-xs outline-none placeholder:font-sans placeholder:text-faint"
                  />
                  <div className="mt-0.5 flex items-center bg-subtle pr-3">
                    <input
                      value={xferAmount}
                      onChange={(e) => setXferAmount(e.target.value)}
                      inputMode="decimal"
                      className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-xs outline-none"
                    />
                    <span className="text-xs text-muted">ETH</span>
                  </div>
                  {ethAddress ? (
                    <button
                      type="button"
                      onClick={() => setXferTo(ethAddress)}
                      className="mt-1 self-start text-[11px] text-accent hover:opacity-70"
                    >
                      send to itself
                    </button>
                  ) : null}
                  {xferTo && xfer.error ? <p className="mt-1 text-[11px] text-warn">{xfer.error}</p> : null}
                  <div className="flex-1" />
                  {btn("transfer", ACTIONS.transfer.button)}
                </div>
                {(["deposit", "borrow"] as const).map((k) => (
                  <div key={k} className="flex flex-col bg-panel p-4">
                    <div className="text-sm font-medium">{ACTIONS[k].title}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-faint">{ACTIONS[k].callName}</div>
                    <p className="mt-2 text-xs text-muted">{ACTIONS[k].description}</p>
                    {k === "borrow" && account?.aave && BigInt(account.aave.availableBorrowsBase) === 0n ? (
                      <p className="mt-2 text-[11px] text-warn">Aave reports nothing to borrow against yet: deposit first.</p>
                    ) : null}
                    <div className="flex-1" />
                    {btn(k, ACTIONS[k].button)}
                  </div>
                ))}
              </div>
              {note ? <p className="mt-3 text-sm text-muted">{note}</p> : null}
              {error ? <p className="mt-3 text-[13px] break-words text-bad">{error}</p> : null}
            </section>

            {/* Aave position */}
            {ethAddress ? (
              <section className="bg-card p-5 sm:p-6">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-base font-medium">Aave V3 position · read from the Pool</h2>
                  <ActorPill actor="base" />
                </div>
                {account?.aave ? (
                  <div className="mt-4 grid gap-0.5 bg-bg p-0.5 sm:grid-cols-2">
                    {[
                      ["Supplied (aWETH)", `${formatEth(account.aave.aWethWei, 9)} aWETH`, `${(account.aave.supplyApy * 100).toFixed(2)}% APY`],
                      ["Borrowed (USDC debt)", `${(Number(account.aave.debtUsdcUnits) / 1e6).toFixed(4)} USDC`, `${(account.aave.borrowApr * 100).toFixed(2)}% APR`],
                      ["USDC held", `${(Number(account.aave.usdcUnits) / 1e6).toFixed(4)} USDC`, ""],
                      [
                        "Collateral · available",
                        `$${(Number(account.aave.totalCollateralBase) / 1e8).toFixed(4)} · $${(Number(account.aave.availableBorrowsBase) / 1e8).toFixed(4)}`,
                        "",
                      ],
                    ].map(([k, v, s]) => (
                      <div key={k} className="bg-panel p-4">
                        <div className="text-xs text-muted">{k}</div>
                        <div className="mt-1 font-mono text-sm tabular-nums">{v}</div>
                        {s ? <div className="mt-0.5 text-xs text-faint">{s}</div> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-muted">{account?.aaveError ? `Could not read the Pool: ${account.aaveError}` : "reading…"}</p>
                )}
                <div className="mt-3 flex flex-wrap gap-x-4 text-xs">
                  <ExtLink href={basescanAddress(AAVE.POOL)}>Pool contract</ExtLink>
                  <ExtLink href={`https://sepolia.basescan.org/token/${AAVE.A_WETH}?a=${ethAddress}`}>aWETH for this address</ExtLink>
                </div>
              </section>
            ) : null}
          </div>

          {/* Right rail: pipeline + CRE panel */}
          <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
            <DemoTimeline state={timeline} rows={rows} />

            <section className="bg-card p-5 sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-medium">Drive the signature with Chainlink CRE</h2>
                <ActorPill actor="cre" />
              </div>
              <p className="mt-2 text-[13px] leading-5 text-muted">
                The SODA MPC subscriber normally finalizes in 1 to 3 s. To show CRE doing it instead, pause the
                subscriber (<span className="font-mono text-[12px]">npm run demo:cre -- pause-subscriber</span>), run an
                action here, then run the soda-signer workflow on the SigRequest. This page waits and labels who
                finalized.
              </p>
              {creCmd ? (
                <div className="mt-3 bg-subtle p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-faint">SigRequest {short(run!.sigRequest!)}</span>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(creCmd).then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        });
                      }}
                      className="rounded-full bg-panel px-3 py-1 text-[11px] transition hover:bg-panel-hover"
                    >
                      {copied ? "copied" : "copy command"}
                    </button>
                  </div>
                  <pre className="mt-2 overflow-x-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-muted">
                    {creCmd}
                  </pre>
                </div>
              ) : (
                <p className="mt-3 text-xs text-faint">The command appears here once Phantom has signed a request.</p>
              )}
              {creLocal && run?.sigRequest && timeline.sign === "active" ? (
                <button
                  type="button"
                  disabled={creRunning}
                  onClick={() => void runCre(run.sigRequest!)}
                  className="mt-3 h-11 w-full rounded-full text-sm font-[450] text-white transition hover:opacity-90 disabled:opacity-40"
                  style={{ background: CHAINLINK_BLUE }}
                >
                  {creRunning ? "Running Chainlink CRE…" : "Run Chainlink CRE signer now (local)"}
                </button>
              ) : null}
              {creMsg ? <p className="mt-2 text-xs text-muted">{creMsg}</p> : null}
              {via && via !== "pending" ? (
                <p className="mt-3 text-sm">
                  {viaCre ? (
                    <span className="text-good">Finalized by Chainlink CRE → SODA MPC.</span>
                  ) : (
                    <span className="text-muted">Finalized by the SODA MPC subscriber (not Chainlink).</span>
                  )}
                </p>
              ) : null}
            </section>

            {run?.signedHex ? (
              <section className="bg-card p-5 sm:p-6">
                <h2 className="text-base font-medium">Signed RLP</h2>
                <p className="mt-1 text-xs text-faint">
                  r, s are the pair soda stored on Solana; v = recovery_id + 35 + 2·{DEMO_CHAIN.chainId.toString()}.
                </p>
                <div className="mt-2 max-h-40 overflow-y-auto bg-subtle p-3 font-mono text-[11px] break-all text-muted">
                  {run.signedHex}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
