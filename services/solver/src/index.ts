// SODA Intents solver bot. Run from the repo root: npx tsx services/solver/src/index.ts

import {
  baseRpc,
  fetchConfig,
  fetchSolver,
  poolEvmAddress,
  solanaExplorerTx,
} from "../../../lib/intents";
import { connection, intentsProgram, registerSolverIx, sendIxs } from "./chain";
import {
  baseRpcUrl,
  botPrivateKey,
  envBig,
  envNum,
  envStr,
  loadEnv,
  programId,
  redactUrl,
  solanaRpcUrl,
  solanaWsUrl,
  solverKeypair,
} from "./env";
import { checksumAddr, evmAddressOf, hexAddr, signDepositProof } from "./evm";
import { parseUsd18 } from "./pyth";
import { startServer } from "./server";
import { Solver, type SolverSettings } from "./solver";
import { ProgramWatcher } from "./watcher";
import { watcherConnection } from "./watcher-conn";

async function main(): Promise<void> {
  loadEnv();
  const pid = programId();
  const keypair = solverKeypair();
  const rpcUrl = solanaRpcUrl();
  const conn = connection(rpcUrl);
  // logsSubscribe is optional: the watcher polls signatures over SOLANA_RPC_URL.
  const wsUrl = solanaWsUrl();
  const wsConn = wsUrl ? connection(rpcUrl, wsUrl) : null;
  // Its own Connection, so 429s reach the watcher's backoff instead of web3.js retries.
  const watcher = new ProgramWatcher(watcherConnection(rpcUrl), {
    programId: pid,
    watchMs: envNum("WATCH_MS", 1_500),
    backfillSigs: envNum("BACKFILL_SIGS", 1_000),
    // Paced so a long backfill stays under free-tier per-second limits.
    txPerSec: envNum("WATCHER_TX_PER_SEC", 10),
    rewalkMs: envNum("REWALK_MS", 180_000),
    maxOlderSigs: envNum("MAX_OLDER_SIGS", 20_000),
  });
  const program = intentsProgram(conn, keypair, pid);
  // Tight timeout: the recipient check and gas read sit on the fill path.
  const base = baseRpc({ url: baseRpcUrl(), timeoutMs: envNum("BASE_RPC_TIMEOUT_MS", 5_000) });
  const fallback = (name: string) => {
    const v = envStr(name);
    return v ? parseUsd18(v) : undefined;
  };

  const settings: SolverSettings = {
    programId: pid,
    spreadBps: envBig("SPREAD_BPS", 30n),
    depthMult: envBig("VIRTUAL_DEPTH", 10n),
    priceMaxAgeSec: envBig("PRICE_MAX_AGE_SEC", 3_600n),
    solUsdFallback18: fallback("SOL_USD_FALLBACK"),
    ethUsdFallback18: fallback("ETH_USD_FALLBACK"),
    tickMs: envNum("TICK_MS", 1_000),
    pollMs: envNum("POLL_MS", 10_000),
    deliverMs: envNum("DELIVER_MS", 4_000),
    anchorMs: envNum("ANCHOR_MS", 60_000),
    clockSkewSec: 5n,
    priorityMicroLamports: envNum("PRIORITY_MICROLAMPORTS", 0),
    gasMarginBps: envBig("GAS_MARGIN_BPS", 2_500n),
    gasFloorWei: envBig("GAS_FLOOR_WEI", 1_000_000n),
    bumpExtraBps: envBig("BUMP_EXTRA_BPS", 1_000n),
    selfBumpAfterMs: 30_000,
    otherBumpAfterMs: 60_000,
    includeSigRent: envStr("INCLUDE_SIG_RENT", "1") !== "0",
    checkRecipientCode: envStr("CHECK_RECIPIENT_CODE", "1") !== "0",
    includeIntentRent: envStr("INCLUDE_INTENT_RENT", "1") !== "0",
    rfqQuoteTtlMs: envNum("RFQ_QUOTE_TTL_MS", 30_000),
  };
  if (settings.spreadBps < 0n || settings.spreadBps >= 10_000n) throw new Error("SPREAD_BPS must be in [0, 10000)");

  console.log(`solver ${keypair.publicKey.toBase58()} on program ${pid.toBase58()}`);
  console.log(
    `solana rpc ${redactUrl(rpcUrl)}, ws ${wsUrl ? redactUrl(wsUrl) : "off (polling signatures every " + watcher.watchMs + " ms)"}, base rpc ${redactUrl(baseRpcUrl())}`,
  );
  console.log(`pool Base address ${checksumAddr(poolEvmAddress(undefined, pid))}, spread ${settings.spreadBps} bps`);

  const config = await fetchConfig(conn, pid);
  if (!config) throw new Error("intents Config not found: run `npm run cli -- init-config` first");

  const botKey = botPrivateKey();
  const botAddr = botKey ? evmAddressOf(botKey) : undefined;
  let solver = await fetchSolver(conn, keypair.publicKey, pid);
  if (!solver) {
    if (!botKey || !botAddr || envStr("AUTO_REGISTER", "1") === "0") {
      throw new Error("solver not registered: run `npm run cli -- register-solver` or set BOT_ID to auto-register");
    }
    const proof = signDepositProof(botKey, keypair.publicKey, pid);
    const ix = await registerSolverIx(program, keypair.publicKey, botAddr, botAddr, proof);
    const sig = await sendIxs(conn, keypair, [ix], pid);
    console.log(`registered solver with payout/deposit address ${checksumAddr(botAddr)}: ${solanaExplorerTx(sig)}`);
    solver = await fetchSolver(conn, keypair.publicKey, pid);
  } else if (botAddr && hexAddr(solver.payoutAddr) !== hexAddr(botAddr)) {
    console.warn(`registered payout_addr ${checksumAddr(solver.payoutAddr)} differs from BOT_ID's ${checksumAddr(botAddr)}`);
  }
  if (solver && solver.balanceWei === 0n) {
    console.warn("ledger balance is 0: deposit to the pool (`cli deposit`) and have the admin `credit-solver`");
  }

  const bot = new Solver(conn, wsConn, program, keypair, base, settings, watcher);
  await bot.start();
  const port = envNum("PORT", 8080);
  const server = startServer(bot, port);
  console.log(`quote server on :${port} (GET /quote?inLamports=, POST /rfq/quote, POST /rfq/execute, GET /health)`);

  const shutdown = async () => {
    await bot.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
