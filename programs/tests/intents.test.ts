// LiteSVM integration tests: the built intents program against the real soda
// program dumped from devnet, with lib/soda and lib/intents doing every
// client-side computation (that is the parity test). HANDOVER §3.4 Tests.
//
//   anchor build (in programs/), then from the repo root:
//   npx tsx --test programs/tests/*.test.ts

import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { address, getTransactionDecoder, lamports } from "@solana/kit";
import { BN, BorshCoder } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { evmAddressOf, signDepositProof } from "../../services/solver/src/evm";
import { decodeUnsignedLegacy, deriveEthAddress, encodeUnsignedLegacy, EVM_CHAIN_TAG } from "../../lib/soda";
import {
  buildCandidates,
  buildPayoutTx,
  CHAIN_ID,
  COMMITTEE_PDA,
  configPda,
  creditPda,
  CREDIT_SIZE,
  decodeConfig,
  decodeIntent,
  decodeSigRequest,
  decodeSolver,
  decodeWithdrawal,
  decodeWitnessClaim,
  gasPricesFromEvents,
  GAS_LIMIT,
  GROUP_PK,
  INTENTS_IDL,
  intentPda,
  IntentStatus,
  minBumpGasPrice,
  parseIntentsLogs,
  payloadOf,
  payoutCost,
  payoutSigRequest,
  payoutUnsignedRlp,
  poolEvmAddress,
  poolPda,
  requiredOut,
  SIG_REQUEST_SIZE,
  sigRequestPda,
  solverPda,
  unsignedRlpBySigRequest,
  withdrawalPda,
  WITNESS_CLAIM_SIZE,
  WITNESS_CONFIG_SIZE,
  witnessConfigPda,
  PRODUCTION_FORWARDER_ID,
  type IntentsEvent,
  type PayoutParams,
} from "../../lib/intents";

const PROGRAM_ID = new PublicKey("BV9KfzKwXPp9hQZEyhoVm9STbDy7gCGCmKcKpCDr8jXA");
const SODA = new PublicKey("CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J");
const WITNESS = new PublicKey("5v97wLYgMzyfQfpZWGQ6uPXTHh4JsJitUXPReYy2uuTp");
const POOL = "WtaezksvpBC1LGh4oV7xvURsdtdTv752z1A4NpLv7uS";
const POOL_EVM = "7662920f66682d8996ec6b6d9e4ac9ed25a1006c";

const ROOT = path.resolve(__dirname, "..");
const INTENTS_SO = path.join(ROOT, "target/deploy/intents.so");
const SODA_SO = path.join(ROOT, "tests/fixtures/soda.so");
const COMMITTEE_JSON = path.join(ROOT, "tests/fixtures/committee.json");

const ERR = {
  Paused: 6000,
  IntentNotOpen: 6001,
  IntentExpired: 6002,
  BelowRequiredOut: 6003,
  GasPriceTooHigh: 6004,
  InsufficientSolverBalance: 6005,
  NonceMoved: 6006,
  NotFillingSolver: 6007,
  BumpTooSmall: 6008,
  TooManyBumps: 6009,
  BadAuctionParams: 6010,
  NotClosable: 6011,
  GasPriceTooLow: 6013,
  ZeroAmount: 6014,
  BadGasConfig: 6015,
  ClaimNotFromWitness: 6016,
  InvalidClaim: 6017,
  ClaimTxHashMismatch: 6018,
  ClaimNotRecorded: 6019,
  DepositReverted: 6020,
  ClaimWrongChain: 6021,
  DepositNotToPool: 6022,
  DepositNotFromSolver: 6023,
  ClaimNotBySolver: 6024,
  UntrustedWitness: 6025,
  DepositFromNotProven: 6026,
  // Anchor framework errors
  ConstraintHasOne: 2001,
  ConstraintSeeds: 2006,
  ConstraintOwner: 2004,
  ConstraintAddress: 2012,
} as const;

const T0 = 1_700_000_000n;
const GWEI = 1_000_000_000n;
const ETH = 10n ** 18n;
const MAX_GAS = 5n * GWEI;
const MIN_GAS = 1_000_000n; // 0.001 gwei
const L1_BUFFER = 1_000_000_000_000n; // 1e12 wei
const RECIPIENT = new Uint8Array(20).fill(0xaa);
const PAYOUT_ADDR = new Uint8Array(20).fill(0x99);
/** The solvers' Base wallet; register_solver needs its personal_sign. */
const DEPOSIT_KEY = hexToBytes("46".repeat(32));
const DEPOSIT_FROM = evmAddressOf(DEPOSIT_KEY);
const MOCK_FORWARDER = new PublicKey("7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK");
const SIG_REQUESTED_DISC = "f241344e28e151b6";
/** SigRequest.completed with empty derivation seeds: 8+1+32+32+64+4+32+32+4+8. */
const SIG_REQUEST_COMPLETED_OFFSET = 217;

const coder = new BorshCoder(INTENTS_IDL);
const bn = (n: bigint | number) => new BN(n.toString());
const hex = (b: Uint8Array) => bytesToHex(b);

type Sent = { ok: boolean; code: number | null; logs: string[]; cu: bigint; events: IntentsEvent[] };

type OpenParams = {
  inLamports: bigint;
  recipient: Uint8Array;
  startOutWei: bigint;
  minOutWei: bigint;
  auctionDuration: number;
  expiresAt: bigint;
};

/** Custom error code of a failed transaction, from the error object or the logs. */
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

/** One fresh chain per test: intents + real soda + the devnet Committee account. */
class Env {
  svm = new LiteSVM();
  // Pays every transaction fee, so signer balances move only by program effects.
  feePayer = Keypair.generate();
  admin = Keypair.generate();
  solver = Keypair.generate();
  user = Keypair.generate();
  stranger = Keypair.generate();
  config = configPda(PROGRAM_ID)[0];
  pool = poolPda(PROGRAM_ID)[0];
  private nextIntentId = 1n;

  constructor() {
    this.svm.addProgramFromFile(address(PROGRAM_ID.toBase58()), INTENTS_SO);
    this.svm.addProgramFromFile(address(SODA.toBase58()), SODA_SO);
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
    for (const k of [this.feePayer, this.admin, this.solver, this.user, this.stranger]) {
      this.svm.airdrop(address(k.publicKey.toBase58()), lamports(100n * BigInt(LAMPORTS_PER_SOL)));
    }
    this.setTime(T0);
    this.setWitnessConfig(MOCK_FORWARDER); // as on devnet
  }

  /** soda_witness Config as init_config/set_config leave it. */
  setWitnessConfig(forwarder: PublicKey, workflowOwner = new Uint8Array(20), key = witnessConfigPda(WITNESS)[0], owner = WITNESS) {
    const d = new Uint8Array(WITNESS_CONFIG_SIZE);
    d.set(WITNESS_CONFIG_DISC, 0);
    d.set(this.admin.publicKey.toBytes(), 8);
    d.set(forwarder.toBytes(), 40);
    d.set(workflowOwner, 104);
    d[134] = witnessConfigPda(WITNESS)[1];
    this.svm.setAccount({
      address: address(key.toBase58()),
      data: d,
      executable: false,
      lamports: lamports(this.rent(d.length)),
      programAddress: address(owner.toBase58()),
      space: BigInt(d.length),
    });
  }

  // ------------------------------------------------------------ runtime

  setTime(t: bigint) {
    const c = this.svm.getClock();
    c.unixTimestamp = t;
    this.svm.setClock(c);
  }
  advance(sec: bigint) {
    this.setTime(this.now() + sec);
  }
  now(): bigint {
    return this.svm.getClock().unixTimestamp;
  }
  balance(pk: PublicKey): bigint {
    return BigInt(this.svm.getBalance(address(pk.toBase58())) ?? 0n);
  }
  data(pk: PublicKey): { data: Uint8Array; lamports: bigint; owner: string } | null {
    const a = this.svm.getAccount(address(pk.toBase58()));
    if (!a.exists || a.lamports === 0n) return null;
    return { data: Uint8Array.from(a.data), lamports: BigInt(a.lamports), owner: a.programAddress };
  }
  rent(len: number): bigint {
    return this.svm.minimumBalanceForRentExemption(BigInt(len));
  }

  send(ixs: TransactionInstruction[], signers: Keypair[], cu = 400_000): Sent {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs);
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.feePayer = this.feePayer.publicKey;
    const all = [this.feePayer, ...signers.filter((s) => !s.publicKey.equals(this.feePayer.publicKey))];
    tx.sign(...all);
    const r: TransactionMetadata | FailedTransactionMetadata = this.svm.sendTransaction(
      getTransactionDecoder().decode(tx.serialize()),
    );
    // A fresh blockhash per send, so an identical retry is not "already processed".
    this.svm.expireBlockhash();
    if (r instanceof FailedTransactionMetadata) {
      const logs = r.meta().logs();
      return { ok: false, code: errorCode(r, logs), logs, cu: r.meta().computeUnitsConsumed(), events: [] };
    }
    const logs = r.logs();
    return { ok: true, code: null, logs, cu: r.computeUnitsConsumed(), events: parseIntentsLogs(logs, PROGRAM_ID) };
  }

  // ------------------------------------------------------------ instructions

  /** An optional account given as null is Anchor's None: the program id, unsigned. */
  ix(name: string, args: Record<string, unknown>, accounts: Record<string, PublicKey | null>, remaining: PublicKey[] = []): TransactionInstruction {
    const def = INTENTS_IDL.instructions.find((i) => i.name === name);
    if (!def) throw new Error(`no instruction ${name}`);
    const keys = def.accounts.map((raw) => {
      const a = raw as { name: string; signer?: boolean; writable?: boolean; optional?: boolean };
      const pubkey = accounts[a.name];
      if (pubkey === null && a.optional) return { pubkey: PROGRAM_ID, isSigner: false, isWritable: false };
      if (!pubkey) throw new Error(`${name}: missing account ${a.name}`);
      return { pubkey, isSigner: !!a.signer, isWritable: !!a.writable };
    });
    keys.push(...remaining.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })));
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: coder.instruction.encode(name, args) });
  }

  initConfig(maxGas = MAX_GAS, l1 = L1_BUFFER, minGas = MIN_GAS, poolEvm = poolEvmAddress(GROUP_PK, PROGRAM_ID)): Sent {
    return this.send(
      [
        this.ix(
          "init_config",
          { pool_evm_addr: [...poolEvm], max_gas_price: bn(maxGas), l1_fee_buffer_wei: bn(l1), min_gas_price: bn(minGas) },
          { admin: this.admin.publicKey, config: this.config, pool: this.pool, system_program: SystemProgram.programId },
        ),
      ],
      [this.admin],
    );
  }

  /** `sig` defaults to DEPOSIT_KEY's proof for `kp`, built with the bot's own signer. */
  register(kp: Keypair, payout = PAYOUT_ADDR, depositFrom = DEPOSIT_FROM, sig = signDepositProof(DEPOSIT_KEY, kp.publicKey, PROGRAM_ID)): Sent {
    return this.send(
      [
        this.ix(
          "register_solver",
          { payout_addr: [...payout], deposit_from: [...depositFrom], deposit_sig: [...sig] },
          { authority: kp.publicKey, solver: solverPda(kp.publicKey, PROGRAM_ID)[0], system_program: SystemProgram.programId },
        ),
      ],
      [kp],
    );
  }

  /** Admin credit for deposit `txHash` (a fresh one unless given). */
  credit(authority: PublicKey, amountWei: bigint, signer = this.admin, txHash = Keypair.generate().publicKey.toBytes()): Sent {
    return this.send(
      [
        this.ix(
          "credit_solver",
          { amount_wei: bn(amountWei), tx_hash: [...txHash] },
          {
            admin: signer.publicKey,
            config: this.config,
            solver: solverPda(authority, PROGRAM_ID)[0],
            credit: creditPda(txHash, PROGRAM_ID)[0],
            system_program: SystemProgram.programId,
          },
        ),
      ],
      [signer],
    );
  }

  /** Plants a soda_witness Claim (as on_report leaves it) at a fresh address. */
  plantClaim(c: Partial<FakeClaim> = {}, owner = WITNESS): { claim: PublicKey; facts: FakeClaim } {
    const facts: FakeClaim = {
      requester: this.solver.publicKey,
      chainId: CHAIN_ID,
      txHash: Keypair.generate().publicKey.toBytes(),
      status: 1,
      from: DEPOSIT_FROM,
      to: this.cfg().poolEvmAddr,
      valueWei: ETH,
      block: 47_799_710n,
      success: true,
      recordedAt: this.now(),
      disc: CLAIM_DISC,
      ...c,
    };
    const claim = Keypair.generate().publicKey;
    const data = claimBytes(facts);
    this.svm.setAccount({
      address: address(claim.toBase58()),
      data,
      executable: false,
      lamports: lamports(this.rent(data.length)),
      programAddress: address(owner.toBase58()),
      space: BigInt(data.length),
    });
    return { claim, facts };
  }

  /** `admin` co-signs by default (the mock-forwarder witness needs it); null omits it. */
  creditFromClaim(
    claim: PublicKey,
    txHash: Uint8Array,
    authority = this.solver.publicKey,
    payer = this.stranger,
    admin: Keypair | null = this.admin,
    witnessConfig = witnessConfigPda(WITNESS)[0],
  ): Sent {
    return this.send(
      [
        this.ix(
          "credit_solver_from_claim",
          { tx_hash: [...txHash] },
          {
            payer: payer.publicKey,
            admin: admin?.publicKey ?? null,
            config: this.config,
            solver: solverPda(authority, PROGRAM_ID)[0],
            claim,
            witness_config: witnessConfig,
            credit: creditPda(txHash, PROGRAM_ID)[0],
            system_program: SystemProgram.programId,
          },
        ),
      ],
      admin ? [payer, admin] : [payer],
    );
  }

  setPaused(paused: boolean, signer = this.admin): Sent {
    return this.send([this.ix("set_paused", { paused }, { admin: signer.publicKey, config: this.config })], [signer]);
  }

  setMaxGas(maxGas: bigint, signer = this.admin): Sent {
    return this.send(
      [this.ix("set_max_gas_price", { max_gas_price: bn(maxGas) }, { admin: signer.publicKey, config: this.config })],
      [signer],
    );
  }

  setMinGas(minGas: bigint, signer = this.admin): Sent {
    return this.send(
      [this.ix("set_min_gas_price", { min_gas_price: bn(minGas) }, { admin: signer.publicKey, config: this.config })],
      [signer],
    );
  }

  defaultOpen(over: Partial<OpenParams> = {}): OpenParams {
    return {
      inLamports: BigInt(LAMPORTS_PER_SOL),
      recipient: RECIPIENT,
      startOutWei: ETH,
      minOutWei: (ETH * 9n) / 10n,
      auctionDuration: 120,
      expiresAt: this.now() + 600n,
      ...over,
    };
  }

  open(over: Partial<OpenParams> = {}, user = this.user, intentId = this.nextIntentId++): { intent: PublicKey; sent: Sent } {
    const p = this.defaultOpen(over);
    const intent = intentPda(user.publicKey, intentId, PROGRAM_ID)[0];
    const sent = this.send(
      [
        this.ix(
          "open_intent",
          {
            intent_id: bn(intentId),
            in_lamports: bn(p.inLamports),
            recipient: [...p.recipient],
            start_out_wei: bn(p.startOutWei),
            min_out_wei: bn(p.minOutWei),
            auction_duration: p.auctionDuration,
            expires_at: bn(p.expiresAt),
          },
          { user: user.publicKey, config: this.config, intent, system_program: SystemProgram.programId },
        ),
      ],
      [user],
    );
    return { intent, sent };
  }

  cancel(intent: PublicKey, user = this.user): Sent {
    return this.send([this.ix("cancel_intent", {}, { user: user.publicKey, intent })], [user]);
  }

  /** `closer` signs; rent goes to the intent's user. */
  close(intent: PublicKey, closer = this.user, user = this.user.publicKey): Sent {
    return this.send(
      [this.ix("close_intent", {}, { closer: closer.publicKey, user, config: this.config, intent })],
      [closer],
    );
  }

  /** sig_request is derived with lib/intents from the payout the program should build. */
  fill(
    intent: PublicKey,
    o: { outWei: bigint; gasPrice?: bigint; nonce?: bigint; solver?: Keypair; ledger?: PublicKey; sigRequest?: PublicKey; committee?: PublicKey; soda?: PublicKey },
  ): Sent {
    const solver = o.solver ?? this.solver;
    const gasPrice = o.gasPrice ?? GWEI;
    const nonce = o.nonce ?? this.cfg().nextNonce;
    const recipient = this.intent(intent).recipient;
    const { sigRequest } = payoutSigRequest({ recipient, outWei: o.outWei, baseNonce: nonce, gasPrice }, PROGRAM_ID, SODA);
    return this.send(
      [
        this.ix(
          "fill",
          { expected_nonce: bn(nonce), out_wei: bn(o.outWei), gas_price: bn(gasPrice) },
          {
            solver_authority: solver.publicKey,
            solver: o.ledger ?? solverPda(solver.publicKey, PROGRAM_ID)[0],
            config: this.config,
            intent,
            committee: o.committee ?? COMMITTEE_PDA,
            sig_request: o.sigRequest ?? sigRequest,
            pool: this.pool,
            soda_program: o.soda ?? SODA,
            system_program: SystemProgram.programId,
          },
        ),
      ],
      [solver],
    );
  }

  bump(intent: PublicKey, newGasPrice: bigint, caller = this.solver, reuse: PublicKey[] = []): Sent {
    const it = this.intent(intent);
    const { sigRequest } = payoutSigRequest(
      { recipient: it.recipient, outWei: it.outWei, baseNonce: it.baseNonce, gasPrice: newGasPrice },
      PROGRAM_ID,
      SODA,
    );
    return this.send(
      [
        this.ix(
          "bump_gas",
          { new_gas_price: bn(newGasPrice) },
          {
            caller: caller.publicKey,
            solver: solverPda(it.solver, PROGRAM_ID)[0],
            config: this.config,
            intent,
            committee: COMMITTEE_PDA,
            sig_request: sigRequest,
            pool: this.pool,
            soda_program: SODA,
            system_program: SystemProgram.programId,
          },
          reuse,
        ),
      ],
      [caller],
    );
  }

  bumpWithdrawal(nonce: bigint, newGasPrice: bigint, caller = this.solver, reuse: PublicKey[] = []): Sent {
    const key = withdrawalPda(nonce, PROGRAM_ID)[0];
    const w = this.withdrawal(nonce);
    const { sigRequest } = payoutSigRequest(
      { recipient: w.payoutAddr, outWei: w.amountWei, baseNonce: w.baseNonce, gasPrice: newGasPrice },
      PROGRAM_ID,
      SODA,
    );
    return this.send(
      [
        this.ix(
          "bump_withdrawal_gas",
          { new_gas_price: bn(newGasPrice) },
          {
            caller: caller.publicKey,
            solver: solverPda(w.solver, PROGRAM_ID)[0],
            config: this.config,
            withdrawal: key,
            committee: COMMITTEE_PDA,
            sig_request: sigRequest,
            pool: this.pool,
            soda_program: SODA,
            system_program: SystemProgram.programId,
          },
          reuse,
        ),
      ],
      [caller],
    );
  }

  withdraw(amountWei: bigint, o: { gasPrice?: bigint; nonce?: bigint; solver?: Keypair; ledger?: PublicKey } = {}): Sent {
    const solver = o.solver ?? this.solver;
    const ledger = o.ledger ?? solverPda(solver.publicKey, PROGRAM_ID)[0];
    const gasPrice = o.gasPrice ?? GWEI;
    const nonce = o.nonce ?? this.cfg().nextNonce;
    const payout = decodeSolver(this.data(ledger)!.data).payoutAddr;
    const { sigRequest } = payoutSigRequest({ recipient: payout, outWei: amountWei, baseNonce: nonce, gasPrice }, PROGRAM_ID, SODA);
    return this.send(
      [
        this.ix(
          "solver_withdraw",
          { expected_nonce: bn(nonce), amount_wei: bn(amountWei), gas_price: bn(gasPrice) },
          {
            solver_authority: solver.publicKey,
            solver: ledger,
            config: this.config,
            withdrawal: withdrawalPda(nonce, PROGRAM_ID)[0],
            committee: COMMITTEE_PDA,
            sig_request: sigRequest,
            pool: this.pool,
            soda_program: SODA,
            system_program: SystemProgram.programId,
          },
        ),
      ],
      [solver],
    );
  }

  // ------------------------------------------------------------ state

  cfg() {
    return decodeConfig(this.data(this.config)!.data);
  }
  ledger(authority = this.solver.publicKey) {
    return decodeSolver(this.data(solverPda(authority, PROGRAM_ID)[0])!.data);
  }
  intent(pk: PublicKey) {
    return decodeIntent(this.data(pk)!.data);
  }
  withdrawal(nonce: bigint) {
    return decodeWithdrawal(this.data(withdrawalPda(nonce, PROGRAM_ID)[0])!.data);
  }
  /** Stand-in for the committee: flip SigRequest.completed on-chain. */
  markSigned(pk: PublicKey) {
    const a = this.svm.getAccount(address(pk.toBase58()));
    assert.ok(a.exists);
    const data = Uint8Array.from(a.data);
    data[SIG_REQUEST_COMPLETED_OFFSET] = 1;
    this.svm.setAccount({ ...a, data });
    assert.equal(this.sigRequest(pk).completed, true);
  }
  sigRequest(pk: PublicKey) {
    const a = this.data(pk);
    assert.ok(a, `SigRequest ${pk.toBase58()} does not exist`);
    return { ...decodeSigRequest(a.data), lamports: a.lamports, owner: a.owner, size: a.data.length };
  }
}

type FakeClaim = {
  requester: PublicKey;
  chainId: bigint;
  txHash: Uint8Array;
  status: number;
  from: Uint8Array;
  to: Uint8Array;
  valueWei: bigint;
  block: bigint;
  success: boolean;
  recordedAt: bigint;
  disc: Uint8Array;
};

/** soda_witness Claim discriminator, sha256("account:Claim")[..8]. */
const CLAIM_DISC = Uint8Array.from([155, 70, 22, 176, 123, 215, 246, 102]);
/** soda_witness Config discriminator, sha256("account:Config")[..8]. */
const WITNESS_CONFIG_DISC = Uint8Array.from([155, 12, 170, 224, 30, 250, 204, 130]);

/** Claim bytes in soda_witness's Borsh layout (HANDOVER §4.2), bump 255. */
function claimBytes(c: FakeClaim): Uint8Array {
  const b = Buffer.alloc(WITNESS_CLAIM_SIZE);
  let o = 0;
  const put = (x: Uint8Array) => (b.set(x, o), (o += x.length));
  put(c.disc);
  put(c.requester.toBytes());
  o = b.writeBigUInt64LE(c.chainId, o);
  put(c.txHash);
  o = b.writeUInt8(c.status, o);
  put(c.from);
  put(c.to);
  o = b.writeBigUInt64LE(c.valueWei & ((1n << 64n) - 1n), o);
  o = b.writeBigUInt64LE(c.valueWei >> 64n, o);
  o = b.writeBigUInt64LE(c.block, o);
  o = b.writeUInt8(c.success ? 1 : 0, o);
  o = b.writeBigInt64LE(c.recordedAt, o);
  b.writeUInt8(255, o);
  return Uint8Array.from(b);
}

/** Config + one registered solver with `credit` wei on its ledger. */
function setup(credit = 10n * ETH): Env {
  const env = new Env();
  ok(env.initConfig(), "init_config");
  ok(env.register(env.solver), "register_solver");
  ok(env.credit(env.solver.publicKey, credit), "credit_solver");
  return env;
}

function ok(r: Sent, label = "tx"): Sent {
  assert.ok(r.ok, `${label} failed (code ${r.code}):\n${r.logs.slice(-8).join("\n")}`);
  return r;
}

function fails(r: Sent, code: number | readonly number[], label = "tx") {
  const codes = typeof code === "number" ? [code] : code;
  assert.ok(!r.ok, `${label} unexpectedly succeeded`);
  assert.ok(codes.includes(r.code ?? -1), `${label}: expected error ${codes.join("/")}, got ${r.code}:\n${r.logs.slice(-6).join("\n")}`);
}

function event<N extends IntentsEvent["name"]>(r: Sent, name: N): Extract<IntentsEvent, { name: N }> {
  const e = r.events.find((x) => x.name === name);
  assert.ok(e, `no ${name} event in ${r.events.map((x) => x.name).join(",")}`);
  return e as Extract<IntentsEvent, { name: N }>;
}

function other(r: Sent, eventName: string): Record<string, unknown> {
  const e = r.events.find((x) => x.name === "Other" && x.eventName === eventName);
  assert.ok(e && e.name === "Other", `no ${eventName} event`);
  return e.data;
}

const big = (v: unknown) => BigInt((v as { toString(): string }).toString());

// ====================================================================== tests

describe("pool address and payout parity with lib/soda", () => {
  it("init_config stores pool bump 254 and the SDK-derived pool address", () => {
    const env = setup();
    const [pool, poolBump] = poolPda(PROGRAM_ID);
    assert.equal(pool.toBase58(), POOL);
    assert.equal(poolBump, 254);

    const derived = deriveEthAddress(GROUP_PK, pool.toBytes(), new Uint8Array(0), EVM_CHAIN_TAG).ethAddress;
    assert.equal(hex(derived), POOL_EVM);

    const c = env.cfg();
    assert.ok(c.admin.equals(env.admin.publicKey));
    assert.equal(c.poolBump, 254);
    assert.equal(hex(c.poolEvmAddr), POOL_EVM);
    assert.equal(c.nextNonce, 0n);
    assert.equal(c.maxGasPrice, MAX_GAS);
    assert.equal(c.minGasPrice, MIN_GAS);
    assert.equal(c.l1FeeBufferWei, L1_BUFFER);
    assert.equal(c.paused, false);
    assert.ok(c.witnessProgram.equals(WITNESS));
    assert.equal(env.data(env.pool), null, "pool PDA must stay a data-less, unfunded address");

    assert.ok(!env.initConfig().ok, "second init_config must fail");
  });

  it("soda's stored foreign key, the RLP, the payload and the SigRequest address all match lib", () => {
    const env = setup();
    const { intent } = env.open();
    const p: PayoutParams = { recipient: RECIPIENT, outWei: ETH, baseNonce: 0n, gasPrice: GWEI };
    const r = ok(env.fill(intent, { outWei: ETH, gasPrice: GWEI, nonce: 0n }), "fill");

    // Events: EthTxRequested first (relayer layout), then IntentFilled; nothing from soda.
    assert.deepEqual(r.events.map((e) => e.name), ["EthTxRequested", "IntentFilled"]);
    const eth = event(r, "EthTxRequested");
    assert.equal(eth.chainId, CHAIN_ID);
    const expectedRlp = encodeUnsignedLegacy(buildPayoutTx(p));
    assert.equal(hex(eth.unsignedRlp), hex(expectedRlp));
    assert.equal(hex(eth.unsignedRlp), hex(payoutUnsignedRlp(p)));
    const tx = decodeUnsignedLegacy(eth.unsignedRlp);
    assert.equal(tx.nonce, 0n);
    assert.equal(tx.gasPriceWei, GWEI);
    assert.equal(tx.gasLimit, GAS_LIMIT);
    assert.equal(hex(tx.to), hex(RECIPIENT));
    assert.equal(tx.data.length, 0);
    assert.equal(tx.chainId, CHAIN_ID);

    const payload = keccak_256(expectedRlp);
    const { sigRequest } = payoutSigRequest(p, PROGRAM_ID, SODA);
    assert.ok(eth.sigRequest.equals(sigRequest));
    assert.ok(sigRequestPda(env.pool, payload, SODA)[0].equals(sigRequest));
    assert.ok(env.intent(intent).sigRequests[0].equals(sigRequest));

    // What the real soda program wrote.
    const sr = env.sigRequest(sigRequest);
    assert.equal(sr.owner, SODA.toBase58());
    assert.equal(sr.size, SIG_REQUEST_SIZE);
    assert.ok(sr.requester.equals(env.pool));
    assert.ok(sr.committee.equals(COMMITTEE_PDA));
    assert.equal(hex(sr.payload), hex(payload));
    assert.equal(hex(sr.payload), hex(payloadOf(eth.unsignedRlp)));
    assert.equal(hex(sr.chainTag), hex(EVM_CHAIN_TAG));
    assert.equal(sr.derivationSeeds.length, 0);
    assert.equal(sr.domainId, 0);
    assert.equal(sr.completed, false);
    assert.equal(sr.expiresAt, env.now() + 300n);

    const derived = deriveEthAddress(GROUP_PK, env.pool.toBytes(), new Uint8Array(0), EVM_CHAIN_TAG);
    assert.equal(hex(sr.foreignPkXy), hex(derived.foreignPk.subarray(1)));
    assert.equal(hex(keccak_256(sr.foreignPkXy).subarray(12)), POOL_EVM);

    // soda's own SigRequested names the pool and the same key (what the MPC subscriber sees).
    const sodaEvents = r.logs
      .filter((l) => l.startsWith("Program data: "))
      .map((l) => Buffer.from(l.slice(14), "base64"))
      .filter((b) => b.subarray(0, 8).toString("hex") === SIG_REQUESTED_DISC);
    assert.equal(sodaEvents.length, 1);
    const sq = sodaEvents[0];
    assert.ok(new PublicKey(sq.subarray(8, 40)).equals(sigRequest));
    assert.ok(new PublicKey(sq.subarray(40, 72)).equals(env.pool));
    assert.equal(hex(sq.subarray(72, 136)), hex(sr.foreignPkXy));
    assert.equal(hex(sq.subarray(136, 168)), hex(payload));

    // lib's candidate builder resolves the one pending candidate from the account alone.
    const cands = buildCandidates(env.intent(intent), [sr], { programId: PROGRAM_ID, sodaProgramId: SODA });
    assert.equal(cands.length, 1);
    assert.ok(cands[0].unsigned);
    assert.equal(hex(encodeUnsignedLegacy(cands[0].unsigned)), hex(expectedRlp));
    assert.equal(cands[0].completed, false);
    assert.equal(cands[0].signed, null);
  });
});

describe("open_intent", () => {
  it("escrows in_lamports in the intent account and emits IntentOpened", () => {
    const env = setup();
    const before = env.balance(env.user.publicKey);
    const { intent, sent } = env.open({ inLamports: 2n * BigInt(LAMPORTS_PER_SOL) }, env.user, 42n);
    ok(sent, "open_intent");
    const rent = env.rent(331);
    assert.equal(env.balance(intent), rent + 2n * BigInt(LAMPORTS_PER_SOL));
    assert.equal(before - env.balance(env.user.publicKey), rent + 2n * BigInt(LAMPORTS_PER_SOL));

    const it = env.intent(intent);
    assert.ok(it.user.equals(env.user.publicKey));
    assert.equal(it.intentId, 42n);
    assert.equal(it.status, IntentStatus.Open);
    assert.equal(it.auctionStart, env.now());
    assert.equal(it.sigRequestCount, 0);
    assert.equal(it.bump, intentPda(env.user.publicKey, 42n, PROGRAM_ID)[1]);

    const ev = event(sent, "IntentOpened");
    assert.ok(ev.intent.equals(intent));
    assert.equal(ev.intentId, 42n);
    assert.equal(ev.inLamports, 2n * BigInt(LAMPORTS_PER_SOL));
    assert.equal(hex(ev.recipient), hex(RECIPIENT));
    assert.equal(ev.auctionStart, env.now());
    assert.equal(ev.expiresAt, it.expiresAt);
  });

  it("rejects bad auction parameters with BadAuctionParams", () => {
    const env = setup();
    const now = env.now();
    const bad: [string, Partial<OpenParams>][] = [
      ["min_out_wei = 0", { minOutWei: 0n, startOutWei: ETH }],
      ["start < min", { startOutWei: ETH - 1n, minOutWei: ETH }],
      ["expires_at = now + duration", { auctionDuration: 120, expiresAt: now + 120n }],
      ["expires_at in the past", { expiresAt: now - 1n }],
      ["in_lamports = 0", { inLamports: 0n }],
      ["zero recipient", { recipient: new Uint8Array(20) }],
    ];
    for (const [label, over] of bad) fails(env.open(over).sent, ERR.BadAuctionParams, label);

    ok(env.open({ auctionDuration: 120, expiresAt: now + 121n }).sent, "expires_at = now + duration + 1");
    ok(env.open({ startOutWei: ETH, minOutWei: ETH, auctionDuration: 0, expiresAt: now + 1n }).sent, "flat price, zero duration");
  });

  it("rejects reusing an intent id", () => {
    const env = setup();
    ok(env.open({}, env.user, 7n).sent);
    assert.ok(!env.open({}, env.user, 7n).sent.ok);
  });
});

describe("fill", () => {
  it("moves exactly in_lamports to the solver wallet, debits the ledger and takes the nonce", (t: TestContext) => {
    const env = setup();
    const { intent } = env.open();
    const intentRent = env.rent(331);
    const solverWallet = env.balance(env.solver.publicKey);
    const userWallet = env.balance(env.user.publicKey);
    const ledger = env.ledger().balanceWei;
    const outWei = ETH;
    const gas = 2n * GWEI;

    const r = ok(env.fill(intent, { outWei, gasPrice: gas }), "fill");
    t.diagnostic(`fill CU ${r.cu}`);
    assert.ok(r.cu < 300_000n, `fill used ${r.cu} CU`);

    const it = env.intent(intent);
    const sr = env.sigRequest(it.sigRequests[0]);
    t.diagnostic(`SigRequest rent ${sr.lamports} lamports (${sr.size} bytes)`);
    assert.equal(sr.lamports, env.rent(SIG_REQUEST_SIZE));
    assert.equal(env.balance(intent), intentRent, "intent keeps exactly its rent");
    assert.equal(env.balance(env.solver.publicKey) - solverWallet, BigInt(LAMPORTS_PER_SOL) - sr.lamports);
    assert.equal(env.balance(env.user.publicKey), userWallet);
    assert.equal(env.data(env.pool), null, "pool PDA stays unfunded");

    const cost = payoutCost(outWei, gas, L1_BUFFER);
    assert.equal(cost, outWei + gas * 21_000n + L1_BUFFER);
    assert.equal(ledger - env.ledger().balanceWei, cost);
    assert.equal(env.ledger().fills, 1n);
    assert.equal(env.cfg().nextNonce, 1n);

    assert.equal(it.status, IntentStatus.Filled);
    assert.ok(it.solver.equals(env.solver.publicKey), "Intent.solver is the solver wallet");
    assert.equal(it.outWei, outWei);
    assert.equal(it.baseNonce, 0n);
    assert.equal(it.gasPrice, gas);
    assert.equal(it.filledAt, env.now());
    assert.equal(it.sigRequestCount, 1);

    const ev = event(r, "IntentFilled");
    assert.ok(ev.intent.equals(intent));
    assert.ok(ev.user.equals(env.user.publicKey));
    assert.ok(ev.solver.equals(env.solver.publicKey));
    assert.equal(ev.inLamports, BigInt(LAMPORTS_PER_SOL));
    assert.equal(ev.outWei, outWei);
    assert.equal(ev.baseNonce, 0n);
    assert.equal(ev.gasPrice, gas);
    assert.ok(ev.sigRequest.equals(it.sigRequests[0]));
    assert.equal(ev.filledAt, env.now());
  });

  it("required_out at start, middle and end: exactly required passes, 1 wei below fails", () => {
    const env = setup(100n * ETH);
    // 1 s exercises the floor rounding; 119 is the last second of decay.
    for (const offset of [0n, 1n, 37n, 60n, 119n, 120n, 500n]) {
      const { intent } = env.open({ auctionDuration: 120, expiresAt: env.now() + 600n });
      const it = env.intent(intent);
      env.advance(offset);
      const need = requiredOut(it.startOutWei, it.minOutWei, it.auctionStart, BigInt(it.auctionDuration), env.now());
      if (offset === 0n) assert.equal(need, ETH);
      if (offset === 60n) assert.equal(need, (ETH * 95n) / 100n);
      if (offset >= 120n) assert.equal(need, (ETH * 9n) / 10n);
      fails(env.fill(intent, { outWei: need - 1n }), ERR.BelowRequiredOut, `t+${offset} required - 1`);
      ok(env.fill(intent, { outWei: need }), `t+${offset} required`);
    }
  });

  it("fails IntentExpired at expires_at, passes one second before", () => {
    const env = setup();
    const a = env.open({ expiresAt: env.now() + 600n }).intent;
    const b = env.open({ expiresAt: env.now() + 600n }).intent;
    env.advance(599n);
    ok(env.fill(a, { outWei: ETH }), "fill at expires_at - 1");
    env.advance(1n);
    fails(env.fill(b, { outWei: ETH }), ERR.IntentExpired, "fill at expires_at");
    env.advance(1000n);
    fails(env.fill(b, { outWei: ETH }), ERR.IntentExpired, "fill long after expiry");
    ok(env.cancel(b), "an expired intent can still be cancelled");
  });

  it("fails GasPriceTooHigh over max_gas_price; the cap itself passes; set_max_gas_price lifts it", () => {
    const env = setup();
    const a = env.open().intent;
    const b = env.open().intent;
    fails(env.fill(a, { outWei: ETH, gasPrice: MAX_GAS + 1n }), ERR.GasPriceTooHigh);
    ok(env.fill(a, { outWei: ETH, gasPrice: MAX_GAS }), "fill at the cap");
    fails(env.fill(b, { outWei: ETH, gasPrice: 2n * MAX_GAS }), ERR.GasPriceTooHigh);
    ok(env.setMaxGas(2n * MAX_GAS));
    ok(env.fill(b, { outWei: ETH, gasPrice: 2n * MAX_GAS }), "fill after raising the cap");
  });

  it("fails InsufficientSolverBalance 1 wei short of cost; exactly cost passes and empties the ledger", () => {
    const env = setup();
    const poor = Keypair.generate();
    env.svm.airdrop(address(poor.publicKey.toBase58()), lamports(10n * BigInt(LAMPORTS_PER_SOL)));
    ok(env.register(poor));
    const cost = payoutCost(ETH, GWEI, L1_BUFFER);
    ok(env.credit(poor.publicKey, cost - 1n));
    const { intent } = env.open();
    fails(env.fill(intent, { outWei: ETH, gasPrice: GWEI, solver: poor }), ERR.InsufficientSolverBalance);
    ok(env.credit(poor.publicKey, 1n));
    ok(env.fill(intent, { outWei: ETH, gasPrice: GWEI, solver: poor }));
    assert.equal(env.ledger(poor.publicKey).balanceWei, 0n);
  });

  it("fails NonceMoved for the solver that lost the race", () => {
    const env = setup();
    const rival = Keypair.generate();
    env.svm.airdrop(address(rival.publicKey.toBase58()), lamports(10n * BigInt(LAMPORTS_PER_SOL)));
    ok(env.register(rival));
    ok(env.credit(rival.publicKey, 10n * ETH));
    const a = env.open().intent;
    const b = env.open().intent;
    ok(env.fill(a, { outWei: ETH, nonce: 0n }), "winner");
    fails(env.fill(b, { outWei: ETH, nonce: 0n, solver: rival }), ERR.NonceMoved, "stale nonce");
    fails(env.fill(b, { outWei: ETH, nonce: 2n, solver: rival }), ERR.NonceMoved, "future nonce");
    ok(env.fill(b, { outWei: ETH, nonce: 1n, solver: rival }), "re-read nonce");
    assert.equal(env.cfg().nextNonce, 2n);
  });

  it("double fill fails IntentNotOpen", () => {
    const env = setup();
    const { intent } = env.open();
    ok(env.fill(intent, { outWei: ETH }));
    fails(env.fill(intent, { outWei: ETH }), ERR.IntentNotOpen);
    fails(env.fill(intent, { outWei: 2n * ETH }), ERR.IntentNotOpen);
  });

  it("paused: open_intent, fill and solver_withdraw fail Paused; cancel still works", () => {
    const env = setup();
    const a = env.open().intent;
    const b = env.open().intent;
    ok(env.setPaused(true));
    fails(env.open().sent, ERR.Paused, "open while paused");
    fails(env.fill(a, { outWei: ETH }), ERR.Paused, "fill while paused");
    fails(env.withdraw(ETH / 10n), ERR.Paused, "withdraw while paused");
    ok(env.cancel(b), "cancel while paused");
    ok(env.setPaused(false));
    ok(env.fill(a, { outWei: ETH }), "fill after unpause");
  });

  it("a sig_request that does not match the program's payout is rejected by soda, leaving state untouched", () => {
    const env = setup();
    const { intent } = env.open();
    const wrong = payoutSigRequest({ recipient: RECIPIENT, outWei: ETH, baseNonce: 0n, gasPrice: GWEI + 1n }, PROGRAM_ID, SODA).sigRequest;
    const ledger = env.ledger().balanceWei;
    const r = env.fill(intent, { outWei: ETH, gasPrice: GWEI, sigRequest: wrong });
    assert.ok(!r.ok);
    assert.ok(r.logs.some((l) => l.includes(`Program ${SODA.toBase58()} failed`)), "soda rejects the seeds");
    assert.equal(env.intent(intent).status, IntentStatus.Open);
    assert.equal(env.cfg().nextNonce, 0n);
    assert.equal(env.ledger().balanceWei, ledger);
  });

  it("cannot spend another solver's ledger, or use a fake committee or soda program", () => {
    const env = setup();
    const thief = Keypair.generate();
    env.svm.airdrop(address(thief.publicKey.toBase58()), lamports(10n * BigInt(LAMPORTS_PER_SOL)));
    ok(env.register(thief));
    const { intent } = env.open();
    fails(env.fill(intent, { outWei: ETH, solver: thief, ledger: solverPda(env.solver.publicKey, PROGRAM_ID)[0] }), ERR.ConstraintSeeds);
    fails(env.fill(intent, { outWei: ETH, committee: Keypair.generate().publicKey }), ERR.ConstraintAddress);
    fails(env.fill(intent, { outWei: ETH, soda: SystemProgram.programId }), ERR.ConstraintAddress);
    ok(env.fill(intent, { outWei: ETH }));
  });
});

describe("cancel_intent and close_intent", () => {
  it("cancel refunds the escrow; close returns the rent; a second cancel and a later fill fail", () => {
    const env = setup();
    const { intent } = env.open({ inLamports: 3n * BigInt(LAMPORTS_PER_SOL) });
    const rent = env.rent(331);
    const before = env.balance(env.user.publicKey);

    const r = ok(env.cancel(intent), "cancel");
    assert.equal(env.balance(env.user.publicKey) - before, 3n * BigInt(LAMPORTS_PER_SOL));
    assert.equal(env.balance(intent), rent);
    assert.equal(env.intent(intent).status, IntentStatus.Cancelled);
    const ev = event(r, "IntentCancelled");
    assert.ok(ev.intent.equals(intent));
    assert.equal(ev.refundedLamports, 3n * BigInt(LAMPORTS_PER_SOL));

    fails(env.cancel(intent), ERR.IntentNotOpen, "cancel twice");
    fails(env.fill(intent, { outWei: ETH }), ERR.IntentNotOpen, "fill after cancel");

    ok(env.close(intent), "close cancelled");
    assert.equal(env.balance(env.user.publicKey) - before, 3n * BigInt(LAMPORTS_PER_SOL) + rent);
    assert.equal(env.data(intent), null);
  });

  it("close: Open fails NotClosable; Filled only by the admin after filled_at + 600, rent to the user", () => {
    const env = setup();
    const { intent } = env.open();
    fails(env.close(intent), ERR.NotClosable, "close open");
    fails(env.close(intent, env.admin), ERR.NotClosable, "admin close open");
    ok(env.fill(intent, { outWei: ETH }));
    const filledAt = env.intent(intent).filledAt;
    fails(env.close(intent, env.admin), ERR.NotClosable, "admin close right after fill");
    env.setTime(filledAt + 600n);
    fails(env.close(intent, env.admin), ERR.NotClosable, "admin close at filled_at + 600");
    env.setTime(filledAt + 601n);
    const before = env.balance(env.user.publicKey);
    ok(env.close(intent, env.admin), "admin close at filled_at + 601");
    assert.equal(env.balance(env.user.publicKey) - before, env.rent(331));
    assert.equal(env.data(intent), null);
  });

  it("F3: the user cannot close a Filled intent, so its bump state survives an unlanded payout", () => {
    const env = setup();
    const { intent } = env.open();
    ok(env.fill(intent, { outWei: ETH, gasPrice: MIN_GAS }));
    const filledAt = env.intent(intent).filledAt;
    env.setTime(filledAt + 10_000n);
    fails(env.close(intent), ERR.NotClosable, "user close long after fill");
    fails(env.close(intent, env.stranger), ERR.NotClosable, "stranger close");
    // The payout can still be re-signed at its nonce.
    ok(env.bump(intent, 2n * GWEI, env.stranger), "bump after the user's attempt");
    assert.equal(env.intent(intent).sigRequestCount, 2);
  });

  it("only the intent's user can cancel or close it", () => {
    const env = setup();
    const { intent } = env.open();
    const notUser = [ERR.ConstraintSeeds, ERR.ConstraintHasOne];
    fails(env.cancel(intent, env.stranger), notUser, "stranger cancel");
    fails(env.cancel(intent, env.solver), notUser, "solver cancel");
    ok(env.cancel(intent));
    fails(env.close(intent, env.stranger), ERR.NotClosable, "stranger close");
    fails(env.close(intent, env.admin), ERR.NotClosable, "admin close of a cancelled intent");
    fails(env.close(intent, env.stranger, env.stranger.publicKey), notUser, "rent to someone else");
    ok(env.close(intent));
  });
});

describe("bump_gas", () => {
  it("the filling solver can bump at once: same nonce, new SigRequest, extra gas from its ledger", (t: TestContext) => {
    const env = setup();
    const { intent } = env.open();
    ok(env.fill(intent, { outWei: ETH, gasPrice: GWEI }));
    const first = env.intent(intent).sigRequests[0];
    const ledger = env.ledger().balanceWei;
    const wallet = env.balance(env.solver.publicKey);
    const nonceAfterFill = env.cfg().nextNonce;

    const newGas = minBumpGasPrice(GWEI);
    assert.equal(newGas, (GWEI * 110n) / 100n);
    const r = ok(env.bump(intent, newGas), "bump");
    t.diagnostic(`bump_gas CU ${r.cu}`);
    assert.ok(r.cu < 300_000n, `bump_gas used ${r.cu} CU`);

    const it = env.intent(intent);
    assert.equal(it.sigRequestCount, 2);
    assert.equal(it.gasPrice, newGas);
    assert.equal(it.baseNonce, 0n);
    assert.ok(it.sigRequests[0].equals(first));
    assert.equal(env.cfg().nextNonce, nonceAfterFill, "a bump does not take a new nonce");
    assert.equal(ledger - env.ledger().balanceWei, (newGas - GWEI) * GAS_LIMIT);

    const eth = event(r, "EthTxRequested");
    const tx = decodeUnsignedLegacy(eth.unsignedRlp);
    assert.equal(tx.nonce, 0n);
    assert.equal(tx.gasPriceWei, newGas);
    assert.equal(hex(tx.to), hex(RECIPIENT));
    assert.equal(hex(eth.unsignedRlp), hex(payoutUnsignedRlp({ recipient: RECIPIENT, outWei: ETH, baseNonce: 0n, gasPrice: newGas })));
    assert.ok(eth.sigRequest.equals(it.sigRequests[1]));
    const sr = env.sigRequest(it.sigRequests[1]);
    assert.equal(hex(sr.payload), hex(keccak_256(eth.unsignedRlp)));
    assert.ok(sr.requester.equals(env.pool));
    assert.equal(wallet - env.balance(env.solver.publicKey), sr.lamports, "caller pays the SigRequest rent");

    const gb = event(r, "GasBumped");
    assert.ok(gb.intent.equals(intent));
    assert.ok(gb.caller.equals(env.solver.publicKey));
    assert.ok(gb.solver.equals(env.solver.publicKey));
    assert.equal(gb.baseNonce, 0n);
    assert.equal(gb.oldGasPrice, GWEI);
    assert.equal(gb.newGasPrice, newGas);
    assert.ok(gb.sigRequest.equals(it.sigRequests[1]));
    assert.equal(gb.sigRequestCount, 2);
  });

  it("a stranger may bump only after filled_at + 60, and the filling solver's ledger pays", () => {
    const env = setup();
    const { intent } = env.open();
    ok(env.fill(intent, { outWei: ETH, gasPrice: GWEI }));
    const filledAt = env.intent(intent).filledAt;
    const ledger = env.ledger().balanceWei;
    const strangerWallet = env.balance(env.stranger.publicKey);
    const newGas = 2n * GWEI;

    fails(env.bump(intent, newGas, env.stranger), ERR.NotFillingSolver, "stranger at once");
    env.setTime(filledAt + 60n);
    fails(env.bump(intent, newGas, env.stranger), ERR.NotFillingSolver, "stranger at filled_at + 60");
    env.setTime(filledAt + 61n);
    const r = ok(env.bump(intent, newGas, env.stranger), "stranger at filled_at + 61");

    const it = env.intent(intent);
    const sr = env.sigRequest(it.sigRequests[1]);
    assert.equal(strangerWallet - env.balance(env.stranger.publicKey), sr.lamports);
    assert.equal(ledger - env.ledger().balanceWei, (newGas - GWEI) * GAS_LIMIT);
    const gb = event(r, "GasBumped");
    assert.ok(gb.caller.equals(env.stranger.publicKey));
    assert.ok(gb.solver.equals(env.solver.publicKey));
  });

  it("under 10% fails BumpTooSmall; lib's minBumpGasPrice is exactly the boundary", () => {
    const env = setup();
    const { intent } = env.open();
    const gas = GWEI + 7n; // floor(old * 110 / 100) is not a round number here
    ok(env.fill(intent, { outWei: ETH, gasPrice: gas }));
    const min = minBumpGasPrice(gas);
    assert.equal(min, (gas * 110n) / 100n);
    fails(env.bump(intent, gas), ERR.BumpTooSmall, "same price");
    fails(env.bump(intent, min - 1n), ERR.BumpTooSmall, "min - 1");
    ok(env.bump(intent, min), "exactly min");
  });

  it("over max_gas_price fails GasPriceTooHigh; bumps still work while paused", () => {
    const env = setup();
    const { intent } = env.open();
    ok(env.fill(intent, { outWei: ETH, gasPrice: 4n * GWEI }));
    fails(env.bump(intent, MAX_GAS + 1n), ERR.GasPriceTooHigh);
    ok(env.setPaused(true));
    ok(env.bump(intent, MAX_GAS), "bump at the cap while paused");
  });

  it("a 5th SigRequest fails TooManyBumps; lib rebuilds all four candidates from event hints", () => {
    const env = setup();
    const { intent } = env.open();
    const fill = ok(env.fill(intent, { outWei: ETH, gasPrice: GWEI }));
    const events: IntentsEvent[] = [...fill.events];
    let gas = GWEI;
    for (let i = 0; i < 3; i++) {
      gas = minBumpGasPrice(gas);
      events.push(...ok(env.bump(intent, gas), `bump ${i + 1}`).events);
    }
    fails(env.bump(intent, minBumpGasPrice(gas)), ERR.TooManyBumps);

    const it = env.intent(intent);
    assert.equal(it.sigRequestCount, 4);
    const accounts = it.sigRequests.map((k) => decodeSigRequest(env.data(k)!.data));
    assert.equal(new Set(it.sigRequests.map((k) => k.toBase58())).size, 4);

    // Gas-price hints alone (no SigRequest accounts) must reproduce every PDA.
    const hinted = buildCandidates(it, [], {
      gasPriceHints: gasPricesFromEvents(events, intent),
      programId: PROGRAM_ID,
      sodaProgramId: SODA,
    });
    assert.equal(hinted.length, 4);
    for (const c of hinted) {
      assert.ok(c.unsigned, `candidate ${c.index} unresolved`);
      assert.equal(c.unsigned.nonce, 0n);
      assert.equal(hex(payloadOf(encodeUnsignedLegacy(c.unsigned))), hex(accounts[c.index].payload));
    }
    // And the RLP from EthTxRequested events resolves them against the real accounts.
    const fromRlp = buildCandidates(it, accounts, {
      unsignedBySigRequest: unsignedRlpBySigRequest(events),
      programId: PROGRAM_ID,
      sodaProgramId: SODA,
    });
    assert.ok(fromRlp.every((c) => c.unsigned && c.gasPrice !== null));
    assert.deepEqual(fromRlp.map((c) => c.gasPrice), [GWEI, 1_100_000_000n, 1_210_000_000n, 1_331_000_000n]);
  });

  it("an Open intent cannot be bumped", () => {
    const env = setup();
    const { intent } = env.open();
    // The filling-solver ledger is seeded from Intent.solver, still default while Open.
    const it = env.intent(intent);
    assert.ok(it.solver.equals(PublicKey.default));
    const r = env.bump(intent, 2n * GWEI);
    assert.ok(!r.ok);
    assert.ok([ERR.IntentNotOpen, 3012 /* AccountNotInitialized */].includes(r.code as number), `got ${r.code}`);
  });

  it("fails InsufficientSolverBalance when the filling solver cannot cover the extra gas", () => {
    const env = setup(payoutCost(ETH, GWEI, L1_BUFFER));
    const { intent } = env.open();
    ok(env.fill(intent, { outWei: ETH, gasPrice: GWEI }));
    assert.equal(env.ledger().balanceWei, 0n);
    fails(env.bump(intent, 2n * GWEI), ERR.InsufficientSolverBalance);
    ok(env.credit(env.solver.publicKey, GWEI * GAS_LIMIT));
    ok(env.bump(intent, 2n * GWEI));
    assert.equal(env.ledger().balanceWei, 0n);
  });

  /** A fill plus three bumps, all left unsigned: every slot is taken. */
  function exhausted(env: Env, intent: PublicKey): bigint {
    ok(env.fill(intent, { outWei: ETH, gasPrice: GWEI }));
    let gas = GWEI;
    for (let i = 0; i < 3; i++) {
      gas = minBumpGasPrice(gas);
      ok(env.bump(intent, gas), `bump ${i + 1}`);
    }
    assert.equal(env.intent(intent).sigRequestCount, 4);
    return gas;
  }

  it("F2: with all slots taken, anyone may reuse the slot of a SigRequest that expired unsigned", () => {
    const env = setup();
    const { intent } = env.open();
    const gas = exhausted(env, intent);
    const before = env.intent(intent);
    const dead = before.sigRequests[1];
    const expiresAt = env.sigRequest(dead).expiresAt;
    const next = minBumpGasPrice(gas);

    fails(env.bump(intent, next), ERR.TooManyBumps, "nothing offered");
    env.setTime(expiresAt + 60n);
    fails(env.bump(intent, next, env.stranger, [dead]), ERR.TooManyBumps, "inside the 60 s margin");
    env.setTime(expiresAt + 61n);
    const r = ok(env.bump(intent, next, env.stranger, [dead]), "reuse the dead slot");

    const it = env.intent(intent);
    assert.equal(it.sigRequestCount, 4);
    assert.equal(it.gasPrice, next);
    assert.ok(!it.sigRequests[1].equals(dead), "slot 1 now holds the new request");
    for (const i of [0, 2, 3]) assert.ok(it.sigRequests[i].equals(before.sigRequests[i]));
    const eth = event(r, "EthTxRequested");
    assert.ok(eth.sigRequest.equals(it.sigRequests[1]));
    assert.equal(decodeUnsignedLegacy(eth.unsignedRlp).nonce, it.baseNonce);
    assert.equal(event(r, "GasBumped").sigRequestCount, 4);
  });

  it("F2: a signed, foreign-owned or unrelated SigRequest does not free a slot; the admin may reuse any", () => {
    const env = setup();
    const { intent } = env.open();
    const gas = exhausted(env, intent);
    const it = env.intent(intent);
    const [s0, s1, s2] = it.sigRequests;
    env.setTime(env.sigRequest(s2).expiresAt + 1_000n);
    const next = minBumpGasPrice(gas);

    env.markSigned(s0);
    fails(env.bump(intent, next, env.stranger, [s0]), ERR.TooManyBumps, "signed request");

    const a = env.svm.getAccount(address(s1.toBase58()));
    assert.ok(a.exists);
    env.svm.setAccount({ ...a, programAddress: address(SystemProgram.programId.toBase58()) });
    fails(env.bump(intent, next, env.stranger, [s1]), ERR.TooManyBumps, "not owned by soda");

    // A dead request that belongs to another intent is not one of this intent's slots.
    const other = env.open().intent;
    ok(env.fill(other, { outWei: ETH, gasPrice: GWEI }));
    env.advance(1_000n);
    const foreign = env.intent(other).sigRequests[0];
    fails(env.bump(intent, next, env.stranger, [foreign]), ERR.TooManyBumps, "another intent's request");

    // The admin's escape hatch: reuse a slot even though it was signed.
    ok(env.bump(intent, next, env.admin, [s0]), "admin reuses slot 0");
    assert.ok(!env.intent(intent).sigRequests[0].equals(s0));
    // Still dead-provable for anyone.
    ok(env.bump(intent, minBumpGasPrice(next), env.stranger, [s0, s2]), "stranger reuses dead slot 2");
    assert.ok(!env.intent(intent).sigRequests[2].equals(s2));
  });

  it("F5: a bump must reach min_gas_price, so raising the floor re-prices a stuck payout", () => {
    const env = setup();
    const { intent } = env.open();
    ok(env.fill(intent, { outWei: ETH, gasPrice: MIN_GAS }));
    ok(env.setMinGas(GWEI));
    fails(env.bump(intent, minBumpGasPrice(MIN_GAS)), ERR.GasPriceTooLow, "+10% but under the new floor");
    ok(env.bump(intent, GWEI), "bump to the floor");
  });
});

describe("solver_withdraw", () => {
  it("debits amount + gas + buffer, takes the next nonce and pays payout_addr", (t: TestContext) => {
    const env = setup();
    const amount = ETH / 4n;
    const gas = 3n * GWEI;
    const ledger = env.ledger().balanceWei;
    const r = ok(env.withdraw(amount, { gasPrice: gas }), "withdraw");
    t.diagnostic(`solver_withdraw CU ${r.cu}`);
    assert.ok(r.cu < 300_000n, `solver_withdraw used ${r.cu} CU`);

    assert.equal(ledger - env.ledger().balanceWei, payoutCost(amount, gas, L1_BUFFER));
    assert.equal(env.cfg().nextNonce, 1n);

    const p: PayoutParams = { recipient: PAYOUT_ADDR, outWei: amount, baseNonce: 0n, gasPrice: gas };
    const eth = event(r, "EthTxRequested");
    assert.equal(hex(eth.unsignedRlp), hex(payoutUnsignedRlp(p)));
    const tx = decodeUnsignedLegacy(eth.unsignedRlp);
    assert.equal(hex(tx.to), hex(PAYOUT_ADDR));
    assert.equal(tx.nonce, 0n);
    const { sigRequest } = payoutSigRequest(p, PROGRAM_ID, SODA);
    assert.ok(eth.sigRequest.equals(sigRequest));
    const sr = env.sigRequest(sigRequest);
    assert.ok(sr.requester.equals(env.pool));
    assert.equal(hex(sr.payload), hex(keccak_256(eth.unsignedRlp)));

    const w = other(r, "SolverWithdrew");
    assert.ok((w.solver as PublicKey).equals(env.solver.publicKey));
    assert.equal(hex(Uint8Array.from(w.payout_addr as number[])), hex(PAYOUT_ADDR));
    assert.equal(big(w.amount_wei), amount);
    assert.equal(big(w.base_nonce), 0n);
    assert.equal(big(w.gas_price), gas);
    assert.ok((w.sig_request as PublicKey).equals(sigRequest));
    assert.equal(big(w.balance_wei), env.ledger().balanceWei);
  });

  it("shares one nonce sequence with fills", () => {
    const env = setup();
    const a = env.open().intent;
    const b = env.open().intent;
    ok(env.fill(a, { outWei: ETH }));
    ok(env.withdraw(ETH / 10n));
    ok(env.fill(b, { outWei: ETH }));
    assert.equal(env.intent(a).baseNonce, 0n);
    assert.equal(env.intent(b).baseNonce, 2n);
    assert.equal(env.cfg().nextNonce, 3n);
  });

  it("rejects a stale nonce, over balance, over max gas and another solver's ledger", () => {
    const env = setup(ETH);
    fails(env.withdraw(ETH / 10n, { nonce: 1n }), ERR.NonceMoved, "wrong nonce");
    fails(env.withdraw(ETH), ERR.InsufficientSolverBalance, "amount = balance (gas not covered)");
    fails(env.withdraw(ETH / 10n, { gasPrice: MAX_GAS + 1n }), ERR.GasPriceTooHigh, "over max gas");
    const thief = Keypair.generate();
    env.svm.airdrop(address(thief.publicKey.toBase58()), lamports(10n * BigInt(LAMPORTS_PER_SOL)));
    ok(env.register(thief, new Uint8Array(20).fill(0x66)));
    fails(
      env.withdraw(ETH / 10n, { solver: thief, ledger: solverPda(env.solver.publicKey, PROGRAM_ID)[0] }),
      ERR.ConstraintSeeds,
      "thief",
    );
    const all = ETH - GWEI * GAS_LIMIT - L1_BUFFER;
    ok(env.withdraw(all), "withdraw everything net of gas and buffer");
    assert.equal(env.ledger().balanceWei, 0n);
  });

  it("F1/F5: rejects amount 0 and a gas price under min_gas_price", () => {
    const env = setup();
    const ledger = env.ledger().balanceWei;
    fails(env.withdraw(0n), ERR.ZeroAmount, "zero amount");
    fails(env.withdraw(ETH / 10n, { gasPrice: 0n }), ERR.GasPriceTooLow, "gas 0");
    fails(env.withdraw(ETH / 10n, { gasPrice: MIN_GAS - 1n }), ERR.GasPriceTooLow, "gas under the floor");
    assert.equal(env.cfg().nextNonce, 0n);
    assert.equal(env.ledger().balanceWei, ledger);
    ok(env.withdraw(ETH / 10n, { gasPrice: MIN_GAS }), "gas at the floor");
  });

  it("F1: records a Withdrawal at its nonce, which bump_withdrawal_gas re-signs", (t: TestContext) => {
    const env = setup();
    const amount = ETH / 4n;
    ok(env.withdraw(amount, { gasPrice: MIN_GAS }), "withdraw");
    const w = env.withdrawal(0n);
    assert.ok(w.solver.equals(env.solver.publicKey));
    assert.equal(hex(w.payoutAddr), hex(PAYOUT_ADDR));
    assert.equal(w.amountWei, amount);
    assert.equal(w.baseNonce, 0n);
    assert.equal(w.gasPrice, MIN_GAS);
    assert.equal(w.createdAt, env.now());
    assert.equal(w.sigRequestCount, 1);
    assert.ok(w.sigRequests[0].equals(payoutSigRequest({ recipient: PAYOUT_ADDR, outWei: amount, baseNonce: 0n, gasPrice: MIN_GAS }, PROGRAM_ID, SODA).sigRequest));
    assert.equal(w.bump, withdrawalPda(0n, PROGRAM_ID)[1]);

    // Later traffic does not stop a bump of the stuck head-of-queue withdrawal.
    ok(env.fill(env.open().intent, { outWei: ETH }));
    const ledger = env.ledger().balanceWei;
    const newGas = 2n * GWEI;
    fails(env.bumpWithdrawal(0n, newGas, env.stranger), ERR.NotFillingSolver, "stranger at once");
    fails(env.bumpWithdrawal(0n, minBumpGasPrice(MIN_GAS) - 1n), ERR.BumpTooSmall, "under +10%");
    fails(env.bumpWithdrawal(0n, MAX_GAS + 1n), ERR.GasPriceTooHigh, "over the cap");
    const r = ok(env.bumpWithdrawal(0n, newGas), "solver bumps");
    t.diagnostic(`bump_withdrawal_gas CU ${r.cu}`);

    const after = env.withdrawal(0n);
    assert.equal(after.sigRequestCount, 2);
    assert.equal(after.gasPrice, newGas);
    assert.equal(ledger - env.ledger().balanceWei, (newGas - MIN_GAS) * GAS_LIMIT);
    assert.equal(env.cfg().nextNonce, 2n, "a bump takes no nonce");
    const eth = event(r, "EthTxRequested");
    const tx = decodeUnsignedLegacy(eth.unsignedRlp);
    assert.equal(tx.nonce, 0n);
    assert.equal(tx.gasPriceWei, newGas);
    assert.equal(hex(tx.to), hex(PAYOUT_ADDR));
    assert.ok(eth.sigRequest.equals(after.sigRequests[1]));
    assert.ok(env.sigRequest(after.sigRequests[1]).requester.equals(env.pool));
    const gb = other(r, "WithdrawalGasBumped");
    assert.equal(big(gb.base_nonce), 0n);
    assert.equal(big(gb.new_gas_price), newGas);

    env.advance(61n);
    ok(env.bumpWithdrawal(0n, minBumpGasPrice(newGas), env.stranger), "stranger after created_at + 60");
  });

  it("F1/F2: an unsigned withdrawal keeps being re-signable once its slots are used up", () => {
    const env = setup();
    ok(env.withdraw(ETH / 10n, { gasPrice: GWEI }));
    let gas = GWEI;
    for (let i = 0; i < 3; i++) ok(env.bumpWithdrawal(0n, (gas = minBumpGasPrice(gas))));
    fails(env.bumpWithdrawal(0n, minBumpGasPrice(gas)), ERR.TooManyBumps, "all four taken");
    const w = env.withdrawal(0n);
    env.setTime(env.sigRequest(w.sigRequests[3]).expiresAt + 61n);
    ok(env.bumpWithdrawal(0n, minBumpGasPrice(gas), env.stranger, [w.sigRequests[0]]), "reuse an expired slot");
    assert.equal(env.withdrawal(0n).sigRequestCount, 4);
  });
});

describe("admin", () => {
  it("credit_solver is admin-only and emits SolverCredited", () => {
    const env = setup(0n);
    fails(env.credit(env.solver.publicKey, ETH, env.stranger), ERR.ConstraintHasOne, "stranger credit");
    fails(env.credit(env.solver.publicKey, ETH, env.solver), ERR.ConstraintHasOne, "self credit");
    assert.equal(env.ledger().balanceWei, 0n);
    const r = ok(env.credit(env.solver.publicKey, 5n * ETH));
    const ev = other(r, "SolverCredited");
    assert.ok((ev.solver as PublicKey).equals(env.solver.publicKey));
    assert.equal(big(ev.amount_wei), 5n * ETH);
    assert.equal(big(ev.balance_wei), 5n * ETH);
    ok(env.credit(env.solver.publicKey, 1n));
    assert.equal(env.ledger().balanceWei, 5n * ETH + 1n);
  });

  it("F5: init_config, set_min_gas_price and set_max_gas_price keep 0 < min <= max", () => {
    const env = new Env();
    fails(env.initConfig(MAX_GAS, L1_BUFFER, 0n), ERR.BadGasConfig, "min 0");
    fails(env.initConfig(MAX_GAS, L1_BUFFER, MAX_GAS + 1n), ERR.BadGasConfig, "min > max");
    ok(env.initConfig());
    fails(env.setMinGas(GWEI, env.stranger), ERR.ConstraintHasOne, "stranger");
    fails(env.setMinGas(0n), ERR.BadGasConfig);
    fails(env.setMinGas(MAX_GAS + 1n), ERR.BadGasConfig);
    ok(env.setMinGas(GWEI));
    assert.equal(env.cfg().minGasPrice, GWEI);
    fails(env.setMaxGas(GWEI - 1n), ERR.BadGasConfig, "max under min");
    ok(env.setMaxGas(GWEI));
  });

  it("F5: fill rejects a gas price under min_gas_price", () => {
    const env = setup();
    const { intent } = env.open();
    fails(env.fill(intent, { outWei: ETH, gasPrice: 0n }), ERR.GasPriceTooLow, "gas 0");
    fails(env.fill(intent, { outWei: ETH, gasPrice: MIN_GAS - 1n }), ERR.GasPriceTooLow, "under the floor");
    ok(env.fill(intent, { outWei: ETH, gasPrice: MIN_GAS }), "at the floor");
  });

  it("set_paused and set_max_gas_price are admin-only", () => {
    const env = setup();
    fails(env.setPaused(true, env.stranger), ERR.ConstraintHasOne);
    fails(env.setMaxGas(GWEI, env.stranger), ERR.ConstraintHasOne);
    ok(env.setPaused(true));
    ok(env.setMaxGas(7n * GWEI));
    const c = env.cfg();
    assert.equal(c.paused, true);
    assert.equal(c.maxGasPrice, 7n * GWEI);
  });

  it("register_solver stores the ledger once; a second registration fails", () => {
    const env = setup(0n);
    const s = env.ledger();
    assert.ok(s.authority.equals(env.solver.publicKey));
    assert.equal(hex(s.payoutAddr), hex(PAYOUT_ADDR));
    assert.equal(hex(s.depositFrom), hex(DEPOSIT_FROM));
    assert.equal(s.balanceWei, 0n);
    assert.equal(s.fills, 0n);
    assert.equal(s.bump, solverPda(env.solver.publicKey, PROGRAM_ID)[1]);
    assert.ok(!env.register(env.solver).ok);
  });
});

describe("credit_solver_from_claim (Phase 2)", () => {
  it("credits a Recorded deposit once; the payer funds the Credit rent", (t: TestContext) => {
    const env = setup(0n);
    const { claim, facts } = env.plantClaim({ valueWei: 3n * ETH / 2n });
    assert.equal(decodeWitnessClaim(env.data(claim)!.data).valueWei, 3n * ETH / 2n, "lib decodes the planted claim");
    const payerBefore = env.balance(env.stranger.publicKey);

    const r = ok(env.creditFromClaim(claim, facts.txHash), "credit_solver_from_claim");
    t.diagnostic(`credit_solver_from_claim CU ${r.cu}`);
    assert.equal(env.ledger().balanceWei, 3n * ETH / 2n);
    const [credit, bump] = creditPda(facts.txHash, PROGRAM_ID);
    const acct = env.data(credit)!;
    assert.equal(acct.data.length, CREDIT_SIZE);
    assert.equal(payerBefore - env.balance(env.stranger.publicKey), env.rent(CREDIT_SIZE), "payer funds the Credit");
    const stored = coder.accounts.decode("Credit", Buffer.from(acct.data));
    assert.ok(stored.solver.equals(env.solver.publicKey));
    assert.ok(stored.claim.equals(claim));
    assert.equal(hex(Uint8Array.from(stored.tx_hash)), hex(facts.txHash));
    assert.equal(big(stored.amount_wei), 3n * ETH / 2n);
    assert.equal(big(stored.credited_at), env.now());
    assert.equal(stored.bump, bump);

    const ev = other(r, "SolverCreditedFromClaim");
    assert.ok((ev.solver as PublicKey).equals(env.solver.publicKey));
    assert.ok((ev.claim as PublicKey).equals(claim));
    assert.equal(hex(Uint8Array.from(ev.tx_hash as number[])), hex(facts.txHash));
    assert.equal(big(ev.amount_wei), 3n * ETH / 2n);
    assert.equal(big(ev.balance_wei), 3n * ETH / 2n);

    // The credited balance is spendable like an admin credit.
    ok(env.withdraw(ETH / 10n), "withdraw from claim-credited balance");

    const again = env.creditFromClaim(claim, facts.txHash, env.solver.publicKey, env.solver);
    assert.ok(!again.ok, "second credit of the same claim");
    assert.ok(again.logs.some((l) => /already in use/.test(l)), again.logs.slice(-4).join("\n"));
  });

  it("a deposit credits once even when another solver with the same deposit_from claims it too", () => {
    const env = setup(0n);
    const rival = Keypair.generate();
    env.svm.airdrop(address(rival.publicKey.toBase58()), lamports(10n * BigInt(LAMPORTS_PER_SOL)));
    ok(env.register(rival));
    const mine = env.plantClaim();
    const theirs = env.plantClaim({ requester: rival.publicKey, txHash: mine.facts.txHash });
    ok(env.creditFromClaim(mine.claim, mine.facts.txHash));
    const r = env.creditFromClaim(theirs.claim, theirs.facts.txHash, rival.publicKey);
    assert.ok(!r.ok);
    assert.ok(r.logs.some((l) => /already in use/.test(l)));
    assert.equal(env.ledger(rival.publicKey).balanceWei, 0n);
  });

  it("rejects a claim not owned by the witness program, or with a foreign discriminator", () => {
    const env = setup(0n);
    const fake = env.plantClaim({}, PROGRAM_ID);
    fails(env.creditFromClaim(fake.claim, fake.facts.txHash), ERR.ClaimNotFromWitness, "owned by intents");
    const sys = env.plantClaim({}, SystemProgram.programId);
    fails(env.creditFromClaim(sys.claim, sys.facts.txHash), ERR.ClaimNotFromWitness, "owned by system");
    const disc = env.plantClaim({ disc: Uint8Array.from([155, 12, 170, 224, 30, 250, 204, 130]) }); // witness Config
    fails(env.creditFromClaim(disc.claim, disc.facts.txHash), ERR.InvalidClaim, "witness Config discriminator");
    assert.equal(env.ledger().balanceWei, 0n);
    assert.equal(env.data(creditPda(fake.facts.txHash, PROGRAM_ID)[0]), null, "a failed credit leaves no Credit");
  });

  it("judges each recorded fact itself", () => {
    const env = setup(0n);
    const cases: [string, Partial<FakeClaim>, number][] = [
      ["Pending", { status: 0, from: new Uint8Array(20), to: new Uint8Array(20), valueWei: 0n, success: false }, ERR.ClaimNotRecorded],
      ["reverted", { success: false }, ERR.DepositReverted],
      ["Base mainnet", { chainId: 8453n }, ERR.ClaimWrongChain],
      ["not to the pool", { to: RECIPIENT }, ERR.DepositNotToPool],
      ["from another wallet", { from: PAYOUT_ADDR }, ERR.DepositNotFromSolver],
      ["requester is not the solver", { requester: env.stranger.publicKey }, ERR.ClaimNotBySolver],
      ["zero value", { valueWei: 0n }, ERR.ZeroAmount],
    ];
    for (const [label, over, code] of cases) {
      const { claim, facts } = env.plantClaim(over);
      fails(env.creditFromClaim(claim, facts.txHash), code, label);
    }
    const { claim, facts } = env.plantClaim();
    fails(env.creditFromClaim(claim, new Uint8Array(32).fill(1)), ERR.ClaimTxHashMismatch, "tx_hash arg");
    ok(env.setPaused(true));
    fails(env.creditFromClaim(claim, facts.txHash), ERR.Paused, "paused");
    ok(env.setPaused(false));
    assert.equal(env.ledger().balanceWei, 0n);
    ok(env.creditFromClaim(claim, facts.txHash), "the same claim passes once the facts hold");
  });

  it("a witness-owned claim opened by another solver cannot credit this solver's ledger", () => {
    const env = setup(0n);
    const other = Keypair.generate();
    env.svm.airdrop(address(other.publicKey.toBase58()), lamports(10n * BigInt(LAMPORTS_PER_SOL)));
    ok(env.register(other));
    const { claim, facts } = env.plantClaim({ requester: other.publicKey });
    fails(env.creditFromClaim(claim, facts.txHash, env.solver.publicKey), ERR.ClaimNotBySolver, "onto the wrong ledger");
    assert.equal(env.ledger().balanceWei, 0n);
    ok(env.creditFromClaim(claim, facts.txHash, other.publicKey), "onto the requester's own ledger");
    assert.equal(env.ledger(other.publicKey).balanceWei, ETH);
    assert.equal(env.ledger().balanceWei, 0n);
  });
});

describe("one Credit marker for both credit paths (F1)", () => {
  it("an admin credit writes the marker, so the same deposit cannot also credit from a claim", () => {
    const env = setup(0n);
    const { claim, facts } = env.plantClaim();
    ok(env.credit(env.solver.publicKey, ETH, env.admin, facts.txHash), "admin credit");
    const [credit, bump] = creditPda(facts.txHash, PROGRAM_ID);
    const stored = coder.accounts.decode("Credit", Buffer.from(env.data(credit)!.data));
    assert.ok(stored.solver.equals(env.solver.publicKey));
    assert.ok(stored.claim.equals(PublicKey.default), "no claim behind an admin credit");
    assert.equal(hex(Uint8Array.from(stored.tx_hash)), hex(facts.txHash));
    assert.equal(big(stored.amount_wei), ETH);
    assert.equal(big(stored.credited_at), env.now());
    assert.equal(stored.bump, bump);

    const r = env.creditFromClaim(claim, facts.txHash);
    assert.ok(!r.ok, "claim credit after admin credit");
    assert.ok(r.logs.some((l) => /already in use/.test(l)));
    assert.ok(!env.credit(env.solver.publicKey, ETH, env.admin, facts.txHash).ok, "admin twice");
    assert.equal(env.ledger().balanceWei, ETH);
  });

  it("a claim credit blocks a later admin credit of the same deposit", () => {
    const env = setup(0n);
    const { claim, facts } = env.plantClaim();
    ok(env.creditFromClaim(claim, facts.txHash));
    const r = env.credit(env.solver.publicKey, ETH, env.admin, facts.txHash);
    assert.ok(!r.ok);
    assert.ok(r.logs.some((l) => /already in use/.test(l)));
    assert.equal(env.ledger().balanceWei, ETH);
  });

  it("backfill: a zero admin credit only marks the deposit, and works while paused", () => {
    const env = setup(ETH); // stands in for the pre-upgrade admin credit
    const { claim, facts } = env.plantClaim();
    ok(env.setPaused(true));
    ok(env.credit(env.solver.publicKey, 0n, env.admin, facts.txHash), "marker while paused");
    ok(env.setPaused(false));
    assert.equal(env.ledger().balanceWei, ETH, "the marker adds nothing");
    assert.ok(!env.creditFromClaim(claim, facts.txHash).ok, "the old deposit no longer credits from its claim");
    assert.equal(env.ledger().balanceWei, ETH);
  });
});

describe("admin co-signs claim credits while the witness is unauthenticated (F2)", () => {
  it("mock forwarder: a forged claim cannot credit without the admin's signature", () => {
    const env = setup(0n);
    const { claim, facts } = env.plantClaim({ valueWei: 100n * ETH });
    fails(env.creditFromClaim(claim, facts.txHash, env.solver.publicKey, env.stranger, null), ERR.UntrustedWitness, "no admin");
    fails(env.creditFromClaim(claim, facts.txHash, env.solver.publicKey, env.stranger, env.stranger), ERR.UntrustedWitness, "stranger as admin");
    fails(env.creditFromClaim(claim, facts.txHash, env.solver.publicKey, env.solver, env.solver), ERR.UntrustedWitness, "solver as admin");
    assert.equal(env.ledger().balanceWei, 0n);
    assert.equal(env.data(creditPda(facts.txHash, PROGRAM_ID)[0]), null);
    ok(env.creditFromClaim(claim, facts.txHash), "admin co-signs");
    assert.equal(env.ledger().balanceWei, 100n * ETH);
  });

  it("production forwarder with workflow_owner pinned: anyone may credit; unpinned still needs the admin", () => {
    const env = setup(0n);
    const prod = new PublicKey(PRODUCTION_FORWARDER_ID);
    env.setWitnessConfig(prod); // owner not pinned: any workflow could write
    const a = env.plantClaim();
    fails(env.creditFromClaim(a.claim, a.facts.txHash, env.solver.publicKey, env.stranger, null), ERR.UntrustedWitness, "unpinned");
    env.setWitnessConfig(prod, new Uint8Array(20).fill(0x42));
    ok(env.creditFromClaim(a.claim, a.facts.txHash, env.solver.publicKey, env.stranger, null), "pinned, no admin");
    assert.equal(env.ledger().balanceWei, ETH);
  });

  it("the witness Config must be soda_witness's own PDA", () => {
    const env = setup(0n);
    const prod = new PublicKey(PRODUCTION_FORWARDER_ID);
    const pinned = new Uint8Array(20).fill(0x42);
    const { claim, facts } = env.plantClaim();
    const fake = Keypair.generate().publicKey;
    env.setWitnessConfig(prod, pinned, fake);
    fails(env.creditFromClaim(claim, facts.txHash, env.solver.publicKey, env.stranger, null, fake), ERR.ConstraintSeeds, "elsewhere");
    // The right address but not owned by the witness (cannot happen on chain; checked anyway).
    env.setWitnessConfig(prod, pinned, witnessConfigPda(WITNESS)[0], SystemProgram.programId);
    fails(env.creditFromClaim(claim, facts.txHash, env.solver.publicKey, env.stranger, null), ERR.ConstraintOwner, "foreign owner");
    assert.equal(env.ledger().balanceWei, 0n);
  });
});

describe("register_solver proves deposit_from (F3)", () => {
  it("rejects an address the caller cannot sign for, and a proof made for another solver", (t: TestContext) => {
    const env = new Env();
    ok(env.initConfig());
    const squatter = Keypair.generate();
    env.svm.airdrop(address(squatter.publicKey.toBase58()), lamports(10n * BigInt(LAMPORTS_PER_SOL)));
    const ownKey = hexToBytes("47".repeat(32));
    const ownSig = signDepositProof(ownKey, squatter.publicKey, PROGRAM_ID);
    fails(env.register(squatter, PAYOUT_ADDR, DEPOSIT_FROM, ownSig), ERR.DepositFromNotProven, "someone else's address");
    const replay = signDepositProof(DEPOSIT_KEY, env.solver.publicKey, PROGRAM_ID);
    fails(env.register(squatter, PAYOUT_ADDR, DEPOSIT_FROM, replay), ERR.DepositFromNotProven, "the real solver's proof");
    const otherProgram = signDepositProof(DEPOSIT_KEY, squatter.publicKey, Keypair.generate().publicKey);
    fails(env.register(squatter, PAYOUT_ADDR, DEPOSIT_FROM, otherProgram), ERR.DepositFromNotProven, "another program's proof");
    const badV = signDepositProof(DEPOSIT_KEY, squatter.publicKey, PROGRAM_ID);
    badV[64] = 29;
    fails(env.register(squatter, PAYOUT_ADDR, DEPOSIT_FROM, badV), ERR.DepositFromNotProven, "v = 29");
    assert.equal(env.data(solverPda(squatter.publicKey, PROGRAM_ID)[0]), null);

    // Its own address registers, and so does a raw (0/1) recovery id.
    const r = ok(env.register(squatter, PAYOUT_ADDR, evmAddressOf(ownKey), ownSig), "own address");
    t.diagnostic(`register_solver CU ${r.cu}`);
    const raw = signDepositProof(DEPOSIT_KEY, env.solver.publicKey, PROGRAM_ID);
    raw[64] -= 27;
    ok(env.register(env.solver, PAYOUT_ADDR, DEPOSIT_FROM, raw), "v as 0/1");
    assert.equal(hex(env.ledger().depositFrom), hex(DEPOSIT_FROM));
  });
});
