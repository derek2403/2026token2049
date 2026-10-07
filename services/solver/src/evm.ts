// The operator's own Base wallet (BOT_ID): its address becomes the solver's
// payout_addr / deposit_from, and it funds the pool with an ordinary signed
// transfer. Signing is local; the key never leaves this process.

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  BASE_SEPOLIA_CHAIN_ID,
  bigintToBe,
  eip155V,
  encodeSignedLegacy,
  encodeUnsignedLegacy,
  ethAddressFromPk,
  type EthRpc,
  type LegacyTx,
} from "../../../lib/soda";
import type { PublicKey } from "@solana/web3.js";
import { GAS_LIMIT, depositProofMessage } from "../../../lib/intents";

export function evmAddressOf(privateKey: Uint8Array): Uint8Array {
  return ethAddressFromPk(secp256k1.getPublicKey(privateKey, false));
}

export function hexAddr(addr: Uint8Array): string {
  return "0x" + bytesToHex(addr);
}

/** EIP-55 checksummed form, for display. */
export function checksumAddr(addr: Uint8Array | string): string {
  const lower = (typeof addr === "string" ? addr.replace(/^0x/i, "") : bytesToHex(addr)).toLowerCase();
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/** 0x + 40 hex → 20 bytes. Mixed case must be a valid EIP-55 checksum. */
export function parseEvmAddress(s: string): Uint8Array {
  const t = s.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) throw new Error(`not an EVM address: ${s}`);
  const body = t.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && checksumAddr(body) !== t) throw new Error(`bad EIP-55 checksum: ${s}`);
  return hexToBytes(body.toLowerCase());
}

export type SignedTx = { raw: Uint8Array; rawHex: string; txHash: string };

/** EIP-155 legacy signature (low-s), the same shape SODA's payouts use. */
export function signLegacy(tx: LegacyTx, privateKey: Uint8Array): SignedTx {
  const digest = keccak_256(encodeUnsignedLegacy(tx));
  const sig = secp256k1.sign(digest, privateKey, { lowS: true });
  const raw = encodeSignedLegacy(tx, eip155V(sig.recovery, tx.chainId), bigintToBe(sig.r, 32), bigintToBe(sig.s, 32));
  return { raw, rawHex: "0x" + bytesToHex(raw), txHash: "0x" + bytesToHex(keccak_256(raw)) };
}

/** EIP-191 personal_sign: r || s || v (27/28), as wallets return it. */
export function personalSign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const sig = secp256k1.sign(keccak_256(new Uint8Array([...prefix, ...message])), privateKey, { lowS: true });
  const out = new Uint8Array(65);
  out.set(sig.toCompactRawBytes(), 0);
  out[64] = 27 + sig.recovery;
  return out;
}

/** register_solver's deposit_sig: proves this key's address may be the solver's deposit_from. */
export function signDepositProof(privateKey: Uint8Array, authority: PublicKey, programId: PublicKey): Uint8Array {
  return personalSign(depositProofMessage(authority, programId), privateKey);
}

export type DepositPlan = {
  from: string;
  to: string;
  valueWei: bigint;
  nonce: bigint;
  gasPrice: bigint;
  gasLimit: bigint;
  fromBalanceWei: bigint;
  signed: SignedTx;
};

/**
 * Builds and signs (but does not send) a plain transfer from the BOT_ID wallet
 * to `to`. Reads the pending nonce, gas price and balance through `rpc`.
 */
export async function planDeposit(
  rpc: EthRpc,
  privateKey: Uint8Array,
  to: Uint8Array,
  valueWei: bigint,
  opts: { nonce?: bigint; gasPrice?: bigint; gasPriceBumpBps?: bigint } = {},
): Promise<DepositPlan> {
  const from = hexAddr(evmAddressOf(privateKey));
  const [nonce, rpcGas, fromBalanceWei] = await Promise.all([
    opts.nonce !== undefined ? Promise.resolve(opts.nonce) : rpc.getNonce(from),
    opts.gasPrice !== undefined ? Promise.resolve(opts.gasPrice) : rpc.getGasPrice(),
    rpc.getBalance(from),
  ]);
  const gasPrice = opts.gasPrice ?? (rpcGas * (10_000n + (opts.gasPriceBumpBps ?? 2_000n))) / 10_000n;
  const tx: LegacyTx = {
    nonce,
    gasPriceWei: gasPrice,
    gasLimit: GAS_LIMIT,
    to,
    valueWeiBe: bigintToBe(valueWei, 32),
    data: new Uint8Array(0),
    chainId: BASE_SEPOLIA_CHAIN_ID,
  };
  return {
    from,
    to: hexAddr(to),
    valueWei,
    nonce,
    gasPrice,
    gasLimit: GAS_LIMIT,
    fromBalanceWei,
    signed: signLegacy(tx, privateKey),
  };
}

/** "0.05" → 5e16 wei (up to 18 decimals). */
export function parseEther(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(s.trim());
  if (!m) throw new Error(`bad ETH amount "${s}"`);
  return BigInt(m[1]) * 10n ** 18n + BigInt((m[2] ?? "").padEnd(18, "0"));
}

/** "0.1" → 1e8 lamports (up to 9 decimals). */
export function parseSol(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(s.trim());
  if (!m) throw new Error(`bad SOL amount "${s}"`);
  return BigInt(m[1]) * 10n ** 9n + BigInt((m[2] ?? "").padEnd(9, "0"));
}
