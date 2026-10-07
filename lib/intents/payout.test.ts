import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { bigintToBe, decodeUnsignedLegacy, encodeUnsignedLegacy, ethAddressFromPk, type LegacyTx } from "../soda";
import {
  assembleSigned,
  buildCandidates,
  buildPayoutTx,
  classifyBroadcastError,
  decodeSigRequest,
  payloadOf,
  payoutSigRequest,
  payoutUnsignedRlp,
  PayoutTracker,
  signedFromSigRequest,
  type EthReceipt,
  type PayoutRpc,
} from "./payout";
import { poolPda, sigRequestPda } from "./pdas";
import { encodeSigRequest, fakeSigRequest, filledIntent, RECIPIENT, sigRequestsFor } from "./testutil";

const hex = (b: Uint8Array) => bytesToHex(b);

// Minimal RLP list decoder, independent of lib/soda, for checking signed txs.
function rlpList(b: Uint8Array): Uint8Array[] {
  const len = (off: number, n: number) => b.subarray(off, off + n).reduce((a, x) => a * 256 + x, 0);
  const ll0 = b[0] <= 0xf7 ? 0 : b[0] - 0xf7;
  let start = 1 + ll0;
  const end = start + (ll0 === 0 ? b[0] - 0xc0 : len(1, ll0));
  const items: Uint8Array[] = [];
  while (start < end) {
    const t = b[start];
    if (t < 0x80) items.push(b.subarray(start, ++start));
    else if (t <= 0xb7) items.push(b.subarray(start + 1, (start += 1 + t - 0x80)));
    else {
      const ll = t - 0xb7;
      const l = len(start + 1, ll);
      items.push(b.subarray(start + 1 + ll, (start += 1 + ll + l)));
    }
  }
  assert.equal(start, b.length);
  return items;
}
const toBig = (b: Uint8Array) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);

test("payout RLP matches a hand-assembled vector and round-trips", () => {
  const p = { recipient: RECIPIENT, outWei: 10n ** 15n, baseNonce: 0n, gasPrice: 1_000_000n };
  const rlp = payoutUnsignedRlp(p);
  const expected =
    "ec" + // list, 44-byte payload
    "80" + // nonce 0
    "830f4240" + // gas price 1_000_000
    "825208" + // gas limit 21000
    "94" + hex(RECIPIENT) + // to
    "87038d7ea4c68000" + // value 1e15
    "80" + // data empty
    "83014a34" + // chain id 84532
    "8080"; // r, s placeholders
  assert.equal(hex(rlp), expected);

  const back = decodeUnsignedLegacy(rlp);
  assert.deepEqual(back, buildPayoutTx(p));
  assert.equal(hex(encodeUnsignedLegacy(back)), expected);
  assert.equal(hex(payloadOf(rlp)), hex(keccak_256(rlp)));
});

test("payoutSigRequest derives the soda PDA from the pool and the payload", () => {
  const p = { recipient: RECIPIENT, outWei: 123n, baseNonce: 5n, gasPrice: 9n };
  const { unsignedRlp, payload, sigRequest } = payoutSigRequest(p);
  assert.equal(hex(payload), hex(keccak_256(unsignedRlp)));
  assert.ok(sigRequest.equals(sigRequestPda(poolPda()[0], payload)[0]));
});

test("EIP-155 spec vector: signed tx and hash", () => {
  // https://eips.ethereum.org/EIPS/eip-155 example (chain 1).
  const tx: LegacyTx = {
    nonce: 9n,
    gasPriceWei: 20_000_000_000n,
    gasLimit: 21000n,
    to: hexToBytes("3535353535353535353535353535353535353535"),
    valueWeiBe: bigintToBe(10n ** 18n, 16),
    data: new Uint8Array(0),
    chainId: 1n,
  };
  const unsigned = encodeUnsignedLegacy(tx);
  assert.equal(hex(unsigned), "ec098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080018080");
  const sighash = keccak_256(unsigned);
  assert.equal(hex(sighash), "daf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53");
  const sig = secp256k1.sign(sighash, hexToBytes("46".repeat(32)));
  const signed = assembleSigned(tx, sig.toCompactRawBytes(), sig.recovery);
  const expected =
    "f86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83";
  assert.equal(signed.v, 37n);
  assert.equal(signed.signedHex, "0x" + expected);
  assert.equal(signed.txHash, "0x" + hex(keccak_256(hexToBytes(expected))));
});

test("self-signed payout: hash, v and recovered sender", () => {
  const priv = secp256k1.utils.randomPrivateKey();
  const sender = ethAddressFromPk(secp256k1.getPublicKey(priv, false));
  const p = { recipient: RECIPIENT, outWei: 995_000_000_000_000n, baseNonce: 7n, gasPrice: 1_200_000n };
  const tx = buildPayoutTx(p);
  const payload = payloadOf(encodeUnsignedLegacy(tx));
  const sr = fakeSigRequest(payload, { privKey: priv });
  const signed = signedFromSigRequest(tx, sr)!;

  assert.equal(signed.v, BigInt(sr.recoveryId) + 35n + 2n * 84532n);
  assert.equal(signed.txHash, "0x" + hex(keccak_256(signed.signedRaw)));

  // Parse the signed RLP independently, rebuild the sighash and recover the sender.
  const [nonce, gasPrice, gasLimit, to, value, data, v, r, s] = rlpList(signed.signedRaw);
  assert.equal(toBig(nonce), 7n);
  assert.equal(toBig(gasPrice), 1_200_000n);
  assert.equal(toBig(gasLimit), 21000n);
  assert.equal(hex(to), hex(RECIPIENT));
  assert.equal(toBig(value), 995_000_000_000_000n);
  assert.equal(data.length, 0);
  const recovery = Number(toBig(v) - 35n - 2n * 84532n);
  const sig = new secp256k1.Signature(toBig(r), toBig(s)).addRecoveryBit(recovery);
  const recovered = sig.recoverPublicKey(payload).toRawBytes(false);
  assert.equal(hex(ethAddressFromPk(recovered)), hex(sender));

  assert.equal(signedFromSigRequest(tx, { ...sr, completed: false }), null);
  assert.throws(() => signedFromSigRequest(buildPayoutTx({ ...p, gasPrice: 1n }), sr), /payload/);
});

test("decodeSigRequest reads soda's 347-byte layout", () => {
  const payload = new Uint8Array(32).fill(3);
  const sr = fakeSigRequest(payload, { expiresAt: 1_700_000_300n });
  const data = encodeSigRequest(sr);
  assert.equal(data.length, 347);
  const back = decodeSigRequest(data);
  assert.deepEqual(back, sr);
  const seeded = { ...sr, derivationSeeds: Uint8Array.of(1, 2, 3) };
  assert.deepEqual(decodeSigRequest(encodeSigRequest(seeded)), seeded);
  const bad = data.slice();
  bad[0] ^= 1;
  assert.throws(() => decodeSigRequest(bad), /SigRequest/);
});

test("buildCandidates rebuilds every candidate, using hints for bumped-over gas prices", () => {
  const prices = [1_000_000n, 1_100_000n, 1_300_000n];
  const intent = filledIntent(prices);
  const srs = sigRequestsFor(intent, prices, [true, true, false]);

  // Intent.gas_price is only the latest; without hints the first two are unresolved.
  const bare = buildCandidates(intent, srs);
  assert.deepEqual(bare.map((c) => c.gasPrice), [null, null, 1_300_000n]);
  assert.equal(bare[2].signed, null); // not completed yet

  const hinted = buildCandidates(intent, srs, { gasPriceHints: [1_000_000n, 1_100_000n, 42n] });
  assert.deepEqual(hinted.map((c) => c.gasPrice), prices);
  assert.ok(hinted[0].signed && hinted[1].signed);
  assert.notEqual(hinted[0].signed!.txHash, hinted[1].signed!.txHash);

  // Without fetched accounts, the PDA check alone resolves gas prices.
  const noAccounts = buildCandidates(intent, [], { gasPriceHints: prices });
  assert.deepEqual(noAccounts.map((c) => c.gasPrice), prices);
  assert.ok(noAccounts.every((c) => c.signed === null && !c.completed));

  // Unsigned RLP from EthTxRequested works too; a wrong one is ignored.
  const fromEvents = new Map<string, Uint8Array>([
    [intent.sigRequests[0].toBase58(), payoutUnsignedRlp({ ...intent, gasPrice: 1_000_000n })],
    [intent.sigRequests[1].toBase58(), payoutUnsignedRlp({ ...intent, gasPrice: 5n })],
  ]);
  const ev = buildCandidates(intent, srs, { unsignedBySigRequest: fromEvents });
  assert.deepEqual(ev.map((c) => c.gasPrice), [1_000_000n, null, 1_300_000n]);
});

test("classifyBroadcastError", () => {
  assert.equal(classifyBroadcastError("eth_sendRawTransaction: already known"), "already_known");
  assert.equal(classifyBroadcastError("known transaction: 0xabc"), "already_known");
  assert.equal(classifyBroadcastError("eth_sendRawTransaction: nonce too low: next nonce 8, tx nonce 7"), "nonce_too_low");
  assert.equal(classifyBroadcastError("replacement transaction underpriced"), "underpriced");
  assert.equal(classifyBroadcastError("insufficient funds for gas * price + value"), "error");
});

// ---------------------------------------------------------------- tracker

class FakeRpc implements PayoutRpc {
  sent: string[] = [];
  receiptCalls = 0;
  receipts = new Map<string, EthReceipt>();
  sendError: ((hex: string) => string | null) | null = null;
  /** Receipts that appear only after a send (models "mined between calls"). */
  minedOnSend = new Map<string, EthReceipt>();

  async sendRawTransaction(signedHex: string): Promise<string> {
    this.sent.push(signedHex);
    const err = this.sendError?.(signedHex);
    for (const [h, r] of this.minedOnSend) this.receipts.set(h, r);
    if (err) throw new Error(`eth_sendRawTransaction: ${err}`);
    return "0x" + hex(keccak_256(hexToBytes(signedHex.slice(2))));
  }

  async getReceipt(txHash: string): Promise<EthReceipt | null> {
    this.receiptCalls++;
    return this.receipts.get(txHash) ?? null;
  }
}

const receipt = (txHash: string, status: 0 | 1 = 1): EthReceipt => ({
  txHash,
  status,
  blockNumber: 100n,
  gasUsed: 21000n,
  effectiveGasPrice: null,
});

function setup(completed: boolean[]) {
  const prices = [1_000_000n, 1_100_000n].slice(0, completed.length);
  const intent = filledIntent(prices);
  const srs = sigRequestsFor(intent, prices, completed);
  return buildCandidates(intent, srs, { gasPriceHints: prices });
}

test("tracker: nothing signed → awaiting_signature, no RPC traffic", async () => {
  const rpc = new FakeRpc();
  const res = await new PayoutTracker(rpc).track(setup([false]));
  assert.equal(res.state, "awaiting_signature");
  assert.equal(rpc.sent.length, 0);
});

test("tracker: broadcasts every completed candidate; 'already known' stays pending", async () => {
  const cands = setup([true, true]);
  const rpc = new FakeRpc();
  rpc.sendError = (h) => (h === cands[0].signed!.signedHex ? "already known" : null);
  let now = 1_000;
  const tracker = new PayoutTracker(rpc, () => now);
  const res = await tracker.track(cands);
  assert.equal(res.state, "pending");
  assert.deepEqual(rpc.sent, [cands[0].signed!.signedHex, cands[1].signed!.signedHex]);
  assert.deepEqual(res.attempts.map((a) => a.outcome), ["already_known", "sent"]);
  now = 31_000;
  assert.equal(tracker.pendingForMs(cands), 30_000);
});

test("tracker: a receipt on ANY candidate (even the older one) is delivered", async () => {
  const cands = setup([true, true]);
  const rpc = new FakeRpc();
  rpc.receipts.set(cands[0].signed!.txHash, receipt(cands[0].signed!.txHash));
  const res = await new PayoutTracker(rpc).track(cands);
  assert.equal(res.state, "delivered");
  assert.equal(res.delivered!.index, 0);
  assert.equal(res.delivered!.status, 1);
  assert.equal(rpc.sent.length, 0); // no rebroadcast once delivered
});

test("tracker: reverted receipt is delivered with status 0", async () => {
  const cands = setup([true]);
  const rpc = new FakeRpc();
  rpc.receipts.set(cands[0].signed!.txHash, receipt(cands[0].signed!.txHash, 0));
  const res = await new PayoutTracker(rpc).track(cands);
  assert.equal(res.state, "delivered");
  assert.equal(res.delivered!.status, 0);
});

test("tracker: 'nonce too low' alone is never delivered", async () => {
  const cands = setup([true, true]);
  const rpc = new FakeRpc();
  rpc.sendError = () => "nonce too low";
  const res = await new PayoutTracker(rpc).track(cands);
  assert.equal(res.state, "nonce_used");
  assert.equal(res.delivered, null);
  assert.equal(rpc.receiptCalls, 4); // checked before broadcasting, then re-checked
});

test("tracker: 'nonce too low' triggers a receipt re-check that finds the mined candidate", async () => {
  const cands = setup([true, true]);
  const rpc = new FakeRpc();
  const h1 = cands[1].signed!.txHash;
  rpc.minedOnSend.set(h1, receipt(h1));
  rpc.sendError = () => "nonce too low";
  const res = await new PayoutTracker(rpc).track(cands);
  assert.equal(res.state, "delivered");
  assert.equal(res.delivered!.index, 1);
  assert.equal(res.delivered!.txHash, h1);
});

test("tracker: unresolved candidates are reported", async () => {
  const prices = [1_000_000n, 1_100_000n];
  const intent = filledIntent(prices);
  const cands = buildCandidates(intent, sigRequestsFor(intent, prices, [true, true]));
  const res = await new PayoutTracker(new FakeRpc()).track(cands);
  assert.deepEqual(res.unresolved, [0]);
  assert.equal(res.attempts.length, 1);
});
