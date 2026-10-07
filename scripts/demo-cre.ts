// Demo helper for "Chainlink CRE drives the MPC committee".
//
//   npm run demo:cre -- status                 Railway soda-mpc-subscriber deployment status
//   npm run demo:cre -- pause-subscriber       stop it, so no one but CRE finalizes new SigRequests
//   npm run demo:cre -- resume-subscriber      redeploy it and wait for SUCCESS
//   npm run demo:cre -- cre-sign <intent|sigRequest>
//                                              write cre/payloads/sign.json, run the soda-signer
//                                              workflow with --broadcast, then report who finalized
//   npm run demo:cre -- who <intent|sigRequest>   read-only: who finalized it (CRE or subscriber)
//
// Reads RAILWAY_API_TOKEN (workspace token) and SOLANA_RPC_URL from .env. Never prints them.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { PublicKey, type Connection } from "@solana/web3.js";
import { decodeIntent, decodeSigRequest } from "../lib/intents";
import { connection } from "../services/solver/src/chain";
import { envStr, loadEnv, solanaRpcUrl } from "../services/solver/src/env";
import { attributeFinalize } from "../app/lib/server/signer-attribution";

const SODA_PROGRAM_ID = "CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J";

const RAILWAY_GQL = "https://backboard.railway.com/graphql/v2";
const PROJECT_ID = "537f955f-168f-4ef8-b202-241666c927e1"; // pagecontrol-signing
const SERVICE_ID = "29c7abf8-9ed7-42bf-ac06-e55abe126d2e"; // soda-mpc-subscriber
const ENVIRONMENT_ID = "9fb7005c-75e3-403c-8a43-9c78fa19e347";
const CRE_DIR = resolve(__dirname, "../cre");
const PAYLOAD = resolve(CRE_DIR, "payloads/sign.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Railway

type Deployment = { id: string; status: string; createdAt: string; deploymentStopped?: boolean | null };

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const token = envStr("RAILWAY_API_TOKEN");
  if (!token) throw new Error("RAILWAY_API_TOKEN is not set in .env");
  const r = await fetch(RAILWAY_GQL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await r.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
  if (!r.ok || !body || body.errors?.length || !body.data) {
    throw new Error(`Railway API: ${body?.errors?.map((e) => e.message).join("; ") ?? `HTTP ${r.status}`}`);
  }
  return body.data;
}

async function deployments(first = 5): Promise<Deployment[]> {
  const q = (extra: string) => `query($input: DeploymentListInput!, $first: Int) {
    deployments(input: $input, first: $first) { edges { node { id status createdAt ${extra} } } } }`;
  const vars = { input: { projectId: PROJECT_ID, serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID }, first };
  type R = { deployments: { edges: { node: Deployment }[] } };
  let d: R;
  try {
    d = await gql<R>(q("deploymentStopped"), vars);
  } catch {
    d = await gql<R>(q(""), vars); // older schema without deploymentStopped
  }
  return d.deployments.edges.map((e) => e.node);
}

function describe(d: Deployment): string {
  const stopped = d.deploymentStopped ? " (stopped)" : "";
  return `${d.status}${stopped}  ${d.createdAt}  ${d.id}`;
}

async function cmdStatus() {
  const ds = await deployments(5);
  if (ds.length === 0) return console.log("soda-mpc-subscriber: no deployments");
  const live = ds[0];
  const running = live.status === "SUCCESS" && !live.deploymentStopped;
  console.log(`soda-mpc-subscriber: ${running ? "RUNNING (subscriber will race CRE)" : "NOT RUNNING (CRE can sign alone)"}`);
  for (const d of ds) console.log(`  ${describe(d)}`);
  if (live.status === "SUCCESS" && live.deploymentStopped === undefined) {
    console.log("  note: Railway may keep reporting SUCCESS for a few seconds after deploymentStop");
  }
}

async function cmdPause() {
  const ds = await deployments(10);
  const target = ds.find((d) => d.status === "SUCCESS" && !d.deploymentStopped);
  if (!target) {
    console.log("no running SUCCESS deployment; the subscriber is already stopped");
    return cmdStatus();
  }
  await gql<{ deploymentStop: boolean }>(`mutation($id: String!) { deploymentStop(id: $id) }`, { id: target.id });
  console.log(`stopped ${target.id} at ${new Date().toISOString()}`);
  console.log("CRE is now the only signer. Resume afterwards: npm run demo:cre -- resume-subscriber");
}

async function cmdResume() {
  const [latest] = await deployments(1);
  if (!latest) throw new Error("no deployment to redeploy");
  const d = await gql<{ deploymentRedeploy: { id: string; status: string } }>(
    `mutation($id: String!) { deploymentRedeploy(id: $id) { id status } }`,
    { id: latest.id },
  );
  const id = d.deploymentRedeploy.id;
  console.log(`redeploying ${latest.id} → ${id} (${d.deploymentRedeploy.status})`);
  const deadline = Date.now() + 5 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const s = await gql<{ deployment: { status: string } }>(`query($id: String!) { deployment(id: $id) { status } }`, { id });
    if (s.deployment.status !== last) console.log(`  ${new Date().toISOString().slice(11, 19)} ${s.deployment.status}`);
    last = s.deployment.status;
    if (s.deployment.status === "SUCCESS") return console.log("subscriber is back");
    if (["FAILED", "CRASHED", "REMOVED"].includes(s.deployment.status)) throw new Error(`redeploy ${s.deployment.status}`);
    await sleep(3_000);
  }
  throw new Error("redeploy did not reach SUCCESS within 5 min; check Railway");
}

// ---------------------------------------------------------------- CRE signer

/** An intent (newest SigRequest) or a SigRequest address → the SigRequest and its state. */
async function resolveSigRequest(conn: Connection, arg: string): Promise<{ sigRequest: PublicKey; completed: boolean; intent?: PublicKey }> {
  const key = new PublicKey(arg);
  const info = await conn.getAccountInfo(key);
  if (!info) throw new Error(`${arg} not found on devnet (closed?)`);
  if (info.owner.toBase58() === SODA_PROGRAM_ID) {
    return { sigRequest: key, completed: decodeSigRequest(info.data).completed };
  }
  const intent = decodeIntent(info.data);
  if (intent.sigRequestCount === 0) throw new Error("intent has no SigRequest yet (not filled)");
  const sigRequest = intent.sigRequests[intent.sigRequestCount - 1];
  const sr = await conn.getAccountInfo(sigRequest);
  if (!sr) throw new Error(`SigRequest ${sigRequest.toBase58()} not found`);
  return { sigRequest, completed: decodeSigRequest(sr.data).completed, intent: key };
}

async function printWho(conn: Connection, sigRequest: PublicKey) {
  const info = await conn.getAccountInfo(sigRequest);
  const completed = info ? decodeSigRequest(info.data).completed : false;
  const a = await attributeFinalize(conn, sigRequest);
  console.log(`sig_request ${sigRequest.toBase58()}  completed=${completed}`);
  console.log(`finalized by: ${a.via}${a.forwarder ? ` (${a.forwarder} forwarder)` : ""}  ${a.via === "pending" ? "" : a.label}`);
  if (a.finalizeTx) console.log(`finalize tx:  https://explorer.solana.com/tx/${a.finalizeTx}?cluster=devnet`);
}

function creBin(): string {
  const p = resolve(homedir(), ".cre/bin/cre");
  return existsSync(p) ? p : "cre";
}

async function cmdCreSign(arg: string) {
  const conn = connection(solanaRpcUrl());
  const { sigRequest, completed, intent } = await resolveSigRequest(conn, arg);
  if (intent) console.log(`intent      ${intent.toBase58()}`);
  console.log(`sig_request ${sigRequest.toBase58()}  completed=${completed}`);
  if (completed) console.log("already finalized: the workflow will log AlreadyFinalized (still a valid demo of the read + MPC call)");
  mkdirSync(resolve(PAYLOAD, ".."), { recursive: true });
  writeFileSync(PAYLOAD, JSON.stringify({ sigRequest: sigRequest.toBase58() }, null, 2) + "\n");
  console.log(`wrote ${PAYLOAD}\n`);

  const args = [
    "workflow", "simulate", "soda-signer",
    "--target", "simulation-settings",
    "--non-interactive",
    "--trigger-index", "0",
    "--http-payload", "./payloads/sign.json",
    "--broadcast",
  ];
  console.log(`$ (cd cre && cre ${args.join(" ")})`);
  const started = Date.now();
  const code = await new Promise<number>((res, rej) => {
    const child = spawn(creBin(), args, { cwd: CRE_DIR, stdio: "inherit" });
    child.on("error", rej);
    child.on("close", (c) => res(c ?? 1));
  });
  console.log(`\ncre exited ${code} after ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  // Give the RPC a moment to index the finalize tx.
  for (let i = 0; i < 5; i++) {
    const a = await attributeFinalize(conn, sigRequest);
    if (a.via !== "pending") break;
    await sleep(2_000);
  }
  await printWho(conn, sigRequest);
  if (code !== 0) process.exit(code);
}

async function cmdWho(arg: string) {
  const conn = connection(solanaRpcUrl());
  const { sigRequest, intent } = await resolveSigRequest(conn, arg);
  if (intent) console.log(`intent      ${intent.toBase58()}`);
  await printWho(conn, sigRequest);
}

// ---------------------------------------------------------------- main

const USAGE = `usage: npm run demo:cre -- <command>
  status                         soda-mpc-subscriber deployment status (Railway)
  pause-subscriber               deploymentStop the running deployment
  resume-subscriber              deploymentRedeploy the latest deployment, wait for SUCCESS
  cre-sign <intent|sigRequest>   run cre soda-signer (--broadcast) for it, then show who finalized
  who <intent|sigRequest>        read-only: CRE or subscriber?`;

async function main() {
  loadEnv();
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "status":
      return cmdStatus();
    case "pause-subscriber":
      return cmdPause();
    case "resume-subscriber":
      return cmdResume();
    case "cre-sign":
      if (!arg) throw new Error("cre-sign needs <intent|sigRequest>");
      return cmdCreSign(arg);
    case "who":
      if (!arg) throw new Error("who needs <intent|sigRequest>");
      return cmdWho(arg);
    default:
      console.log(USAGE);
      if (cmd && cmd !== "help") process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
