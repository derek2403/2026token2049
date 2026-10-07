// Destination networks shown in the token picker. Only `live` routes can be
// opened: the intents program pays out on Base Sepolia (programs/intents
// CHAIN_ID 84532). EVM entries share the same derived address, so adding one
// is a program, solver and payout-builder change, not a UI one.

export type DestChainId = "base" | "ethereum" | "arbitrum" | "optimism" | "polygon" | "sui";

export type DestChain = {
  id: DestChainId;
  /** Short network name, as in "Receive on {name}". */
  name: string;
  /** Testnet the route uses. */
  network: string;
  token: "ETH" | "POL" | "SUI";
  tokenName: string;
  kind: "evm" | "sui";
  /** EIP-155 chain id for EVM routes. */
  chainId?: number;
  live: boolean;
};

export const DEST_CHAINS: DestChain[] = [
  { id: "base", name: "Base", network: "Base Sepolia", token: "ETH", tokenName: "Ether", kind: "evm", chainId: 84532, live: true },
  {
    id: "ethereum",
    name: "Ethereum",
    network: "Ethereum Sepolia",
    token: "ETH",
    tokenName: "Ether",
    kind: "evm",
    chainId: 11155111,
    live: false,
  },
  {
    id: "arbitrum",
    name: "Arbitrum",
    network: "Arbitrum Sepolia",
    token: "ETH",
    tokenName: "Ether",
    kind: "evm",
    chainId: 421614,
    live: false,
  },
  {
    id: "optimism",
    name: "Optimism",
    network: "OP Sepolia",
    token: "ETH",
    tokenName: "Ether",
    kind: "evm",
    chainId: 11155420,
    live: false,
  },
  { id: "polygon", name: "Polygon", network: "Polygon Amoy", token: "POL", tokenName: "Polygon", kind: "evm", chainId: 80002, live: false },
  { id: "sui", name: "Sui", network: "Sui Testnet", token: "SUI", tokenName: "Sui", kind: "sui", live: false },
];

export const destChain = (id: DestChainId): DestChain => DEST_CHAINS.find((c) => c.id === id)!;
