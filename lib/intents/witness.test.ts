import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { DEFAULT_INTENTS_PROGRAM_ID } from "./constants";
import { creditPda } from "./pdas";
import {
  ClaimStatus,
  claimCreditProblems,
  decodeWitnessClaim,
  PRODUCTION_FORWARDER_ID,
  WITNESS_CLAIM_SIZE,
  WITNESS_CONFIG_SIZE,
  witnessConfigPda,
  witnessTrusted,
} from "./witness";
import witnessIdl from "../../idl/soda_witness.json";

// Devnet claim 2LHehzzCpXXMHpWhDMZRTCsZGXTsF5kzSVJDXfjGoEmF as recorded by the CRE simulation (2026-10-07).
const LIVE_CLAIM = hexToBytes(
  "9b4616b07bd7f666b388c6bf3f289cd4e348155a63814db5f0fa9121be0da7464d105cb2718f072e344a010000000000" +
    "b9d12a5ab63a10f508a1288e0fa6db38da7a46b50d25daf06125669aec2757d701" +
    "31777694f7b90b635b1f3b786f5d24be7651be7b7662920f66682d8996ec6b6d9e4ac9ed25a1006c" +
    "000064a7b3b6e00d0000000000000000" +
    "9e5dd90200000000012321c66a00000000ff",
);
const SOLVER_A = new PublicKey("D5pwjGzqvgvuFt4rtMVf1ta4RKXWyGGfG2ekh5KuDfZw");
const POOL_EVM = hexToBytes("7662920f66682d8996ec6b6d9e4ac9ed25a1006c");
const BOT = hexToBytes("31777694f7b90b635b1f3b786f5d24be7651be7b");

test("decodes the live devnet claim", () => {
  assert.equal(LIVE_CLAIM.length, WITNESS_CLAIM_SIZE);
  const c = decodeWitnessClaim(LIVE_CLAIM);
  assert.ok(c.requester.equals(SOLVER_A));
  assert.equal(c.chainId, 84532n);
  assert.equal(bytesToHex(c.txHash), "b9d12a5ab63a10f508a1288e0fa6db38da7a46b50d25daf06125669aec2757d7");
  assert.equal(c.status, ClaimStatus.Recorded);
  assert.equal(bytesToHex(c.from), bytesToHex(BOT));
  assert.equal(bytesToHex(c.to), bytesToHex(POOL_EVM));
  assert.equal(c.valueWei, 10n ** 18n);
  assert.equal(c.block, 47799710n);
  assert.equal(c.success, true);
  assert.equal(c.bump, 255);
});

test("discriminator matches the soda_witness IDL; foreign or short data is rejected", () => {
  const disc = witnessIdl.accounts.find((a) => a.name === "Claim")!.discriminator;
  assert.equal(bytesToHex(LIVE_CLAIM.subarray(0, 8)), bytesToHex(Uint8Array.from(disc)));
  const bad = LIVE_CLAIM.slice();
  bad[0] ^= 1;
  assert.throws(() => decodeWitnessClaim(bad), /discriminator/);
  assert.throws(() => decodeWitnessClaim(LIVE_CLAIM.subarray(0, 154)), /155 bytes/);
});

test("claimCreditProblems mirrors the program's checks", () => {
  const c = decodeWitnessClaim(LIVE_CLAIM);
  const solver = { authority: SOLVER_A, depositFrom: BOT };
  assert.deepEqual(claimCreditProblems(c, POOL_EVM, solver), []);
  const other = { authority: new PublicKey("CozgNEdiG93qqo8cxXeXddvuT3F1Gh6zHr4VLro1sZ54"), depositFrom: BOT };
  assert.match(claimCreditProblems(c, POOL_EVM, other).join(), /ClaimNotBySolver/);
  assert.match(claimCreditProblems({ ...c, success: false }, POOL_EVM, solver).join(), /DepositReverted/);
  assert.match(claimCreditProblems({ ...c, status: ClaimStatus.Pending }, POOL_EVM, solver).join(), /ClaimNotRecorded/);
  assert.match(claimCreditProblems({ ...c, from: new Uint8Array(20) }, POOL_EVM, solver).join(), /DepositNotFromSolver/);
  assert.match(claimCreditProblems({ ...c, to: new Uint8Array(20) }, POOL_EVM, solver).join(), /DepositNotToPool/);
  assert.match(claimCreditProblems({ ...c, chainId: 8453n }, POOL_EVM, solver).join(), /ClaimWrongChain/);
  assert.match(claimCreditProblems({ ...c, valueWei: 0n }, POOL_EVM, solver).join(), /ZeroAmount/);
});

test("credit PDA is [\"credit\", tx_hash]", () => {
  const program = new PublicKey(DEFAULT_INTENTS_PROGRAM_ID);
  const tx = decodeWitnessClaim(LIVE_CLAIM).txHash;
  const [pda, bump] = creditPda(tx, program);
  const expected = PublicKey.createProgramAddressSync([Buffer.from("credit"), Buffer.from(tx), Buffer.from([bump])], program);
  assert.ok(pda.equals(expected));
  assert.throws(() => creditPda(new Uint8Array(31), program), /32 bytes/);
});

test("witness Config PDA is the live one; only a pinned production forwarder is trusted", () => {
  assert.equal(witnessConfigPda()[0].toBase58(), "5Dxc9Y6sWUwvcLUhatWAHmBwVnKfUXPu5cuWccZZCNRY");
  const cfg = (forwarder: string, owner: number) => {
    const d = new Uint8Array(WITNESS_CONFIG_SIZE);
    d.set(new PublicKey(forwarder).toBytes(), 40);
    d.fill(owner, 104, 124);
    return d;
  };
  assert.equal(witnessTrusted(cfg(PRODUCTION_FORWARDER_ID, 1)), true);
  assert.equal(witnessTrusted(cfg(PRODUCTION_FORWARDER_ID, 0)), false, "owner not pinned");
  assert.equal(witnessTrusted(cfg("7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK", 1)), false, "mock forwarder");
  assert.equal(witnessTrusted(cfg(PRODUCTION_FORWARDER_ID, 1).subarray(0, 134)), false, "short");
});
