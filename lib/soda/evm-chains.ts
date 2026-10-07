// Copied from frontier packages/soda-sdk/src/chains.ts (SODA, prior work), trimmed to the EVM registry and chainById (no Aave/Sui fields); used by mpc/relayer.

import { EVM_CHAIN_TAG } from "./chains";

export type EvmChainKey = "sepolia" | "base-sepolia";

export type EvmChain = {
  key: EvmChainKey;
  name: string;
  chainId: bigint;
  /** 32-byte derivation tag. Every EVM chain shares EVM_CHAIN_TAG. */
  chainTag: Uint8Array;
  /** Keyless public RPC used when the env var below is unset. */
  defaultRpc: string;
  /** Server-side env var that overrides defaultRpc. */
  rpcEnv: string;
  explorerTx: (hash: string) => string;
  explorerAddress: (addr: string) => string;
};

export const CHAINS: Record<EvmChainKey, EvmChain> = {
  sepolia: {
    key: "sepolia",
    name: "Ethereum Sepolia",
    chainId: 11_155_111n,
    chainTag: EVM_CHAIN_TAG,
    defaultRpc: "https://ethereum-sepolia-rpc.publicnode.com",
    rpcEnv: "SEPOLIA_RPC_URL",
    explorerTx: (h) => `https://sepolia.etherscan.io/tx/${h}`,
    explorerAddress: (a) => `https://sepolia.etherscan.io/address/${a}`,
  },
  "base-sepolia": {
    key: "base-sepolia",
    name: "Base Sepolia",
    chainId: 84_532n,
    chainTag: EVM_CHAIN_TAG,
    defaultRpc: "https://sepolia.base.org",
    rpcEnv: "BASE_SEPOLIA_RPC_URL",
    explorerTx: (h) => `https://sepolia.basescan.org/tx/${h}`,
    explorerAddress: (a) => `https://sepolia.basescan.org/address/${a}`,
  },
};

/** Look a chain up by the id recovered from a transaction's EIP-155 `v`. */
export function chainById(chainId: bigint): EvmChain | undefined {
  return Object.values(CHAINS).find((c) => c.chainId === chainId);
}
