// Writes cre/payloads/sign.json for the soda-signer CRE workflow: the newest
// SigRequest of an intent, and whether the committee has already signed it.
//
//   npx tsx scripts/cre-sign-payload.ts <intent pubkey>

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { decodeSigRequest, fetchIntent } from "../lib/intents";
import { connection } from "../services/solver/src/chain";
import { loadEnv, solanaRpcUrl } from "../services/solver/src/env";

async function main(): Promise<void> {
  loadEnv();
  const arg = process.argv[2];
  if (!arg) throw new Error("usage: cre-sign-payload.ts <intent pubkey>");
  const conn = connection(solanaRpcUrl());
  const intent = await fetchIntent(conn, new PublicKey(arg));
  if (!intent) throw new Error(`intent ${arg} not found`);
  if (intent.sigRequestCount === 0) throw new Error("intent has no SigRequest yet (not filled)");
  const sigRequest = intent.sigRequests[intent.sigRequestCount - 1];
  const info = await conn.getAccountInfo(sigRequest);
  if (!info) throw new Error(`SigRequest ${sigRequest.toBase58()} not found`);
  const sr = decodeSigRequest(info.data);
  const out = resolve(__dirname, "../cre/payloads/sign.json");
  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify({ sigRequest: sigRequest.toBase58() }, null, 2) + "\n");
  console.log(`sig_request ${sigRequest.toBase58()}  completed=${sr.completed}`);
  console.log(`wrote ${out}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
