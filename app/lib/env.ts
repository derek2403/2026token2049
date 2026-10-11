// Public (browser-visible) settings. Literal process.env reads so Next.js inlines them.

// In the browser, Solana HTTP RPC goes through our own /api/solana-rpc proxy:
// it uses the server's keyed RPC, so a page's burst of reads is not rate-limited.
// NEXT_PUBLIC_SOLANA_RPC_URL is only the server-render fallback (no window).
export const SOLANA_RPC_URL =
  typeof window !== "undefined"
    ? `${window.location.origin}/api/solana-rpc`
    : process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";

export const SOLANA_WS_URL =
  process.env.NEXT_PUBLIC_SOLANA_WS_URL || "wss://solana-devnet.api.onfinality.io/public-ws";
