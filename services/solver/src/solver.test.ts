// The solver loop against an in-memory fake Connection: re-anchor, quote, the
// fill path (decision, nonce retry, lost race) and delivery. Intents are found
// the way the bot finds them on Alchemy: program signatures, transaction logs and
// getMultipleAccountsInfo (getProgramAccounts throws). No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SendTransactionError,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  type Connection,
} from "@solana/web3.js";
import {
  DEFAULT_INTENTS_PROGRAM_ID,
  configPda,
  intentPda,
  intentsCoders,
  payoutSigRequest,
  requiredOut,
  solverPda,
  withdrawalPda,
} from "../../../lib/intents";
import { encodeSigRequest, fakeSigRequest } from "../../../lib/intents/testutil";
import type { EthRpc } from "../../../lib/soda";
import { connection, intentsProgram } from "./chain";
import { ETH_USD_FEED_ID, ETH_USD_PRICE_ACCOUNT, SOL_USD_FEED_ID, SOL_USD_PRICE_ACCOUNT } from "./pyth";
import { Solver, type SolverSettings } from "./solver";
import { ProgramWatcher } from "./watcher";
import { encodeEvent, encodePriceUpdateV2, FakeProgramHistory, programLogs } from "./testutil";

const PID = new PublicKey(DEFAULT_INTENTS_PROGRAM_ID);
const NOW = 1_760_000_000n;
const ONE_ETH = 10n ** 18n;
const bn = (v: bigint) => new BN(v.toString());

async function encode(name: string, fields: Record<string, unknown>): Promise<Buffer> {
  return intentsCoders().accounts.encode(name, fields);
}

function clockData(unix: bigint): Buffer {
  const b = Buffer.alloc(40);
  b.writeBigInt64LE(unix, 32);
  return b;
}

const configFields = (nextNonce: bigint, over: Record<string, unknown> = {}) => ({
  admin: Keypair.generate().publicKey,
  pool_bump: 254,
  pool_evm_addr: new Array(20).fill(1),
  next_nonce: bn(nextNonce),
  max_gas_price: bn(1_000_000_000n),
  l1_fee_buffer_wei: bn(20_000_000_000_000n),
  paused: false,
  witness_program: PublicKey.default,
  min_gas_price: bn(1_000n),
  ...over,
});

type Sent = { tx: Transaction };
type SendBehaviour = "ok" | { logs: string[]; effect?: () => void };

class FakeConnection extends FakeProgramHistory {
  accounts = new Map<string, Buffer>();
  sent: Sent[] = [];
  behaviours: SendBehaviour[] = [];

  async getMultipleAccountsInfo(keys: PublicKey[]) {
    return keys.map((k) => this.getInfo(k));
  }
  async getAccountInfo(k: PublicKey) {
    return this.getInfo(k);
  }
  private getInfo(k: PublicKey) {
    const data = this.accounts.get(k.toBase58());
    return data ? { data, owner: PID, lamports: 1, executable: false } : null;
  }
  gpaCalls = 0;
  async getProgramAccounts(): Promise<never> {
    this.gpaCalls++;
    throw new Error("getProgramAccounts is not available on this RPC (Alchemy free tier)");
  }
  async getLatestBlockhash() {
    return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 };
  }
  async sendRawTransaction(raw: Buffer) {
    const tx = Transaction.from(raw);
    this.sent.push({ tx });
    const b = this.behaviours.shift() ?? "ok";
    if (b !== "ok") {
      b.effect?.();
      throw new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "sim failed", logs: b.logs });
    }
    return "5ig" + this.sent.length;
  }
  async getSignatureStatuses() {
    return { value: [{ err: null, confirmationStatus: "confirmed" }] };
  }
  async getBlockHeight() {
    return 0;
  }
  subscriptions = 0;
  onLogs() {
    this.subscriptions++;
    return 1;
  }
  async removeOnLogsListener() {}
}

const settings: SolverSettings = {
  programId: PID,
  spreadBps: 30n,
  depthMult: 10n,
  priceMaxAgeSec: 3_600n,
  tickMs: 20,
  pollMs: 60_000,
  deliverMs: 60_000,
  anchorMs: 60_000,
  clockSkewSec: 5n,
  priorityMicroLamports: 0,
  gasMarginBps: 2_500n,
  gasFloorWei: 1_000_000n,
  bumpExtraBps: 1_000n,
  selfBumpAfterMs: 30_000,
  otherBumpAfterMs: 60_000,
  includeSigRent: true,
  checkRecipientCode: true,
};

type Filled = { gasPrice: bigint; sigRequest: PublicKey; completed: boolean; solverIsMe: boolean; payload: Uint8Array };

async function setup(opts: {
  startOut: bigint;
  minOut: bigint;
  nonce?: bigint;
  config?: Record<string, unknown>;
  filled?: Omit<Filled, "sigRequest" | "payload">;
  base?: EthRpc;
  settings?: Partial<SolverSettings>;
  ws?: boolean;
}) {
  const fake = new FakeConnection();
  const kp = Keypair.generate();
  const user = Keypair.generate().publicKey;
  const [intentKey] = intentPda(user, 1n, PID);
  const recipient = new Uint8Array(20).fill(0xab);

  fake.accounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), clockData(NOW));
  fake.accounts.set(configPda(PID)[0].toBase58(), await encode("Config", configFields(opts.nonce ?? 4n, opts.config)));
  fake.accounts.set(
    solverPda(kp.publicKey, PID)[0].toBase58(),
    await encode("Solver", {
      authority: kp.publicKey,
      payout_addr: new Array(20).fill(2),
      deposit_from: new Array(20).fill(2),
      balance_wei: bn(ONE_ETH),
      fills: bn(0n),
      bump: 255,
    }),
  );
  const pyth = (feedId: string, price: bigint) =>
    Buffer.from(encodePriceUpdateV2({ feedId, price, expo: -8, publishTime: NOW - 10n }));
  fake.accounts.set(SOL_USD_PRICE_ACCOUNT.toBase58(), pyth(SOL_USD_FEED_ID, 150n * 10n ** 8n));
  fake.accounts.set(ETH_USD_PRICE_ACCOUNT.toBase58(), pyth(ETH_USD_FEED_ID, 3000n * 10n ** 8n));

  let filled: Filled | undefined;
  const outWei = 47_000_000_000_000_000n;
  if (opts.filled) {
    const { sigRequest, payload } = payoutSigRequest({ recipient, outWei, baseNonce: 4n, gasPrice: opts.filled.gasPrice }, PID);
    filled = { ...opts.filled, sigRequest, payload };
    const sr = fakeSigRequest(payload, { completed: opts.filled.completed, expiresAt: NOW + 200n });
    fake.accounts.set(sigRequest.toBase58(), Buffer.from(encodeSigRequest(sr)));
  }
  const intent = {
    user,
    intent_id: bn(1n),
    in_lamports: bn(10n ** 9n),
    recipient: Array.from(recipient),
    start_out_wei: bn(opts.startOut),
    min_out_wei: bn(opts.minOut),
    auction_start: bn(NOW - 30n),
    auction_duration: 60,
    expires_at: bn(NOW + 90n),
    status: filled ? 1 : 0,
    solver: filled ? (filled.solverIsMe ? kp.publicKey : Keypair.generate().publicKey) : PublicKey.default,
    out_wei: bn(filled ? outWei : 0n),
    base_nonce: bn(filled ? 4n : 0n),
    gas_price: bn(filled?.gasPrice ?? 0n),
    filled_at: bn(filled ? NOW - 120n : 0n),
    sig_requests: [filled?.sigRequest ?? PublicKey.default, PublicKey.default, PublicKey.default, PublicKey.default],
    sig_request_count: filled ? 1 : 0,
    bump: 255,
  };
  fake.accounts.set(intentKey.toBase58(), await encode("Intent", intent));
  // The transaction that announced it, for the watcher's backfill.
  const ev = filled
    ? await encodeEvent("IntentFilled", {
        intent: intentKey,
        user,
        solver: intent.solver,
        in_lamports: intent.in_lamports,
        out_wei: intent.out_wei,
        base_nonce: intent.base_nonce,
        gas_price: intent.gas_price,
        sig_request: filled.sigRequest,
        filled_at: intent.filled_at,
      })
    : await encodeEvent("IntentOpened", {
        intent: intentKey,
        user,
        intent_id: intent.intent_id,
        in_lamports: intent.in_lamports,
        recipient: intent.recipient,
        start_out_wei: intent.start_out_wei,
        min_out_wei: intent.min_out_wei,
        auction_start: intent.auction_start,
        auction_duration: intent.auction_duration,
        expires_at: intent.expires_at,
      });
  fake.push(programLogs(PID, [ev]));

  const conn = fake as unknown as Connection;
  const program = intentsProgram(connection("http://127.0.0.1:9"), kp, PID);
  const bot = new Solver(conn, opts.ws ? conn : null, program, kp, opts.base ?? null, { ...settings, ...opts.settings });
  return { fake, bot, kp, intentKey, recipient, filled };
}

async function until(cond: () => boolean, ms = 2_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fillArgs(tx: Transaction) {
  const ix = tx.instructions.find((i) => i.programId.equals(PID))!;
  const d = Buffer.from(ix.data);
  return {
    nonce: d.readBigUInt64LE(8),
    outWei: d.readBigUInt64LE(16) + (d.readBigUInt64LE(24) << 64n),
    gasPrice: d.readBigUInt64LE(32),
    sigRequest: ix.keys[5].pubkey,
  };
}

test("quote and health after re-anchoring to Pyth", async () => {
  const { bot, kp } = await setup({ startOut: 10n ** 17n, minOut: 9n * 10n ** 16n });
  await bot.start();
  await bot.stop();
  const q = bot.quote(10n ** 9n);
  assert.ok(!("error" in q));
  // 1 SOL ≈ 0.05 ETH, less 30 bps, sig rent and gas: a bit under 0.0497.
  assert.ok(q.outWei < 49_700_000_000_000_000n && q.outWei > 49_000_000_000_000_000n, `${q.outWei}`);
  assert.ok(q.minOutWei < q.outWei);
  const h = bot.health();
  assert.equal(h.solver, kp.publicKey.toBase58());
  assert.equal(h.ethPerSol, "0.05");
  assert.equal(h.ok, true);
});

test("does not fill while required_out is above its curve", async () => {
  const { fake, bot } = await setup({ startOut: 10n ** 17n, minOut: 9n * 10n ** 16n });
  await bot.start();
  await new Promise((r) => setTimeout(r, 100));
  await bot.stop();
  assert.equal(fake.sent.length, 0);
});

test("fills at required_out(cluster time − 5 s) with the config nonce", async () => {
  const start = 50_000_000_000_000_000n;
  const min = 45_000_000_000_000_000n;
  const { fake, bot, recipient } = await setup({ startOut: start, minOut: min, nonce: 4n });
  await bot.start();
  await until(() => fake.sent.length > 0);
  await bot.stop();

  const a = fillArgs(fake.sent[0].tx);
  assert.equal(a.nonce, 4n);
  assert.equal(a.outWei, requiredOut(start, min, NOW - 30n, 60n, NOW - 5n));
  assert.equal(a.gasPrice, 1_000_000n);
  const expected = payoutSigRequest({ recipient, outWei: a.outWei, baseNonce: 4n, gasPrice: a.gasPrice }, PID);
  assert.ok(a.sigRequest.equals(expected.sigRequest));
  assert.equal(fake.sent.length, 1);
});

test("NonceMoved re-reads Config and retries at the new nonce", async () => {
  const { fake, bot } = await setup({ startOut: 50_000_000_000_000_000n, minOut: 45_000_000_000_000_000n, nonce: 4n });
  const moved = await encode("Config", configFields(5n));
  fake.behaviours.push({
    logs: [
      `Program ${PID.toBase58()} invoke [1]`,
      "Program log: AnchorError occurred. Error Code: NonceMoved. Error Number: 6006. Error Message: nonce moved.",
    ],
    // Another solver took nonce 4 just before us.
    effect: () => fake.accounts.set(configPda(PID)[0].toBase58(), moved),
  });
  await bot.start();
  await until(() => fake.sent.length > 1);
  await bot.stop();
  assert.equal(fillArgs(fake.sent[0].tx).nonce, 4n);
  assert.equal(fillArgs(fake.sent[1].tx).nonce, 5n);
});

test("IntentNotOpen means the race is lost: no retry", async () => {
  const { fake, bot } = await setup({ startOut: 50_000_000_000_000_000n, minOut: 45_000_000_000_000_000n });
  fake.behaviours.push({ logs: ["Program log: AnchorError occurred. Error Code: IntentNotOpen. Error Number: 6001."] });
  await bot.start();
  await until(() => fake.sent.length > 0);
  await new Promise((r) => setTimeout(r, 100));
  await bot.stop();
  assert.equal(fake.sent.length, 1);
  assert.equal(bot.health().openIntents, 0);
});

class FakeBase {
  sent: string[] = [];
  receipts = new Map<string, unknown>();
  gasPrice = 800_000n;
  codeError = false;
  codeChecks = 0;
  async call(method: string, params: unknown[]) {
    if (method === "eth_getTransactionCount") return "0x4"; // nonce 4 is the head of the queue
    if (method === "eth_getTransactionReceipt") return this.receipts.get(params[0] as string) ?? null;
    if (method === "eth_getCode") {
      this.codeChecks++;
      if (this.codeError) throw new Error("eth_getCode: 429 Too Many Requests");
      return "0x";
    }
    throw new Error(`unexpected ${method}`);
  }
  async getGasPrice() {
    return this.gasPrice;
  }
  async sendRawTransaction(hex: string) {
    this.sent.push(hex);
    return "0x";
  }
}

test("delivery: broadcasts a signed payout, then bumps gas once it counts as stuck", async () => {
  const base = new FakeBase();
  const { fake, bot, filled } = await setup({
    startOut: 10n ** 17n,
    minOut: 9n * 10n ** 16n,
    filled: { gasPrice: 1_000_000n, completed: true, solverIsMe: true },
    base: base as unknown as EthRpc,
    settings: { deliverMs: 20, selfBumpAfterMs: 0 },
  });
  await bot.start();
  await until(() => fake.sent.length > 0);
  await bot.stop();
  assert.ok(base.sent.length >= 1, "rebroadcast the signed payout");

  const ix = fake.sent[0].tx.instructions.find((i) => i.programId.equals(PID))!;
  const d = Buffer.from(ix.data);
  const newGas = d.readBigUInt64LE(8);
  // max(old · 1.2, market 800k · 1.25) and at least the program's +10%.
  assert.equal(newGas, 1_200_000n);
  const expected = payoutSigRequest(
    { recipient: new Uint8Array(20).fill(0xab), outWei: 47_000_000_000_000_000n, baseNonce: 4n, gasPrice: newGas },
    PID,
  );
  assert.ok(ix.keys[5].pubkey.equals(expected.sigRequest));
  assert.ok(!ix.keys[5].pubkey.equals(filled!.sigRequest));
});

test("delivery: a receipt on any candidate means delivered, no bump", async () => {
  const base = new FakeBase();
  const { fake, bot, filled, intentKey } = await setup({
    startOut: 10n ** 17n,
    minOut: 9n * 10n ** 16n,
    filled: { gasPrice: 1_000_000n, completed: true, solverIsMe: true },
    base: base as unknown as EthRpc,
    settings: { deliverMs: 20, selfBumpAfterMs: 0 },
  });
  // Precompute the hash the tracker will look up.
  const { buildCandidates, decodeSigRequest, decodeIntent } = await import("../../../lib/intents");
  const intent = decodeIntent(fake.accounts.get(intentKey.toBase58())!);
  const sr = decodeSigRequest(fake.accounts.get(filled!.sigRequest.toBase58())!);
  const hash = buildCandidates(intent, [sr], { programId: PID })[0].signed!.txHash;
  base.receipts.set(hash, { transactionHash: hash, status: "0x1", blockNumber: "0x10", gasUsed: "0x5208" });

  await bot.start();
  await new Promise((r) => setTimeout(r, 150));
  await bot.stop();
  assert.equal(fake.sent.length, 0);
  assert.equal(base.sent.length, 0);
  assert.equal(bot.health().pendingPayouts, 0);
});

test("delivery: another solver's payout is rebroadcast but not bumped before 60 s pending", async () => {
  const base = new FakeBase();
  const { fake, bot } = await setup({
    startOut: 10n ** 17n,
    minOut: 9n * 10n ** 16n,
    filled: { gasPrice: 1_000_000n, completed: true, solverIsMe: false },
    base: base as unknown as EthRpc,
    settings: { deliverMs: 20, otherBumpAfterMs: 60_000 },
  });
  await bot.start();
  await new Promise((r) => setTimeout(r, 150));
  await bot.stop();
  assert.ok(base.sent.length >= 1, "still rebroadcasts other solvers' payouts");
  assert.equal(fake.sent.length, 0);
});

// ---------------------------------------------------------------- review fixes

type Internals = { reanchor(): Promise<void>; pricer: { anchor: { atMs: number } | null } };
const internals = (bot: Solver) => bot as unknown as Internals;
const FILLABLE = { startOut: 50_000_000_000_000_000n, minOut: 45_000_000_000_000_000n };

test("stale-pyth-anchor: a re-anchor with no usable price stops quoting and filling", async () => {
  const { fake, bot } = await setup(FILLABLE);
  await internals(bot).reanchor();
  assert.ok(!("error" in bot.quote(10n ** 9n)));
  fake.accounts.delete(SOL_USD_PRICE_ACCOUNT.toBase58());
  fake.accounts.delete(ETH_USD_PRICE_ACCOUNT.toBase58());
  await bot.start();
  await new Promise((r) => setTimeout(r, 100));
  await bot.stop();
  assert.deepEqual(bot.quote(10n ** 9n), { error: "no fresh prices or no inventory" });
  assert.equal(bot.health().ok, false);
  assert.equal(fake.sent.length, 0);
});

test("stale-pyth-anchor: an anchor older than 3 re-anchor intervals stops quoting", async () => {
  const { bot } = await setup(FILLABLE);
  await internals(bot).reanchor();
  internals(bot).pricer.anchor!.atMs = Date.now() - 3 * settings.anchorMs - 1_000;
  assert.ok("error" in bot.quote(10n ** 9n));
  assert.equal(bot.health().ok, false);
});

test("fill-at-gas-cap: no fill and no quote while Base gas is above max_gas_price", async () => {
  const base = new FakeBase();
  base.gasPrice = 2_000_000_000n; // max_gas_price is 1 gwei
  const { fake, bot } = await setup({ ...FILLABLE, base: base as unknown as EthRpc });
  await bot.start();
  await new Promise((r) => setTimeout(r, 100));
  await bot.stop();
  assert.equal(fake.sent.length, 0);
  assert.deepEqual(bot.quote(10n ** 9n), { error: "Base gas price is above max_gas_price" });
  assert.equal(bot.health().overCap, true);
});

test("fill-at-gas-cap: only the margin over the cap is clamped; fills at the cap", async () => {
  const base = new FakeBase();
  base.gasPrice = 900_000_000n; // + 25% margin is over the 1 gwei cap, the market is not
  const { fake, bot } = await setup({ ...FILLABLE, base: base as unknown as EthRpc });
  await bot.start();
  await until(() => fake.sent.length > 0);
  await bot.stop();
  assert.equal(fillArgs(fake.sent[0].tx).gasPrice, 1_000_000_000n);
});

test("F5: fills at Config.min_gas_price when the market is below it", async () => {
  const { fake, bot } = await setup({ ...FILLABLE, config: { min_gas_price: bn(5_000_000n) } });
  await bot.start();
  await until(() => fake.sent.length > 0);
  await bot.stop();
  assert.equal(fillArgs(fake.sent[0].tx).gasPrice, 5_000_000n);
});

test("recipient-check-fail-open: an eth_getCode error means no fill yet", async () => {
  const base = new FakeBase();
  base.codeError = true;
  const { fake, bot } = await setup({ ...FILLABLE, base: base as unknown as EthRpc });
  await bot.start();
  await until(() => base.codeChecks > 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fake.sent.length, 0, "fails closed");
  await bot.stop();
});

test("closed-intent-tracking-dropped: a closed intent's signed payout is still rebroadcast", async () => {
  const base = new FakeBase();
  const { fake, bot, intentKey } = await setup({
    startOut: 10n ** 17n,
    minOut: 9n * 10n ** 16n,
    filled: { gasPrice: 1_000_000n, completed: true, solverIsMe: false },
    base: base as unknown as EthRpc,
    settings: { deliverMs: 20 },
  });
  await bot.start();
  await until(() => base.sent.length > 0);
  fake.accounts.delete(intentKey.toBase58()); // the admin closed it before nonce 4 landed
  const before = base.sent.length;
  await until(() => base.sent.length > before + 1);
  await bot.stop();
  assert.equal(bot.health().pendingPayouts, 1);
});

test("withdraw-payouts-not-delivered: the head withdrawal is rebroadcast and bumped with bump_withdrawal_gas", async () => {
  const base = new FakeBase();
  const { fake, bot, kp } = await setup({
    startOut: 10n ** 17n,
    minOut: 9n * 10n ** 16n,
    nonce: 5n,
    base: base as unknown as EthRpc,
    settings: { deliverMs: 20, selfBumpAfterMs: 0 },
  });
  const payoutAddr = new Uint8Array(20).fill(2);
  const amount = 3n * 10n ** 17n;
  const { sigRequest, payload } = payoutSigRequest({ recipient: payoutAddr, outWei: amount, baseNonce: 4n, gasPrice: 1_000_000n }, PID);
  fake.accounts.set(sigRequest.toBase58(), Buffer.from(encodeSigRequest(fakeSigRequest(payload, { expiresAt: NOW + 200n }))));
  const [wKey] = withdrawalPda(4n, PID);
  fake.accounts.set(
    wKey.toBase58(),
    await encode("Withdrawal", {
      solver: kp.publicKey,
      payout_addr: Array.from(payoutAddr),
      amount_wei: bn(amount),
      base_nonce: bn(4n),
      gas_price: bn(1_000_000n),
      created_at: bn(NOW - 120n),
      sig_requests: [sigRequest, PublicKey.default, PublicKey.default, PublicKey.default],
      sig_request_count: 1,
      bump: 255,
    }),
  );
  await bot.start();
  await until(() => fake.sent.length > 0);
  await bot.stop();
  assert.ok(base.sent.length >= 1, "rebroadcast the signed withdrawal");

  const ix = fake.sent[0].tx.instructions.find((i) => i.programId.equals(PID))!;
  const newGas = Buffer.from(ix.data).readBigUInt64LE(8);
  assert.equal(newGas, 1_200_000n);
  assert.ok(ix.keys[3].pubkey.equals(wKey), "bump_withdrawal_gas names the Withdrawal");
  const expected = payoutSigRequest({ recipient: payoutAddr, outWei: amount, baseNonce: 4n, gasPrice: newGas }, PID);
  assert.ok(ix.keys[5].pubkey.equals(expected.sigRequest));
});

test("F2: with all four slots taken, the bot bumps by offering requests that expired unsigned", async () => {
  const base = new FakeBase();
  const { fake, bot, intentKey, recipient } = await setup({
    startOut: 10n ** 17n,
    minOut: 9n * 10n ** 16n,
    filled: { gasPrice: 1_000_000n, completed: false, solverIsMe: true },
    base: base as unknown as EthRpc,
    settings: { deliverMs: 20, selfBumpAfterMs: 0 },
  });
  const outWei = 47_000_000_000_000_000n;
  const prices = [1_000_000n, 1_100_000n, 1_210_000n, 1_331_000n];
  const keys = prices.map((gasPrice) => {
    const { sigRequest, payload } = payoutSigRequest({ recipient, outWei, baseNonce: 4n, gasPrice }, PID);
    // Expired 120 s ago, never signed.
    fake.accounts.set(sigRequest.toBase58(), Buffer.from(encodeSigRequest(fakeSigRequest(payload, { completed: false, expiresAt: NOW - 120n }))));
    return sigRequest;
  });
  const it = intentsCoders().accounts.decode("Intent", fake.accounts.get(intentKey.toBase58())!);
  fake.accounts.set(intentKey.toBase58(), await encode("Intent", {
    ...it,
    gas_price: bn(1_331_000n),
    sig_requests: keys,
    sig_request_count: 4,
  }));
  await bot.start();
  await until(() => fake.sent.length > 0);
  await bot.stop();
  const ix = fake.sent[0].tx.instructions.find((i) => i.programId.equals(PID))!;
  assert.ok(ix.keys[3].pubkey.equals(intentKey));
  const offered = ix.keys.slice(9).map((k) => k.pubkey.toBase58());
  assert.deepEqual(offered, keys.map((k) => k.toBase58()));
  assert.equal(Buffer.from(ix.data).readBigUInt64LE(8), (1_331_000n * 12_000n) / 10_000n);
});

// ---------------------------------------------------------------- discovery without getProgramAccounts

test("watcher: an IntentOpened polled from program signatures is filled; no websocket, no getProgramAccounts", async () => {
  const { fake, bot, kp } = await setup({ startOut: 10n ** 17n, minOut: 9n * 10n ** 16n });
  await bot.start();
  await bot.ready; // backfill done, open intents read
  assert.equal(bot.health().openIntents, 1);
  assert.equal(fake.subscriptions, 0, "SOLANA_WS_URL unset: no logsSubscribe");
  assert.equal(fake.sent.length, 0);

  // A second, fillable intent lands after start.
  const user = Keypair.generate().publicKey;
  const [key] = intentPda(user, 2n, PID);
  const fields = {
    user,
    intent_id: bn(2n),
    in_lamports: bn(10n ** 9n),
    recipient: new Array(20).fill(0xcd),
    start_out_wei: bn(50_000_000_000_000_000n),
    min_out_wei: bn(45_000_000_000_000_000n),
    auction_start: bn(NOW - 30n),
    auction_duration: 60,
    expires_at: bn(NOW + 90n),
  };
  fake.accounts.set(
    key.toBase58(),
    await encode("Intent", {
      ...fields,
      status: 0,
      solver: PublicKey.default,
      out_wei: bn(0n),
      base_nonce: bn(0n),
      gas_price: bn(0n),
      filled_at: bn(0n),
      sig_requests: new Array(4).fill(PublicKey.default),
      sig_request_count: 0,
      bump: 255,
    }),
  );
  fake.push(programLogs(PID, [await encodeEvent("IntentOpened", { intent: key, ...fields })]));
  await bot.watcher.pollOnce(); // what the 1.5 s poll timer does
  await until(() => fake.sent.length > 0);
  await bot.stop();
  const ix = fake.sent[0].tx.instructions.find((i) => i.programId.equals(PID))!;
  assert.ok(ix.keys.some((k) => k.pubkey.equals(key)), "filled the new intent");
  assert.equal(fake.gpaCalls, 0);
  assert.equal(bot.health().solver, kp.publicKey.toBase58());
});

test("watcher: given a websocket connection the bot also subscribes to logs", async () => {
  const { fake, bot } = await setup({ startOut: 10n ** 17n, minOut: 9n * 10n ** 16n, ws: true });
  await bot.start();
  await bot.stop();
  assert.equal(fake.subscriptions, 1);
});

test("watcher: delivery reads filled intents by key, never with getProgramAccounts", async () => {
  const base = new FakeBase();
  const { fake, bot } = await setup({
    startOut: 10n ** 17n,
    minOut: 9n * 10n ** 16n,
    filled: { gasPrice: 1_000_000n, completed: true, solverIsMe: false },
    base: base as unknown as EthRpc,
    settings: { deliverMs: 20 },
  });
  await bot.start();
  await until(() => base.sent.length > 0);
  await bot.stop();
  assert.equal(fake.gpaCalls, 0);
  assert.equal(bot.health().pendingPayouts, 1);
});

test("watcher: after a restart the head payout's fill is older than the backfill; delivery finds it by nonce and rebroadcasts it", async () => {
  const base = new FakeBase();
  const { fake, kp } = await setup({
    startOut: 10n ** 17n,
    minOut: 9n * 10n ** 16n,
    nonce: 5n, // nonce 4 is in flight and is the pool's head (FakeBase mined 4)
    filled: { gasPrice: 1_000_000n, completed: true, solverIsMe: false },
    base: base as unknown as EthRpc,
  });
  // Plenty of program traffic since that fill: it falls outside BACKFILL_SIGS.
  const filler = await encodeEvent("IntentCancelled", { intent: Keypair.generate().publicKey, user: kp.publicKey, refunded_lamports: bn(1n) });
  for (let i = 0; i < 30; i++) fake.push(programLogs(PID, [filler]));
  const conn = fake as unknown as Connection;
  const watcher = new ProgramWatcher(conn, {
    programId: PID,
    watchMs: 20,
    backfillSigs: 5,
    olderPageSize: 10,
    seekGraceMs: 0,
    rewalkMs: 0,
    log: () => {},
  });
  const program = intentsProgram(connection("http://127.0.0.1:9"), kp, PID);
  const bot = new Solver(conn, null, program, kp, base as unknown as EthRpc, { ...settings, deliverMs: 20 }, watcher);
  await bot.start();
  await until(() => base.sent.length > 0, 5_000);
  await bot.stop();
  assert.ok(watcher.knowsNonce(4n));
  assert.ok(watcher.stats.olderSigs > 0, "found by paging past the backfill");
  assert.equal(bot.health().pendingPayouts, 1);
});
