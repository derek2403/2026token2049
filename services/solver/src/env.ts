// Environment for the solver bot and the operator CLI. Secrets (SOLVER_KEYPAIR_*,
// BOT_ID, keyed RPC URLs) are parsed here and never logged.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { DEFAULT_INTENTS_PROGRAM_ID, DEFAULT_BASE_RPC_URL } from "../../../lib/intents/constants";

let loaded = false;

/** Loads the repo-root .env once, without overriding variables already set. NO_DOTENV=1 skips it. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  if (process.env.NO_DOTENV === "1") return;
  for (const p of [resolve(__dirname, "../../../.env"), resolve(process.cwd(), ".env")]) {
    if (existsSync(p)) {
      loadDotenv({ path: p, quiet: true });
      return;
    }
  }
}

export const DEFAULT_SOLANA_RPC_URL = "https://api.devnet.solana.com";
// Empty means no WebSocket: the solver discovers intents by polling
// getSignaturesForAddress over SOLANA_RPC_URL (watcher.ts). Alchemy's WS has no
// logsSubscribe, and keyless public ones rate-limit shared hosts like Railway.
export const DEFAULT_SOLANA_WS_URL = "";

export function envStr(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v.trim() !== "" ? v.trim() : fallback;
}

export function envNum(name: string, fallback: number): number {
  const v = envStr(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export function envBig(name: string, fallback: bigint): bigint {
  const v = envStr(name);
  if (v === undefined) return fallback;
  try {
    return BigInt(v);
  } catch {
    throw new Error(`${name} must be an integer`);
  }
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

export function keypairFromJson(json: string, what: string): Keypair {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
  if (!Array.isArray(arr) || arr.length !== 64) throw new Error(`${what} must be a 64-byte JSON array`);
  return Keypair.fromSecretKey(Uint8Array.from(arr as number[]));
}

export function keypairFromFile(path: string): Keypair {
  const p = expandHome(path);
  if (!existsSync(p)) throw new Error(`keypair file not found: ${p}`);
  return keypairFromJson(readFileSync(p, "utf8"), p);
}

/** SOLVER_KEYPAIR_JSON (JSON array), SOL_KEY (base58 secret), or SOLVER_KEYPAIR_PATH (local file). */
export function solverKeypair(): Keypair {
  const json = envStr("SOLVER_KEYPAIR_JSON");
  if (json) return keypairFromJson(json, "SOLVER_KEYPAIR_JSON");
  const b58 = envStr("SOL_KEY");
  if (b58) {
    try {
      return Keypair.fromSecretKey(bs58.decode(b58));
    } catch {
      throw new Error("SOL_KEY is not a base58 64-byte Solana secret key");
    }
  }
  const path = envStr("SOLVER_KEYPAIR_PATH");
  if (path) return keypairFromFile(path);
  throw new Error("set SOLVER_KEYPAIR_JSON (JSON array), SOL_KEY (base58) or SOLVER_KEYPAIR_PATH");
}

export function programId(): PublicKey {
  return new PublicKey(envStr("INTENTS_PROGRAM_ID", DEFAULT_INTENTS_PROGRAM_ID)!);
}

export function solanaRpcUrl(): string {
  return envStr("SOLANA_RPC_URL", DEFAULT_SOLANA_RPC_URL)!;
}

/** Optional logsSubscribe endpoint; undefined when SOLANA_WS_URL is unset, empty or "off". */
export function solanaWsUrl(): string | undefined {
  const v = envStr("SOLANA_WS_URL", DEFAULT_SOLANA_WS_URL);
  return v && v.toLowerCase() !== "off" ? v : undefined;
}

export function baseRpcUrl(): string {
  return envStr("BASE_RPC_URL", DEFAULT_BASE_RPC_URL)!;
}

/** BOT_ID: the operator's funded Base wallet key, 0x + 64 hex. undefined if unset. */
export function botPrivateKey(): Uint8Array | undefined {
  const v = envStr("BOT_ID");
  if (!v) return undefined;
  const hex = v.startsWith("0x") || v.startsWith("0X") ? v.slice(2) : v;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("BOT_ID must be a 32-byte hex private key");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/** Redacts URL query strings and long path segments (keyed RPC URLs) for logs. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split("/")
      .map((seg) => (seg.length >= 16 ? "***" : seg))
      .join("/");
    return `${u.protocol}//${u.host}${path}${u.search ? "?***" : ""}`;
  } catch {
    return "***";
  }
}
