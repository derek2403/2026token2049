import { test } from "node:test";
import assert from "node:assert/strict";
import { BN, BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { bytesToHex } from "@noble/hashes/utils";
import {
  accountDiscriminator,
  CONFIG_SIZE,
  CREDIT_SIZE,
  decodeConfig,
  decodeIntent,
  decodeSolver,
  eventDiscriminator,
  ETH_TX_REQUESTED_DISCRIMINATOR,
  gasPricesFromEvents,
  INTENT_SIZE,
  INTENT_STATUS_OFFSET,
  INTENT_USER_OFFSET,
  intentFilters,
  parseIntentsLogs,
  SOLVER_SIZE,
  decodeWithdrawal,
  unsignedRlpBySigRequest,
  WITHDRAWAL_SIZE,
} from "./accounts";
import { INTENTS_PROGRAM_ID, IntentStatus, SODA_PROGRAM_ID } from "./constants";
import { INTENTS_IDL } from "./idl";
import { payoutUnsignedRlp } from "./payout";
import { RECIPIENT, SOLVER, USER } from "./testutil";

const coder = new BorshAccountsCoder(INTENTS_IDL);
const hex = (b: Uint8Array) => bytesToHex(b);
const KEY_A = new PublicKey("WtaezksvpBC1LGh4oV7xvURsdtdTv752z1A4NpLv7uS");
const KEY_B = new PublicKey("9mX3oHUmsrYvzXjCo35HhfXufrGZT3hjsLoC74xbA6SS");

// Encodes an IDL event type by registering it as an "account" with the event's discriminator.
function encodeEvent(name: string, data: Record<string, unknown>): Promise<Buffer> {
  const ev = INTENTS_IDL.events!.find((e) => e.name === name)!;
  const idl = { ...INTENTS_IDL, accounts: [{ name, discriminator: ev.discriminator }] } as Idl;
  return new BorshAccountsCoder(idl).encode(name, data);
}

test("IDL discriminators match sha256('account:'/'event:' name)", () => {
  for (const a of INTENTS_IDL.accounts!) assert.equal(hex(accountDiscriminator(a.name)), hex(Uint8Array.from(a.discriminator)));
  for (const e of INTENTS_IDL.events!) assert.equal(hex(eventDiscriminator(e.name)), hex(Uint8Array.from(e.discriminator)));
  assert.equal(hex(eventDiscriminator("EthTxRequested")), hex(ETH_TX_REQUESTED_DISCRIMINATOR));
});

test("account sizes match the IDL", () => {
  assert.equal(coder.size("Config"), CONFIG_SIZE);
  assert.equal(coder.size("Solver"), SOLVER_SIZE);
  assert.equal(coder.size("Intent"), INTENT_SIZE);
  assert.equal(coder.size("Withdrawal"), WITHDRAWAL_SIZE);
  assert.equal(coder.size("Credit"), CREDIT_SIZE);
});

const rawIntent = {
  user: USER,
  intent_id: new BN(42),
  in_lamports: new BN(1_000_000_000),
  recipient: [...RECIPIENT],
  start_out_wei: new BN("1000000000000000000"),
  min_out_wei: new BN("990000000000000000"),
  auction_start: new BN(1_700_000_000),
  auction_duration: 60,
  expires_at: new BN(1_700_000_120),
  status: IntentStatus.Filled,
  solver: SOLVER,
  out_wei: new BN("995000000000000000"),
  base_nonce: new BN(7),
  gas_price: new BN(1_100_000),
  filled_at: new BN(1_700_000_030),
  sig_requests: [KEY_A, KEY_B, PublicKey.default, PublicKey.default],
  sig_request_count: 2,
  bump: 253,
};

test("decodeIntent and the getProgramAccounts offsets", async () => {
  const data = await coder.encode("Intent", rawIntent);
  assert.equal(data.length, INTENT_SIZE);
  const i = decodeIntent(Uint8Array.from(data));
  assert.ok(i.user.equals(USER));
  assert.equal(i.intentId, 42n);
  assert.equal(i.startOutWei, 10n ** 18n);
  assert.equal(i.minOutWei, 990_000_000_000_000_000n);
  assert.equal(i.auctionDuration, 60);
  assert.equal(i.status, IntentStatus.Filled);
  assert.equal(i.outWei, 995_000_000_000_000_000n);
  assert.equal(i.gasPrice, 1_100_000n);
  assert.equal(hex(i.recipient), hex(RECIPIENT));
  assert.ok(i.sigRequests[1].equals(KEY_B));
  assert.equal(i.sigRequestCount, 2);
  assert.equal(i.bump, 253);

  // The filter offsets point at Intent.user and Intent.status.
  assert.equal(hex(data.subarray(INTENT_USER_OFFSET, INTENT_USER_OFFSET + 32)), hex(USER.toBytes()));
  assert.equal(data[INTENT_STATUS_OFFSET], IntentStatus.Filled);
  const open = await coder.encode("Intent", { ...rawIntent, status: IntentStatus.Open });
  assert.equal(open[INTENT_STATUS_OFFSET], IntentStatus.Open);
});

test("intentFilters: discriminator always, then user and status", () => {
  const f = intentFilters({ user: USER, status: IntentStatus.Open });
  assert.deepEqual(f, [
    { memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator("Intent")) } },
    { memcmp: { offset: 8, bytes: USER.toBase58() } },
    { memcmp: { offset: 128, bytes: bs58.encode([0]) } },
  ]);
  assert.equal(intentFilters().length, 1);
});

test("decodeConfig and decodeSolver", async () => {
  const cfg = decodeConfig(
    await coder.encode("Config", {
      admin: USER,
      pool_bump: 254,
      pool_evm_addr: [...RECIPIENT],
      next_nonce: new BN(9),
      max_gas_price: new BN(50_000_000),
      l1_fee_buffer_wei: new BN(1_000),
      paused: false,
      witness_program: KEY_A,
      min_gas_price: new BN(1_000_000),
    }),
  );
  assert.equal(cfg.poolBump, 254);
  assert.equal(cfg.minGasPrice, 1_000_000n);
  assert.equal(cfg.nextNonce, 9n);
  assert.equal(cfg.maxGasPrice, 50_000_000n);
  assert.equal(cfg.paused, false);
  assert.ok(cfg.witnessProgram.equals(KEY_A));

  const s = decodeSolver(
    await coder.encode("Solver", {
      authority: SOLVER,
      payout_addr: [...RECIPIENT],
      deposit_from: new Array(20).fill(1),
      balance_wei: new BN("340282366920938463463374607431768211455"), // u128::MAX
      fills: new BN(3),
      bump: 250,
    }),
  );
  assert.equal(s.balanceWei, (1n << 128n) - 1n);
  assert.equal(s.fills, 3n);
  assert.deepEqual([...s.depositFrom], new Array(20).fill(1));
  assert.throws(() => decodeSolver(Uint8Array.from(Buffer.alloc(SOLVER_SIZE))), /discriminator/);
});

test("decodeWithdrawal", async () => {
  const w = decodeWithdrawal(
    await coder.encode("Withdrawal", {
      solver: SOLVER,
      payout_addr: [...RECIPIENT],
      amount_wei: new BN("5000000000000000000"),
      base_nonce: new BN(11),
      gas_price: new BN(2_000_000),
      created_at: new BN(1_700_000_000),
      sig_requests: [KEY_A, KEY_B, PublicKey.default, PublicKey.default],
      sig_request_count: 2,
      bump: 251,
    }),
  );
  assert.ok(w.solver.equals(SOLVER));
  assert.equal(hex(w.payoutAddr), hex(RECIPIENT));
  assert.equal(w.amountWei, 5n * 10n ** 18n);
  assert.equal(w.baseNonce, 11n);
  assert.equal(w.gasPrice, 2_000_000n);
  assert.equal(w.createdAt, 1_700_000_000n);
  assert.equal(w.sigRequestCount, 2);
  assert.ok(w.sigRequests[1].equals(KEY_B));
});

test("parseIntentsLogs keeps only events emitted by the intents program frame", async () => {
  const rlp = payoutUnsignedRlp({ recipient: RECIPIENT, outWei: 995n, baseNonce: 7n, gasPrice: 1_000_000n });
  const intentKey = KEY_A;
  const ethTx = await encodeEvent("EthTxRequested", { sig_request: KEY_B, chain_id: new BN(84532), unsigned_rlp: Buffer.from(rlp) });
  const filled = await encodeEvent("IntentFilled", {
    intent: intentKey,
    user: USER,
    solver: SOLVER,
    in_lamports: new BN(1_000_000_000),
    out_wei: new BN(995),
    base_nonce: new BN(7),
    gas_price: new BN(1_000_000),
    sig_request: KEY_B,
    filled_at: new BN(1_700_000_030),
  });
  const bumped = await encodeEvent("GasBumped", {
    intent: intentKey,
    caller: SOLVER,
    solver: SOLVER,
    base_nonce: new BN(7),
    old_gas_price: new BN(1_000_000),
    new_gas_price: new BN(1_100_000),
    sig_request: KEY_A,
    sig_request_count: 2,
  });
  const P = INTENTS_PROGRAM_ID.toBase58();
  const S = SODA_PROGRAM_ID.toBase58();
  const OTHER = "11111111111111111111111111111111";
  const data = (b: Buffer) => `Program data: ${b.toString("base64")}`;
  const logs = [
    "Program ComputeBudget111111111111111111111111111111 invoke [1]",
    "Program ComputeBudget111111111111111111111111111111 success",
    `Program ${P} invoke [1]`,
    "Program log: Instruction: Fill",
    `Program ${S} invoke [2]`,
    data(ethTx), // emitted inside soda's frame: not ours
    `Program ${S} consumed 40000 of 260000 compute units`,
    `Program ${S} success`,
    data(ethTx),
    data(filled),
    data(bumped),
    `Program ${P} consumed 90000 of 300000 compute units`,
    `Program ${P} success`,
    `Program ${OTHER} invoke [1]`,
    data(filled), // a different program forging our event
    `Program ${OTHER} success`,
  ];
  const events = parseIntentsLogs(logs);
  assert.deepEqual(events.map((e) => e.name), ["EthTxRequested", "IntentFilled", "GasBumped"]);

  const [eth, fill] = events;
  assert.ok(eth.name === "EthTxRequested" && eth.sigRequest.equals(KEY_B) && eth.chainId === 84532n);
  assert.ok(eth.name === "EthTxRequested" && hex(eth.unsignedRlp) === hex(rlp));
  assert.ok(fill.name === "IntentFilled" && fill.outWei === 995n && fill.gasPrice === 1_000_000n && fill.filledAt === 1_700_000_030n);

  assert.deepEqual(gasPricesFromEvents(events, intentKey), [1_000_000n, 1_100_000n]);
  assert.deepEqual(gasPricesFromEvents(events, KEY_B), []);
  assert.equal(hex(unsignedRlpBySigRequest(events).get(KEY_B.toBase58())!), hex(rlp));
});
