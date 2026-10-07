import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { bytesToHex } from "@noble/hashes/utils";
import { DEFAULT_INTENTS_PROGRAM_ID, DEFAULT_SODA_PROGRAM_ID } from "./constants";
import { depositProofMessage, intentPda, poolEvmAddress, poolPda, sigRequestPda, u64Le } from "./pdas";

const PROGRAM = new PublicKey(DEFAULT_INTENTS_PROGRAM_ID);
const SODA = new PublicKey(DEFAULT_SODA_PROGRAM_ID);

test("pool PDA and its SODA Base address", () => {
  const [pool, bump] = poolPda(PROGRAM);
  assert.equal(pool.toBase58(), "WtaezksvpBC1LGh4oV7xvURsdtdTv752z1A4NpLv7uS");
  assert.equal(bump, 254);
  assert.equal("0x" + bytesToHex(poolEvmAddress(undefined, PROGRAM)), "0x7662920f66682d8996ec6b6d9e4ac9ed25a1006c");
});

test("intent PDA uses intent_id as u64 little-endian", () => {
  assert.deepEqual([...u64Le(0x0102030405060708n)], [8, 7, 6, 5, 4, 3, 2, 1]);
  const user = new PublicKey("9mX3oHUmsrYvzXjCo35HhfXufrGZT3hjsLoC74xbA6SS");
  const [pda, bump] = intentPda(user, 42n, PROGRAM);
  const expected = PublicKey.createProgramAddressSync(
    [Buffer.from("intent"), user.toBuffer(), Buffer.from([42, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([bump])],
    PROGRAM,
  );
  assert.ok(pda.equals(expected));
});

test("sigRequest PDA is [\"sig\", requester, payload] under soda", () => {
  const [pool] = poolPda(PROGRAM);
  const payload = new Uint8Array(32).fill(7);
  const [pda, bump] = sigRequestPda(pool, payload, SODA);
  const expected = PublicKey.createProgramAddressSync(
    [Buffer.from("sig"), pool.toBuffer(), Buffer.from(payload), Buffer.from([bump])],
    SODA,
  );
  assert.ok(pda.equals(expected));
  // A different payload or requester gives a different account.
  assert.ok(!sigRequestPda(pool, new Uint8Array(32).fill(8), SODA)[0].equals(pda));
  assert.ok(!sigRequestPda(PROGRAM, payload, SODA)[0].equals(pda));
  assert.throws(() => sigRequestPda(pool, new Uint8Array(31), SODA));
});

test("deposit proof message is tag || program id || authority", () => {
  const authority = new PublicKey(new Uint8Array(32).fill(5));
  const m = depositProofMessage(authority, PROGRAM);
  assert.equal(m.length, 80);
  assert.equal(new TextDecoder().decode(m.subarray(0, 16)), "intents register");
  assert.deepEqual([...m.subarray(16, 48)], [...PROGRAM.toBytes()]);
  assert.deepEqual([...m.subarray(48)], new Array(32).fill(5));
});
