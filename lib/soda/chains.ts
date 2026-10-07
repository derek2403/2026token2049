// Copied from frontier packages/soda-sdk/src/chains.ts (SODA, prior work):
// only the EVM derivation tag. The rest of that registry (Aave, Sui) is not
// used here.

function tag32(s: string): Uint8Array {
  const t = new Uint8Array(32);
  t.set(new TextEncoder().encode(s), 0);
  return t;
}

/**
 * The single derivation tag for every EVM chain. One requester, one EVM
 * address on Base Sepolia and Ethereum Sepolia alike; EIP-155 chain ids stop
 * cross-chain replay.
 */
export const EVM_CHAIN_TAG: Uint8Array = tag32("evm");

export const BASE_SEPOLIA_CHAIN_ID = 84532n;
