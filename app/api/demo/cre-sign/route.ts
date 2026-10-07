// POST /api/demo/cre-sign {sigRequest}: LOCAL DEMO ONLY.
//
// Runs `cre workflow simulate soda-signer … --broadcast` on this machine, so
// Chainlink CRE asks the SODA MPC coordinator to sign the SigRequest and writes
// finalize_signature through Chainlink's forwarder. Returns the log tail and
// who finalized it (attributeFinalize).
//
// Inert unless DEMO_LOCAL_CRE=1 (404 otherwise): on Railway there is no cre
// CLI and no cre/.env, and this must never be callable there.
//
//   DEMO_LOCAL_CRE=1 npm run dev
//   curl -XPOST localhost:3000/api/demo/cre-sign -d '{"sigRequest":"<pda>"}'
//
// Accepts an intent address too (its newest SigRequest is used).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { connection as requestTime } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { decodeIntent } from "@/lib/intents";
import { attributeFinalize } from "@/app/lib/server/signer-attribution";
import { publicError, serverConnection } from "@/app/lib/server/solana";

// `runtime` / `dynamic` segment config is rejected under cacheComponents;
// GET calls requestTime() instead so the env check runs per request.
export const maxDuration = 180;

const SODA_PROGRAM_ID = "CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J";
const RUN_TIMEOUT_MS = 150_000;
const TAIL_LINES = 40;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const enabled = () => process.env.DEMO_LOCAL_CRE === "1";

// One run at a time: the payload file is shared.
let running = false;

/** Strips ANSI codes and anything that looks like a keyed RPC URL. */
function clean(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/https?:\/\/\S*(alchemy|onfinality|helius|quiknode|infura|api[-_]?key|token)\S*/gi, "<rpc>");
}

async function resolveSigRequest(arg: string): Promise<PublicKey> {
  const conn = serverConnection();
  const key = new PublicKey(arg);
  const info = await conn.getAccountInfo(key);
  if (!info) throw new Error("account not found on devnet");
  if (info.owner.toBase58() === SODA_PROGRAM_ID) return key;
  const intent = decodeIntent(info.data);
  if (intent.sigRequestCount === 0) throw new Error("intent has no SigRequest yet (not filled)");
  return intent.sigRequests[intent.sigRequestCount - 1];
}

function runCre(creDir: string): Promise<{ code: number; log: string; ms: number }> {
  const bin = existsSync(resolve(homedir(), ".cre/bin/cre")) ? resolve(homedir(), ".cre/bin/cre") : "cre";
  const args = [
    "workflow", "simulate", "soda-signer",
    "--target", "simulation-settings",
    "--non-interactive",
    "--trigger-index", "0",
    "--http-payload", "./payloads/sign.json",
    "--broadcast",
  ];
  const started = Date.now();
  return new Promise((res) => {
    let log = "";
    const child = spawn(bin, args, { cwd: creDir });
    const timer = setTimeout(() => {
      log += "\n[demo] timed out; killing cre\n";
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      res({ code: 127, log: log + `\n[demo] could not start cre: ${e.message}\n`, ms: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ code: code ?? 1, log, ms: Date.now() - started });
    });
  });
}

export async function POST(req: Request) {
  if (!enabled()) return new Response("Not found", { status: 404 });
  if (running) return json({ error: "A CRE run is already in progress" }, 409);

  const body = (await req.json().catch(() => null)) as { sigRequest?: unknown; intent?: unknown } | null;
  const arg = typeof body?.sigRequest === "string" ? body.sigRequest : typeof body?.intent === "string" ? body.intent : "";
  let sigRequest: PublicKey;
  try {
    sigRequest = await resolveSigRequest(arg);
  } catch (e) {
    return json({ error: `sigRequest: ${publicError(e)}` }, 400);
  }

  const creDir = resolve(process.cwd(), "cre");
  if (!existsSync(resolve(creDir, "project.yaml"))) return json({ error: "cre/ project not found next to the app" }, 500);

  running = true;
  try {
    await mkdir(resolve(creDir, "payloads"), { recursive: true });
    await writeFile(resolve(creDir, "payloads/sign.json"), JSON.stringify({ sigRequest: sigRequest.toBase58() }, null, 2) + "\n");
    const run = await runCre(creDir);
    const lines = clean(run.log).split("\n");
    const conn = serverConnection();
    let attribution = await attributeFinalize(conn, sigRequest).catch(() => null);
    for (let i = 0; i < 4 && (!attribution || attribution.via === "pending"); i++) {
      await new Promise((r) => setTimeout(r, 1500));
      attribution = await attributeFinalize(conn, sigRequest).catch(() => null);
    }
    return json({
      sigRequest: sigRequest.toBase58(),
      exitCode: run.code,
      durationMs: run.ms,
      alreadyFinalized: /AlreadyFinalized/i.test(run.log),
      userLogs: lines.filter((l) => l.includes("[USER LOG]")),
      logTail: lines.slice(-TAIL_LINES).join("\n"),
      attribution,
    });
  } finally {
    running = false;
  }
}

export async function GET() {
  await requestTime();
  if (!enabled()) return new Response("Not found", { status: 404 });
  return json({ enabled: true, usage: 'POST {"sigRequest":"<SigRequest or intent pubkey>"}' });
}
