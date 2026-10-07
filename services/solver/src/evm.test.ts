import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bigintToBe, ethAddressFromPk } from "../../../lib/soda";
import { PublicKey } from "@solana/web3.js";
import { DEFAULT_INTENTS_PROGRAM_ID } from "../../../lib/intents";
import { checksumAddr, evmAddressOf, parseEther, parseEvmAddress, parseSol, personalSign, signDepositProof, signLegacy } from "./evm";

test("signLegacy reproduces the EIP-155 spec example", () => {
  const key = hexToBytes("46".repeat(32));
  const signed = signLegacy(
    {
      nonce: 9n,
      gasPriceWei: 20_000_000_000n,
      gasLimit: 21_000n,
      to: hexToBytes("35".repeat(20)),
      valueWeiBe: bigintToBe(10n ** 18n, 32),
      data: new Uint8Array(0),
      chainId: 1n,
    },
    key,
  );
  assert.equal(
    signed.rawHex,
    "0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83",
  );
  assert.equal(signed.txHash, "0x33469b22e9f636356c4160a87eb19df52b7412e8eac32a4a55ffe88ea8350788");
});

test("evmAddressOf matches the EIP-155 example key's address", () => {
  assert.equal(bytesToHex(evmAddressOf(hexToBytes("46".repeat(32)))), "9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f");
});

test("EIP-55 checksums", () => {
  const a = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  assert.equal(checksumAddr(a.toLowerCase()), a);
  assert.equal(bytesToHex(parseEvmAddress(a)), a.slice(2).toLowerCase());
  assert.doesNotThrow(() => parseEvmAddress(a.toLowerCase()));
  assert.throws(() => parseEvmAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"), /checksum/);
  assert.throws(() => parseEvmAddress("0x1234"));
});

test("parseEther and parseSol", () => {
  assert.equal(parseEther("0.05"), 50_000_000_000_000_000n);
  assert.equal(parseEther("1"), 10n ** 18n);
  assert.equal(parseEther("0.000000000000000001"), 1n);
  assert.throws(() => parseEther("0.0000000000000000001"));
  assert.equal(parseSol("0.1"), 100_000_000n);
  assert.equal(parseSol("2"), 2_000_000_000n);
  assert.throws(() => parseSol("1e9"));
});

test("personalSign recovers to the signer's address over the EIP-191 digest", () => {
  const key = hexToBytes("46".repeat(32));
  const msg = new TextEncoder().encode("hello world");
  const sig = personalSign(msg, key);
  assert.ok(sig[64] === 27 || sig[64] === 28);
  const digest = keccak_256(new Uint8Array([...new TextEncoder().encode("\x19Ethereum Signed Message:\n11"), ...msg]));
  const pk = secp256k1.Signature.fromCompact(sig.subarray(0, 64)).addRecoveryBit(sig[64] - 27).recoverPublicKey(digest);
  assert.equal(bytesToHex(ethAddressFromPk(pk.toRawBytes(false))), "9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f");
});

// The Rust unit test deposit_proof_recovers_the_signer recovers 0x9d8a..5a4f from this signature.
test("signDepositProof is the vector the program's Rust test recovers", () => {
  const sig = signDepositProof(hexToBytes("46".repeat(32)), new PublicKey(new Uint8Array(32).fill(5)), new PublicKey(DEFAULT_INTENTS_PROGRAM_ID));
  assert.equal(
    bytesToHex(sig),
    "23ac4512da552760084a04b3239900d577b764d229ff79dd37eda723a125b0ff6668ba3ae0d323e747e6377b26f3b04b5b62483f10183a50930668f0a67a7d401c",
  );
});
