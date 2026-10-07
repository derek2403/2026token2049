// Server-side Solana devnet reads for the API routes.

import { Connection } from "@solana/web3.js";

let conn: Connection | null = null;

export function serverConnection(): Connection {
  conn ??= new Connection(
    process.env.SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    // Fail fast on 429 instead of backing off for seconds; the page polls again.
    { commitment: "confirmed", disableRetryOnRateLimit: true },
  );
  return conn;
}

/** Error text safe to return to the browser (no URLs, bounded length). */
export function publicError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/https?:\/\/\S+/g, "<rpc>").slice(0, 240);
}
