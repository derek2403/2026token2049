// RfqDesk (/rfq/quote, /rfq/execute) against an in-memory Connection: the good
// path down to the transaction it sends, and every refusal before one is sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BN, BorshInstructionCoder } from "@coral-xyz/anchor";
import { ed25519 } from "@noble/curves/ed25519";
import {
  Ed25519Program,
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
  encodeSignedIntent,
  intentPda,
  intentsCoders,
  payoutSigRequest,
  renderIntentMessage,
  rfqExecuteRequest,
  solverPda,
  vaultPda,
  type IntentMessageFields,
} from "../../../lib/intents";
import { connection, intentsProgram } from "./chain";
import { RfqDesk, type RfqDeps, type RfqExecuted, type RfqPrice } from "./rfq";

const PID = new PublicKey(DEFAULT_INTENTS_PROGRAM_ID);
const NOW = 1_760_000_000n;
const ONE_ETH = 10n ** 18n;
const SELL = 100_000_000n;
const OUT = 4_900_000_000_000_000n;
const GAS = 1_200_000n;
const bn = (v: bigint) => new BN(v.toString());
const encode = (name: string, fields: Record<string, unknown>) => intentsCoders().accounts.encode(name, fields);

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
  min_gas_price: bn(1_000_000n),
  ...over,
});

type SendBehaviour = "ok" | { logs: string[]; effect?: () => void };

class FakeConnection {
  accounts = new Map<string, Buffer>();
  sent: Transaction[] = [];
  behaviours: SendBehaviour[] = [];
  /** Sends in flight right now, and the most there ever were. */
  inFlight = 0;
  maxInFlight = 0;
  sendDelayMs = 0;

  async getMultipleAccountsInfo(keys: PublicKey[]) {
    return keys.map((k) => this.info(k));
  }
  async getAccountInfo(k: PublicKey) {
    return this.info(k);
  }
  private info(k: PublicKey) {
    const data = this.accounts.get(k.toBase58());
    return data ? { data, owner: PID, lamports: 1, executable: false } : null;
  }
  async getLatestBlockhash() {
    return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 };
  }
  async sendRawTransaction(raw: Buffer) {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.sendDelayMs) await new Promise((r) => setTimeout(r, this.sendDelayMs));
      const tx = Transaction.from(raw);
      this.sent.push(tx);
      const b = this.behaviours.shift() ?? "ok";
      if (b !== "ok") {
        b.effect?.();
        throw new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "sim failed", logs: b.logs });
      }
      return "5ig" + this.sent.length;
    } finally {
      this.inFlight--;
    }
  }
  async getSignatureStatuses() {
    return { value: [{ err: null, confirmationStatus: "confirmed" }] };
  }
  async getBlockHeight() {
    return 0;
  }
  async getTransaction() {
    return null;
  }
}

async function setup(opts: { vaultSol?: bigint | null; nonce?: bigint; ledger?: bigint; price?: RfqPrice; config?: Record<string, unknown> } = {}) {
  const fake = new FakeConnection();
  const solverKp = Keypair.generate();
  const userKp = Keypair.generate();
  const user = userKp.publicKey;
  fake.accounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), clockData(NOW));
  fake.accounts.set(configPda(PID)[0].toBase58(), await encode("Config", configFields(opts.nonce ?? 5n, opts.config)));
  fake.accounts.set(
    solverPda(solverKp.publicKey, PID)[0].toBase58(),
    await encode("Solver", {
      authority: solverKp.publicKey,
      payout_addr: new Array(20).fill(2),
      deposit_from: new Array(20).fill(2),
      balance_wei: bn(opts.ledger ?? ONE_ETH),
      fills: bn(0n),
      bump: 255,
    }),
  );
  if (opts.vaultSol !== null) {
    fake.accounts.set(
      vaultPda(user, PID)[0].toBase58(),
      await encode("UserVault", { owner: user, sol: bn(opts.vaultSol ?? 10n ** 9n), bump: 254 }),
    );
  }
  let clock = 1_000_000;
  const executed: RfqExecuted[] = [];
  const logs: string[] = [];
  const deps: RfqDeps = {
    conn: fake as unknown as Connection,
    program: intentsProgram(connection("http://127.0.0.1:9"), solverKp, PID),
    keypair: solverKp,
    programId: PID,
    price: () => opts.price ?? { outWei: OUT, breakEvenWei: OUT + 10n ** 14n, gasPrice: GAS },
    recipientOk: async () => true,
    onExecuted: (e) => executed.push(e),
    now: () => clock,
    log: (m) => logs.push(m),
  };
  const desk = new RfqDesk(deps);
  const advance = (ms: number) => {
    clock += ms;
  };
  return { fake, desk, solverKp, userKp, user, executed, logs, advance };
}

const RECIPIENT = new Uint8Array(20).fill(0xab);

function fields(user: PublicKey, over: Partial<IntentMessageFields> = {}): IntentMessageFields {
  return { user, nonce: 1_759_830_000_123n, deadline: NOW + 120n, sellLamports: SELL, minOutWei: OUT, recipient: RECIPIENT, ...over };
}

/** The request the relay forwards: the user's signature over the rendered message. */
function signedRequest(quoteId: string, f: IntentMessageFields, signer: Keypair) {
  const message = renderIntentMessage(f, PID);
  const sig = ed25519.sign(message, signer.secretKey.slice(0, 32));
  return rfqExecuteRequest(quoteId, f, encodeSignedIntent(message, sig, f.user));
}

async function quoted(desk: RfqDesk, id = "q1", amount = SELL) {
  const r = await desk.quote({ quote_id: id, exact_amount_in: amount.toString() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { quote_id: string; solver: string; amount_out: string; expiration_time: number };
}

const code = (r: { body: unknown }) => (r.body as { code: string }).code;

function executeArgs(tx: Transaction) {
  const program = intentsProgram(connection("http://127.0.0.1:9"), Keypair.generate(), PID);
  const ix = tx.instructions.find((i) => i.programId.equals(PID))!;
  const d = (program.coder.instruction as BorshInstructionCoder).decode(Buffer.from(ix.data)) as {
    name: string;
    data: { args: Record<string, unknown> };
  };
  const a = d.data.args;
  const get = (k: string) => a[k] ?? a[k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())];
  const big = (k: string) => BigInt((get(k) as BN).toString());
  return {
    name: d.name,
    keys: ix.keys,
    nonce: big("nonce"),
    outWei: big("out_wei"),
    expectedNonce: big("expected_nonce"),
    gasPrice: big("gas_price"),
    ed25519IxIndex: get("ed25519_ix_index") as number,
  };
}

test("quote: binds a price to the quote_id and amount for the TTL", async () => {
  const { desk, solverKp } = await setup();
  const q = await quoted(desk);
  assert.deepEqual(q, { quote_id: "q1", solver: solverKp.publicKey.toBase58(), amount_out: OUT.toString(), expiration_time: 1_000_000 + 30_000 });
  // The id cannot be rebound to another amount.
  assert.equal(code(await desk.quote({ quote_id: "q1", exact_amount_in: "5" })), "quote_id_taken");
  for (const bad of [
    null,
    [],
    { quote_id: "q2" },
    { quote_id: "q2", exact_amount_in: "0" },
    { quote_id: "q2", exact_amount_in: "01" },
    { quote_id: "q2", exact_amount_in: 5 },
    { quote_id: "q2", exact_amount_in: "18446744073709551616" },
    { quote_id: "", exact_amount_in: "5" },
    { quote_id: "a b", exact_amount_in: "5" },
    { quote_id: "q2", exact_amount_in: "5", recipient: "0x00" },
    { quote_id: "q2", exact_amount_in: "5", recipient: "0x" + "00".repeat(20) },
  ]) {
    assert.equal((await desk.quote(bad)).status, 400, JSON.stringify(bad));
  }
});

test("quote: 503 when pricing refuses", async () => {
  const { desk } = await setup({ price: { error: "no fresh prices or no inventory" } });
  const r = await desk.quote({ quote_id: "q1", exact_amount_in: "5" });
  assert.equal(r.status, 503);
  assert.equal(code(r), "cannot_quote");
});

test("quote: a full store refuses new quotes instead of evicting live ones", async () => {
  const { desk, user, userKp } = await setup();
  await quoted(desk, "first");
  for (let i = 1; i < 10_000; i++) await quoted(desk, `f${i}`);
  const r = await desk.quote({ quote_id: "late", exact_amount_in: SELL.toString() });
  assert.equal(r.status, 503);
  assert.equal(code(r), "busy");
  assert.equal((await desk.execute(signedRequest("first", fields(user), userKp))).status, 200);
});

test("execute: good path sends [ComputeBudget, Ed25519, execute_signed_intent] once", async () => {
  const { fake, desk, user, userKp, solverKp, executed } = await setup({ nonce: 5n });
  await quoted(desk);
  const f = fields(user);
  const r = await desk.execute(signedRequest("q1", f, userKp));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [intent] = intentPda(user, f.nonce, PID);
  assert.deepEqual(r.body, { signature: "5ig1", intent: intent.toBase58(), out_wei: OUT.toString(), base_nonce: "5" });

  assert.equal(fake.sent.length, 1);
  const tx = fake.sent[0];
  assert.ok(tx.feePayer!.equals(solverKp.publicKey));
  assert.equal(tx.instructions.length, 3);
  assert.ok(tx.instructions[1].programId.equals(Ed25519Program.programId));
  const a = executeArgs(tx);
  assert.equal(a.name, "executeSignedIntent");
  // The precompile verifies the user's key over exactly the rendered message.
  const ed = Buffer.from(tx.instructions[1].data);
  assert.ok(ed.subarray(16, 48).equals(user.toBuffer()));
  assert.ok(ed.subarray(112).equals(Buffer.from(renderIntentMessage(f, PID))));
  assert.equal(a.ed25519IxIndex, 1);
  assert.equal(a.nonce, f.nonce);
  assert.equal(a.outWei, OUT);
  assert.equal(a.expectedNonce, 5n);
  assert.equal(a.gasPrice, GAS);
  assert.ok(a.keys[4].pubkey.equals(intent));
  const { sigRequest } = payoutSigRequest({ recipient: RECIPIENT, outWei: OUT, baseNonce: 5n, gasPrice: GAS }, PID);
  assert.ok(a.keys[6].pubkey.equals(sigRequest));

  assert.equal(executed.length, 1);
  assert.ok(executed[0].intent.equals(intent));
  assert.equal(executed[0].baseNonce, 5n);
  assert.equal(executed[0].sellLamports, SELL);

  // A quote settles once.
  assert.equal(code(await desk.execute(signedRequest("q1", f, userKp))), "quote_used");
  assert.equal(fake.sent.length, 1);
});

test("execute: a min_out below the quote is fine; the solver still pays its quote", async () => {
  const { fake, desk, user, userKp } = await setup();
  await quoted(desk);
  const r = await desk.execute(signedRequest("q1", fields(user, { minOutWei: OUT - 1_000n }), userKp));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(executeArgs(fake.sent[0]).outWei, OUT);
});

test("execute: tampered message or fields are refused before any transaction", async () => {
  const { fake, desk, user, userKp } = await setup();
  await quoted(desk);
  const f = fields(user);

  // The message edited after signing (sell 100000000 → 900000000).
  const req = signedRequest("q1", f, userKp);
  const text = Buffer.from(req.message, "base64").toString("utf8").replace("sell: 1", "sell: 9");
  const tampered = { ...req, message: Buffer.from(text).toString("base64") };
  assert.equal(code(await desk.execute(tampered)), "invalid_signed_intent");

  // A validly signed message, but the fields sent alongside it differ.
  assert.equal(code(await desk.execute({ ...req, min_out_wei: (OUT - 1n).toString() })), "message_mismatch");
  assert.equal(code(await desk.execute({ ...req, nonce: "7" })), "message_mismatch");
  assert.equal(code(await desk.execute({ ...req, recipient: "0x" + "cd".repeat(20) })), "message_mismatch");

  // A message for another verifier program.
  const other = Keypair.generate().publicKey;
  const msg = renderIntentMessage(f, other);
  const wire = encodeSignedIntent(msg, ed25519.sign(msg, userKp.secretKey.slice(0, 32)), user);
  assert.equal(code(await desk.execute({ ...req, ...wire })), "invalid_signed_intent");

  assert.equal(code(await desk.execute({ ...req, deadline: "01" })), "bad_request");
  assert.equal(code(await desk.execute({ ...req, signature: undefined })), "bad_request");
  assert.equal(fake.sent.length, 0);
  // Still executable with the real request.
  assert.equal((await desk.execute(req)).status, 200);
});

test("execute: wrong signer is refused", async () => {
  const { fake, desk, user } = await setup();
  await quoted(desk);
  const f = fields(user);
  const mallory = Keypair.generate();
  // Signed by someone else for the user's vault.
  assert.equal(code(await desk.execute(signedRequest("q1", f, mallory))), "invalid_signed_intent");
  // public_key names the real signer, but the message's signer line is the victim.
  const message = renderIntentMessage(f, PID);
  const w = encodeSignedIntent(message, ed25519.sign(message, mallory.secretKey.slice(0, 32)), mallory.publicKey);
  const r = await desk.execute({ ...signedRequest("q1", f, mallory), ...w });
  assert.equal(code(r), "invalid_signed_intent");
  assert.match((r.body as { error: string }).error, /signer line/);
  assert.equal(fake.sent.length, 0);
});

test("execute: unknown and expired quotes", async () => {
  const { fake, desk, user, userKp, advance } = await setup();
  assert.equal(code(await desk.execute(signedRequest("nope", fields(user), userKp))), "unknown_quote");
  await quoted(desk);
  advance(30_001);
  const r = await desk.execute(signedRequest("q1", fields(user), userKp));
  assert.equal(r.status, 410);
  assert.equal(code(r), "quote_expired");
  assert.equal(fake.sent.length, 0);
});

test("execute: min_out above the quote, or another amount, is refused", async () => {
  const { fake, desk, user, userKp } = await setup();
  await quoted(desk);
  assert.equal(code(await desk.execute(signedRequest("q1", fields(user, { minOutWei: OUT + 1n }), userKp))), "min_out_above_quote");
  assert.equal(code(await desk.execute(signedRequest("q1", fields(user, { sellLamports: SELL - 1n }), userKp))), "amount_mismatch");
  assert.equal(fake.sent.length, 0);
});

test("execute: a short or missing vault is refused, and the quote stays usable", async () => {
  const { fake, desk, user, userKp } = await setup({ vaultSol: SELL - 1n });
  await quoted(desk);
  const r = await desk.execute(signedRequest("q1", fields(user), userKp));
  assert.equal(r.status, 409);
  assert.equal(code(r), "vault_short");
  assert.equal((r.body as { vault_lamports: string }).vault_lamports, (SELL - 1n).toString());
  assert.equal(fake.sent.length, 0);
  // The user tops up; the same quote now settles.
  fake.accounts.set(vaultPda(user, PID)[0].toBase58(), await encode("UserVault", { owner: user, sol: bn(SELL), bump: 254 }));
  assert.equal((await desk.execute(signedRequest("q1", fields(user), userKp))).status, 200);

  const none = await setup({ vaultSol: null });
  await quoted(none.desk);
  assert.equal(code(await none.desk.execute(signedRequest("q1", fields(none.user), none.userKp))), "vault_short");
});

test("execute: chain-state refusals (deadline, replay, ledger, price, paused)", async () => {
  const s = await setup();
  await quoted(s.desk, "a");
  assert.equal(code(await s.desk.execute(signedRequest("a", fields(s.user, { deadline: NOW + 4n }), s.userKp))), "deadline_passed");
  assert.equal(code(await s.desk.execute(signedRequest("a", fields(s.user, { deadline: NOW + 601n }), s.userKp))), "deadline_too_far");
  const f = fields(s.user);
  s.fake.accounts.set(intentPda(s.user, f.nonce, PID)[0].toBase58(), Buffer.alloc(8));
  assert.equal(code(await s.desk.execute(signedRequest("a", f, s.userKp))), "already_executed");

  const poor = await setup({ ledger: OUT });
  await quoted(poor.desk);
  assert.equal(code(await poor.desk.execute(signedRequest("q1", fields(poor.user), poor.userKp))), "insufficient_inventory");

  const moved = await setup({ price: { outWei: OUT, breakEvenWei: OUT - 1n, gasPrice: GAS } });
  await quoted(moved.desk);
  assert.equal(code(await moved.desk.execute(signedRequest("q1", fields(moved.user), moved.userKp))), "price_moved");

  const paused = await setup({ config: { paused: true } });
  await quoted(paused.desk);
  assert.equal(code(await paused.desk.execute(signedRequest("q1", fields(paused.user), paused.userKp))), "paused");

  for (const x of [s, poor, moved, paused]) assert.equal(x.fake.sent.length, 0);
});

test("execute: NonceMoved re-reads Config and retries at the new nonce", async () => {
  const { fake, desk, user, userKp } = await setup({ nonce: 5n });
  const moved = await encode("Config", configFields(6n));
  fake.behaviours.push({
    logs: [`Program ${PID.toBase58()} invoke [1]`, "Program log: AnchorError occurred. Error Code: NonceMoved. Error Number: 6006. Error Message: nonce moved."],
    effect: () => fake.accounts.set(configPda(PID)[0].toBase58(), moved),
  });
  await quoted(desk);
  const r = await desk.execute(signedRequest("q1", fields(user), userKp));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(fake.sent.map((t) => executeArgs(t).expectedNonce), [5n, 6n]);
  assert.equal((r.body as { base_nonce: string }).base_nonce, "6");
});

test("execute: a program error is reported by name and frees the quote", async () => {
  const { fake, desk, user, userKp } = await setup();
  fake.behaviours.push({ logs: ["Program log: AnchorError occurred. Error Code: InsufficientVaultBalance. Error Number: 6031."] });
  await quoted(desk);
  const r = await desk.execute(signedRequest("q1", fields(user), userKp));
  assert.equal(r.status, 409);
  assert.equal(code(r), "program_InsufficientVaultBalance");
  assert.equal((await desk.execute(signedRequest("q1", fields(user), userKp))).status, 200);
});

test("execute: submissions are serialized (one in flight per bot)", async () => {
  const { fake, desk, user, userKp } = await setup();
  fake.sendDelayMs = 30;
  for (const id of ["a", "b", "c"]) await quoted(desk, id);
  const rs = await Promise.all(
    ["a", "b", "c"].map((id, i) => desk.execute(signedRequest(id, fields(user, { nonce: 100n + BigInt(i) }), userKp))),
  );
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
  assert.equal(fake.sent.length, 3);
  assert.equal(fake.maxInFlight, 1);
});
