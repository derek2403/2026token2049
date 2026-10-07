// LiteSVM tests for RFQ-lite: user vaults and execute_signed_intent, against
// the built intents program and the real soda program dumped from devnet.
//
//   anchor build (in programs/), then from the repo root:
//   npx tsx --test programs/tests/rfq.test.ts
//
// fixtures/noop.so is a do-nothing program (a no_std `entrypoint` returning 0,
// built with cargo-build-sbf). It carries arbitrary instruction data: a fake
// "Ed25519" instruction under another program, and the bytes another Ed25519
// instruction can point its offsets at. INTENTS_SO=<path> runs the suite
// against another build (e.g. a mutant with a signature check removed).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { address, getTransactionDecoder, lamports } from "@solana/kit";
import { BN, BorshCoder } from "@coral-xyz/anchor";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { signDepositProof } from "../../services/solver/src/evm";
import {
  COMMITTEE_PDA,
  configPda,
  creditPda,
  decodeConfig,
  decodeIntent,
  decodeSigRequest,
  decodeSolver,
  GROUP_PK,
  INTENTS_IDL,
  intentPda,
  IntentStatus,
  parseIntentsLogs,
  payoutCost,
  payoutSigRequest,
  poolEvmAddress,
  poolPda,
  renderIntentMessage,
  solverPda,
  type IntentsEvent,
} from "../../lib/intents";

const PROGRAM_ID = new PublicKey("BV9KfzKwXPp9hQZEyhoVm9STbDy7gCGCmKcKpCDr8jXA");
const SODA = new PublicKey("CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J");
const NOOP = new PublicKey(new Uint8Array(32).fill(0x4e));
const ROOT = path.resolve(__dirname, "..");
const INTENTS_SO = process.env.INTENTS_SO ?? path.join(ROOT, "target/deploy/intents.so");
const SODA_SO = path.join(ROOT, "tests/fixtures/soda.so");
const NOOP_SO = path.join(ROOT, "tests/fixtures/noop.so");
const COMMITTEE_JSON = path.join(ROOT, "tests/fixtures/committee.json");
const VECTORS = JSON.parse(readFileSync(path.join(ROOT, "../lib/intents/rfq-vectors.json"), "utf8")) as {
  vectors: { program_id: string; user: string; nonce: string; deadline: string; sell_lamports: string; min_out_wei: string; recipient: string; message: string }[];
};

const ERR = {
  Paused: 6000,
  BelowRequiredOut: 6003,
  GasPriceTooHigh: 6004,
  InsufficientSolverBalance: 6005,
  NonceMoved: 6006,
  GasPriceTooLow: 6013,
  ZeroAmount: 6014,
  InvalidSignatureInstruction: 6027,
  SignatureMismatch: 6028,
  DeadlinePassed: 6029,
  DeadlineTooFar: 6030,
  InsufficientVaultBalance: 6031,
  ZeroRecipient: 6032,
  ConstraintSeeds: 2006,
  ConstraintAddress: 2012,
  AccountNotInitialized: 3012,
} as const;

const T0 = 1_700_000_000n;
const GWEI = 1_000_000_000n;
const ETH = 10n ** 18n;
const SOL = BigInt(LAMPORTS_PER_SOL);
const L1_BUFFER = 20_000_000_000_000n; // as on devnet
const MIN_GAS = 1_000_000n; // as on devnet
const MAX_GAS = 5n * GWEI;
const RECIPIENT = new Uint8Array(20).fill(0xaa);
const DEPOSIT_KEY = hexToBytes("46".repeat(32));
const VAULT_SIZE = 49;
const TX_LIMIT = 1232;
const U16_MAX = 0xffff;

const coder = new BorshCoder(INTENTS_IDL);
const bn = (n: bigint | number) => new BN(n.toString());
const enc = (s: string) => new TextEncoder().encode(s);
const big = (v: unknown) => BigInt((v as { toString(): string }).toString());
const show = (o: unknown) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? bytesToHex(v) : v));

/** The shared renderer (lib/intents/rfq.ts), checked against rfq-vectors.json below. */
function renderMessage(programId: PublicKey, a: { user: PublicKey; nonce: bigint; deadline: bigint; sellLamports: bigint; minOutWei: bigint; recipient: Uint8Array }): Uint8Array {
  return renderIntentMessage(a, programId);
}

type Entry = { publicKey: Uint8Array; signature: Uint8Array; message: Uint8Array };
type Indices = { sig?: number; pk?: number; msg?: number };

/**
 * Ed25519 program data in web3.js's layout: count, padding, one offsets struct
 * per entry, then pk | sig | msg per entry. Indices default to u16::MAX (this
 * instruction); entries of equal size land at equal offsets in any instruction.
 */
function ed25519Data(entries: Entry[], ix: Indices = {}): Uint8Array {
  const head = 2 + 14 * entries.length;
  const d = new Uint8Array(head + entries.reduce((n, e) => n + 96 + e.message.length, 0));
  const dv = new DataView(d.buffer);
  d[0] = entries.length;
  let at = head;
  entries.forEach((e, i) => {
    const [pk, sig, msg] = [at, at + 32, at + 96];
    d.set(e.publicKey, pk);
    d.set(e.signature, sig);
    d.set(e.message, msg);
    [sig, ix.sig ?? U16_MAX, pk, ix.pk ?? U16_MAX, msg, e.message.length, ix.msg ?? U16_MAX]
      .forEach((v, k) => dv.setUint16(2 + 14 * i + 2 * k, v, true));
    at = msg + e.message.length;
  });
  return d;
}

const dataIx = (programId: PublicKey, data: Uint8Array) => new TransactionInstruction({ programId, keys: [], data: Buffer.from(data) });
const sign = (message: Uint8Array, k: Keypair) => ed25519.sign(message, k.secretKey.slice(0, 32));

type Args = {
  user: PublicKey;
  nonce: bigint;
  deadline: bigint;
  sellLamports: bigint;
  minOutWei: bigint;
  recipient: Uint8Array;
  outWei: bigint;
  expectedNonce: bigint;
  gasPrice: bigint;
  ed25519IxIndex: number;
};

type Sent = { ok: boolean; code: number | null; logs: string[]; cu: bigint; events: IntentsEvent[]; size: number };

/** The intents program ran, so any Ed25519 instruction passed the precompile. */
const reachedProgram = (r: Sent) => r.logs.some((l) => l.startsWith(`Program ${PROGRAM_ID.toBase58()} invoke`));
const eventNames = (r: Sent) => r.events.map((e) => (e.name === "Other" ? e.eventName : e.name));
const eventData = (r: Sent, name: string) => {
  const e = r.events.find((x) => x.name === "Other" && x.eventName === name);
  assert.ok(e && e.name === "Other", `no ${name} event`);
  return e.data;
};

class Env {
  svm = new LiteSVM();
  admin = Keypair.generate();
  solver = Keypair.generate();
  user = Keypair.generate();
  stranger = Keypair.generate();
  config = configPda(PROGRAM_ID)[0];
  pool = poolPda(PROGRAM_ID)[0];
  private nextNonce = 1n;

  constructor() {
    this.svm.addProgramFromFile(address(PROGRAM_ID.toBase58()), INTENTS_SO);
    this.svm.addProgramFromFile(address(SODA.toBase58()), SODA_SO);
    this.svm.addProgramFromFile(address(NOOP.toBase58()), NOOP_SO);
    const c = JSON.parse(readFileSync(COMMITTEE_JSON, "utf8"));
    const data = Buffer.from(c.account.data[0], "base64");
    this.svm.setAccount({
      address: address(c.pubkey),
      data,
      executable: false,
      lamports: lamports(BigInt(c.account.lamports)),
      programAddress: address(c.account.owner),
      space: BigInt(data.length),
    });
    for (const k of [this.admin, this.solver, this.user, this.stranger]) {
      this.svm.airdrop(address(k.publicKey.toBase58()), lamports(100n * SOL));
    }
    this.svm.warpToSlot(100n); // lookup tables extended at slot 0 are active
    this.setTime(T0);
    assert.ok(this.send([this.ix("init_config", {
      pool_evm_addr: [...poolEvmAddress(GROUP_PK, PROGRAM_ID)],
      max_gas_price: bn(MAX_GAS),
      l1_fee_buffer_wei: bn(L1_BUFFER),
      min_gas_price: bn(MIN_GAS),
    }, { admin: this.admin.publicKey, config: this.config, pool: this.pool, system_program: SystemProgram.programId })], this.admin).ok);
    const sig = signDepositProof(DEPOSIT_KEY, this.solver.publicKey, PROGRAM_ID);
    assert.ok(this.send([this.ix("register_solver", {
      payout_addr: [...new Uint8Array(20).fill(0x99)],
      deposit_from: [...hexToBytes("9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f")],
      deposit_sig: [...sig],
    }, { authority: this.solver.publicKey, solver: solverPda(this.solver.publicKey, PROGRAM_ID)[0], system_program: SystemProgram.programId })], this.solver).ok);
    const txHash = Keypair.generate().publicKey.toBytes();
    assert.ok(this.send([this.ix("credit_solver", { amount_wei: bn(ETH), tx_hash: [...txHash] }, {
      admin: this.admin.publicKey,
      config: this.config,
      solver: solverPda(this.solver.publicKey, PROGRAM_ID)[0],
      credit: creditPda(txHash, PROGRAM_ID)[0],
      system_program: SystemProgram.programId,
    })], this.admin).ok);
  }

  setTime(t: bigint) {
    const c = this.svm.getClock();
    c.unixTimestamp = t;
    this.svm.setClock(c);
  }
  now() {
    return this.svm.getClock().unixTimestamp;
  }
  balance(pk: PublicKey): bigint {
    return BigInt(this.svm.getBalance(address(pk.toBase58())) ?? 0n);
  }
  raw(pk: PublicKey) {
    const a = this.svm.getAccount(address(pk.toBase58()));
    return a.exists && a.lamports > 0n
      ? { data: Uint8Array.from(a.data), lamports: BigInt(a.lamports), owner: new PublicKey(a.programAddress) }
      : null;
  }
  rent() {
    return this.svm.minimumBalanceForRentExemption(BigInt(VAULT_SIZE));
  }
  vaultPda(owner = this.user.publicKey) {
    return PublicKey.findProgramAddressSync([enc("vault"), owner.toBytes()], PROGRAM_ID)[0];
  }
  vault(owner = this.user.publicKey) {
    const a = this.raw(this.vaultPda(owner));
    if (!a) return null;
    const d = coder.accounts.decode("UserVault", Buffer.from(a.data));
    return { owner: d.owner as PublicKey, sol: BigInt(d.sol.toString()), lamports: a.lamports };
  }
  cfg() {
    return decodeConfig(this.raw(this.config)!.data);
  }
  ledger() {
    return decodeSolver(this.raw(solverPda(this.solver.publicKey, PROGRAM_ID)[0])!.data);
  }

  /**
   * A v0 lookup table holding every non-signer, non-program key of `ixs`, so
   * the multi-instruction attack transactions below fit in 1232 bytes.
   */
  lookupTable(ixs: TransactionInstruction[]): AddressLookupTableAccount {
    const programs = new Set(ixs.map((i) => i.programId.toBase58()));
    const keys = [...new Set(ixs.flatMap((i) => i.keys.filter((k) => !k.isSigner).map((k) => k.pubkey.toBase58())))]
      .filter((k) => !programs.has(k))
      .map((k) => new PublicKey(k));
    const key = Keypair.generate().publicKey;
    // LookupTableMeta (56 bytes): type 1, deactivation u64::MAX, extended at slot 0, authority None.
    const data = new Uint8Array(56 + 32 * keys.length);
    const dv = new DataView(data.buffer);
    dv.setUint32(0, 1, true);
    dv.setBigUint64(4, 2n ** 64n - 1n, true);
    keys.forEach((k, i) => data.set(k.toBytes(), 56 + 32 * i));
    this.svm.setAccount({
      address: address(key.toBase58()),
      data,
      executable: false,
      lamports: lamports(this.svm.minimumBalanceForRentExemption(BigInt(data.length))),
      programAddress: address(AddressLookupTableProgram.programId.toBase58()),
      space: BigInt(data.length),
    });
    return new AddressLookupTableAccount({ key, state: AddressLookupTableAccount.deserialize(data) });
  }

  /** The solver pays the fee and signs, as the bot does. Index 0 is always ComputeBudget. */
  send(ixs: TransactionInstruction[], payer: Keypair, o: { v0?: boolean; alt?: boolean } = {}): Sent {
    const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...ixs];
    let wire: Uint8Array;
    if (o.v0 || o.alt) {
      const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: this.svm.latestBlockhash(), instructions: all })
        .compileToV0Message(o.alt ? [this.lookupTable(all)] : []);
      const vtx = new VersionedTransaction(msg);
      vtx.sign([payer]);
      wire = vtx.serialize();
    } else {
      const tx = new Transaction().add(...all);
      tx.recentBlockhash = this.svm.latestBlockhash();
      tx.feePayer = payer.publicKey;
      tx.sign(payer);
      wire = tx.serialize();
    }
    const r = this.svm.sendTransaction(getTransactionDecoder().decode(wire));
    this.svm.expireBlockhash();
    if (r instanceof FailedTransactionMetadata) {
      const logs = r.meta().logs();
      const m = logs.map((l) => /custom program error: 0x([0-9a-f]+)/.exec(l)).find(Boolean);
      const e = r.err() as { err?: () => { code?: number } };
      const code = typeof e.err === "function" ? (e.err()?.code ?? null) : null;
      return { ok: false, code: code ?? (m ? parseInt(m[1], 16) : null), logs, cu: r.meta().computeUnitsConsumed(), events: [], size: wire.length };
    }
    const logs = r.logs();
    return { ok: true, code: null, logs, cu: r.computeUnitsConsumed(), events: parseIntentsLogs(logs, PROGRAM_ID), size: wire.length };
  }

  ix(name: string, args: Record<string, unknown>, accounts: Record<string, PublicKey>): TransactionInstruction {
    const def = INTENTS_IDL.instructions.find((i) => i.name === name)!;
    const keys = def.accounts.map((raw) => {
      const a = raw as { name: string; signer?: boolean; writable?: boolean };
      const pubkey = accounts[a.name];
      if (!pubkey) throw new Error(`${name}: missing account ${a.name}`);
      return { pubkey, isSigner: !!a.signer, isWritable: !!a.writable };
    });
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: coder.instruction.encode(name, args) });
  }

  deposit(amount: bigint, owner = this.user): Sent {
    return this.send([this.ix("deposit_sol", { amount: bn(amount) }, {
      owner: owner.publicKey, config: this.config, user_vault: this.vaultPda(owner.publicKey), system_program: SystemProgram.programId,
    })], owner);
  }
  withdraw(amount: bigint, owner = this.user, vault = this.vaultPda(owner.publicKey)): Sent {
    return this.send([this.ix("withdraw_sol", { amount: bn(amount) }, { owner: owner.publicKey, user_vault: vault })], owner);
  }
  setPaused(paused: boolean): Sent {
    return this.send([this.ix("set_paused", { paused }, { admin: this.admin.publicKey, config: this.config })], this.admin);
  }

  args(over: Partial<Args> = {}): Args {
    const minOutWei = over.minOutWei ?? 4_000_000_000_000_000n;
    return {
      user: this.user.publicKey,
      nonce: this.nextNonce++,
      deadline: this.now() + 120n,
      sellLamports: SOL / 10n,
      minOutWei,
      recipient: RECIPIENT,
      outWei: minOutWei + 1_000n,
      expectedNonce: this.cfg().nextNonce,
      gasPrice: GWEI,
      ed25519IxIndex: 1,
      ...over,
    };
  }

  /** The user's signature over the canonical message, as Phantom signMessage returns it. */
  sign(a: Args, signer = this.user): { message: Uint8Array; signature: Uint8Array } {
    const message = renderMessage(PROGRAM_ID, a);
    return { message, signature: sign(message, signer) };
  }

  executeIx(a: Args, o: { sigRequest?: PublicKey; instructions?: PublicKey; userVault?: PublicKey; intent?: PublicKey } = {}): TransactionInstruction {
    const { sigRequest } = payoutSigRequest(
      { recipient: a.recipient, outWei: a.outWei, baseNonce: a.expectedNonce, gasPrice: a.gasPrice },
      PROGRAM_ID,
      SODA,
    );
    return this.ix("execute_signed_intent", {
      args: {
        user: a.user,
        nonce: bn(a.nonce),
        deadline: bn(a.deadline),
        sell_lamports: bn(a.sellLamports),
        min_out_wei: bn(a.minOutWei),
        recipient: [...a.recipient],
        out_wei: bn(a.outWei),
        expected_nonce: bn(a.expectedNonce),
        gas_price: bn(a.gasPrice),
        ed25519_ix_index: a.ed25519IxIndex,
      },
    }, {
      solver_authority: this.solver.publicKey,
      solver: solverPda(this.solver.publicKey, PROGRAM_ID)[0],
      config: this.config,
      user_vault: o.userVault ?? this.vaultPda(a.user),
      intent: o.intent ?? intentPda(a.user, a.nonce, PROGRAM_ID)[0],
      committee: COMMITTEE_PDA,
      sig_request: o.sigRequest ?? sigRequest,
      pool: this.pool,
      soda_program: SODA,
      instructions: o.instructions ?? SYSVAR_INSTRUCTIONS_PUBKEY,
      system_program: SystemProgram.programId,
    });
  }

  /** [ComputeBudget, Ed25519, execute_signed_intent]; `signed` may differ from `a` to tamper. */
  execute(a: Args, signed: { message: Uint8Array; signature: Uint8Array; publicKey?: Uint8Array } = this.sign(a), ed?: TransactionInstruction): Sent {
    const edIx = ed ?? Ed25519Program.createInstructionWithPublicKey({
      publicKey: signed.publicKey ?? a.user.toBytes(),
      message: signed.message,
      signature: signed.signature,
    });
    return this.send([edIx, this.executeIx(a)], this.solver);
  }

  /** [ComputeBudget, ...pre, execute_signed_intent], v0 with a lookup table so extra instructions fit. */
  executeAfter(pre: TransactionInstruction[], a: Args): Sent {
    return this.send([...pre, this.executeIx(a)], this.solver, { alt: true });
  }
}

describe("rfq message", () => {
  it("test renderer matches the shared vectors byte for byte", () => {
    for (const v of VECTORS.vectors) {
      const got = renderMessage(new PublicKey(v.program_id), {
        user: new PublicKey(v.user),
        nonce: BigInt(v.nonce),
        deadline: BigInt(v.deadline),
        sellLamports: BigInt(v.sell_lamports),
        minOutWei: BigInt(v.min_out_wei),
        recipient: hexToBytes(v.recipient.slice(2)),
      });
      assert.equal(Buffer.from(got).toString("utf8"), v.message);
    }
  });

  it("test Ed25519 data builder matches web3.js for one self-contained entry", () => {
    const k = Keypair.generate();
    const message = enc("hello");
    const signature = sign(message, k);
    const want = Ed25519Program.createInstructionWithPublicKey({ publicKey: k.publicKey.toBytes(), message, signature }).data;
    assert.equal(bytesToHex(ed25519Data([{ publicKey: k.publicKey.toBytes(), signature, message }])), bytesToHex(want));
  });
});

describe("user vault", () => {
  it("deposit creates the vault, adds up, and keeps lamports == rent + sol", () => {
    const env = new Env();
    const before = env.balance(env.user.publicKey);
    const r = env.deposit(SOL);
    assert.ok(r.ok, r.logs.join("\n"));
    const rent = env.rent();
    let v = env.vault()!;
    assert.deepEqual([v.owner.toBase58(), v.sol, v.lamports], [env.user.publicKey.toBase58(), SOL, rent + SOL]);
    const ev = eventData(r, "VaultDeposited");
    assert.deepEqual([(ev.owner as PublicKey).toBase58(), big(ev.amount), big(ev.sol)], [env.user.publicKey.toBase58(), SOL, SOL]);
    assert.ok(env.deposit(SOL / 2n).ok);
    v = env.vault()!;
    assert.deepEqual([v.sol, v.lamports], [(3n * SOL) / 2n, rent + (3n * SOL) / 2n]);
    assert.equal(before - env.balance(env.user.publicKey), rent + (3n * SOL) / 2n + 10_000n); // two fees
    assert.equal(env.deposit(0n).code, ERR.ZeroAmount);
    // Vaults are per owner.
    assert.ok(env.deposit(SOL / 4n, env.stranger).ok);
    assert.equal(env.vault(env.stranger.publicKey)!.sol, SOL / 4n);
    assert.equal(env.vault()!.sol, (3n * SOL) / 2n);
  });

  it("withdraw returns SOL, stays rent-exempt, and works while paused; deposit does not", () => {
    const env = new Env();
    env.deposit(SOL);
    const rent = env.rent();
    assert.equal(env.withdraw(SOL + 1n).code, ERR.InsufficientVaultBalance);
    assert.equal(env.withdraw(0n).code, ERR.ZeroAmount);
    assert.ok(env.setPaused(true).ok);
    assert.equal(env.deposit(SOL).code, ERR.Paused);
    const before = env.balance(env.user.publicKey);
    const r = env.withdraw(SOL);
    assert.ok(r.ok, r.logs.join("\n"));
    assert.equal(env.balance(env.user.publicKey) - before, SOL - 5000n); // minus the fee
    assert.deepEqual([env.vault()!.sol, env.vault()!.lamports], [0n, rent]);
    const ev = eventData(r, "VaultWithdrew");
    assert.deepEqual([big(ev.amount), big(ev.sol)], [SOL, 0n]);
    assert.equal(env.withdraw(1n).code, ERR.InsufficientVaultBalance);
    assert.ok(env.setPaused(false).ok);
    assert.ok(env.deposit(SOL / 2n).ok, "an emptied vault is reused");
    assert.deepEqual([env.vault()!.sol, env.vault()!.lamports], [SOL / 2n, rent + SOL / 2n]);
  });

  it("SOL sent straight to the vault is not credited and cannot be withdrawn", () => {
    const env = new Env();
    env.deposit(SOL);
    env.svm.airdrop(address(env.vaultPda().toBase58()), lamports(SOL));
    assert.deepEqual([env.vault()!.sol, env.vault()!.lamports], [SOL, env.rent() + 2n * SOL]);
    assert.equal(env.withdraw(SOL + 1n).code, ERR.InsufficientVaultBalance);
    assert.ok(env.withdraw(SOL).ok);
    assert.deepEqual([env.vault()!.sol, env.vault()!.lamports], [0n, env.rent() + SOL]);
  });

  it("only the owner withdraws", () => {
    const env = new Env();
    env.deposit(SOL);
    assert.equal(env.withdraw(1n, env.stranger, env.vaultPda()).code, ERR.ConstraintSeeds);
    assert.equal(env.vault()!.sol, SOL);
  });
});

describe("execute_signed_intent", () => {
  it("settles a signed intent: Filled record, payout requested, SOL to the solver", () => {
    const env = new Env();
    env.deposit(SOL);
    const a = env.args();
    const solverBefore = env.balance(env.solver.publicKey);
    const ledgerBefore = env.ledger().balanceWei;
    const r = env.execute(a);
    assert.ok(r.ok, r.logs.join("\n"));
    console.log(`execute_signed_intent: ${r.cu} CU`);

    const intentKey = intentPda(a.user, a.nonce, PROGRAM_ID)[0];
    const it = decodeIntent(env.raw(intentKey)!.data);
    const { sigRequest, unsignedRlp, payload } = payoutSigRequest({ recipient: a.recipient, outWei: a.outWei, baseNonce: a.expectedNonce, gasPrice: a.gasPrice }, PROGRAM_ID, SODA);
    assert.equal(it.status, IntentStatus.Filled);
    assert.equal(it.user.toBase58(), a.user.toBase58());
    assert.equal(it.intentId, a.nonce);
    assert.equal(it.inLamports, a.sellLamports);
    assert.equal(bytesToHex(it.recipient), bytesToHex(a.recipient));
    assert.equal(it.startOutWei, a.outWei);
    assert.equal(it.minOutWei, a.minOutWei);
    assert.equal(it.auctionDuration, 0);
    assert.equal(it.auctionStart, T0);
    assert.equal(it.expiresAt, a.deadline);
    assert.equal(it.solver.toBase58(), env.solver.publicKey.toBase58());
    assert.equal(it.outWei, a.outWei);
    assert.equal(it.baseNonce, a.expectedNonce);
    assert.equal(it.gasPrice, a.gasPrice);
    assert.equal(it.filledAt, T0);
    assert.equal(it.sigRequestCount, 1);
    assert.equal(it.sigRequests[0].toBase58(), sigRequest.toBase58());

    // The SigRequest is soda's, at the address lib/intents derives, for the pool's payload.
    const srRaw = env.raw(sigRequest)!;
    assert.equal(srRaw.owner.toBase58(), SODA.toBase58());
    const sr = decodeSigRequest(srRaw.data);
    assert.equal(sr.requester.toBase58(), env.pool.toBase58());
    assert.equal(bytesToHex(sr.payload), bytesToHex(payload));

    assert.equal(env.cfg().nextNonce, a.expectedNonce + 1n);
    const v = env.vault()!;
    assert.deepEqual([v.sol, v.lamports], [SOL - a.sellLamports, env.rent() + SOL - a.sellLamports]);
    assert.equal(ledgerBefore - env.ledger().balanceWei, payoutCost(a.outWei, a.gasPrice, L1_BUFFER));
    assert.equal(env.ledger().fills, 1n);
    // Gets the SOL; pays the Intent and SigRequest rent and the fee (tx + precompile signature).
    const intentRent = env.raw(intentKey)!.lamports;
    assert.equal(env.balance(env.solver.publicKey), solverBefore + a.sellLamports - intentRent - srRaw.lamports - 10_000n);

    assert.deepEqual(eventNames(r), ["EthTxRequested", "IntentFilled", "SignedIntentExecuted"]);
    const eth = r.events[0];
    assert.ok(eth.name === "EthTxRequested");
    assert.deepEqual([eth.sigRequest.toBase58(), eth.chainId, bytesToHex(eth.unsignedRlp)], [sigRequest.toBase58(), 84532n, bytesToHex(unsignedRlp)]);
    const filled = r.events[1];
    assert.ok(filled.name === "IntentFilled");
    assert.deepEqual(
      [filled.intent, filled.user, filled.solver, filled.sigRequest].map((k) => k.toBase58()),
      [intentKey, a.user, env.solver.publicKey, sigRequest].map((k) => k.toBase58()),
    );
    assert.deepEqual([filled.inLamports, filled.outWei, filled.baseNonce, filled.gasPrice, filled.filledAt], [a.sellLamports, a.outWei, a.expectedNonce, a.gasPrice, T0]);
    // Typed if lib/intents decodes it, else raw IDL fields.
    const ev = r.events[2] as unknown as Record<string, unknown> & { name: string; data?: Record<string, unknown> };
    const field = (camel: string, snake: string) => (ev.name === "Other" ? ev.data![snake] : ev[camel]);
    assert.deepEqual(
      [field("intent", "intent"), field("user", "user"), field("solver", "solver")].map((k) => (k as PublicKey).toBase58()),
      [intentKey, a.user, env.solver.publicKey].map((k) => k.toBase58()),
    );
    assert.deepEqual(
      [field("nonce", "nonce"), field("sellLamports", "sell_lamports"), field("minOutWei", "min_out_wei"), field("outWei", "out_wei"), field("baseNonce", "base_nonce")].map(big),
      [a.nonce, a.sellLamports, a.minOutWei, a.outWei, a.expectedNonce],
    );
  });

  it("bump_gas by the filling solver works on an RFQ intent unchanged", () => {
    const env = new Env();
    env.deposit(SOL);
    const a = env.args();
    assert.ok(env.execute(a).ok);
    const intent = intentPda(a.user, a.nonce, PROGRAM_ID)[0];
    const newGas = (a.gasPrice * 11n) / 10n;
    const { sigRequest } = payoutSigRequest({ recipient: a.recipient, outWei: a.outWei, baseNonce: a.expectedNonce, gasPrice: newGas }, PROGRAM_ID, SODA);
    const r = env.send([env.ix("bump_gas", { new_gas_price: bn(newGas) }, {
      caller: env.solver.publicKey,
      solver: solverPda(env.solver.publicKey, PROGRAM_ID)[0],
      config: env.config,
      intent,
      committee: COMMITTEE_PDA,
      sig_request: sigRequest,
      pool: env.pool,
      soda_program: SODA,
      system_program: SystemProgram.programId,
    })], env.solver);
    assert.ok(r.ok, r.logs.join("\n"));
    const it = decodeIntent(env.raw(intent)!.data);
    assert.deepEqual([it.sigRequestCount, it.gasPrice, it.sigRequests[1].toBase58()], [2, newGas, sigRequest.toBase58()]);
    assert.deepEqual(eventNames(r), ["EthTxRequested", "GasBumped"]);
  });

  it("the user's nonce settles once; other users' nonces are independent", () => {
    const env = new Env();
    env.deposit(SOL);
    const a = env.args();
    const signed = env.sign(a);
    assert.ok(env.execute(a, signed).ok);
    const replay = env.execute({ ...a, expectedNonce: env.cfg().nextNonce }, signed);
    assert.equal(replay.ok, false);
    assert.ok(replay.logs.some((l) => l.includes("already in use")), replay.logs.join("\n"));
    // A fresh signature for a different trade under the same nonce is refused the same way.
    const b = { ...a, sellLamports: a.sellLamports / 2n, expectedNonce: env.cfg().nextNonce };
    const again = env.execute(b);
    assert.ok(again.logs.some((l) => l.includes("already in use")), again.logs.join("\n"));
    assert.equal(env.vault()!.sol, SOL - a.sellLamports);
    // Same nonce, another user: its own Intent PDA.
    env.deposit(SOL, env.stranger);
    const c = env.args({ user: env.stranger.publicKey, nonce: a.nonce });
    assert.ok(env.execute(c, env.sign(c, env.stranger)).ok);
  });

  it("deadline: open at the deadline, closed one second after, at most 600 s out", () => {
    const env = new Env();
    env.deposit(SOL);
    const late = env.args({ deadline: T0 + 60n });
    const signed = env.sign(late);
    env.setTime(T0 + 61n);
    assert.equal(env.execute({ ...late, expectedNonce: env.cfg().nextNonce }, signed).code, ERR.DeadlinePassed);
    assert.equal(env.execute(env.args({ deadline: env.now() + 601n })).code, ERR.DeadlineTooFar);
    assert.equal(env.execute(env.args({ deadline: -1n })).code, ERR.DeadlinePassed);
    assert.ok(env.execute(env.args({ deadline: env.now() + 600n })).ok);
    const onTime = env.args({ deadline: env.now() + 30n });
    const s = env.sign(onTime);
    env.setTime(onTime.deadline);
    assert.ok(env.execute({ ...onTime, expectedNonce: env.cfg().nextNonce }, s).ok);
  });

  it("checks amounts, vault, gas bounds, nonce and ledger", () => {
    const env = new Env();
    env.deposit(SOL);
    const start = env.cfg().nextNonce;
    const cases: [Partial<Args>, number][] = [
      [{ sellLamports: 0n }, ERR.ZeroAmount],
      [{ minOutWei: 0n, outWei: 1n }, ERR.ZeroAmount],
      [{ outWei: 4_000_000_000_000_000n - 1n }, ERR.BelowRequiredOut],
      [{ recipient: new Uint8Array(20) }, ERR.ZeroRecipient],
      [{ sellLamports: SOL + 1n }, ERR.InsufficientVaultBalance],
      [{ gasPrice: MAX_GAS + 1n }, ERR.GasPriceTooHigh],
      [{ gasPrice: MIN_GAS - 1n }, ERR.GasPriceTooLow],
      [{ expectedNonce: env.cfg().nextNonce + 1n }, ERR.NonceMoved],
      [{ outWei: ETH }, ERR.InsufficientSolverBalance],
    ];
    for (const [over, code] of cases) {
      const r = env.execute(env.args(over));
      assert.equal(r.code, code, show(over));
    }
    const ledger = env.ledger().balanceWei;
    assert.equal(env.cfg().nextNonce, start, "failed executions leave the nonce");
    assert.equal(env.vault()!.sol, SOL);

    // Edges that pass: gas at both bounds, the whole vault, the whole ledger.
    assert.ok(env.execute(env.args({ gasPrice: MIN_GAS })).ok);
    assert.ok(env.execute(env.args({ gasPrice: MAX_GAS })).ok);
    const left = env.ledger().balanceWei;
    assert.ok(left < ledger);
    const all = left - GWEI * 21_000n - L1_BUFFER;
    assert.equal(env.execute(env.args({ minOutWei: all, outWei: all + 1n })).code, ERR.InsufficientSolverBalance);
    const sell = env.vault()!.sol;
    assert.ok(env.execute(env.args({ minOutWei: all, outWei: all, sellLamports: sell })).ok);
    assert.equal(env.ledger().balanceWei, 0n);
    assert.deepEqual([env.vault()!.sol, env.vault()!.lamports], [0n, env.rent()]);
    assert.equal(env.execute(env.args({ sellLamports: 1n, minOutWei: 1n })).code, ERR.InsufficientVaultBalance);
  });

  it("NonceMoved when another fill lands first; the retry with the new nonce settles", () => {
    const env = new Env();
    env.deposit(SOL);
    const a = env.args();
    const b = env.args(); // read the same next_nonce as a
    assert.equal(a.expectedNonce, b.expectedNonce);
    assert.ok(env.execute(a).ok);
    const signedB = env.sign(b);
    assert.equal(env.execute(b, signedB).code, ERR.NonceMoved);
    // expected_nonce is not signed, so the same user signature is retried as-is.
    const r = env.execute({ ...b, expectedNonce: env.cfg().nextNonce }, signedB);
    assert.ok(r.ok, r.logs.join("\n"));
    assert.equal(decodeIntent(env.raw(intentPda(b.user, b.nonce, PROGRAM_ID)[0])!.data).baseNonce, a.expectedNonce + 1n);
  });

  it("paused blocks execution; unpausing restores it", () => {
    const env = new Env();
    env.deposit(SOL);
    assert.ok(env.setPaused(true).ok);
    const a = env.args();
    const signed = env.sign(a);
    assert.equal(env.execute(a, signed).code, ERR.Paused);
    assert.ok(env.setPaused(false).ok);
    assert.ok(env.execute(a, signed).ok);
  });

  it("needs the user's own vault and Intent PDA", () => {
    const env = new Env();
    env.deposit(SOL, env.stranger);
    const a = env.args();
    // No vault yet for the signer.
    assert.equal(env.execute(a).code, ERR.AccountNotInitialized);
    // Someone else's funded vault.
    const ed = Ed25519Program.createInstructionWithPublicKey({ publicKey: a.user.toBytes(), ...env.sign(a) });
    const theirs = env.send([ed, env.executeIx(a, { userVault: env.vaultPda(env.stranger.publicKey) })], env.solver);
    assert.equal(theirs.code, ERR.ConstraintSeeds);
    env.deposit(SOL);
    const wrongIntent = env.send([ed, env.executeIx(a, { intent: intentPda(a.user, a.nonce + 1n, PROGRAM_ID)[0] })], env.solver);
    assert.equal(wrongIntent.code, ERR.ConstraintSeeds);
    // A SigRequest that is not the payout's: soda refuses it.
    const wrongSr = env.send([ed, env.executeIx(a, { sigRequest: Keypair.generate().publicKey })], env.solver);
    assert.equal(wrongSr.ok, false);
    assert.deepEqual([env.vault()!.sol, env.vault(env.stranger.publicKey)!.sol, env.cfg().nextNonce], [SOL, SOL, a.expectedNonce]);
    assert.ok(env.executeAfter([ed], a).ok);
  });
});

describe("execute_signed_intent signature checks", () => {
  it("rejects args the user did not sign", () => {
    const env = new Env();
    env.deposit(SOL);
    const a = env.args();
    const signed = { ...env.sign(a), publicKey: a.user.toBytes() };
    const edits: Partial<Args>[] = [
      { user: env.stranger.publicKey },
      { minOutWei: a.minOutWei - 1n },
      { sellLamports: a.sellLamports + 1n },
      { recipient: new Uint8Array(20).fill(0xbb) },
      { deadline: a.deadline + 1n },
      { nonce: a.nonce + 1n },
    ];
    env.deposit(SOL, env.stranger);
    for (const e of edits) {
      const r = env.execute({ ...a, ...e }, signed);
      assert.equal(r.code, ERR.SignatureMismatch, show(e));
      assert.ok(reachedProgram(r));
    }
    // out_wei is the solver's own choice and is not signed.
    assert.ok(env.execute({ ...a, outWei: a.minOutWei }, signed).ok);
  });

  it("rejects a real user signature over a message altered by one byte, in every line", () => {
    const env = new Env();
    env.deposit(SOL);
    const a = env.args();
    const msg = env.sign(a).message;
    const ends = [...msg.keys()].filter((i) => msg[i] === 0x0a).map((i) => i - 1).concat(msg.length - 1);
    assert.equal(ends.length, 8);
    const altered: [string, Uint8Array][] = ends.map((at, line) => [`line ${line}`, msg.map((b, i) => (i === at ? b ^ 1 : b))]);
    altered.push(
      ["trailing newline", Uint8Array.from([...msg, 0x0a])],
      ["last byte dropped", msg.slice(0, -1)],
      ["mainnet", enc(new TextDecoder().decode(msg).replace(" devnet\n", " mainnet\n"))],
      ["other verifier", renderMessage(SODA, a)],
      ["CRLF", enc(new TextDecoder().decode(msg).replaceAll("\n", "\r\n"))],
    );
    for (const [what, m] of altered) {
      assert.notEqual(bytesToHex(m), bytesToHex(msg), what);
      const r = env.execute(a, { message: m, signature: sign(m, env.user) });
      assert.equal(r.code, ERR.SignatureMismatch, what);
      assert.ok(reachedProgram(r), what);
    }
    assert.ok(env.execute(a, { message: msg, signature: sign(msg, env.user) }).ok);
  });

  it("rejects the user's signature over a different intent, and other keys' signatures", () => {
    const env = new Env();
    env.deposit(SOL);
    env.deposit(SOL, env.stranger);
    const a = env.args();
    const b = env.args({ sellLamports: a.sellLamports * 2n });
    // Valid signature, but for b's message.
    assert.equal(env.execute(a, env.sign(b)).code, ERR.SignatureMismatch);
    // a's message, signed by another key.
    const theirs = env.sign(a, env.stranger);
    assert.equal(env.execute(a, { ...theirs, publicKey: env.stranger.publicKey.toBytes() }).code, ERR.SignatureMismatch);
    // A message for another user, signed by that user, cannot spend this vault.
    const forged = { ...a, user: env.stranger.publicKey };
    const s = env.sign(forged, env.stranger);
    const ed = Ed25519Program.createInstructionWithPublicKey({ publicKey: env.stranger.publicKey.toBytes(), ...s });
    assert.equal(env.executeAfter([ed], a).code, ERR.SignatureMismatch);
    // A bad signature fails in the Ed25519 precompile, before the program runs.
    const signed = env.sign(a);
    const bad = { message: signed.message, signature: signed.signature.map((x, i) => (i === 0 ? x ^ 1 : x)) };
    const r = env.execute(a, bad);
    assert.equal(r.ok, false);
    assert.ok(r.code === null || r.code < 6000, `code ${r.code}`);
    assert.ok(!reachedProgram(r), r.logs.join("\n"));
    assert.deepEqual([env.vault()!.sol, env.cfg().nextNonce], [SOL, a.expectedNonce]);
  });

  it("rejects a missing Ed25519 instruction, a wrong index and a fake instructions sysvar", () => {
    const env = new Env();
    env.deposit(SOL);
    const a = env.args();
    // ed25519_ix_index at ComputeBudget (0), at execute itself (2), past the end, max u8.
    for (const idx of [0, 2, 3, 255]) {
      assert.equal(env.execute({ ...a, ed25519IxIndex: idx }).code, ERR.InvalidSignatureInstruction, `index ${idx}`);
    }
    // No Ed25519 instruction at all.
    assert.equal(env.executeAfter([], a).code, ERR.InvalidSignatureInstruction);
    assert.equal(env.executeAfter([], { ...a, ed25519IxIndex: 0 }).code, ERR.InvalidSignatureInstruction);
    // Valid Ed25519 at index 2 but the args point at 1 (a second, unrelated one).
    const { message, signature } = env.sign(a);
    const real = Ed25519Program.createInstructionWithPublicKey({ publicKey: a.user.toBytes(), message, signature });
    const decoyMsg = enc("unrelated");
    const decoy = Ed25519Program.createInstructionWithPublicKey({ publicKey: env.stranger.publicKey.toBytes(), message: decoyMsg, signature: sign(decoyMsg, env.stranger) });
    assert.equal(env.executeAfter([decoy, real], a).code, ERR.SignatureMismatch);
    assert.ok(env.executeAfter([decoy, real], { ...a, ed25519IxIndex: 2 }).ok, "the right index settles");
    // A fake instructions sysvar.
    const b = env.args();
    const edB = Ed25519Program.createInstructionWithPublicKey({ publicKey: b.user.toBytes(), ...env.sign(b) });
    assert.equal(env.send([edB, env.executeIx(b, { instructions: env.stranger.publicKey })], env.solver).code, ERR.ConstraintAddress);
  });

  it("rejects Ed25519-shaped data under another program", () => {
    const env = new Env();
    env.deposit(SOL);
    const a = env.args();
    const { message, signature } = env.sign(a);
    // A no-op program accepts anything, including a forged signature.
    const forged = ed25519Data([{ publicKey: a.user.toBytes(), signature: new Uint8Array(64), message }]);
    const r = env.executeAfter([dataIx(NOOP, forged)], a);
    assert.equal(r.code, ERR.InvalidSignatureInstruction);
    // Even with a genuine signature, the bytes only count under the Ed25519 program.
    const genuine = ed25519Data([{ publicKey: a.user.toBytes(), signature, message }]);
    assert.equal(env.executeAfter([dataIx(NOOP, genuine)], a).code, ERR.InvalidSignatureInstruction);
    assert.equal(env.vault()!.sol, SOL);
  });

  it("rejects offsets that point at another instruction's data (the known bypass)", () => {
    const env = new Env();
    env.deposit(SOL);
    const user = env.user.publicKey.toBytes();
    const stranger = env.stranger.publicKey.toBytes();
    const zeros = new Uint8Array(64);
    // [ComputeBudget, carrier, Ed25519, execute]; small amounts keep two copies of the message under 1232 bytes.
    const intent = () => {
      const a = env.args({ ed25519IxIndex: 2, sellLamports: 1n, minOutWei: 1n });
      const msg = env.sign(a).message;
      // Any same-length bytes someone holds a signature over (e.g. a login message).
      const other = Uint8Array.from(msg, (b, i) => (i === 0 ? b ^ 0x20 : b));
      return { a, msg, other };
    };
    // `upTo`: the carrier only needs the bytes the redirected offsets reach (pk at 16, sig at 48, msg at 112).
    type Case = { what: string; make: (msg: Uint8Array, other: Uint8Array) => { carrier: Entry; own: Entry; ix: Indices; upTo?: number } };
    const cases: Case[] = [
      {
        what: "all three elsewhere: the stranger signed something, our ix holds the user's claim",
        make: (msg, other) => ({
          carrier: { publicKey: stranger, signature: sign(other, env.stranger), message: other },
          own: { publicKey: user, signature: zeros, message: msg },
          ix: { sig: 1, pk: 1, msg: 1 },
        }),
      },
      {
        what: "message elsewhere: the user's signature over other bytes reused for the intent",
        make: (msg, other) => ({
          carrier: { publicKey: user, signature: zeros, message: other },
          own: { publicKey: user, signature: sign(other, env.user), message: msg },
          ix: { msg: 1 },
        }),
      },
      {
        what: "public key elsewhere: the stranger signed the user's intent",
        make: (msg) => ({
          carrier: { publicKey: stranger, signature: zeros, message: msg },
          own: { publicKey: user, signature: sign(msg, env.stranger), message: msg },
          ix: { pk: 1 },
          upTo: 48,
        }),
      },
      {
        what: "signature elsewhere",
        make: (msg) => ({
          carrier: { publicKey: user, signature: sign(msg, env.user), message: msg },
          own: { publicKey: user, signature: zeros, message: msg },
          ix: { sig: 1 },
          upTo: 112,
        }),
      },
      {
        what: "carrier is another Ed25519 instruction",
        make: (msg, other) => ({
          carrier: { publicKey: stranger, signature: sign(other, env.stranger), message: other },
          own: { publicKey: user, signature: zeros, message: msg },
          ix: { sig: 1, pk: 1, msg: 1 },
        }),
      },
    ];
    const got = cases.map((c) => {
      const { a, msg, other } = intent();
      const m = c.make(msg, other);
      const carrierData = ed25519Data([m.carrier]).slice(0, m.upTo);
      const carrier = dataIx(c.what.startsWith("carrier is") ? Ed25519Program.programId : NOOP, carrierData);
      const r = env.executeAfter([carrier, dataIx(Ed25519Program.programId, ed25519Data([m.own], m.ix))], a);
      assert.ok(reachedProgram(r), `${c.what}: the precompile should accept it\n${r.logs.join("\n")}`);
      return `${c.what}: ${r.ok ? "SETTLED" : r.code}`;
    });
    assert.deepEqual(got, cases.map((c) => `${c.what}: ${ERR.InvalidSignatureInstruction}`));
    // An explicit index naming the Ed25519 instruction itself is refused too.
    const { a, msg } = intent();
    const self = Ed25519Program.createInstructionWithPublicKey({ publicKey: user, message: msg, signature: sign(msg, env.user), instructionIndex: 1 });
    const explicit = env.executeAfter([self], { ...a, ed25519IxIndex: 1 });
    assert.ok(reachedProgram(explicit));
    assert.equal(explicit.code, ERR.InvalidSignatureInstruction);
    assert.deepEqual([env.vault()!.sol, env.cfg().nextNonce], [SOL, a.expectedNonce]);
  });

  it("rejects zero or two signatures in the Ed25519 instruction", () => {
    const env = new Env();
    env.deposit(SOL);
    const a = env.args();
    const { message, signature } = env.sign(a);
    const userEntry = { publicKey: a.user.toBytes(), signature, message };
    const decoyMsg = enc("decoy");
    const decoy = { publicKey: env.stranger.publicKey.toBytes(), signature: sign(decoyMsg, env.stranger), message: decoyMsg };
    const variants: [string, Uint8Array][] = [
      ["zero signatures", Uint8Array.from([0, 0])],
      ["two, the user's first", ed25519Data([userEntry, decoy])],
      ["two, the user's second", ed25519Data([decoy, userEntry])],
      ["the user's twice", ed25519Data([userEntry, userEntry])],
    ];
    for (const [what, data] of variants) {
      const r = env.executeAfter([dataIx(Ed25519Program.programId, data)], a);
      assert.ok(reachedProgram(r), `${what}: the precompile should accept it\n${r.logs.join("\n")}`);
      assert.equal(r.code, ERR.InvalidSignatureInstruction, what);
    }
    assert.ok(env.execute(a).ok);
  });
});

describe("execute_signed_intent transaction size", () => {
  const sizes = (env: Env, a: Args) => {
    const ixs = [Ed25519Program.createInstructionWithPublicKey({ publicKey: a.user.toBytes(), ...env.sign(a) }), env.executeIx(a)];
    const wire = (v0: boolean) => {
      const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...ixs];
      if (v0) {
        const vtx = new VersionedTransaction(new TransactionMessage({ payerKey: env.solver.publicKey, recentBlockhash: env.svm.latestBlockhash(), instructions: all }).compileToV0Message());
        vtx.sign([env.solver]);
        return vtx.serialize().length;
      }
      const tx = new Transaction().add(...all);
      tx.recentBlockhash = env.svm.latestBlockhash();
      tx.feePayer = env.solver.publicKey;
      tx.sign(env.solver);
      return tx.serialize().length;
    };
    return { legacy: wire(false), v0: wire(true), message: renderMessage(PROGRAM_ID, a).length };
  };

  it("fits under 1232 bytes, legacy and v0, typical and worst case", () => {
    const env = new Env();
    const typical = sizes(env, env.args());
    const worst = sizes(env, env.args({ nonce: 2n ** 64n - 1n, deadline: -(2n ** 63n), sellLamports: 2n ** 64n - 1n, minOutWei: 2n ** 128n - 1n, outWei: 2n ** 128n - 1n, recipient: new Uint8Array(20).fill(0xff) }));
    console.log(`execute tx bytes: typical legacy ${typical.legacy}, v0 ${typical.v0} (message ${typical.message}); worst legacy ${worst.legacy}, v0 ${worst.v0} (message ${worst.message}); limit ${TX_LIMIT}`);
    for (const s of [typical, worst]) {
      assert.ok(s.legacy < TX_LIMIT, show(s));
      assert.ok(s.v0 < TX_LIMIT, show(s));
    }
  });

  it("a v0 transaction settles too", () => {
    const env = new Env();
    env.deposit(SOL);
    const a = env.args();
    const ed = Ed25519Program.createInstructionWithPublicKey({ publicKey: a.user.toBytes(), ...env.sign(a) });
    const r = env.send([ed, env.executeIx(a)], env.solver, { v0: true });
    assert.ok(r.ok, r.logs.join("\n"));
    assert.ok(r.size < TX_LIMIT);
    assert.deepEqual(eventNames(r), ["EthTxRequested", "IntentFilled", "SignedIntentExecuted"]);
  });
});
