// The demo pipeline, outside React: fund → simulate → Phantom signs
// eth_demo::sign_eth_transfer → wait for the committee (subscriber or Chainlink
// CRE) to finalize on Solana → broadcast on Base → receipt.
// Ported from runAction in frontier apps/web/pages/index.tsx (prior work).

import { Buffer } from "buffer";
import { AnchorProvider, BN, Program, type Wallet } from "@coral-xyz/anchor";
import { SystemProgram, type Connection, type PublicKey } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { keccak_256 } from "@noble/hashes/sha3";
import { COMMITTEE_PDA, SODA_PROGRAM_ID, sigRequestPda as deriveSigRequestPda } from "@/lib/intents";
import { bigintToBe, encodeUnsignedLegacy, EVM_CHAIN_TAG } from "@/lib/soda";
import {
  DEMO_CHAIN,
  ETH_DEMO_IDL,
  ETH_DEMO_PROGRAM_ID,
  hex0x,
  type DemoAttribution,
  type DemoFinalizeResponse,
  type DemoPrepare,
  type DemoStatus,
  type TxSpec,
} from "./config";
import { sendViaWallet } from "./send-via-wallet";

export type PipelineStep = "request" | "sigRequested" | "sign" | "finalize" | "broadcast" | "receipt";
export type PipelineStepState = "idle" | "active" | "done" | "error";

export type PipelineUpdate = {
  sigRequest?: string;
  requestTx?: string;
  attribution?: DemoAttribution;
  signMs?: number;
  ethTxHash?: string;
  signedHex?: string;
  receipt?: { status: 0 | 1; blockNumber: string };
  totalMs?: number;
};

export type PipelineCallbacks = {
  step: (k: PipelineStep, s: PipelineStepState) => void;
  update: (u: PipelineUpdate) => void;
  note: (n: string | null) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok && res.status !== 202) throw new Error(body.error ?? `${url} ${res.status}`);
  return { status: res.status, body };
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export async function runPipeline(
  opts: {
    connection: Connection;
    wallet: AnchorWallet;
    owner: PublicKey;
    ethAddress: string;
    pathBytes: Uint8Array;
    spec: TxSpec;
    balanceWei: bigint | null;
  },
  cb: PipelineCallbacks,
): Promise<void> {
  const { connection, wallet, owner, ethAddress, pathBytes, spec } = opts;
  const t0 = Date.now();

  // 1. Gas: the derived address pays its own gas on Base, so top it up.
  if (opts.balanceWei == null || opts.balanceWei < spec.minBalanceWei) {
    cb.note("Topping up gas on your derived address from the demo faucet…");
    await api(`/api/demo/fund`, post({ address: ethAddress, minWei: spec.minBalanceWei.toString() }));
  }

  // 2. Nonce, gas price, and a dry run so an Aave revert shows up before Phantom.
  cb.note("Simulating on Base…");
  const { body: prep } = await api<DemoPrepare>(
    `/api/demo/prepare`,
    post({ from: ethAddress, to: hex0x(spec.to), valueWei: spec.valueWei.toString(), dataHex: hex0x(spec.data) }),
  );
  const nonce = BigInt(prep.nonce);
  // A per-click salt (< 0.1 gwei) so a retry with the same nonce gets a fresh SigRequest PDA.
  const gasPrice = BigInt(prep.gasPriceWei) + BigInt(Math.floor(Math.random() * 100_000_000));
  const valueWeiBe = bigintToBe(spec.valueWei, 16);
  const payload = keccak_256(
    encodeUnsignedLegacy({
      nonce,
      gasPriceWei: gasPrice,
      gasLimit: spec.gasLimit,
      to: spec.to,
      valueWeiBe,
      data: spec.data,
      chainId: DEMO_CHAIN.chainId,
    }),
  );
  const [sigRequest] = deriveSigRequestPda(owner, payload);
  const sr = sigRequest.toBase58();

  // 3. Phantom signs eth_demo::sign_eth_transfer (which CPIs soda::request_signature).
  const provider = new AnchorProvider(connection, wallet as Wallet, { commitment: "confirmed" });
  const program = new Program({ ...ETH_DEMO_IDL, address: ETH_DEMO_PROGRAM_ID }, provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx = await (program.methods as any)
    .signEthTransfer(
      Array.from(spec.to),
      Array.from(valueWeiBe),
      new BN(nonce.toString()),
      new BN(gasPrice.toString()),
      new BN(spec.gasLimit.toString()),
      Buffer.from(spec.data),
      new BN(DEMO_CHAIN.chainId.toString()),
      Array.from(EVM_CHAIN_TAG),
      Buffer.from(pathBytes),
    )
    .accountsPartial({
      user: owner,
      committee: COMMITTEE_PDA,
      sigRequest,
      sodaProgram: SODA_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  cb.note("Approve in Phantom…");
  cb.step("request", "active");
  const { signature: requestTx } = await sendViaWallet(connection, wallet, tx, "sign_eth_transfer");
  const signStart = Date.now();
  cb.note(null);
  cb.step("request", "done");
  cb.step("sigRequested", "done");
  cb.step("sign", "active");
  cb.update({ sigRequest: sr, requestTx });

  // 4. Wait for the committee (SODA MPC subscriber or Chainlink CRE) to finalize on Solana.
  let status: DemoStatus | null = null;
  const signDeadline = Date.now() + 10 * 60_000;
  while (Date.now() < signDeadline) {
    status = (await api<DemoStatus>(`/api/demo/status?sigRequest=${sr}`).catch(() => null))?.body ?? null;
    if (status?.completed) break;
    await sleep(1_000);
  }
  if (!status?.completed) throw new Error("The committee did not sign within 10 minutes.");
  cb.step("sign", "done");
  cb.step("finalize", "done");
  cb.update({ attribution: status.attribution, signMs: Date.now() - signStart });

  // 5. Join the recorded signature with the same RLP and broadcast on Base.
  cb.step("broadcast", "active");
  let fin: DemoFinalizeResponse | null = null;
  for (let i = 0; i < 10 && (!fin || fin.pending); i++) {
    fin = (
      await api<DemoFinalizeResponse>(
        `/api/demo/finalize`,
        post({
          sigRequest: sr,
          to: hex0x(spec.to),
          valueWei: spec.valueWei.toString(),
          dataHex: hex0x(spec.data),
          nonce: nonce.toString(),
          gasPriceWei: gasPrice.toString(),
          gasLimit: spec.gasLimit.toString(),
        }),
      )
    ).body;
  }
  if (!fin || fin.pending) throw new Error("Broadcast did not happen: the SigRequest is still pending.");
  cb.step("broadcast", "done");
  cb.step("receipt", "active");
  cb.update({ ethTxHash: fin.ethTxHash, signedHex: fin.signedHex, attribution: fin.attribution });

  // 6. Receipt.
  for (let i = 0; i < 60; i++) {
    const s = (await api<DemoStatus>(`/api/demo/status?sigRequest=${sr}&tx=${fin.ethTxHash}`).catch(() => null))?.body;
    if (s?.receipt) {
      const receipt = { status: s.receipt.status, blockNumber: s.receipt.blockNumber };
      cb.step("receipt", receipt.status === 1 ? "done" : "error");
      cb.update({ receipt, totalMs: Date.now() - t0 });
      if (receipt.status !== 1) throw new Error("The Base transaction was mined but reverted.");
      return;
    }
    await sleep(1_500);
  }
  throw new Error("No Base receipt after 90 s. Check Basescan.");
}
