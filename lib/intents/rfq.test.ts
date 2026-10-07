import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { accountDiscriminator } from "./accounts";
import { DEFAULT_INTENTS_PROGRAM_ID, IntentStatus } from "./constants";
import { intentPda } from "./pdas";
import {
  USER_VAULT_SIZE,
  decodeSignedIntent,
  decodeUserVault,
  encodeSignedIntent,
  fetchUserVault,
  isRfqIntent,
  newIntentNonce,
  parseIntentMessage,
  renderIntentMessage,
  rfqExecuteRequest,
  vaultPda,
  verifyIntentSignature,
  type IntentMessageFields,
} from "./rfq";
import { intentStatus } from "./status";
import { filledIntent, openIntent, sigRequestsFor } from "./testutil";
import type { EthReceipt } from "./payout";

type Vector = {
  name: string;
  program_id: string;
  user: string;
  nonce: string;
  deadline: string;
  sell_lamports: string;
  min_out_wei: string;
  recipient: string;
  message: string;
  message_hex: string;
  message_len: number;
};

const { vectors } = JSON.parse(readFileSync(path.join(__dirname, "rfq-vectors.json"), "utf8")) as { vectors: Vector[] };
const PID = new PublicKey(DEFAULT_INTENTS_PROGRAM_ID);

const fieldsOf = (v: Vector): IntentMessageFields => ({
  user: new PublicKey(v.user),
  nonce: BigInt(v.nonce),
  deadline: BigInt(v.deadline),
  sellLamports: BigInt(v.sell_lamports),
  minOutWei: BigInt(v.min_out_wei),
  recipient: hexToBytes(v.recipient.slice(2)),
});

test("renderIntentMessage matches the Rust vectors byte for byte", () => {
  assert.ok(vectors.length >= 5);
  for (const v of vectors) {
    const got = renderIntentMessage(fieldsOf(v), new PublicKey(v.program_id));
    assert.equal(bytesToHex(got), v.message_hex, v.name);
    assert.equal(got.length, v.message_len, v.name);
    assert.equal(new TextDecoder().decode(got), v.message, v.name);
  }
});

test("parseIntentMessage round-trips every vector", () => {
  for (const v of vectors) {
    const p = parseIntentMessage(hexToBytes(v.message_hex));
    assert.equal(p.programId.toBase58(), v.program_id);
    assert.equal(p.user.toBase58(), v.user);
    assert.equal(p.nonce, BigInt(v.nonce));
    assert.equal(p.deadline, BigInt(v.deadline));
    assert.equal(p.sellLamports, BigInt(v.sell_lamports));
    assert.equal(p.minOutWei, BigInt(v.min_out_wei));
    assert.equal(`0x${bytesToHex(p.recipient)}`, v.recipient);
    assert.equal(bytesToHex(renderIntentMessage(p, p.programId)), v.message_hex);
    assert.deepEqual(parseIntentMessage(v.message), p, "text input");
  }
});

test("parseIntentMessage rejects anything the renderer would not produce", () => {
  const m = vectors[0].message;
  const bad: [string, string][] = [
    ["trailing newline", m + "\n"],
    ["CRLF", m.replace(/\n/g, "\r\n")],
    ["missing line", m.split("\n").slice(0, 7).join("\n")],
    ["extra line", m + "\nextra"],
    ["other version", m.replace("v1", "v2")],
    ["other network", m.replace(" devnet", " mainnet")],
    ["leading zero nonce", m.replace("nonce: 1759830000123", "nonce: 01759830000123")],
    ["plus sign", m.replace("deadline: 1759830120", "deadline: +1759830120")],
    ["minus zero", m.replace("deadline: 1759830120", "deadline: -0")],
    ["double space", m.replace("sell: 100000000", "sell:  100000000")],
    ["decimal point", m.replace("sell: 100000000 lamports", "sell: 0.1 lamports")],
    ["uppercase hex", m.replace("0xdd8e2f5a", "0xDD8E2F5A")],
    ["short address", m.replace("0xdd8e2f5a", "0xdd8e2f5")],
    ["other chain", m.replace("(84532)", "(8453)")],
    ["u64 overflow", m.replace("nonce: 1759830000123", "nonce: 18446744073709551616")],
    ["u128 overflow", m.replace("2138000000000000", "340282366920938463463374607431768211456")],
    ["i64 overflow", m.replace("deadline: 1759830120", "deadline: 9223372036854775808")],
    ["non-canonical base58", m.replace("signer: D5pw", "signer: 1D5pw")],
    ["bad base58 char", m.replace("signer: D5pw", "signer: 05pw")],
  ];
  for (const [name, text] of bad) {
    assert.notEqual(text, m, `${name}: the edit did not apply`);
    assert.throws(() => parseIntentMessage(text), Error, name);
  }
  // Invalid UTF-8.
  const bytes = hexToBytes(vectors[0].message_hex);
  bytes[3] = 0xff;
  assert.throws(() => parseIntentMessage(bytes));
});

test("renderIntentMessage refuses out-of-range fields", () => {
  const f = fieldsOf(vectors[0]);
  assert.throws(() => renderIntentMessage({ ...f, nonce: -1n }), /nonce/);
  assert.throws(() => renderIntentMessage({ ...f, nonce: 1n << 64n }), /nonce/);
  assert.throws(() => renderIntentMessage({ ...f, deadline: 1n << 63n }), /deadline/);
  assert.throws(() => renderIntentMessage({ ...f, minOutWei: 1n << 128n }), /min_out_wei/);
  assert.throws(() => renderIntentMessage({ ...f, recipient: new Uint8Array(19) }), /20 bytes/);
});

test("signatures: verify, decode the wire form, and reject every mismatch", () => {
  const user = Keypair.generate();
  const f = { ...fieldsOf(vectors[0]), user: user.publicKey };
  const message = renderIntentMessage(f, PID);
  const signature = ed25519.sign(message, user.secretKey.slice(0, 32));
  assert.ok(verifyIntentSignature(message, signature, user.publicKey));
  assert.ok(!verifyIntentSignature(message, signature, Keypair.generate().publicKey));
  assert.ok(!verifyIntentSignature(message.slice(1), signature, user.publicKey));
  assert.ok(!verifyIntentSignature(message, signature.slice(1), user.publicKey));

  const wire = encodeSignedIntent(message, signature, user.publicKey);
  const d = decodeSignedIntent(wire, PID);
  assert.ok(d.fields.user.equals(user.publicKey));
  assert.equal(d.fields.minOutWei, f.minOutWei);
  assert.deepEqual(d.signature, signature);

  assert.throws(() => decodeSignedIntent(wire, Keypair.generate().publicKey), /verifier/);
  const other = Keypair.generate();
  assert.throws(() => decodeSignedIntent({ ...wire, public_key: other.publicKey.toBase58() }, PID), /signer line/);
  const forged = new Uint8Array(signature);
  forged[0] ^= 1;
  assert.throws(() => decodeSignedIntent({ ...wire, signature: Buffer.from(forged).toString("base64") }, PID), /invalid signature/);
  // Signed by someone else over a message naming the user.
  const sig2 = ed25519.sign(message, other.secretKey.slice(0, 32));
  assert.throws(() => decodeSignedIntent({ ...wire, signature: Buffer.from(sig2).toString("base64") }, PID), /invalid signature/);

  const req = rfqExecuteRequest("q1", f, wire);
  assert.deepEqual(
    [req.quote_id, req.user, req.nonce, req.deadline, req.sell_lamports, req.min_out_wei, req.recipient],
    ["q1", user.publicKey.toBase58(), vectors[0].nonce, vectors[0].deadline, vectors[0].sell_lamports, vectors[0].min_out_wei, vectors[0].recipient],
  );
});

test("a UTF-8 BOM in front of the message is not canonical", () => {
  const user = Keypair.generate();
  const f = { ...fieldsOf(vectors[0]), user: user.publicKey };
  const message = renderIntentMessage(f, PID);
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...message]);
  assert.throws(() => parseIntentMessage(bom));
  const signature = ed25519.sign(bom, user.secretKey.slice(0, 32));
  assert.ok(verifyIntentSignature(bom, signature, user.publicKey));
  assert.throws(() => decodeSignedIntent(encodeSignedIntent(bom, signature, user.publicKey), PID));
});

test("vault PDA and UserVault decoding", () => {
  const owner = new PublicKey("D5pwjGzqvgvuFt4rtMVf1ta4RKXWyGGfG2ekh5KuDfZw");
  const [pda] = vaultPda(owner, PID);
  const [want] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer()], PID);
  assert.ok(pda.equals(want));

  const data = new Uint8Array(USER_VAULT_SIZE);
  data.set(accountDiscriminator("UserVault"), 0);
  data.set(owner.toBytes(), 8);
  new DataView(data.buffer).setBigUint64(40, 123_456_789n, true);
  data[48] = 254;
  const v = decodeUserVault(data);
  assert.ok(v.owner.equals(owner));
  assert.equal(v.sol, 123_456_789n);
  assert.equal(v.bump, 254);
  assert.throws(() => decodeUserVault(new Uint8Array(USER_VAULT_SIZE)));
});

test("fetchUserVault and newIntentNonce read by PDA", async () => {
  const owner = Keypair.generate().publicKey;
  const taken = new Set<string>();
  const conn = {
    getAccountInfo: async (k: PublicKey) => (taken.has(k.toBase58()) ? ({ data: Buffer.alloc(0) } as never) : null),
  };
  assert.equal(await fetchUserVault(conn, owner, PID), null);

  const seq = [0n, 5n, 7n, 1n << 70n | 9n];
  const random = () => seq.shift()!;
  taken.add(intentPda(owner, 5n, PID)[0].toBase58());
  // 0 is skipped, 5 exists, 7 is free.
  assert.equal(await newIntentNonce(conn, owner, PID, random), 7n);
  // Values are reduced to u64.
  assert.equal(await newIntentNonce(conn, owner, PID, random), 9n);
  taken.add(intentPda(owner, 3n, PID)[0].toBase58());
  await assert.rejects(newIntentNonce(conn, owner, PID, () => 3n), /unused intent nonce/);
  const n = await newIntentNonce(conn, owner, PID);
  assert.ok(n > 0n && n < 1n << 64n);
});

test("status: RFQ intents read as settled by the solver, with no fake +0 ms", () => {
  const prices = [1_000_000n];
  const rfq = filledIntent(prices, { auctionDuration: 0, auctionStart: 1_700_000_030n, expiresAt: 1_700_000_150n });
  assert.ok(isRfqIntent(rfq));
  const r = intentStatus({
    intent: rfq,
    sigRequests: sigRequestsFor(rfq, prices, [false]),
    receipts: new Map<string, EthReceipt | null>(),
    now: rfq.filledAt + 2n,
  });
  assert.equal(r.status, "signing");
  assert.equal(r.steps[0].label, "Signed intent settled by solver 9mX3…A6SS");
  assert.equal(r.steps[1].timestamp, undefined);
  assert.equal(r.steps[1].elapsedMs, undefined);

  // A Dutch-auction fill keeps its labels and times.
  const auction = filledIntent(prices);
  assert.ok(!isRfqIntent(auction));
  const a = intentStatus({ intent: auction, sigRequests: [null], receipts: new Map(), now: auction.filledAt });
  assert.match(a.steps[0].label, /escrow/);
  assert.equal(a.steps[1].elapsedMs, 30_000);
  // open_intent with a zero duration, still open or filled later, is not RFQ.
  assert.ok(!isRfqIntent(openIntent({ auctionDuration: 0 })));
  assert.ok(!isRfqIntent({ ...rfq, filledAt: rfq.filledAt + 1n }));
  assert.ok(!isRfqIntent({ ...rfq, status: IntentStatus.Cancelled }));
});
