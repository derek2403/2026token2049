// LiteSVM integration tests: the built soda_witness program, written to by
// Chainlink's mock forwarder exactly as `cre workflow simulate --broadcast`
// does. HANDOVER §4.2.
//
// fixtures/mock_forwarder.so is built from chainlink-solana
// contracts/programs/mock-forwarder (develop) with Anchor 0.32.1, because
// devnet RPC was rate-limited. To test against the deployed binary instead:
//   solana program dump 7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK programs/tests/fixtures/mock_forwarder.so --url devnet
//
//   anchor build (in programs/), then from the repo root:
//   npx tsx --test programs/tests/witness.test.ts
//
// SODA_WITNESS_SO and MOCK_FORWARDER_SO override the binaries.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { address, getTransactionDecoder, lamports } from "@solana/kit";
import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

const WITNESS = new PublicKey("5v97wLYgMzyfQfpZWGQ6uPXTHh4JsJitUXPReYy2uuTp");
const MOCK_FORWARDER = new PublicKey("7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK");
const MOCK_STATE = new PublicKey("5Tipz3yhTBdVsDbaBxZkrp7Gjf3brGq5SKkxReefPMP7");

const ROOT = path.resolve(__dirname, "..");
const WITNESS_SO = process.env.SODA_WITNESS_SO ?? path.join(ROOT, "target/deploy/soda_witness.so");
const MOCK_FORWARDER_SO = process.env.MOCK_FORWARDER_SO ?? path.join(ROOT, "tests/fixtures/mock_forwarder.so");
const IDL = JSON.parse(readFileSync(path.join(ROOT, "../idl/soda_witness.json"), "utf8")) as Idl;

const ERR = {
  NotAdmin: 6000,
  MismatchedForwarderProgram: 6001,
  InvalidForwarderState: 6002,
  InvalidForwarderAuthority: 6003,
  InvalidMetadataLength: 6004,
  WorkflowOwnerMismatch: 6005,
  WorkflowNameMismatch: 6006,
  InvalidReportLength: 6007,
  UnsupportedReportVersion: 6008,
  ClaimNotPending: 6009,
  ChainIdMismatch: 6010,
  TxHashMismatch: 6011,
  // Anchor framework
  ConstraintSeeds: 2006,
  AccountNotSigner: 3010,
} as const;

const T0 = 1_700_000_000n;
const BASE_SEPOLIA = 84_532n;
const TX_HASH = new Uint8Array(32).fill(0x11);
const FROM = new Uint8Array(20).fill(0xf1);
const TO = new Uint8Array(20).fill(0x7e);
const OWNER = new Uint8Array(20).fill(0x0a);
const NAME = Uint8Array.from(Buffer.from("sodawitnes"));

const coder = new BorshCoder(IDL);
const bn = (n: bigint | number) => new BN(n.toString());
const disc = (s: string) => sha256(new TextEncoder().encode(s)).slice(0, 8);

type Report = {
  ver: number;
  chain_id: bigint;
  tx_hash: Uint8Array;
  from: Uint8Array;
  to: Uint8Array;
  value_wei: bigint;
  block: bigint;
  status: number;
};
type Sent = { ok: boolean; code: number | null; logs: string[]; cu: bigint };

function report(over: Partial<Report> = {}): Report {
  return {
    ver: 1,
    chain_id: BASE_SEPOLIA,
    tx_hash: TX_HASH,
    from: FROM,
    to: TO,
    value_wei: 1_234_567_890_123_456_789n,
    block: 34_000_000n,
    status: 1,
    ...over,
  };
}

function encodeReport(r: Report): Uint8Array {
  return coder.types.encode("WitnessReport", {
    ver: r.ver,
    chain_id: bn(r.chain_id),
    tx_hash: [...r.tx_hash],
    from: [...r.from],
    to: [...r.to],
    value_wei: bn(r.value_wei),
    block: bn(r.block),
    status: r.status,
  });
}

/** Receiver metadata: workflow_cid | workflow_name (10) | workflow_owner (20) | report_id (2). */
function metadata(owner = OWNER, name = NAME): Uint8Array {
  const m = new Uint8Array(64);
  m.fill(0xc1, 0, 32);
  m.set(name, 32);
  m.set(owner, 42);
  m.set([0x00, 0x01], 62);
  return m;
}

function errorCode(r: FailedTransactionMetadata, logs: string[]): number | null {
  const e = r.err() as { index?: number; err?: () => unknown };
  if (typeof e.index === "number" && typeof e.err === "function") {
    const inner = e.err() as { code?: number };
    if (inner && typeof inner === "object" && typeof inner.code === "number") return inner.code;
  }
  for (const l of logs) {
    const m = /custom program error: 0x([0-9a-f]+)/.exec(l);
    if (m) return parseInt(m[1], 16);
  }
  return null;
}

const forwarderAuthority = (state: PublicKey, forwarder = MOCK_FORWARDER) =>
  PublicKey.findProgramAddressSync([Buffer.from("forwarder"), state.toBuffer(), WITNESS.toBuffer()], forwarder)[0];
const configPda = () => PublicKey.findProgramAddressSync([Buffer.from("config")], WITNESS)[0];
function claimPda(requester: PublicKey, chainId: bigint, txHash: Uint8Array): PublicKey {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(chainId);
  return PublicKey.findProgramAddressSync([Buffer.from("claim"), requester.toBuffer(), le, txHash], WITNESS)[0];
}

/** One fresh chain per test: soda_witness, the mock forwarder and its state account. */
class Env {
  svm = new LiteSVM();
  feePayer = Keypair.generate();
  admin = Keypair.generate();
  user = Keypair.generate();
  transmitter = Keypair.generate();
  config = configPda();

  constructor() {
    this.svm.addProgramFromFile(address(WITNESS.toBase58()), WITNESS_SO);
    this.svm.addProgramFromFile(address(MOCK_FORWARDER.toBase58()), MOCK_FORWARDER_SO);
    this.addForwarderState(MOCK_STATE);
    for (const k of [this.feePayer, this.admin, this.user, this.transmitter]) {
      this.svm.airdrop(address(k.publicKey.toBase58()), lamports(100n * BigInt(LAMPORTS_PER_SOL)));
    }
    const c = this.svm.getClock();
    c.unixTimestamp = T0;
    this.svm.setClock(c);
  }

  /** The mock's `ForwarderState` is an empty Anchor account: discriminator only. */
  addForwarderState(pk: PublicKey, owner = MOCK_FORWARDER) {
    this.svm.setAccount({
      address: address(pk.toBase58()),
      data: disc("account:ForwarderState"),
      executable: false,
      lamports: lamports(this.svm.minimumBalanceForRentExemption(8n)),
      programAddress: address(owner.toBase58()),
      space: 8n,
    });
  }

  send(ixs: TransactionInstruction[], signers: Keypair[]): Sent {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs);
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.feePayer = this.feePayer.publicKey;
    tx.sign(this.feePayer, ...signers);
    const r: TransactionMetadata | FailedTransactionMetadata = this.svm.sendTransaction(
      getTransactionDecoder().decode(tx.serialize()),
    );
    this.svm.expireBlockhash();
    if (r instanceof FailedTransactionMetadata) {
      const logs = r.meta().logs();
      return { ok: false, code: errorCode(r, logs), logs, cu: r.meta().computeUnitsConsumed() };
    }
    return { ok: true, code: null, logs: r.logs(), cu: r.computeUnitsConsumed() };
  }

  ix(name: string, args: Record<string, unknown>, keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) {
    return new TransactionInstruction({ programId: WITNESS, keys, data: coder.instruction.encode(name, args) });
  }

  initConfig(o: { forwarder?: PublicKey; state?: PublicKey; owner?: Uint8Array; name?: Uint8Array } = {}): Sent {
    return this.send([this.configIx("init_config", this.admin, o, true)], [this.admin]);
  }

  setConfig(
    o: { forwarder?: PublicKey; state?: PublicKey; owner?: Uint8Array; name?: Uint8Array } = {},
    signer = this.admin,
  ): Sent {
    return this.send([this.configIx("set_config", signer, o, false)], [signer]);
  }

  private configIx(
    name: string,
    signer: Keypair,
    o: { forwarder?: PublicKey; state?: PublicKey; owner?: Uint8Array; name?: Uint8Array },
    init: boolean,
  ) {
    const keys = [
      { pubkey: signer.publicKey, isSigner: true, isWritable: init },
      { pubkey: this.config, isSigner: false, isWritable: true },
    ];
    if (init) keys.push({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false });
    return this.ix(
      name,
      {
        forwarder_program: o.forwarder ?? MOCK_FORWARDER,
        forwarder_state: o.state ?? MOCK_STATE,
        workflow_owner: [...(o.owner ?? new Uint8Array(20))],
        workflow_name: [...(o.name ?? new Uint8Array(10))],
      },
      keys,
    );
  }

  openClaim(requester = this.user, chainId = BASE_SEPOLIA, txHash = TX_HASH, claim?: PublicKey): Sent {
    return this.send(
      [
        this.ix("open_claim", { chain_id: bn(chainId), tx_hash: [...txHash] }, [
          { pubkey: requester.publicKey, isSigner: true, isWritable: true },
          { pubkey: claim ?? claimPda(requester.publicKey, chainId, txHash), isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]),
      ],
      [requester],
    );
  }

  /**
   * The path `cre workflow simulate --broadcast` takes: mock_forwarder.report
   * with data = 0 signatures | raw_report | report_context (96 zero bytes),
   * raw_report = forwarder metadata (45) | receiver metadata (64) | borsh{account_hash, payload}.
   * The mock CPIs on_report with [state, forwarder_authority, ...remaining].
   */
  forward(
    payload: Uint8Array,
    o: { claim?: PublicKey; meta?: Uint8Array; state?: PublicKey; remaining?: PublicKey[] } = {},
  ): Sent {
    const state = o.state ?? MOCK_STATE;
    const authority = forwarderAuthority(state);
    const claim = o.claim ?? claimPda(this.user.publicKey, BASE_SEPOLIA, TX_HASH);
    const remaining = o.remaining ?? [this.config, claim];
    const accountHash = sha256(Buffer.concat([state, authority, ...remaining].map((k) => k.toBuffer())));

    const fwdMeta = new Uint8Array(45);
    fwdMeta[0] = 1; // version
    fwdMeta.fill(0xe0, 1, 33); // workflow_execution_id
    const lenLe = Buffer.alloc(4);
    lenLe.writeUInt32LE(payload.length);
    const rawReport = Buffer.concat([fwdMeta, o.meta ?? metadata(), accountHash, lenLe, payload]);
    const data = Buffer.concat([Buffer.from([0]), rawReport, Buffer.alloc(96)]);
    const dataLen = Buffer.alloc(4);
    dataLen.writeUInt32LE(data.length);

    const keys = [
      { pubkey: state, isSigner: false, isWritable: false },
      { pubkey: this.transmitter.publicKey, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: WITNESS, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...remaining.map((pubkey) => ({ pubkey, isSigner: false, isWritable: pubkey.equals(claim) })),
    ];
    const ix = new TransactionInstruction({
      programId: MOCK_FORWARDER,
      keys,
      data: Buffer.concat([disc("global:report"), dataLen, data]),
    });
    return this.send([ix], [this.transmitter]);
  }

  /** on_report called directly, with an arbitrary keypair posing as the forwarder authority. */
  directOnReport(fakeAuthority: Keypair, payload: Uint8Array, state = MOCK_STATE): Sent {
    return this.send(
      [
        this.ix("on_report", { metadata: Buffer.from(metadata()), report: Buffer.from(payload) }, [
          { pubkey: state, isSigner: false, isWritable: false },
          { pubkey: fakeAuthority.publicKey, isSigner: true, isWritable: false },
          { pubkey: this.config, isSigner: false, isWritable: false },
          { pubkey: claimPda(this.user.publicKey, BASE_SEPOLIA, TX_HASH), isSigner: false, isWritable: true },
        ]),
      ],
      [fakeAuthority],
    );
  }

  claim(pk = claimPda(this.user.publicKey, BASE_SEPOLIA, TX_HASH)) {
    const a = this.svm.getAccount(address(pk.toBase58()));
    assert.ok(a.exists, "claim account missing");
    return coder.accounts.decode("Claim", Buffer.from(a.data));
  }

  configAccount() {
    const a = this.svm.getAccount(address(this.config.toBase58()));
    assert.ok(a.exists, "config account missing");
    return coder.accounts.decode("Config", Buffer.from(a.data));
  }
}

function expectErr(r: Sent, code: number) {
  assert.equal(r.ok, false, `expected error ${code}, transaction succeeded`);
  assert.equal(r.code, code, `expected ${code}, got ${r.code}\n${r.logs.join("\n")}`);
  // The mock forwarder's own errors share the 6000 range (6002 = InvalidAccountHash),
  // so also match the name soda_witness logs.
  const name = Object.entries(ERR).find(([, c]) => c === code)![0];
  assert.ok(r.logs.some((l) => l.includes(`Error Code: ${name}.`)), `no ${name} in logs\n${r.logs.join("\n")}`);
}
function expectOk(r: Sent) {
  assert.equal(r.ok, true, r.logs.join("\n"));
}

/** Env with config (no workflow pinning) and the user's Pending claim. */
function ready(): Env {
  const env = new Env();
  expectOk(env.initConfig());
  expectOk(env.openClaim());
  return env;
}

describe("soda_witness", () => {
  it("IDL: address, on_report discriminator and account order", () => {
    assert.equal((IDL as { address: string }).address, WITNESS.toBase58());
    const ix = IDL.instructions.find((i) => i.name === "on_report")!;
    assert.deepEqual([...ix.discriminator], [214, 173, 18, 221, 173, 148, 151, 208]);
    assert.deepEqual([...disc("global:on_report")], [214, 173, 18, 221, 173, 148, 151, 208]);
    assert.deepEqual(
      ix.accounts.map((a) => a.name),
      ["state", "forwarder_authority", "config", "claim"],
    );
    assert.equal(encodeReport(report()).length, 106);
  });

  it("config: init, admin-only set_config, init once", () => {
    const env = new Env();
    expectOk(env.initConfig({ owner: OWNER }));
    let c = env.configAccount();
    assert.ok(c.admin.equals(env.admin.publicKey));
    assert.ok(c.forwarder_program.equals(MOCK_FORWARDER));
    assert.ok(c.forwarder_state.equals(MOCK_STATE));
    assert.equal(bytesToHex(Uint8Array.from(c.workflow_owner)), bytesToHex(OWNER));

    expectErr(env.setConfig({ owner: new Uint8Array(20) }, env.user), ERR.NotAdmin);
    const prod = new PublicKey("CXsKEJcs25TQEYU2e5jZ8QTPE3ffMLZhH6BWHrdcCCB5");
    expectOk(env.setConfig({ forwarder: prod, name: NAME }));
    c = env.configAccount();
    assert.ok(c.forwarder_program.equals(prod));
    assert.equal(Buffer.from(c.workflow_name).toString(), "sodawitnes");
    assert.equal(env.initConfig().ok, false);
  });

  it("open_claim: Pending, seeds keyed on the requester", () => {
    const env = ready();
    const c = env.claim();
    assert.ok(c.requester.equals(env.user.publicKey));
    assert.equal(BigInt(c.chain_id.toString()), BASE_SEPOLIA);
    assert.equal(bytesToHex(Uint8Array.from(c.tx_hash)), bytesToHex(TX_HASH));
    assert.equal(c.status, 0);

    // Someone else gets their own claim for the same tx...
    const other = Keypair.generate();
    env.svm.airdrop(address(other.publicKey.toBase58()), lamports(BigInt(LAMPORTS_PER_SOL)));
    expectOk(env.openClaim(other));
    // ...but cannot create the user's.
    expectErr(
      env.openClaim(other, BASE_SEPOLIA, TX_HASH, claimPda(env.user.publicKey, BASE_SEPOLIA, TX_HASH)),
      ERR.ConstraintSeeds,
    );
    // Same requester, same (chain, tx): exists already.
    assert.equal(env.openClaim().ok, false);
  });

  it("happy path through the mock forwarder stores every field", () => {
    const env = ready();
    const r = env.forward(encodeReport(report()));
    expectOk(r);
    assert.ok(r.logs.some((l) => l.includes(`metadata: ${bytesToHex(metadata())}`)), "metadata logged");
    // The CRE workflow writes with computeLimit 200_000.
    assert.ok(r.cu < 200_000n, `forwarder + on_report used ${r.cu} CU`);
    const c = env.claim();
    assert.equal(c.status, 1);
    assert.equal(bytesToHex(Uint8Array.from(c.from)), bytesToHex(FROM));
    assert.equal(bytesToHex(Uint8Array.from(c.to)), bytesToHex(TO));
    assert.equal(BigInt(c.value_wei.toString()), report().value_wei);
    assert.equal(BigInt(c.block.toString()), report().block);
    assert.equal(c.success, true);
    assert.equal(BigInt(c.recorded_at.toString()), T0);
  });

  it("reverted tx records success = false", () => {
    const env = ready();
    expectOk(env.forward(encodeReport(report({ status: 0 }))));
    const c = env.claim();
    assert.equal(c.status, 1);
    assert.equal(c.success, false);
  });

  it("replay after Recorded fails", () => {
    const env = ready();
    expectOk(env.forward(encodeReport(report())));
    expectErr(env.forward(encodeReport(report({ status: 0 }))), ERR.ClaimNotPending);
    assert.equal(env.claim().success, true);
  });

  it("forwarder state owned by another program", () => {
    const env = ready();
    // Config expects the production forwarder; the mock (simulation) writes anyway.
    expectOk(env.setConfig({ forwarder: new PublicKey("CXsKEJcs25TQEYU2e5jZ8QTPE3ffMLZhH6BWHrdcCCB5") }));
    expectErr(env.forward(encodeReport(report())), ERR.MismatchedForwarderProgram);
  });

  it("forwarder state with the right owner but the wrong key", () => {
    const env = ready();
    const rogue = Keypair.generate().publicKey;
    env.addForwarderState(rogue);
    expectErr(env.forward(encodeReport(report()), { state: rogue }), ERR.InvalidForwarderState);
  });

  it("forwarder_authority that is not the forwarder's PDA", () => {
    const env = ready();
    // Any keypair can sign, but it is not ["forwarder", state, soda_witness] under the forwarder.
    expectErr(env.directOnReport(Keypair.generate(), encodeReport(report())), ERR.InvalidForwarderAuthority);
    // The real PDA cannot sign outside the forwarder's invoke_signed.
    const r = env.send(
      [
        env.ix("on_report", { metadata: Buffer.from(metadata()), report: Buffer.from(encodeReport(report())) }, [
          { pubkey: MOCK_STATE, isSigner: false, isWritable: false },
          { pubkey: forwarderAuthority(MOCK_STATE), isSigner: false, isWritable: false },
          { pubkey: env.config, isSigner: false, isWritable: false },
          { pubkey: claimPda(env.user.publicKey, BASE_SEPOLIA, TX_HASH), isSigner: false, isWritable: true },
        ]),
      ],
      [],
    );
    expectErr(r, ERR.AccountNotSigner);
    assert.equal(env.claim().status, 0);
  });

  it("workflow owner and name, when pinned", () => {
    const env = ready();
    expectOk(env.setConfig({ owner: OWNER }));
    expectErr(env.forward(encodeReport(report()), { meta: metadata(new Uint8Array(20).fill(0xbb)) }), ERR.WorkflowOwnerMismatch);
    expectOk(env.setConfig({ owner: OWNER, name: NAME }));
    expectErr(
      env.forward(encodeReport(report()), { meta: metadata(OWNER, Uint8Array.from(Buffer.from("otherflow!"))) }),
      ERR.WorkflowNameMismatch,
    );
    expectOk(env.forward(encodeReport(report())));
    assert.equal(env.claim().status, 1);
  });

  it("report/claim mismatch: chain_id and tx_hash", () => {
    const env = ready();
    expectErr(env.forward(encodeReport(report({ chain_id: 11_155_111n }))), ERR.ChainIdMismatch);
    expectErr(env.forward(encodeReport(report({ tx_hash: new Uint8Array(32).fill(0x22) }))), ERR.TxHashMismatch);
    assert.equal(env.claim().status, 0);
  });

  it("report version and length", () => {
    const env = ready();
    expectErr(env.forward(encodeReport(report({ ver: 2 }))), ERR.UnsupportedReportVersion);
    const ok = encodeReport(report());
    expectErr(env.forward(ok.slice(0, 105)), ERR.InvalidReportLength);
    expectErr(env.forward(Buffer.concat([ok, Buffer.from([0])])), ERR.InvalidReportLength);
    assert.equal(env.claim().status, 0);
  });
});
