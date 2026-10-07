// Base Sepolia RPC for the API routes. BASE_RPC_URL may carry a provider key in
// its path, so it stays on the server.

import { baseRpc } from "@/lib/intents";
import { EthRpc } from "@/lib/soda";

/** Never null: falls back to the public Base Sepolia endpoint. */
export function getBaseRpc(): EthRpc | null {
  return baseRpc();
}

export const BASE_RPC_MISSING = "Base RPC not configured: set BASE_RPC_URL";
