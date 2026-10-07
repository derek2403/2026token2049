// Operator CLI for SODA Intents. Run from the repo root:
//   npx tsx scripts/intents-cli.ts <command> [flags]      (or: npm run cli -- <command> ...)
// `help` lists the commands. Only `deposit` touches Base, and only with --yes.

import { parseArgs } from "node:util";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import {
  DEFAULT_INTENTS_PROGRAM_ID,
  GROUP_PK,
  INTENT_SIZE,
  IntentStatus,
  SPEED_PRESETS,
  accountDiscriminator,
  baseRpc,
  basescanAddress,
  basescanTx,
  buildCandidates,
  claimCreditProblems,
  configPda,
  creditPda,
  decodeSolver,
  decodeWitnessClaim,
  depositProofMessage,
  fetchConfig,
  fetchIntent,
  fetchIntentSigRequests,
  fetchOpenIntents,
  fetchSigRequests,
  fetchSolver,
  formatEth,
  getReceipt,
  intentFilters,
  intentPda,
  intentStatus,
  decodeIntent,
  isPlainAddress,
  poolEvmAddress,
  poolPda,
  presetParams,
  solanaExplorerAddress,
  solanaExplorerTx,
  solverPda,
  walletEvmAddress,
  withdrawalPda,
  witnessConfigPda,
  witnessTrusted,
  decodeWithdrawal,
  minBumpGasPrice,
  type EthReceipt,
  type SpeedPresetId,
  type StatusResult,
  type StepRef,
  type StepId,
} from "../lib/intents";
import type { EthRpc } from "../lib/soda";
import {
  FILL_COMPUTE_UNITS,
  bumpWithdrawalGasIx,
  cancelIntentIx,
  closeIntentIx,
  clusterTime,
  connection,
  creditSolverFromClaimIx,
  creditSolverIx,
  initConfigIx,
  intentsProgram,
  openIntentIx,
  registerSolverIx,
  sendIxs,
  setMaxGasPriceIx,
  setMinGasPriceIx,
  setPausedIx,
  sleep,
  solverWithdrawIx,
  TxError,
} from "../services/solver/src/chain";
import {
  baseRpcUrl,
  botPrivateKey,
  envStr,
  keypairFromFile,
  loadEnv,
  programId,
  solanaRpcUrl,
  solverKeypair,
} from "../services/solver/src/env";
import {
  checksumAddr,
  evmAddressOf,
  hexAddr,
  parseEther,
  parseEvmAddress,
  parseSol,
  planDeposit,
  signDepositProof,
} from "../services/solver/src/evm";
import { intentHistory } from "../services/solver/src/history";

const EXPECTED_POOL_EVM = "0x7662920f66682d8996ec6b6d9e4ac9ed25a1006c";
const DEFAULT_ADMIN_KEYPAIR = "~/.config/solana/token2049-deployer.json";
const DEFAULT_USER_KEYPAIR = "~/.config/solana/id.json";
/** 1 gwei: far above Base Sepolia's usual ~0.001–0.01 gwei; set-max-gas raises it. */
const DEFAULT_MAX_GAS_WEI = 1_000_000_000n;
/** 0.001 gwei: Base Sepolia's usual floor; raise it with set-min-gas if basefee climbs. */
const DEFAULT_MIN_GAS_WEI = 1_000_000n;
/** 0.00002 ETH per payout for Base's L1 data fee. */
const DEFAULT_L1_BUFFER_WEI = 20_000_000_000_000n;
/**
 * Deposits admin-credited before credit_solver wrote a Credit PDA
 * (runs/intents-devnet.md). Refused here until their markers are backfilled
 * with `credit-solver --wei 0 --tx-hash` (HANDOVER §3.7).
 */
const ADMIN_CREDITED_DEPOSITS = new Set([
  "0xb9d12a5ab63a10f508a1288e0fa6db38da7a46b50d25daf06125669aec2757d7", // solver A, 1 ETH
  "0xaa9bf7dc09866e2a3b8ef5db3ab30bbbbe8f490dcb5ca3e317deb8615262623d", // solver B, 0.5 ETH
]);

const HELP = `SODA Intents CLI

  init-config      [--max-gas-wei N] [--min-gas-wei N] [--l1-buffer-wei N]   admin
  set-paused       true|false                                       admin
  set-max-gas      --wei N                                          admin
  set-min-gas      --wei N                                          admin
  credit-solver    --solver <pubkey> (--tx 0xhash | --tx-hash 0xhash (--eth X | --wei N)) [--force]   admin
  credit-from-claim --claim <pda> [--solver <authority>] [--force]  payer: solver keypair; the admin
                   co-signs while soda_witness takes mock-forwarder reports
  register-solver  [--payout 0x..] [--deposit-from 0x.. --deposit-sig 0x..]   solver; BOT_ID signs
                   the deposit_from proof unless --deposit-sig is given
  withdraw         --eth X [--gas-wei N]                            solver
  bump-withdrawal  <nonce> [--gas-wei N]                            solver, admin, or anyone after 60 s
  deposit          --eth X [--to 0x..] [--yes]                      BOT_ID wallet → pool (dry run without --yes)
  open-intent      --sol X [--preset fast|fair|auction] [--recipient 0x..]
                   [--start-eth X | --quote-url URL] [--min-eth X] [--no-code-check]   user
  trade            same flags as open-intent, plus [--timeout SEC]  open, then follow to completion
  cancel           <intent>                                         user
  close            <intent> [--admin]                               user (cancelled) or admin (filled)
  status           <intent>
  balances
  pool-address

Keypairs: --keypair <path> for user/solver commands; admin uses --admin-keypair,
ADMIN_KEYPAIR or ${DEFAULT_ADMIN_KEYPAIR}; solver uses SOLVER_KEYPAIR_JSON / SOLVER_KEYPAIR_PATH;
user uses USER_KEYPAIR or ${DEFAULT_USER_KEYPAIR}. Quotes come from --quote-url or SOLVER_URLS.`;

type Flags = Record<string, string | boolean | undefined>;

const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: {
    keypair: { type: "string" },
    "admin-keypair": { type: "string" },
    "max-gas-wei": { type: "string" },
    "min-gas-wei": { type: "string" },
    "l1-buffer-wei": { type: "string" },
    wei: { type: "string" },
    eth: { type: "string" },
    sol: { type: "string" },
    tx: { type: "string" },
    "tx-hash": { type: "string" },
    solver: { type: "string" },
    claim: { type: "string" },
    payout: { type: "string" },
    "deposit-from": { type: "string" },
    "deposit-sig": { type: "string" },
    to: { type: "string" },
    "gas-wei": { type: "string" },
    preset: { type: "string" },
    recipient: { type: "string" },
    "start-eth": { type: "string" },
    "min-eth": { type: "string" },
    "quote-url": { type: "string" },
    timeout: { type: "string" },
    "no-code-check": { type: "boolean" },
    yes: { type: "boolean" },
    force: { type: "boolean" },
    admin: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
}) as { values: Flags; positionals: string[] };

const str = (name: string): string | undefined => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);
const need = (name: string): string => {
  const v = str(name);
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};
const pos = (i: number, what: string): string => {
  const v = positionals[i];
  if (!v) throw new Error(`missing <${what}>`);
  return v;
};

// ---------------------------------------------------------------- context

loadEnv();
const pid = programId();
const conn: Connection = connection(solanaRpcUrl());

function adminKeypair(): Keypair {
  return keypairFromFile(str("admin-keypair") ?? envStr("ADMIN_KEYPAIR", DEFAULT_ADMIN_KEYPAIR)!);
}
function userKeypair(): Keypair {
  return keypairFromFile(str("keypair") ?? envStr("USER_KEYPAIR", DEFAULT_USER_KEYPAIR)!);
}
function solverKp(): Keypair {
  const p = str("keypair");
  return p ? keypairFromFile(p) : solverKeypair();
}
function base(): EthRpc {
  return baseRpc({ url: baseRpcUrl() });
}
function maybeBase(): EthRpc | null {
  return base();
}
function botKey(): Uint8Array {
  const k = botPrivateKey();
  if (!k) throw new Error("BOT_ID is not set");
  return k;
}

async function send(kp: Keypair, ix: Promise<TransactionInstruction>, computeUnits?: number, extraSigners?: Keypair[]) {
  const sig = await sendIxs(conn, kp, [await ix], pid, { computeUnits, extraSigners });
  console.log(`  tx ${solanaExplorerTx(sig)}`);
  return sig;
}

async function requireConfig() {
  const cfg = await fetchConfig(conn, pid);
  if (!cfg) throw new Error("Config not initialised: run init-config");
  return cfg;
}

function parseEvmTxHash(s: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error(`bad tx hash ${s}: want 0x + 64 hex`);
  return Uint8Array.from(Buffer.from(s.slice(2), "hex"));
}

function parseKey(s: string, what: string): PublicKey {
  try {
    return new PublicKey(s);
  } catch {
    throw new Error(`bad ${what} pubkey: ${s}`);
  }
}

// ---------------------------------------------------------------- admin

async function cmdInitConfig() {
  const admin = adminKeypair();
  const poolEvm = poolEvmAddress(GROUP_PK, pid);
  console.log(`program     ${pid.toBase58()}`);
  console.log(`admin       ${admin.publicKey.toBase58()}`);
  console.log(`pool PDA    ${poolPda(pid)[0].toBase58()} (bump ${poolPda(pid)[1]})`);
  console.log(`pool Base   ${checksumAddr(poolEvm)}`);
  if (pid.toBase58() === DEFAULT_INTENTS_PROGRAM_ID && hexAddr(poolEvm) !== EXPECTED_POOL_EVM) {
    throw new Error(`derived pool address ${hexAddr(poolEvm)} != expected ${EXPECTED_POOL_EVM}`);
  }
  if (await fetchConfig(conn, pid)) throw new Error("Config already exists");
  const maxGas = BigInt(str("max-gas-wei") ?? DEFAULT_MAX_GAS_WEI);
  const minGas = BigInt(str("min-gas-wei") ?? DEFAULT_MIN_GAS_WEI);
  const l1 = BigInt(str("l1-buffer-wei") ?? DEFAULT_L1_BUFFER_WEI);
  console.log(`gas         ${minGas}..${maxGas} wei, l1 buffer ${formatEth(l1, 8)} ETH`);
  await send(admin, initConfigIx(program(admin), admin.publicKey, poolEvm, maxGas, l1, minGas));
}

async function cmdSetPaused() {
  const v = pos(1, "true|false");
  if (v !== "true" && v !== "false") throw new Error("set-paused takes true or false");
  const admin = adminKeypair();
  await send(admin, setPausedIx(program(admin), admin.publicKey, v === "true"));
}

async function cmdSetMaxGas() {
  const admin = adminKeypair();
  const wei = BigInt(need("wei"));
  await send(admin, setMaxGasPriceIx(program(admin), admin.publicKey, wei));
}

async function cmdSetMinGas() {
  const admin = adminKeypair();
  const wei = BigInt(need("wei"));
  await send(admin, setMinGasPriceIx(program(admin), admin.publicKey, wei));
}

async function cmdCreditSolver() {
  const admin = adminKeypair();
  const authority = parseKey(need("solver"), "solver");
  const solver = await fetchSolver(conn, authority, pid);
  if (!solver) throw new Error(`no Solver account for ${authority.toBase58()}`);
  const cfg = await requireConfig();

  let amount: bigint;
  const txHash = str("tx") ?? need("tx-hash");
  const credit = creditPda(parseEvmTxHash(txHash), pid)[0];
  if (await conn.getAccountInfo(credit)) throw new Error(`deposit already credited (Credit ${credit.toBase58()})`);
  if (str("tx")) {
    // Check the deposit on Base before crediting it (admin trust step, §3.4).
    const rpc = base();
    const tx = await rpc.call<{ from: string; to: string | null; value: string } | null>("eth_getTransactionByHash", [txHash]);
    const rcpt = await getReceipt(rpc, txHash);
    if (!tx || !rcpt) throw new Error("deposit not found or not mined yet");
    if (rcpt.status !== 1) throw new Error("deposit reverted");
    if ((tx.to ?? "").toLowerCase() !== hexAddr(cfg.poolEvmAddr)) throw new Error(`deposit went to ${tx.to}, not the pool`);
    if (tx.from.toLowerCase() !== hexAddr(solver.depositFrom) && !flags.force) {
      throw new Error(`deposit from ${tx.from} != solver deposit_from ${hexAddr(solver.depositFrom)} (use --force)`);
    }
    amount = BigInt(tx.value);
    console.log(`deposit ${basescanTx(txHash)}: ${formatEth(amount)} ETH from ${tx.from}`);
  } else if (str("eth")) {
    amount = parseEther(need("eth"));
  } else {
    amount = BigInt(need("wei"));
  }
  if (ADMIN_CREDITED_DEPOSITS.has(txHash.toLowerCase()) && amount !== 0n && !flags.force) {
    throw new Error("this deposit was already admin-credited; backfill its marker with --wei 0 (use --force to credit again)");
  }
  console.log(`crediting ${formatEth(amount)} ETH to solver ${authority.toBase58()} (balance ${formatEth(solver.balanceWei)})`);
  console.log(`marker      Credit ${credit.toBase58()} for ${txHash}${amount === 0n ? " (marker only)" : ""}`);
  await send(admin, creditSolverIx(program(admin), admin.publicKey, authority, amount, parseEvmTxHash(txHash)));
}

/**
 * Phase 2 (§3.7): credit a deposit soda_witness recorded. Prints the claim's
 * facts, checks them as the program will, then sends. The claim must have been
 * opened with the solver's own key, so its requester is the solver authority.
 */
async function cmdCreditFromClaim() {
  const claimKey = parseKey(need("claim"), "claim");
  const cfg = await requireConfig();
  const info = await conn.getAccountInfo(claimKey);
  if (!info) throw new Error(`no account at ${claimKey.toBase58()}`);
  if (!info.owner.equals(cfg.witnessProgram)) {
    throw new Error(`claim owner ${info.owner.toBase58()} is not the witness program ${cfg.witnessProgram.toBase58()}`);
  }
  const c = decodeWitnessClaim(info.data);
  const txHash = `0x${Buffer.from(c.txHash).toString("hex")}`;
  console.log(`claim       ${claimKey.toBase58()} ${c.status === 1 ? "Recorded" : "Pending"}`);
  console.log(`requester   ${c.requester.toBase58()}`);
  console.log(`chain       ${c.chainId}`);
  console.log(`tx          ${txHash} ${basescanTx(txHash)}`);
  if (c.status === 1) {
    console.log(`success     ${c.success}`);
    console.log(`from        ${checksumAddr(c.from)}`);
    console.log(`to          ${checksumAddr(c.to)}${hexAddr(c.to) === hexAddr(cfg.poolEvmAddr) ? " (intents pool)" : ""}`);
    console.log(`value       ${formatEth(c.valueWei)} ETH (${c.valueWei} wei)`);
    console.log(`block       ${c.block}, recorded ${new Date(Number(c.recordedAt) * 1000).toISOString()}`);
  }

  const authority = str("solver") ? parseKey(str("solver")!, "solver") : c.requester;
  const solver = await fetchSolver(conn, authority, pid);
  if (!solver) throw new Error(`no Solver account for ${authority.toBase58()}`);
  console.log(`solver      ${authority.toBase58()} ledger ${formatEth(solver.balanceWei)} ETH, deposit_from ${checksumAddr(solver.depositFrom)}`);
  const problems = claimCreditProblems(c, cfg.poolEvmAddr, solver);
  if (problems.length) throw new Error(`the program would reject this claim:\n  ${problems.join("\n  ")}`);
  if (cfg.paused) throw new Error("intents program is paused");

  const [credit] = creditPda(c.txHash, pid);
  if (await conn.getAccountInfo(credit)) throw new Error(`deposit already credited (Credit ${credit.toBase58()})`);
  if (ADMIN_CREDITED_DEPOSITS.has(txHash) && !flags.force) {
    throw new Error("this deposit was already credited by the admin (credit_solver); crediting it again double-counts (use --force)");
  }

  // Under the mock forwarder anyone can forge a Recorded claim, so the program
  // wants the admin's signature too; the admin vouches for the deposit.
  const wcfg = await conn.getAccountInfo(witnessConfigPda(cfg.witnessProgram)[0]);
  if (!wcfg) throw new Error("soda_witness Config not found");
  const admin = witnessTrusted(wcfg.data) ? undefined : adminKeypair();
  const payer = solverKp();
  console.log(`payer       ${payer.publicKey.toBase58()} (Credit ${credit.toBase58()})`);
  if (admin) console.log(`admin       ${admin.publicKey.toBase58()} co-signs (witness is not on a pinned production forwarder)`);
  await send(
    payer,
    creditSolverFromClaimIx(program(payer), payer.publicKey, authority, claimKey, c.txHash, {
      admin: admin?.publicKey,
      witnessProgram: cfg.witnessProgram,
    }),
    undefined,
    admin ? [admin] : undefined,
  );
  const after = await fetchSolver(conn, authority, pid);
  if (after) console.log(`ledger      ${formatEth(after.balanceWei)} ETH`);
}

// ---------------------------------------------------------------- solver

async function cmdRegisterSolver() {
  const kp = solverKp();
  // Both default to the BOT_ID wallet: it funds the pool and receives withdrawals.
  const bk = botPrivateKey();
  const botAddr = bk ? evmAddressOf(bk) : undefined;
  const payout = str("payout") ? parseEvmAddress(str("payout")!) : botAddr;
  const depositFrom = str("deposit-from") ? parseEvmAddress(str("deposit-from")!) : (botAddr ?? payout);
  if (!payout || !depositFrom) throw new Error("set BOT_ID or pass --payout");
  console.log(`solver      ${kp.publicKey.toBase58()} (PDA ${solverPda(kp.publicKey, pid)[0].toBase58()})`);
  console.log(`payout      ${checksumAddr(payout)}`);
  console.log(`deposit     ${checksumAddr(depositFrom)}`);
  // The program wants deposit_from's own signature, so nobody registers an
  // address they do not control and takes its deposits.
  let proof: Uint8Array;
  if (str("deposit-sig")) {
    proof = Uint8Array.from(Buffer.from(need("deposit-sig").replace(/^0x/, ""), "hex"));
    if (proof.length !== 65) throw new Error("--deposit-sig must be 65 bytes (r || s || v)");
  } else if (bk && botAddr && hexAddr(botAddr) === hexAddr(depositFrom)) {
    proof = signDepositProof(bk, kp.publicKey, pid);
  } else {
    const msg = Buffer.from(depositProofMessage(kp.publicKey, pid)).toString("hex");
    throw new Error(`deposit_from is not BOT_ID's address: personal_sign 0x${msg} with it and pass --deposit-sig`);
  }
  await send(kp, registerSolverIx(program(kp), kp.publicKey, payout, depositFrom, proof));
}

async function cmdWithdraw() {
  const kp = solverKp();
  const solver = await fetchSolver(conn, kp.publicKey, pid);
  if (!solver) throw new Error("solver not registered");
  const amount = parseEther(need("eth"));
  let gas = str("gas-wei") ? BigInt(str("gas-wei")!) : ((await base().getGasPrice()) * 125n) / 100n;
  for (let attempt = 0; attempt < 3; attempt++) {
    const cfg = await requireConfig();
    if (gas > cfg.maxGasPrice) gas = cfg.maxGasPrice;
    if (gas < cfg.minGasPrice) gas = cfg.minGasPrice;
    const { ix, sigRequest } = solverWithdrawIx(program(kp), kp.publicKey, solver.payoutAddr, cfg.nextNonce, amount, gas);
    console.log(`withdraw ${formatEth(amount)} ETH to ${checksumAddr(solver.payoutAddr)} at nonce ${cfg.nextNonce}, gas ${gas} wei`);
    try {
      await send(kp, ix, FILL_COMPUTE_UNITS);
      console.log(`  sig request ${sigRequest.toBase58()}, Withdrawal ${withdrawalPda(cfg.nextNonce, pid)[0].toBase58()}`);
      console.log(`  running solver bots and frontier's relayer broadcast it once signed; if it sticks: bump-withdrawal ${cfg.nextNonce}`);
      return;
    } catch (e) {
      // A stale nonce whose Withdrawal already exists fails in account init, before NonceMoved.
      const stale = e instanceof TxError && (e.errorName === "NonceMoved" || /already in use/.test(e.logs.join("\n")));
      if (stale) continue;
      throw e;
    }
  }
  throw new Error("withdraw: Config.next_nonce kept moving (3 attempts); nothing was signed, retry");
}

async function cmdBumpWithdrawal() {
  const kp = str("admin-keypair") ? adminKeypair() : solverKp();
  const nonce = BigInt(pos(1, "nonce"));
  const key = withdrawalPda(nonce, pid)[0];
  const info = await conn.getAccountInfo(key);
  if (!info) throw new Error(`no Withdrawal at nonce ${nonce}`);
  const w = decodeWithdrawal(info.data);
  const cfg = await requireConfig();
  const now = await clusterTime(conn);
  let gas = str("gas-wei") ? BigInt(str("gas-wei")!) : ((await base().getGasPrice()) * 125n) / 100n;
  const min = minBumpGasPrice(w.gasPrice) + 1n;
  if (gas < min) gas = min;
  if (gas < cfg.minGasPrice) gas = cfg.minGasPrice;
  if (gas > cfg.maxGasPrice) throw new Error(`bump to ${gas} wei is over max_gas_price ${cfg.maxGasPrice}; admin: set-max-gas`);
  // Once all four slots are taken, offer the requests that expired unsigned for reuse.
  const srs = await fetchSigRequests(conn, w.sigRequests.slice(0, w.sigRequestCount));
  const reuse = w.sigRequests.filter((_, i) => srs[i] && !srs[i]!.completed && srs[i]!.expiresAt + 60n < now);
  console.log(`withdrawal ${key.toBase58()} nonce ${nonce}: ${w.gasPrice} → ${gas} wei (${w.sigRequestCount} signatures)`);
  const { ix } = bumpWithdrawalGasIx(program(kp), kp.publicKey, w, gas, reuse);
  await send(kp, ix, FILL_COMPUTE_UNITS);
}

async function cmdDeposit() {
  const key = botKey();
  const cfg = await fetchConfig(conn, pid);
  const to = str("to") ? parseEvmAddress(str("to")!) : (cfg?.poolEvmAddr ?? poolEvmAddress(GROUP_PK, pid));
  const value = parseEther(need("eth"));
  const rpc = base();
  const plan = await planDeposit(rpc, key, to, value);
  const fee = plan.gasPrice * plan.gasLimit;
  console.log(`from        ${checksumAddr(plan.from)} (balance ${formatEth(plan.fromBalanceWei)} ETH)`);
  console.log(`to          ${checksumAddr(plan.to)}${str("to") ? "" : " (intents pool)"}`);
  console.log(`value       ${formatEth(value)} ETH (${value} wei)`);
  console.log(`nonce       ${plan.nonce}`);
  console.log(`gas         ${plan.gasLimit} @ ${plan.gasPrice} wei (L2 fee ≤ ${formatEth(fee, 9)} ETH, plus L1 data fee)`);
  console.log(`chain       84532 (Base Sepolia)`);
  console.log(`tx hash     ${plan.signed.txHash}`);
  if (plan.fromBalanceWei < value + fee) throw new Error("BOT_ID wallet balance does not cover value + gas");
  if (!flags.yes) {
    console.log("\nDRY RUN: nothing sent. Re-run with --yes to broadcast.");
    return;
  }
  await rpc.sendRawTransaction(plan.signed.rawHex);
  console.log(`sent ${basescanTx(plan.signed.txHash)}`);
  for (let i = 0; i < 60; i++) {
    const r = await getReceipt(rpc, plan.signed.txHash);
    if (r) {
      console.log(`mined in block ${r.blockNumber}, status ${r.status}`);
      console.log(`next (witness): npx tsx scripts/witness-cli.ts open-claim ${plan.signed.txHash} --solver-key`);
      console.log("  then cre workflow simulate … --broadcast, then credit-from-claim --claim <claim>");
      console.log(`or (admin): credit-solver --solver <solver pubkey> --tx ${plan.signed.txHash}`);
      return;
    }
    await sleep(2_000);
  }
  console.log("not mined after 120 s; check Basescan");
}

// ---------------------------------------------------------------- user

async function bestQuote(inLamports: bigint): Promise<bigint> {
  const urls = (str("quote-url") ?? envStr("SOLVER_URLS", "http://localhost:8080")!)
    .split(",")
    .map((u) => u.trim().replace(/\/$/, ""))
    .filter(Boolean);
  let best = 0n;
  for (const u of urls) {
    try {
      const r = await fetch(`${u}/quote?inLamports=${inLamports}`, { signal: AbortSignal.timeout(5_000) });
      const body = (await r.json()) as { outWei?: string; error?: string; solver?: string };
      if (!r.ok || !body.outWei) {
        console.log(`  quote ${u}: ${body.error ?? r.status}`);
        continue;
      }
      console.log(`  quote ${u}: ${formatEth(BigInt(body.outWei))} ETH (solver ${body.solver})`);
      if (BigInt(body.outWei) > best) best = BigInt(body.outWei);
    } catch (e) {
      console.log(`  quote ${u}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (best === 0n) throw new Error("no solver quote; pass --start-eth or --quote-url");
  return best;
}

async function openIntent(): Promise<{ intent: PublicKey; sig: string; sentAt: number; confirmedAt: number }> {
  const user = userKeypair();
  const cfg = await requireConfig();
  if (cfg.paused) throw new Error("intents program is paused");
  const inLamports = parseSol(need("sol"));
  const presetId = (str("preset") ?? "fair") as SpeedPresetId;
  if (!SPEED_PRESETS[presetId]) throw new Error("--preset must be fast, fair or auction");
  const recipient = str("recipient") ? parseEvmAddress(str("recipient")!) : walletEvmAddress(user.publicKey);

  if (!flags["no-code-check"]) {
    if (!(await isPlainAddress(base(), recipient))) {
      throw new Error(`recipient ${checksumAddr(recipient)} has code; a 21000-gas payout to it would revert`);
    }
  }

  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(INTENT_SIZE));
  const balance = BigInt(await conn.getBalance(user.publicKey));
  if (balance < inLamports + rent + 10_000n) {
    throw new Error(`balance ${Number(balance) / LAMPORTS_PER_SOL} SOL < ${Number(inLamports + rent) / LAMPORTS_PER_SOL} SOL + fees`);
  }

  const start = str("start-eth") ? parseEther(str("start-eth")!) : await bestQuote(inLamports);
  const now = await clusterTime(conn);
  const p = presetParams(presetId, start, now);
  const minOut = str("min-eth") ? parseEther(str("min-eth")!) : p.minOutWei;
  if (minOut > start || minOut === 0n) throw new Error("need 0 < min out <= start out");
  const intentId = BigInt(Date.now());
  const [intent] = intentPda(user.publicKey, intentId, pid);

  console.log(`user        ${user.publicKey.toBase58()}`);
  console.log(`sell        ${Number(inLamports) / LAMPORTS_PER_SOL} SOL (+ ${Number(rent) / LAMPORTS_PER_SOL} SOL rent, returned on close)`);
  console.log(`receive     ${formatEth(start)} → ${formatEth(minOut)} ETH over ${p.auctionDuration}s (${presetId})`);
  console.log(`recipient   ${checksumAddr(recipient)}${str("recipient") ? "" : " (your SODA-derived Base address)"}`);
  console.log(`intent      ${intent.toBase58()}`);
  const sentAt = Date.now();
  const sig = await send(
    user,
    openIntentIx(program(user), user.publicKey, {
      intentId,
      inLamports,
      recipient,
      startOutWei: start,
      minOutWei: minOut,
      auctionDuration: p.auctionDuration,
      expiresAt: p.expiresAt,
    }),
  );
  return { intent, sig, sentAt, confirmedAt: Date.now() };
}

async function cmdOpenIntent() {
  const { intent } = await openIntent();
  console.log(`\nfollow it:  npx tsx scripts/intents-cli.ts status ${intent.toBase58()}`);
}

async function cmdCancel() {
  const user = userKeypair();
  const intent = parseKey(pos(1, "intent"), "intent");
  await send(user, cancelIntentIx(program(user), user.publicKey, intent));
}

async function cmdClose() {
  const intent = parseKey(pos(1, "intent"), "intent");
  if (flags.admin) {
    // A Filled intent: check its payout on Basescan first, since this deletes its bump state.
    const it = await fetchIntent(conn, intent);
    if (!it) throw new Error("intent not found");
    const admin = adminKeypair();
    await send(admin, closeIntentIx(program(admin), admin.publicKey, it.user, intent));
    return;
  }
  const user = userKeypair();
  await send(user, closeIntentIx(program(user), user.publicKey, user.publicKey, intent));
}

// ---------------------------------------------------------------- status

let histCache: { key: string; hist: Awaited<ReturnType<typeof intentHistory>> } | null = null;

async function computeStatus(intentKey: PublicKey, refs: Partial<Record<StepId, StepRef>> = {}): Promise<StatusResult | null> {
  const intent = await fetchIntent(conn, intentKey);
  if (!intent) return null;
  // The history only changes on fill, bump or cancel, so reuse it while those are unchanged.
  const histKey = `${intentKey.toBase58()}:${intent.status}:${intent.sigRequestCount}`;
  if (histCache?.key !== histKey) histCache = { key: histKey, hist: await intentHistory(conn, intentKey, pid) };
  const hist = histCache.hist;
  const [srs, now] = await Promise.all([fetchIntentSigRequests(conn, intent), clusterTime(conn)]);
  const candidates =
    intent.status === IntentStatus.Filled
      ? buildCandidates(intent, srs, {
          gasPriceHints: hist.gasPriceHints,
          unsignedBySigRequest: hist.unsignedBySigRequest,
          programId: pid,
        })
      : [];
  const receipts = new Map<string, EthReceipt | null>();
  const rpc = maybeBase();
  if (rpc) {
    for (const c of candidates) if (c.signed) receipts.set(c.signed.txHash, await getReceipt(rpc, c.signed.txHash));
  }
  return intentStatus({ intent, sigRequests: srs, receipts, now, candidates, refs: { ...hist.refs, ...refs } });
}

function link(chain: "solana" | "base", h?: string): string {
  if (!h) return "";
  return chain === "base" ? basescanTx(h) : solanaExplorerTx(h);
}

function printStatus(r: StatusResult) {
  console.log(`status: ${r.status}${r.speedingUp ? " (gas bumped)" : ""}`);
  for (const s of r.steps) {
    const mark = { done: "[x]", active: "[>]", todo: "[ ]", failed: "[!]" }[s.state];
    const when = s.elapsedMs !== undefined ? ` (+${s.elapsedMs} ms)` : "";
    console.log(`  ${mark} ${s.id.padEnd(9)} ${s.label}${when} ${link(s.chain, s.txHash)}`);
  }
  if (r.requiredOutWei !== undefined) console.log(`  required now ${formatEth(r.requiredOutWei)} ETH, auction ends in ${r.auctionEndsIn}s, expires in ${r.expiresIn}s`);
  for (const c of r.candidates) {
    console.log(`  payout #${c.index} sig_request ${c.sigRequest.toBase58()} gas ${c.gasPrice ?? "?"} ${c.completed ? "signed" : "unsigned"} ${c.signed ? basescanTx(c.signed.txHash) : ""}`);
  }
}

async function cmdStatus() {
  const r = await computeStatus(parseKey(pos(1, "intent"), "intent"));
  if (!r) throw new Error("intent not found (closed, or wrong address)");
  printStatus(r);
}

async function cmdTrade() {
  const timeoutMs = Number(str("timeout") ?? "300") * 1000;
  const { intent, sig, sentAt, confirmedAt } = await openIntent();
  console.log(`\nopen_intent confirmed in ${confirmedAt - sentAt} ms`);
  const seen = new Map<string, number>();
  let last = confirmedAt;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await computeStatus(intent, { open: { txHash: sig, timestamp: sentAt } });
    if (!r) throw new Error("intent disappeared");
    for (const s of r.steps) {
      const key = `${s.id}:${s.state}`;
      if (s.state === "todo" || seen.has(key)) continue;
      const t = Date.now();
      seen.set(key, t);
      if (s.state === "done" && seen.has(`${s.id}:active`)) continue;
      console.log(`  ${s.state === "active" ? "→" : "✓"} ${s.id.padEnd(9)} +${t - last} ms (${t - sentAt} ms total) ${s.label} ${link(s.chain, s.txHash)}`);
      last = t;
    }
    if (r.status === "completed" || r.status === "reverted") {
      console.log(`\n${r.status.toUpperCase()} in ${Date.now() - sentAt} ms. surplus over minimum: ${formatEth(r.surplusWei ?? 0n)} ETH`);
      if (r.delivered) console.log(`Base payout ${basescanTx(r.delivered.txHash)}`);
      return;
    }
    if (r.status === "expired") {
      console.log(`\nexpired unfilled. Refund: npx tsx scripts/intents-cli.ts cancel ${intent.toBase58()}`);
      return;
    }
    if (r.status === "cancelled") return;
    await sleep(1_000);
  }
  console.log(`\ntimed out; follow with: npx tsx scripts/intents-cli.ts status ${intent.toBase58()}`);
}

// ---------------------------------------------------------------- balances

async function cmdBalances() {
  const cfg = await requireConfig();
  const derived = poolEvmAddress(GROUP_PK, pid);
  console.log(`program       ${pid.toBase58()}  ${solanaExplorerAddress(pid.toBase58())}`);
  console.log(`config        ${configPda(pid)[0].toBase58()} admin ${cfg.admin.toBase58()}${cfg.paused ? " PAUSED" : ""}`);
  console.log(`next nonce    ${cfg.nextNonce}, gas ${cfg.minGasPrice}..${cfg.maxGasPrice} wei, l1 buffer ${formatEth(cfg.l1FeeBufferWei, 8)} ETH`);
  console.log(`pool          ${poolPda(pid)[0].toBase58()} → ${checksumAddr(cfg.poolEvmAddr)} ${basescanAddress(hexAddr(cfg.poolEvmAddr))}`);
  if (hexAddr(derived) !== hexAddr(cfg.poolEvmAddr)) console.log(`  WARNING: derived pool address is ${hexAddr(derived)}`);

  const rpc = maybeBase();
  let poolBal: bigint | null = null;
  if (rpc) {
    const poolHex = hexAddr(cfg.poolEvmAddr);
    poolBal = await rpc.getBalance(poolHex);
    const mined = BigInt(await rpc.call<string>("eth_getTransactionCount", [poolHex, "latest"]));
    const pending = await rpc.getNonce(poolHex);
    console.log(`pool on Base  ${formatEth(poolBal)} ETH, nonce mined ${mined}, pending ${pending}, program next ${cfg.nextNonce}`);
    const bk = botPrivateKey();
    if (bk) {
      const a = hexAddr(evmAddressOf(bk));
      console.log(`BOT_ID wallet ${checksumAddr(a)} ${formatEth(await rpc.getBalance(a))} ETH`);
    }
  }

  const solvers = await conn.getProgramAccounts(pid, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator("Solver")) } }],
  });
  let total = 0n;
  console.log(`\nsolvers (${solvers.length}):`);
  for (const { account } of solvers) {
    const s = decodeSolver(account.data);
    total += s.balanceWei;
    console.log(`  ${s.authority.toBase58()} ledger ${formatEth(s.balanceWei)} ETH, fills ${s.fills}, payout ${checksumAddr(s.payoutAddr)}`);
  }
  console.log(`  total ledger ${formatEth(total)} ETH${poolBal !== null ? `; pool minus ledger ${formatEth(poolBal - total)} ETH` : ""}`);

  const open = await fetchOpenIntents(conn, pid);
  const escrow = open.reduce((a, r) => a + r.account.inLamports, 0n);
  const filled = await conn.getProgramAccounts(pid, { filters: intentFilters({ status: IntentStatus.Filled }) });
  console.log(`\nopen intents  ${open.length} (${Number(escrow) / LAMPORTS_PER_SOL} SOL in escrow)`);
  console.log(`filled (unclosed) ${filled.length}`);
  for (const { pubkey, account } of filled.slice(-10)) {
    const i = decodeIntent(account.data);
    console.log(`  ${pubkey.toBase58()} nonce ${i.baseNonce} ${formatEth(i.outWei)} ETH → ${hexAddr(i.recipient)} sigs ${i.sigRequestCount}`);
  }
}

function cmdPoolAddress() {
  const [pool, bump] = poolPda(pid);
  console.log(`pool PDA  ${pool.toBase58()} (bump ${bump})`);
  console.log(`pool Base ${checksumAddr(poolEvmAddress(GROUP_PK, pid))}`);
}

// ---------------------------------------------------------------- main

function program(kp: Keypair) {
  return intentsProgram(conn, kp, pid);
}

const commands: Record<string, () => Promise<void> | void> = {
  "init-config": cmdInitConfig,
  "set-paused": cmdSetPaused,
  "set-max-gas": cmdSetMaxGas,
  "set-min-gas": cmdSetMinGas,
  "bump-withdrawal": cmdBumpWithdrawal,
  "credit-solver": cmdCreditSolver,
  "credit-from-claim": cmdCreditFromClaim,
  "register-solver": cmdRegisterSolver,
  withdraw: cmdWithdraw,
  deposit: cmdDeposit,
  "open-intent": cmdOpenIntent,
  trade: cmdTrade,
  cancel: cmdCancel,
  close: cmdClose,
  status: cmdStatus,
  balances: cmdBalances,
  "pool-address": cmdPoolAddress,
};

async function main() {
  const cmd = positionals[0];
  if (!cmd || flags.help || cmd === "help") {
    console.log(HELP);
    return;
  }
  const fn = commands[cmd];
  if (!fn) throw new Error(`unknown command ${cmd}\n\n${HELP}`);
  await fn();
}

main().catch((e) => {
  if (e instanceof TxError) {
    console.error(`transaction failed${e.errorName ? ` (${e.errorName})` : ""}: ${e.message}`);
    for (const l of e.logs.slice(-12)) console.error(`  ${l}`);
  } else {
    console.error(e instanceof Error ? e.message : e);
  }
  process.exit(1);
});
