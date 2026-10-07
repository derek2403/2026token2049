// Demo evidence: what a solver that lost the race sees. Sends `fill` for an
// intent that is no longer Open, with preflight off, so the rejection lands
// on-chain (IntentNotOpen) and has an Explorer link.
//
//   npx tsx scripts/demo-rejected-fill.ts <intent pubkey> [--keypair <solver keypair path>]

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { configPda, fetchConfig, fetchIntent, IntentStatus } from "../lib/intents";
import { connection, FILL_COMPUTE_UNITS, fillIx, intentsErrorName, intentsProgram } from "../services/solver/src/chain";
import { loadEnv, programId, solanaRpcUrl, solverKeypair } from "../services/solver/src/env";

async function main(): Promise<void> {
  loadEnv();
  const [intentArg, flag, path] = process.argv.slice(2);
  if (!intentArg) throw new Error("usage: demo-rejected-fill.ts <intent> [--keypair <path>]");
  const keypair =
    flag === "--keypair" && path
      ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.replace(/^~/, homedir()), "utf8"))))
      : solverKeypair();
  const pid = programId();
  const conn = connection(solanaRpcUrl());
  const program = intentsProgram(conn, keypair, pid);
  const intentKey = new PublicKey(intentArg);

  const intent = await fetchIntent(conn, intentKey);
  if (!intent) throw new Error(`intent ${intentArg} not found`);
  if (intent.status === IntentStatus.Open) throw new Error("intent is still Open; this demo needs a filled or cancelled one");
  const config = await fetchConfig(conn, pid);
  if (!config) throw new Error("Config not found");
  if (!(await conn.getAccountInfo(configPda(pid)[0]))) throw new Error("Config missing");

  // Same arguments a racing solver would send: the current nonce and the filled amount.
  const { ix } = fillIx(program, keypair.publicKey, intentKey, intent, config.nextNonce, intent.outWei, config.minGasPrice);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: keypair.publicKey, blockhash, lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: FILL_COMPUTE_UNITS }),
    await ix,
  );
  tx.sign(keypair);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  // Poll: keyed RPCs (Alchemy) have no signatureSubscribe.
  let t = null;
  for (let i = 0; i < 60 && !t; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  }
  if (!t) throw new Error(`transaction ${sig} not found after 60 s`);
  const logs = t?.meta?.logMessages ?? [];
  console.log(`solver  ${keypair.publicKey.toBase58()}`);
  console.log(`intent  ${intentKey.toBase58()} (status ${IntentStatus[intent.status]})`);
  console.log(`result  ${t?.meta?.err ? "rejected: " + (intentsErrorName(logs, JSON.stringify(t.meta.err), pid) ?? JSON.stringify(t.meta.err)) : "UNEXPECTEDLY SUCCEEDED"}`);
  console.log(`tx      https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
