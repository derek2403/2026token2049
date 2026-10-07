// Public (browser-visible) settings. Literal process.env reads so Next.js inlines them.

export const SOLANA_RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";

export const SOLANA_WS_URL =
  process.env.NEXT_PUBLIC_SOLANA_WS_URL || "wss://solana-devnet.api.onfinality.io/public-ws";
