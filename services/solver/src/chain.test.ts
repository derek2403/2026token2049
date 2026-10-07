import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import {
  COMMITTEE_PDA,
  DEFAULT_INTENTS_PROGRAM_ID,
  INTENTS_IDL,
  SODA_PROGRAM_ID,
  configPda,
  creditPda,
  intentPda,
  payoutSigRequest,
  poolPda,
  renderIntentMessage,
  solverPda,
  vaultPda,
  verifyIntentSignature,
  withdrawalPda,
} from "../../../lib/intents";
import {
  FILL_COMPUTE_UNITS,
  buildExecuteTx,
  bumpGasIx,
  bumpWithdrawalGasIx,
  closeIntentIx,
  connection,
  creditSolverFromClaimIx,
  creditSolverIx,
  decodeClockUnixTimestamp,
  depositSolIx,
  executeSignedIntentIx,
  fillIx,
  intentsErrorName,
  intentsProgram,
  registerSolverIx,
  solverWithdrawIx,
  withdrawSolIx,
} from "./chain";

const PID = new PublicKey(DEFAULT_INTENTS_PROGRAM_ID);
// Unroutable: building instructions with accountsStrict must not touch the network.
const program = intentsProgram(connection("http://127.0.0.1:9"), Keypair.generate(), PID);
const disc = (name: string) => Buffer.from(sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8));

test("Clock sysvar unix_timestamp is at offset 32", () => {
  const data = new Uint8Array(40);
  new DataView(data.buffer).setBigInt64(32, 1_760_000_000n, true);
  assert.equal(decodeClockUnixTimestamp(data), 1_760_000_000n);
});

test("intentsErrorName reads Anchor logs and custom error codes", () => {
  const id = PID.toBase58();
  const anchorLog = [
    `Program ${id} invoke [1]`,
    "Program log: AnchorError thrown in programs/intents/src/lib.rs:200. Error Code: NonceMoved. Error Number: 6006. Error Message: Base nonce moved.",
    `Program ${id} failed: custom program error: 0x1776`,
  ];
  assert.equal(intentsErrorName(anchorLog, "", PID), "NonceMoved");
  assert.equal(intentsErrorName([`Program ${id} failed: custom program error: 0x1771`], "", PID), "IntentNotOpen");
  // Another program's code is not mapped to an intents name.
  assert.equal(intentsErrorName(["Program 11111111111111111111111111111111 failed: custom program error: 0x0"], "", PID), undefined);
});

test("fillIx: discriminator, args, account order and sig_request PDA", async () => {
  const solverAuth = Keypair.generate().publicKey;
  const intentKey = Keypair.generate().publicKey;
  const recipient = Uint8Array.from({ length: 20 }, (_, i) => i + 1);
  const { ix, sigRequest } = fillIx(program, solverAuth, intentKey, { recipient }, 7n, 123_456_789n, 1_250_000n);
  const built = await ix;

  const expected = payoutSigRequest({ recipient, outWei: 123_456_789n, baseNonce: 7n, gasPrice: 1_250_000n }, PID);
  assert.ok(sigRequest.equals(expected.sigRequest));
  assert.ok(built.programId.equals(PID));

  const data = Buffer.from(built.data);
  assert.deepEqual(data.subarray(0, 8), disc("fill"));
  assert.equal(data.length, 8 + 8 + 16 + 8);
  assert.equal(data.readBigUInt64LE(8), 7n);
  assert.equal(data.readBigUInt64LE(16), 123_456_789n); // u128 low half
  assert.equal(data.readBigUInt64LE(24), 0n);
  assert.equal(data.readBigUInt64LE(32), 1_250_000n);

  const keys = built.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);
  assert.deepEqual(keys, [
    [solverAuth.toBase58(), true, true],
    [solverPda(solverAuth, PID)[0].toBase58(), false, true],
    [configPda(PID)[0].toBase58(), false, true],
    [intentKey.toBase58(), false, true],
    [COMMITTEE_PDA.toBase58(), false, false],
    [sigRequest.toBase58(), false, true],
    [poolPda(PID)[0].toBase58(), false, false],
    [SODA_PROGRAM_ID.toBase58(), false, false],
    [SystemProgram.programId.toBase58(), false, false],
  ]);
});

test("bumpGasIx charges the filling solver's PDA and re-signs the same payout", async () => {
  const caller = Keypair.generate().publicKey;
  const filler = Keypair.generate().publicKey;
  const intentKey = Keypair.generate().publicKey;
  const intent = { recipient: new Uint8Array(20).fill(9), outWei: 5n * 10n ** 16n, baseNonce: 3n, solver: filler };
  const { ix, sigRequest } = bumpGasIx(program, caller, intentKey, intent, 2_000_000n);
  const built = await ix;
  assert.deepEqual(Buffer.from(built.data).subarray(0, 8), disc("bump_gas"));
  assert.ok(built.keys[0].pubkey.equals(caller) && built.keys[0].isSigner);
  assert.ok(built.keys[1].pubkey.equals(solverPda(filler, PID)[0]));
  const expected = payoutSigRequest({ recipient: intent.recipient, outWei: intent.outWei, baseNonce: 3n, gasPrice: 2_000_000n }, PID);
  assert.ok(sigRequest.equals(expected.sigRequest));
  assert.ok(built.keys[5].pubkey.equals(sigRequest));
});

test("bumpGasIx appends offered SigRequests as read-only remaining accounts", async () => {
  const intent = { recipient: new Uint8Array(20).fill(9), outWei: 1n, baseNonce: 3n, solver: Keypair.generate().publicKey };
  const dead = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const built = await bumpGasIx(program, Keypair.generate().publicKey, Keypair.generate().publicKey, intent, 2_000_000n, dead).ix;
  assert.equal(built.keys.length, 11);
  assert.deepEqual(
    built.keys.slice(9).map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    dead.map((k) => [k.toBase58(), false, false]),
  );
});

test("solverWithdrawIx and bumpWithdrawalGasIx name the Withdrawal PDA at the nonce", async () => {
  const solver = Keypair.generate().publicKey;
  const payoutAddr = new Uint8Array(20).fill(7);
  const w = await solverWithdrawIx(program, solver, payoutAddr, 12n, 10n ** 17n, 1_000_000n).ix;
  assert.deepEqual(Buffer.from(w.data).subarray(0, 8), disc("solver_withdraw"));
  assert.ok(w.keys[3].pubkey.equals(withdrawalPda(12n, PID)[0]) && w.keys[3].isWritable);

  const caller = Keypair.generate().publicKey;
  const { ix, sigRequest } = bumpWithdrawalGasIx(
    program,
    caller,
    { payoutAddr, amountWei: 10n ** 17n, baseNonce: 12n, solver },
    2_000_000n,
  );
  const b = await ix;
  assert.deepEqual(Buffer.from(b.data).subarray(0, 8), disc("bump_withdrawal_gas"));
  assert.ok(b.keys[1].pubkey.equals(solverPda(solver, PID)[0]), "the withdrawing solver's ledger pays");
  assert.ok(b.keys[3].pubkey.equals(withdrawalPda(12n, PID)[0]));
  const expected = payoutSigRequest({ recipient: payoutAddr, outWei: 10n ** 17n, baseNonce: 12n, gasPrice: 2_000_000n }, PID);
  assert.ok(sigRequest.equals(expected.sigRequest) && b.keys[5].pubkey.equals(sigRequest));
});

test("closeIntentIx: closer signs, rent goes to the user", async () => {
  const admin = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  const intent = Keypair.generate().publicKey;
  const ix = await closeIntentIx(program, admin, user, intent);
  assert.deepEqual(
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [admin.toBase58(), true, false],
      [user.toBase58(), false, true],
      [configPda(PID)[0].toBase58(), false, false],
      [intent.toBase58(), false, true],
    ],
  );
});

test("creditSolverFromClaimIx: payer signs, admin co-signs or is the None placeholder, Credit keyed by the tx hash", async () => {
  const payer = Keypair.generate().publicKey;
  const admin = Keypair.generate().publicKey;
  const solver = Keypair.generate().publicKey;
  const claim = Keypair.generate().publicKey;
  const txHash = new Uint8Array(32).fill(0xb9);
  const keys = (ix: { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) =>
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);
  const rest = [
    [configPda(PID)[0].toBase58(), false, false],
    [solverPda(solver, PID)[0].toBase58(), false, true],
    [claim.toBase58(), false, false],
    ["5Dxc9Y6sWUwvcLUhatWAHmBwVnKfUXPu5cuWccZZCNRY", false, false], // live soda_witness Config
    [creditPda(txHash, PID)[0].toBase58(), false, true],
    [SystemProgram.programId.toBase58(), false, false],
  ];
  const withAdmin = await creditSolverFromClaimIx(program, payer, solver, claim, txHash, { admin });
  assert.deepEqual(Buffer.from(withAdmin.data), Buffer.concat([disc("credit_solver_from_claim"), Buffer.from(txHash)]));
  assert.deepEqual(keys(withAdmin), [[payer.toBase58(), true, true], [admin.toBase58(), true, false], ...rest]);
  // Anchor's None for an optional account is the program id, unsigned.
  const without = await creditSolverFromClaimIx(program, payer, solver, claim, txHash);
  assert.deepEqual(keys(without), [[payer.toBase58(), true, true], [PID.toBase58(), false, false], ...rest]);
  assert.throws(() => creditSolverFromClaimIx(program, payer, solver, claim, new Uint8Array(31)), /32 bytes/);
});

test("creditSolverIx: admin pays the Credit marker keyed by the deposit tx hash", async () => {
  const admin = Keypair.generate().publicKey;
  const solver = Keypair.generate().publicKey;
  const txHash = new Uint8Array(32).fill(0xaa);
  const ix = await creditSolverIx(program, admin, solver, 5n, txHash);
  const amount = Buffer.alloc(16);
  amount.writeBigUInt64LE(5n);
  assert.deepEqual(Buffer.from(ix.data), Buffer.concat([disc("credit_solver"), amount, Buffer.from(txHash)]));
  assert.deepEqual(
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [admin.toBase58(), true, true],
      [configPda(PID)[0].toBase58(), false, false],
      [solverPda(solver, PID)[0].toBase58(), false, true],
      [creditPda(txHash, PID)[0].toBase58(), false, true],
      [SystemProgram.programId.toBase58(), false, false],
    ],
  );
  assert.throws(() => creditSolverIx(program, admin, solver, 5n, new Uint8Array(20)), /32 bytes/);
});

test("registerSolverIx carries the 65-byte deposit proof", async () => {
  const authority = Keypair.generate().publicKey;
  const payout = new Uint8Array(20).fill(1);
  const from = new Uint8Array(20).fill(2);
  const sig = new Uint8Array(65).fill(3);
  const ix = await registerSolverIx(program, authority, payout, from, sig);
  assert.deepEqual(Buffer.from(ix.data), Buffer.concat([disc("register_solver"), payout, from, sig]));
  assert.throws(() => registerSolverIx(program, authority, payout, from, new Uint8Array(64)), /65 bytes/);
});

const keyRows = (ix: { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) =>
  ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);

test("depositSolIx and withdrawSolIx: owner signs, vault PDA ['vault', owner]", async () => {
  const owner = Keypair.generate().publicKey;
  const vault = vaultPda(owner, PID)[0].toBase58();
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(250_000_000n);
  const d = await depositSolIx(program, owner, 250_000_000n);
  assert.deepEqual(Buffer.from(d.data), Buffer.concat([disc("deposit_sol"), amount]));
  assert.deepEqual(keyRows(d), [
    [owner.toBase58(), true, true],
    [configPda(PID)[0].toBase58(), false, false],
    [vault, false, true],
    [SystemProgram.programId.toBase58(), false, false],
  ]);
  const w = await withdrawSolIx(program, owner, 250_000_000n);
  assert.deepEqual(Buffer.from(w.data), Buffer.concat([disc("withdraw_sol"), amount]));
  assert.deepEqual(keyRows(w), [
    [owner.toBase58(), true, true],
    [vault, false, true],
  ]);
});

function signedArgs() {
  const user = Keypair.generate();
  const a = {
    user: user.publicKey,
    nonce: 0xdead_beef_cafe_f00dn,
    deadline: 1_759_830_120n,
    sellLamports: 100_000_000n,
    minOutWei: 2_138_000_000_000_000n,
    recipient: Uint8Array.from({ length: 20 }, (_, i) => 0xd0 + i),
    outWei: 2_140_000_000_000_000n,
    expectedNonce: 5n,
    gasPrice: 1_200_000n,
  };
  const signature = ed25519.sign(renderIntentMessage(a, PID), user.secretKey.slice(0, 32));
  return { user, a, signature };
}

test("executeSignedIntentIx: args encode as SignedIntentArgs, accounts in IDL order", async () => {
  const solverAuth = Keypair.generate().publicKey;
  const { a } = signedArgs();
  const { ix, intent, sigRequest } = executeSignedIntentIx(program, solverAuth, { ...a, ed25519IxIndex: 1 });
  const built = await ix;

  const want = new BorshCoder(INTENTS_IDL as Idl).instruction.encode("execute_signed_intent", {
    args: {
      user: a.user,
      nonce: new BN(a.nonce.toString()),
      deadline: new BN(a.deadline.toString()),
      sell_lamports: new BN(a.sellLamports.toString()),
      min_out_wei: new BN(a.minOutWei.toString()),
      recipient: [...a.recipient],
      out_wei: new BN(a.outWei.toString()),
      expected_nonce: new BN(a.expectedNonce.toString()),
      gas_price: new BN(a.gasPrice.toString()),
      ed25519_ix_index: 1,
    },
  });
  assert.deepEqual(Buffer.from(built.data), Buffer.from(want));
  assert.deepEqual(Buffer.from(built.data).subarray(0, 8), disc("execute_signed_intent"));
  assert.equal(built.data.length, 8 + 32 + 8 + 8 + 8 + 16 + 20 + 16 + 8 + 8 + 1);
  assert.equal(built.data[built.data.length - 1], 1);

  assert.ok(intent.equals(intentPda(a.user, a.nonce, PID)[0]));
  const expected = payoutSigRequest({ recipient: a.recipient, outWei: a.outWei, baseNonce: 5n, gasPrice: a.gasPrice }, PID);
  assert.ok(sigRequest.equals(expected.sigRequest));
  assert.deepEqual(keyRows(built), [
    [solverAuth.toBase58(), true, true],
    [solverPda(solverAuth, PID)[0].toBase58(), false, true],
    [configPda(PID)[0].toBase58(), false, true],
    [vaultPda(a.user, PID)[0].toBase58(), false, true],
    [intent.toBase58(), false, true],
    [COMMITTEE_PDA.toBase58(), false, false],
    [sigRequest.toBase58(), false, true],
    [poolPda(PID)[0].toBase58(), false, false],
    [SODA_PROGRAM_ID.toBase58(), false, false],
    [SYSVAR_INSTRUCTIONS_PUBKEY.toBase58(), false, false],
    [SystemProgram.programId.toBase58(), false, false],
  ]);
});

test("buildExecuteTx: [compute budget, Ed25519, execute] with ed25519_ix_index pointing at the Ed25519 instruction", async () => {
  const solverAuth = Keypair.generate().publicKey;
  const { a, signature } = signedArgs();
  const tx = await buildExecuteTx(program, solverAuth, a, signature);
  assert.equal(tx.ixs.length, 3);
  assert.ok(tx.ixs[0].programId.equals(ComputeBudgetProgram.programId));
  assert.ok(tx.ixs[1].programId.equals(Ed25519Program.programId));
  assert.ok(tx.ixs[2].programId.equals(PID));
  assert.equal(tx.ixs[0].data.readUInt32LE(1), FILL_COMPUTE_UNITS);
  assert.equal(tx.ixs[2].data[tx.ixs[2].data.length - 1], 1);
  assert.ok(tx.intent.equals(intentPda(a.user, a.nonce, PID)[0]));
  assert.ok(verifyIntentSignature(tx.message, signature, a.user));

  // The Ed25519 entry is self-contained (all instruction indices u16::MAX) and carries pk, sig, message.
  const d = tx.ixs[1].data;
  assert.equal(d[0], 1);
  const u16 = (i: number) => d.readUInt16LE(2 + i * 2);
  assert.deepEqual([u16(1), u16(3), u16(6)], [0xffff, 0xffff, 0xffff]);
  assert.deepEqual(d.subarray(u16(2), u16(2) + 32), Buffer.from(a.user.toBytes()));
  assert.deepEqual(d.subarray(u16(0), u16(0) + 64), Buffer.from(signature));
  assert.deepEqual(d.subarray(u16(4), u16(4) + u16(5)), Buffer.from(renderIntentMessage(a, PID)));

  // A priority fee instruction shifts the Ed25519 instruction, and the index follows.
  const pri = await buildExecuteTx(program, solverAuth, a, signature, { priorityMicroLamports: 1_000 });
  assert.equal(pri.ixs.length, 4);
  assert.ok(pri.ixs[2].programId.equals(Ed25519Program.programId));
  assert.equal(pri.ixs[3].data[pri.ixs[3].data.length - 1], 2);

  await assert.rejects(buildExecuteTx(program, solverAuth, a, signature.slice(1)), /64 bytes/);
});
