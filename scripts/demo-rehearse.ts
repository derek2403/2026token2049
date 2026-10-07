// Rehearses the /demo pipeline headlessly (no Phantom): the page's own runPipeline,
// keypair wallet standing in for Phantom, against the local server on :3200.
//   MODE=subscriber|cre  (cre: also POSTs /api/demo/cre-sign once the request is pending)
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";
config({ path: new URL("../.env", import.meta.url).pathname });

const BASE = "http://localhost:3200";
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  realFetch(typeof input === "string" && input.startsWith("/") ? BASE + input : input, init)) as typeof fetch;

async function main() {
  const { runPipeline } = await import("../app/lib/demo/run-pipeline");
  const { ACTIONS } = await import("../app/lib/demo/config");
  const { deriveEthAddress, EVM_CHAIN_TAG } = await import("../lib/soda");
  const mode = process.env.MODE ?? "subscriber";
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(homedir() + "/.config/solana/token2049-testuser.json", "utf8"))));
  const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
  const gpk = Buffer.from("039e4c1ac3a50367eefb5d05d1a18620037b20f2f52fc434bb7c7363081e21c5c5", "hex");
  const path = new Uint8Array(0);
  const { ethAddress } = deriveEthAddress(gpk, kp.publicKey.toBytes(), path, EVM_CHAIN_TAG);
  const eth = "0x" + Buffer.from(ethAddress).toString("hex");
  const wallet = {
    publicKey: kp.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => { (tx as Transaction).partialSign(kp); return tx; },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => { txs.forEach((t) => (t as Transaction).partialSign(kp)); return txs; },
  };
  const spec = ACTIONS.transfer.build(ethAddress, { to: ethAddress, valueWei: 10_000_000_000_000n });
  console.log(`mode=${mode} owner=${kp.publicKey.toBase58()} derived=${eth}`);
  let creFired = false;
  const t0 = Date.now();
  await runPipeline(
    { connection: conn, wallet: wallet as never, owner: kp.publicKey, ethAddress: eth, pathBytes: path, spec, balanceWei: null },
    {
      step: (k, s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s step ${k}: ${s}`),
      note: (n) => n && console.log(`   note: ${n}`),
      update: async (u) => {
        console.log("   update:", JSON.stringify(u));
        if (mode === "cre" && u.sigRequest && !creFired) {
          creFired = true;
          console.log("   → POST /api/demo/cre-sign (Chainlink CRE soda-signer, --broadcast)");
          const r = await fetch("/api/demo/cre-sign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sigRequest: u.sigRequest }) });
          const body = await r.text();
          console.log(`   cre-sign [${r.status}]: ${body.slice(-600)}`);
        }
      },
    },
  );
  console.log(`DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1); });
