// "What runs where": the four parties in the demo, and which ones use Chainlink.

import type { ReactNode } from "react";
import { SODA_PROGRAM_ID, COMMITTEE_PDA, INTENTS_PROGRAM_ID, solanaExplorerAddress } from "@/lib/intents";
import { ETH_DEMO_PROGRAM_ID, SODA_CRE_SIGNER_ID, SODA_WITNESS_ID } from "@/app/lib/demo/config";
import { ActorPill, type Actor } from "./ActorPill";

function Addr({ id, label }: { id: string; label: string }) {
  return (
    <a
      href={solanaExplorerAddress(id)}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-[12px] text-muted underline decoration-line underline-offset-2 hover:text-fg"
      title={id}
    >
      {label} {id.slice(0, 4)}…{id.slice(-4)}
    </a>
  );
}

const ROWS: { actor: Actor; title: string; body: ReactNode }[] = [
  {
    actor: "solana",
    title: "Solana programs",
    body: (
      <>
        <p>
          <span className="text-fg">eth_demo</span> builds the EVM transaction on-chain and asks{" "}
          <span className="text-fg">soda</span> for a signature. soda derives your Base key itself, and{" "}
          <span className="font-mono text-[12px]">finalize_signature</span> checks the committee&apos;s signature
          with <span className="font-mono text-[12px]">secp256k1_recover</span> before anything is broadcast.
          The swap page uses the same soda through the <span className="text-fg">intents</span> program.
        </p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          <Addr id={ETH_DEMO_PROGRAM_ID} label="eth_demo" />
          <Addr id={SODA_PROGRAM_ID.toBase58()} label="soda" />
          <Addr id={INTENTS_PROGRAM_ID.toBase58()} label="intents" />
        </div>
      </>
    ),
  },
  {
    actor: "mpc",
    title: "SODA MPC committee",
    body: (
      <>
        <p>
          Two nodes hold multiplicative shares of one secp256k1 key and run 2-party ECDSA. Each node re-reads
          the SigRequest from its own Solana RPC, so a caller cannot choose what gets signed. Not Chainlink.
        </p>
        <div className="mt-2">
          <Addr id={COMMITTEE_PDA.toBase58()} label="committee" />
        </div>
      </>
    ),
  },
  {
    actor: "cre",
    title: "Chainlink CRE",
    body: (
      <>
        <p>
          <span className="text-fg">Signer</span> workflow: CRE reads the pending SigRequest, calls the MPC
          coordinator, reaches DON consensus on (r, s, v) and writes it through Chainlink&apos;s forwarder into{" "}
          <span className="text-fg">soda_cre_signer</span>, which calls soda::finalize_signature. It replaces the
          off-chain subscriber as the thing that drives the committee.
        </p>
        <p className="mt-2">
          <span className="text-fg">Witness</span> workflow: CRE proves Base deposits (solver ETH deposits) to
          Solana as claims, so the intents program can credit them.
        </p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          <Addr id={SODA_CRE_SIGNER_ID} label="soda_cre_signer" />
          <Addr id={SODA_WITNESS_ID} label="soda_witness" />
        </div>
      </>
    ),
  },
  {
    actor: "base",
    title: "Base Sepolia",
    body: (
      <p>
        Sees only a normal signed transaction from your derived address. No contract, bridge or escrow on Base.
      </p>
    ),
  },
];

export function WhatRunsWhere() {
  return (
    <section className="bg-card p-5 sm:p-6">
      <h2 className="text-base font-medium">What runs where</h2>
      <div className="mt-4 grid gap-0.5 bg-bg p-0.5 sm:grid-cols-2">
        {ROWS.map((r) => (
          <div key={r.actor} className="bg-panel p-4 text-[13px] leading-5 text-muted">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-fg">{r.title}</span>
              <ActorPill actor={r.actor} />
            </div>
            {r.body}
          </div>
        ))}
      </div>
    </section>
  );
}
