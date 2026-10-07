// ProgramWatcher against a fake program history: ordering, pagination, failed
// transactions, backfill + reconcile, open → filled transitions, withdrawals,
// bounded memory and error backoff. No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { DEFAULT_INTENTS_PROGRAM_ID, intentsCoders } from "../../../lib/intents";
import { encodeEvent, FakeProgramHistory, programLogs } from "./testutil";
import { solanaWsUrl } from "./env";
import { errorKind, ProgramWatcher, type WatchedTx, type WatcherOptions } from "./watcher";

const PID = new PublicKey(DEFAULT_INTENTS_PROGRAM_ID);
const bn = (v: bigint | number) => new BN(v.toString());
const FAR = BigInt(Math.floor(Date.now() / 1000)) + 3_600n;
const SOLVER = Keypair.generate().publicKey;

class FakeConn extends FakeProgramHistory {
  accounts = new Map<string, Buffer>();
  failAccounts = 0;
  async getMultipleAccountsInfo(keys: PublicKey[]) {
    this.calls.getMultipleAccountsInfo = (this.calls.getMultipleAccountsInfo ?? 0) + 1;
    if (keys.length > 100) throw new Error("too many keys");
    if (this.failAccounts > 0) {
      this.failAccounts--;
      throw new Error("503 Service Unavailable");
    }
    return keys.map((k) => {
      const data = this.accounts.get(k.toBase58());
      return data ? { data, owner: PID, lamports: 1, executable: false } : null;
    });
  }
}

const opened = (intent: PublicKey, expiresAt = FAR) =>
  encodeEvent("IntentOpened", {
    intent,
    user: Keypair.generate().publicKey,
    intent_id: bn(1),
    in_lamports: bn(1_000_000_000),
    recipient: new Array(20).fill(0xab),
    start_out_wei: bn(10n ** 17n),
    min_out_wei: bn(9n * 10n ** 16n),
    auction_start: bn(expiresAt - 120n),
    auction_duration: 60,
    expires_at: bn(expiresAt),
  });

const filledEv = (intent: PublicKey, nonce: bigint, gasPrice: bigint) =>
  encodeEvent("IntentFilled", {
    intent,
    user: Keypair.generate().publicKey,
    solver: SOLVER,
    in_lamports: bn(1_000_000_000),
    out_wei: bn(47n * 10n ** 15n),
    base_nonce: bn(nonce),
    gas_price: bn(gasPrice),
    sig_request: Keypair.generate().publicKey,
    filled_at: bn(FAR - 60n),
  });

const cancelledEv = (intent: PublicKey) =>
  encodeEvent("IntentCancelled", { intent, user: Keypair.generate().publicKey, refunded_lamports: bn(1) });

const bumpedEv = (intent: PublicKey, nonce: bigint, oldGas: bigint, newGas: bigint) =>
  encodeEvent("GasBumped", {
    intent,
    caller: SOLVER,
    solver: SOLVER,
    base_nonce: bn(nonce),
    old_gas_price: bn(oldGas),
    new_gas_price: bn(newGas),
    sig_request: Keypair.generate().publicKey,
    sig_request_count: 2,
  });

const withdrewEv = (nonce: bigint, gasPrice: bigint) =>
  encodeEvent("SolverWithdrew", {
    solver: SOLVER,
    payout_addr: new Array(20).fill(2),
    amount_wei: bn(10n ** 17n),
    base_nonce: bn(nonce),
    gas_price: bn(gasPrice),
    sig_request: Keypair.generate().publicKey,
    balance_wei: bn(0),
  });

function intentAccount(status: 0 | 1 | 2, nonce = 0n, gasPrice = 0n): Promise<Buffer> {
  return intentsCoders().accounts.encode("Intent", {
    user: Keypair.generate().publicKey,
    intent_id: bn(1),
    in_lamports: bn(1_000_000_000),
    recipient: new Array(20).fill(0xab),
    start_out_wei: bn(10n ** 17n),
    min_out_wei: bn(9n * 10n ** 16n),
    auction_start: bn(FAR - 120n),
    auction_duration: 60,
    expires_at: bn(FAR),
    status,
    solver: status === 1 ? SOLVER : PublicKey.default,
    out_wei: bn(status === 1 ? 47n * 10n ** 15n : 0n),
    base_nonce: bn(nonce),
    gas_price: bn(gasPrice),
    filled_at: bn(status === 1 ? FAR - 60n : 0n),
    sig_requests: new Array(4).fill(PublicKey.default),
    sig_request_count: status === 1 ? 1 : 0,
    bump: 255,
  });
}

function watcher(fake: FakeConn, opts: Partial<WatcherOptions> = {}) {
  const logs: string[] = [];
  const w = new ProgramWatcher(fake as unknown as Connection, {
    programId: PID,
    watchMs: 60_000, // tests drive pollOnce() themselves unless they say otherwise
    log: (m) => logs.push(m),
    ...opts,
  });
  return { w, logs };
}

const key = () => Keypair.generate().publicKey;
const names = (seen: WatchedTx[]) => seen.map((t) => t.signature);

test("backfill replays history oldest first, then polls only what is new", async () => {
  const fake = new FakeConn();
  const a = key();
  const s1 = fake.push(programLogs(PID, [await opened(a)]));
  const s2 = fake.push(programLogs(PID, [await filledEv(a, 3n, 1_000_000n)]));
  fake.accounts.set(a.toBase58(), await intentAccount(1, 3n, 1_000_000n));
  const { w } = watcher(fake);
  const seen: WatchedTx[] = [];
  await w.start((t) => seen.push(t));
  assert.deepEqual(names(seen), [s1, s2]);
  assert.ok(seen.every((t) => t.backfill));
  assert.equal(w.ready, true);
  assert.deepEqual(w.openKeys(), []);
  assert.deepEqual(w.filledKeys().map(String), [a.toBase58()]);

  const b = key();
  const s3 = fake.push(programLogs(PID, [await opened(b)]));
  assert.equal(await w.pollOnce(), 1);
  assert.deepEqual(names(seen), [s1, s2, s3]);
  assert.equal(seen[2].backfill, false);
  assert.equal(await w.pollOnce(), 0, "nothing new: no repeats");
  await w.stop();
});

test("a poll with more than one page of new signatures paginates with `before` and keeps order", async () => {
  const fake = new FakeConn();
  fake.push(programLogs(PID, [await opened(key())]));
  const { w } = watcher(fake, { pageSize: 100 });
  const seen: WatchedTx[] = [];
  await w.start((t) => seen.push(t));
  seen.length = 0;
  const ev = await cancelledEv(key());
  const pushed: string[] = [];
  for (let i = 0; i < 250; i++) pushed.push(fake.push(programLogs(PID, [ev])));
  const before = fake.calls.getSignaturesForAddress;
  assert.equal(await w.pollOnce(), 250);
  assert.equal(fake.calls.getSignaturesForAddress - before, 3, "100 + 100 + 50");
  assert.deepEqual(names(seen), pushed);
  await w.stop();
});

test("failed transactions are skipped, by signature status and by meta.err", async () => {
  const fake = new FakeConn();
  const { w } = watcher(fake);
  const seen: WatchedTx[] = [];
  await w.start((t) => seen.push(t));
  const a = key();
  const b = key();
  fake.push(programLogs(PID, [await opened(a)]), { sigErr: true });
  fake.push(programLogs(PID, [await opened(b)]), { metaErr: true });
  const before = fake.calls.getTransaction ?? 0;
  assert.equal(await w.pollOnce(), 2);
  assert.equal((fake.calls.getTransaction ?? 0) - before, 1, "an err in the signature list is not even fetched");
  assert.equal(seen.length, 0);
  assert.deepEqual(w.openKeys(), []);
  assert.equal(w.stats.failedSkipped, 2);
  await w.stop();
});

test("backfill covers only BACKFILL_SIGS, and reconcile corrects the index from account state", async () => {
  const fake = new FakeConn();
  const [a, b, c, d, old] = [key(), key(), key(), key(), key()];
  fake.push(programLogs(PID, [await opened(old)])); // outside the window
  fake.push(programLogs(PID, [await opened(a), await opened(b)]));
  fake.push(programLogs(PID, [await opened(c), await opened(d)]));
  fake.push(programLogs(PID, [await filledEv(b, 7n, 2_000_000n)]));
  fake.push(programLogs(PID, [await cancelledEv(c)]));
  fake.accounts.set(old.toBase58(), await intentAccount(0));
  fake.accounts.set(a.toBase58(), await intentAccount(1, 8n, 3_000_000n)); // filled in a tx the RPC lags on
  fake.accounts.set(b.toBase58(), await intentAccount(1, 7n, 2_000_000n));
  // c: cancelled and closed; d: opened, then closed (account gone)
  const { w, logs } = watcher(fake, { backfillSigs: 4 });
  await w.start();
  assert.deepEqual(w.openKeys(), [], "a moved to filled, c cancelled, d closed, old never seen");
  assert.deepEqual(new Set(w.filledKeys().map(String)), new Set([a, b].map(String)));
  assert.deepEqual(w.gasHints(a), [3_000_000n], "hint from the account");
  assert.deepEqual(w.gasHints(b), [2_000_000n]);
  assert.match(logs.join("\n"), /backfilled 4 signatures: 0 open, 2 filled/);
  const filled = await w.fetchFilled();
  assert.equal(filled.length, 2);
  await w.stop();
});

test("open → filled → bumped → forgotten, with getMultipleAccountsInfo on indexed keys only", async () => {
  const fake = new FakeConn();
  const { w } = watcher(fake);
  await w.start();
  const e = key();
  fake.push(programLogs(PID, [await opened(e)]));
  await w.pollOnce();
  assert.deepEqual(w.openKeys().map(String), [e.toBase58()]);
  fake.accounts.set(e.toBase58(), await intentAccount(0));
  assert.equal((await w.fetchOpen()).length, 1);

  fake.push(programLogs(PID, [await filledEv(e, 5n, 1_000_000n)]));
  await w.pollOnce();
  assert.deepEqual(w.openKeys(), []);
  assert.deepEqual(w.filledKeys().map(String), [e.toBase58()]);
  fake.push(programLogs(PID, [await bumpedEv(e, 5n, 1_000_000n, 1_200_000n)]));
  await w.pollOnce();
  assert.deepEqual(w.gasHints(e).sort(), [1_000_000n, 1_200_000n]);

  fake.accounts.set(e.toBase58(), await intentAccount(1, 5n, 1_200_000n));
  const rows = await w.fetchFilled();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].account.baseNonce, 5n);
  w.forget(e);
  const before = fake.calls.getMultipleAccountsInfo ?? 0;
  assert.deepEqual(await w.fetchFilled(), []);
  assert.equal((fake.calls.getMultipleAccountsInfo ?? 0) - before, 0, "an empty index costs no RPC call");
  await w.stop();
});

test("loadIntents chunks getMultipleAccountsInfo by 100 and drops closed accounts", async () => {
  const fake = new FakeConn();
  const { w } = watcher(fake);
  await w.start();
  const keys = Array.from({ length: 230 }, key);
  for (const k of keys.slice(0, 200)) fake.accounts.set(k.toBase58(), await intentAccount(0));
  const before = fake.calls.getMultipleAccountsInfo ?? 0;
  const open = await w.fetchOpen(keys);
  assert.equal((fake.calls.getMultipleAccountsInfo ?? 0) - before, 3);
  assert.equal(open.length, 200);
  assert.equal(w.openKeys().length, 200, "only live accounts are indexed");
  await w.stop();
});

test("SolverWithdrew and WithdrawalGasBumped index withdrawals by pool nonce", async () => {
  const fake = new FakeConn();
  fake.push(programLogs(PID, [await withdrewEv(9n, 1_000_000n)]));
  fake.push(programLogs(PID, [await withdrewEv(4n, 1_000_000n)]));
  const { w } = watcher(fake);
  await w.start();
  assert.deepEqual(w.withdrawalEntries().map((x) => x.baseNonce), [4n, 9n]);
  assert.ok(w.withdrawalEntries()[0].solver?.equals(SOLVER));
  w.forgetWithdrawalsBelow(5n);
  assert.deepEqual(w.withdrawalEntries().map((x) => x.baseNonce), [9n]);
  await w.stop();
});

const signedEv = (intent: PublicKey, nonce: bigint) =>
  encodeEvent("SignedIntentExecuted", {
    intent,
    user: Keypair.generate().publicKey,
    solver: SOLVER,
    nonce: bn(1_759_830_000_123n),
    sell_lamports: bn(100_000_000),
    min_out_wei: bn(4n * 10n ** 15n),
    out_wei: bn(4n * 10n ** 15n),
    base_nonce: bn(nonce),
  });

test("RFQ settlements (IntentFilled + SignedIntentExecuted) are indexed as filled payouts", async () => {
  const fake = new FakeConn();
  const a = key();
  const b = key();
  fake.push(programLogs(PID, [await filledEv(a, 7n, 1_000_000n), await signedEv(a, 7n)]));
  fake.accounts.set(a.toBase58(), await intentAccount(1, 7n, 1_000_000n));
  const { w } = watcher(fake);
  const seen: WatchedTx[] = [];
  await w.start((t) => seen.push(t));
  assert.deepEqual(w.filledKeys().map(String), [a.toBase58()]);
  assert.deepEqual(w.gasHints(a), [1_000_000n]);
  assert.ok(w.knowsNonce(7n));
  assert.deepEqual(seen[0].events.map((e) => (e.name === "Other" ? e.eventName : e.name)), ["IntentFilled", "SignedIntentExecuted"]);

  // SignedIntentExecuted on its own is enough to index the payout and its nonce.
  fake.push(programLogs(PID, [await signedEv(b, 8n)]));
  fake.accounts.set(b.toBase58(), await intentAccount(1, 8n, 2_000_000n));
  await w.pollOnce();
  const f = w.filledEntries().find((e) => e.key.equals(b))!;
  assert.ok(f.solver?.equals(SOLVER));
  assert.equal(f.baseNonce, 8n);
  assert.ok(w.knowsNonce(8n));
  assert.deepEqual((await w.fetchFilled()).map((x) => x.pubkey.toBase58()).sort(), [a.toBase58(), b.toBase58()].sort());
  await w.stop();
});

test("a transaction the RPC cannot return yet holds the backlog at the poll rate (no failure), keeping order", async () => {
  const fake = new FakeConn();
  const { w } = watcher(fake, { txConcurrency: 1 });
  const seen: WatchedTx[] = [];
  await w.start((t) => seen.push(t));
  const ev = await cancelledEv(key());
  const s1 = fake.push(programLogs(PID, [ev]));
  const s2 = fake.push(programLogs(PID, [ev]));
  const s3 = fake.push(programLogs(PID, [ev]));
  fake.nullTx.set(s2, 2);
  assert.equal(await w.pollOnce(), 1, "s1 handled, s2 holds the rest");
  assert.deepEqual(names(seen), [s1]);
  assert.equal(await w.pollOnce(), 0);
  assert.equal(await w.pollOnce(), 2);
  assert.deepEqual(names(seen), [s1, s2, s3]);
  assert.equal(w.stats.pollErrors, 0, "a lagging transaction is not a poll failure");
  assert.equal(await w.pollOnce(), 0, "nothing replayed twice");
  await w.stop();
});

test("a transaction missing past maxTxMisses is deferred: later ones go on, it is replayed late when it arrives", async () => {
  const fake = new FakeConn();
  const { w, logs } = watcher(fake, { maxTxMisses: 2, rewalkMs: 0 });
  const seen: WatchedTx[] = [];
  await w.start((t) => seen.push(t));
  const a = key();
  const b = key();
  const s1 = fake.push(programLogs(PID, [await opened(a)]));
  const s2 = fake.push(programLogs(PID, [await opened(b)]));
  fake.accounts.set(a.toBase58(), await intentAccount(0));
  fake.nullTx.set(s1, 1_000);
  assert.equal(await w.pollOnce(), 0, "held once");
  assert.equal(await w.pollOnce(), 2, "then deferred, and s2 goes on");
  assert.deepEqual(names(seen), [s2]);
  assert.deepEqual(w.queueStats().deferred, 1);
  assert.match(logs.join("\n"), /retrying it in the background/);

  fake.nullTx.delete(s1);
  // Deferred retries wait at least 2 s; pretend they are due.
  (w as unknown as { deferred: Map<string, { nextTryAt: number }> }).deferred.get(s1)!.nextTryAt = 0;
  await w.maintain();
  assert.deepEqual(names(seen), [s2, s1]);
  assert.equal(seen[1].backfill, true, "late arrivals are flagged so the solver re-reads state");
  assert.deepEqual(new Set(w.openKeys().map(String)), new Set([a, b].map(String)));
  assert.equal(w.stats.recovered, 1);
  assert.equal(await w.pollOnce(), 0);
  await w.stop();
});

test("a deferred transaction that never arrives is given up on loudly after deferTxMaxMs", async () => {
  const fake = new FakeConn();
  const { w, logs } = watcher(fake, { maxTxMisses: 1, deferTxMaxMs: 0, rewalkMs: 0 });
  await w.start();
  const s1 = fake.push(programLogs(PID, [await opened(key())]));
  fake.nullTx.set(s1, 1_000);
  await w.pollOnce();
  (w as unknown as { deferred: Map<string, { nextTryAt: number }> }).deferred.get(s1)!.nextTryAt = 0;
  await w.maintain();
  assert.equal(w.stats.lost, 1);
  assert.match(logs.join("\n"), /WARNING gave up on sig/);
  assert.equal(await w.pollOnce(), 0);
  await w.stop();
});

test("an empty page right after a full one is retried, not taken as the end of the gap", async () => {
  const fake = new FakeConn();
  fake.push(programLogs(PID, [await cancelledEv(key())]));
  const { w } = watcher(fake, { pageSize: 10 });
  await w.start();
  const ev = await cancelledEv(key());
  const pushed: string[] = [];
  for (let i = 0; i < 25; i++) pushed.push(fake.push(programLogs(PID, [ev])));
  fake.unknownBefore = 2; // page 2 and the check both hit a node that lacks page 1's last signature
  await assert.rejects(w.pollOnce(), /came back empty after a full one/);
  assert.equal(w.stats.signatures, 1, "nothing replayed; the cursor stays put");
  const seen: string[] = [];
  (w as unknown as { handler: (t: WatchedTx) => void }).handler = (t) => seen.push(t.signature);
  assert.equal(await w.pollOnce(), 25);
  assert.deepEqual(seen, pushed);
  await w.stop();
});

test("a gap that is an exact multiple of the page size ends cleanly", async () => {
  const fake = new FakeConn();
  fake.push(programLogs(PID, [await cancelledEv(key())]));
  const { w } = watcher(fake, { pageSize: 10 });
  await w.start();
  const ev = await cancelledEv(key());
  for (let i = 0; i < 20; i++) fake.push(programLogs(PID, [ev]));
  assert.equal(await w.pollOnce(), 20);
  assert.equal(await w.pollOnce(), 0);
  await w.stop();
});

test("polls pass minContextSlot, and a node that does not know the cursor cannot replay old history", async () => {
  const fake = new FakeConn();
  const ev = await opened(key());
  for (let i = 0; i < 10; i++) fake.push(programLogs(PID, [ev]));
  const { w } = watcher(fake, { backfillSigs: 2 });
  const seen: WatchedTx[] = [];
  await w.start((t) => seen.push(t));
  assert.equal(seen.length, 2);
  const tipSlot = fake.txs[fake.txs.length - 1].slot;
  const s = fake.push(programLogs(PID, [await cancelledEv(key())]));
  fake.unknownUntil = 1; // this node returns everything, as if the cursor did not exist
  const txBefore = fake.calls.getTransaction ?? 0;
  assert.equal(await w.pollOnce(), 1);
  assert.equal((fake.calls.getTransaction ?? 0) - txBefore, 1, "only the new transaction was fetched");
  assert.deepEqual(names(seen.slice(2)), [s]);
  assert.equal(fake.sigCalls[fake.sigCalls.length - 1].minContextSlot, tipSlot);
  assert.equal(await w.pollOnce(), 0, "the cursor did not move backwards");
  await w.stop();
});

test("the re-walk replays signatures the polls never listed", async () => {
  const fake = new FakeConn();
  fake.push(programLogs(PID, [await cancelledEv(key())]));
  const { w, logs } = watcher(fake, { rewalkMs: 0 });
  const seen: WatchedTx[] = [];
  await w.start((t) => seen.push(t));
  seen.length = 0;
  const a = key();
  const s1 = fake.push(programLogs(PID, [await opened(a)]));
  const s2 = fake.push(programLogs(PID, [await cancelledEv(key())]));
  const s3 = fake.push(programLogs(PID, [await cancelledEv(key())]));
  fake.accounts.set(a.toBase58(), await intentAccount(0));
  fake.hidden.add(s1); // a node whose index lacked s1 while we polled
  assert.equal(await w.pollOnce(), 2);
  assert.deepEqual(names(seen), [s2, s3]);
  fake.hidden.delete(s1);
  assert.equal(await w.rewalk(), 1);
  assert.deepEqual(names(seen).slice(2), [s1]);
  assert.equal(seen[2].backfill, true);
  assert.deepEqual(w.openKeys().map(String), [a.toBase58()]);
  assert.match(logs.join("\n"), /re-walk found 1 signature/);
  assert.equal(await w.rewalk(), 0, "nothing twice");
  await w.stop();
});

test("seekNonces pages back past the backfill until an unindexed pool nonce's IntentFilled is found", async () => {
  const fake = new FakeConn();
  const head = key();
  fake.push(programLogs(PID, [await opened(head)]));
  fake.push(programLogs(PID, [await filledEv(head, 7n, 1_000_000n)]));
  for (let i = 0; i < 30; i++) fake.push(programLogs(PID, [await cancelledEv(key())]));
  fake.push(programLogs(PID, [await withdrewEv(8n, 1_000_000n)]));
  fake.accounts.set(head.toBase58(), await intentAccount(1, 7n, 1_000_000n));
  const { w, logs } = watcher(fake, { backfillSigs: 5, olderPageSize: 10, seekGraceMs: 0, rewalkMs: 0 });
  await w.start();
  assert.equal(w.knowsNonce(8n), true);
  assert.equal(w.knowsNonce(7n), false, "the head's fill is older than the backfill");
  assert.deepEqual(w.filledKeys(), []);
  w.seekNonces([7n, 8n]);
  for (let i = 0; i < 10 && !w.knowsNonce(7n); i++) await w.maintain();
  assert.equal(w.knowsNonce(7n), true);
  assert.deepEqual(w.filledKeys().map(String), [head.toBase58()], "tracked again, from its account");
  assert.deepEqual(w.openKeys(), [], "its old IntentOpened does not reopen it");
  assert.equal((await w.fetchFilled())[0].account.baseNonce, 7n);
  assert.ok(w.stats.olderSigs >= 20 && w.stats.olderSigs <= 30, `${w.stats.olderSigs}`);
  assert.match(logs.join("\n"), /looking for pool nonce\(s\) 7.*found/);

  // A nonce no event ever used: paging stops at the start of history, with a warning.
  w.seekNonces([99n]);
  for (let i = 0; i < 10; i++) await w.maintain();
  assert.match(logs.join("\n"), /WARNING pool nonce\(s\) 99 not found/);
  const calls = fake.calls.getSignaturesForAddress;
  await w.maintain();
  assert.equal(fake.calls.getSignaturesForAddress, calls, "no more paging once history is exhausted");
  await w.stop();
});

test("seekNonces waits out the grace period, and a nonce indexed meanwhile is never sought", async () => {
  const fake = new FakeConn();
  fake.push(programLogs(PID, [await cancelledEv(key())]));
  const { w } = watcher(fake, { seekGraceMs: 60_000, rewalkMs: 0 });
  await w.start();
  w.seekNonces([3n]);
  const calls = fake.calls.getSignaturesForAddress;
  await w.maintain();
  assert.equal(fake.calls.getSignaturesForAddress, calls);
  w.noteFilled(key(), 1n, 3n);
  assert.deepEqual(w.queueStats().seekingNonces, ["3"]);
  w.seekNonces([3n]);
  await w.maintain();
  assert.deepEqual(w.queueStats().seekingNonces, []);
  await w.stop();
});

test("a stale Open read never undoes a fill, and forgetOpen leaves the filled entry", async () => {
  const fake = new FakeConn();
  const { w } = watcher(fake);
  await w.start();
  const e = key();
  fake.push(programLogs(PID, [await opened(e)]));
  await w.pollOnce();
  fake.push(programLogs(PID, [await filledEv(e, 5n, 1_000_000n)]));
  await w.pollOnce();
  fake.accounts.set(e.toBase58(), await intentAccount(0)); // a node that has not seen the fill yet
  assert.deepEqual(await w.fetchOpen([e]), [], "not reported Open");
  assert.deepEqual(w.openKeys(), []);
  assert.equal(w.hasFilled(e), true);
  w.forgetOpen(e);
  assert.deepEqual(w.filledKeys().map(String), [e.toBase58()]);
  fake.accounts.set(e.toBase58(), await intentAccount(1, 5n, 1_000_000n));
  assert.equal((await w.fetchFilled()).length, 1);
  await w.stop();
});

test("txPerSec paces getTransaction", async () => {
  const fake = new FakeConn();
  const { w } = watcher(fake, { txPerSec: 50 });
  await w.start();
  const ev = await cancelledEv(key());
  for (let i = 0; i < 6; i++) fake.push(programLogs(PID, [ev]));
  const t0 = Date.now();
  assert.equal(await w.pollOnce(), 6);
  assert.ok(Date.now() - t0 >= 90, `${Date.now() - t0} ms for 6 calls at 50/s`);
  await w.stop();
});

test("index maps are bounded and long-expired open intents are dropped", async () => {
  const fake = new FakeConn();
  fake.blockTime = Math.floor(Date.now() / 1000);
  const { w } = watcher(fake, { maxEntries: 10 });
  await w.start();
  const evs = [];
  for (let i = 0; i < 30; i++) evs.push(await opened(key()));
  const expired = key();
  evs.push(await opened(expired, 1_000n)); // expired decades ago, and the newest event
  fake.push(programLogs(PID, evs));
  await w.pollOnce();
  assert.equal(w.openKeys().length, 10);
  assert.ok(!w.openKeys().some((k) => k.equals(expired)));
  await w.stop();
});

test("RPC errors back off exponentially, log once per kind, and recover", async () => {
  const fake = new FakeConn();
  fake.failSigs = { n: 1_000, error: new Error("failed to get signatures for address: 429 Too Many Requests") };
  const { w, logs } = watcher(fake, { watchMs: 10, maxBackoffMs: 80 });
  await w.start();
  await new Promise((r) => setTimeout(r, 400));
  const calls = fake.calls.getSignaturesForAddress;
  // 10 ms polling would be ~40 calls; backoff (20, 40, 80, 80…) allows ~7.
  assert.ok(calls >= 3 && calls <= 10, `${calls} calls`);
  assert.equal(logs.filter((l) => l.includes("rate limited (429)")).length, 1, logs.join("\n"));
  assert.equal(w.ready, false);
  fake.failSigs.n = 0;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(w.ready, true);
  assert.ok(logs.some((l) => /recovered after \d+ failed polls/.test(l)));
  await w.stop();
  const after = fake.calls.getSignaturesForAddress;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.calls.getSignaturesForAddress, after, "stopped means stopped");
});

test("errorKind strips URLs, keys and numbers", () => {
  assert.equal(errorKind(new Error("429 Too Many Requests: {}")), "rate limited (429)");
  const k = errorKind(new Error("fetch failed for https://solana-devnet.g.alchemy.com/v2/SECRETKEY123 at slot 123456"));
  assert.ok(!k.includes("SECRETKEY") && !k.includes("alchemy") && !k.includes("123456"), k);
});

test("SOLANA_WS_URL: unset, empty or \"off\" disables the websocket", () => {
  const prev = process.env.SOLANA_WS_URL;
  try {
    delete process.env.SOLANA_WS_URL;
    assert.equal(solanaWsUrl(), undefined);
    process.env.SOLANA_WS_URL = "";
    assert.equal(solanaWsUrl(), undefined);
    process.env.SOLANA_WS_URL = "OFF";
    assert.equal(solanaWsUrl(), undefined);
    process.env.SOLANA_WS_URL = "wss://example.invalid/ws";
    assert.equal(solanaWsUrl(), "wss://example.invalid/ws");
  } finally {
    if (prev === undefined) delete process.env.SOLANA_WS_URL;
    else process.env.SOLANA_WS_URL = prev;
  }
});
