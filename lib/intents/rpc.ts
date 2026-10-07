// Base Sepolia RPC. Server-only: BASE_RPC_URL may carry a provider key in its
// path, so the page calls its API routes, which call this.

import { bytesToHex } from "@noble/hashes/utils";
import { EthRpc } from "../soda";
import { DEFAULT_BASE_RPC_URL } from "./constants";
import type { EthReceipt, PayoutRpc } from "./payout";

/** EthRpc for Base Sepolia at BASE_RPC_URL (default: the public endpoint). */
export function baseRpc(opts: { url?: string; timeoutMs?: number } = {}): EthRpc {
  if (typeof window !== "undefined") {
    throw new Error("baseRpc() is server-only; call a Next.js API route from the browser");
  }
  const url = opts.url ?? process.env.BASE_RPC_URL ?? DEFAULT_BASE_RPC_URL;
  return new EthRpc(url, {}, opts.timeoutMs);
}

type RawReceipt = {
  transactionHash: string;
  status?: string;
  blockNumber: string;
  gasUsed: string;
  effectiveGasPrice?: string;
};

export function parseReceipt(raw: RawReceipt): EthReceipt {
  return {
    txHash: raw.transactionHash.toLowerCase(),
    status: raw.status && BigInt(raw.status) === 1n ? 1 : 0,
    blockNumber: BigInt(raw.blockNumber),
    gasUsed: BigInt(raw.gasUsed),
    effectiveGasPrice: raw.effectiveGasPrice ? BigInt(raw.effectiveGasPrice) : null,
  };
}

/** null while the tx is unknown or unmined. */
export async function getReceipt(rpc: EthRpc, txHash: string): Promise<EthReceipt | null> {
  const raw = await rpc.call<RawReceipt | null>("eth_getTransactionReceipt", [txHash]);
  return raw ? parseReceipt(raw) : null;
}

export async function getCode(rpc: EthRpc, address: string): Promise<string> {
  return await rpc.call<string>("eth_getCode", [address, "latest"]);
}

/**
 * Payouts use GAS_LIMIT 21000, so a recipient with code (a contract, or an
 * EIP-7702 delegated EOA) could revert after the user's SOL has gone. Only
 * eth_getCode == "0x" passes.
 */
export async function isPlainAddress(rpc: EthRpc, address: string | Uint8Array): Promise<boolean> {
  const hex = typeof address === "string" ? address : "0x" + bytesToHex(address);
  const code = (await getCode(rpc, hex)).trim().toLowerCase();
  return code === "0x";
}

/** Adapts EthRpc to the PayoutTracker interface. */
export function payoutRpc(rpc: EthRpc): PayoutRpc {
  return {
    sendRawTransaction: (signedHex) => rpc.sendRawTransaction(signedHex),
    getReceipt: (txHash) => getReceipt(rpc, txHash),
  };
}
