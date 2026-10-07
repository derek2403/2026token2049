// Fixtures for services/solver tests.

import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";
import { INTENTS_IDL } from "../../../lib/intents";
import { PRICE_UPDATE_V2_DISCRIMINATOR } from "./pyth";

/** Synthetic PriceUpdateV2 bytes in the layout pyth.ts documents. */
export function encodePriceUpdateV2(opts: {
  partial?: boolean;
  feedId: string;
  price: bigint;
  expo: number;
  publishTime: bigint;
}): Uint8Array {
  const out = new Uint8Array(134);
  const dv = new DataView(out.buffer);
  out.set(PRICE_UPDATE_V2_DISCRIMINATOR, 0);
  out.fill(7, 8, 40); // write_authority
  let o = 40;
  if (opts.partial) {
    out[o++] = 0;
    out[o++] = 3;
  } else {
    out[o++] = 1;
  }
  out.set(Buffer.from(opts.feedId, "hex"), o);
  o += 32;
  dv.setBigInt64(o, opts.price, true);
  dv.setBigUint64(o + 8, 12345n, true);
  dv.setInt32(o + 16, opts.expo, true);
  dv.setBigInt64(o + 20, opts.publishTime, true);
  dv.setBigInt64(o + 28, opts.publishTime - 1n, true);
  dv.setBigInt64(o + 36, opts.price - 5n, true);
  dv.setBigUint64(o + 44, 99n, true);
  dv.setBigUint64(o + 52, 424242n, true);
  return out;
}

// ---------------------------------------------------------------- program history (watcher)

/** Borsh-encodes an IDL event by registering it as an "account" with the event's discriminator. */
export function encodeEvent(name: string, data: Record<string, unknown>): Promise<Buffer> {
  const ev = INTENTS_IDL.events!.find((e) => e.name === name);
  if (!ev) throw new Error(`no event ${name} in the IDL`);
  const idl = { ...INTENTS_IDL, accounts: [{ name, discriminator: ev.discriminator }] } as Idl;
  return new BorshAccountsCoder(idl).encode(name, data);
}

/** Log lines of one top-level intents instruction emitting `events`. */
export function programLogs(programId: PublicKey, events: Buffer[]): string[] {
  const id = programId.toBase58();
  return [`Program ${id} invoke [1]`, ...events.map((e) => `Program data: ${e.toString("base64")}`), `Program ${id} success`];
}

type FakeTx = { signature: string; slot: number; logs: string[]; sigErr: boolean; metaErr: boolean };

/**
 * A program's transaction history behind getSignaturesForAddress /
 * getTransaction, with getSignaturesForAddress' before/until/limit semantics
 * (newest first, both bounds exclusive). Failures can be injected.
 */
export class FakeProgramHistory {
  readonly txs: FakeTx[] = []; // oldest first
  readonly calls: Record<string, number> = {};
  /** The next N getSignaturesForAddress calls throw this. */
  failSigs: { n: number; error: Error } = { n: 0, error: new Error("429 Too Many Requests") };
  /** getTransaction returns null this many more times per signature. */
  readonly nullTx = new Map<string, number>();
  /** blockTime returned for every transaction (null: unknown). */
  blockTime: number | null = null;
  /** The next N calls behave like a node that does not know `until` (it returns older history too). */
  unknownUntil = 0;
  /** The next N calls with `before` behave like a node that does not know it ([] and no error). */
  unknownBefore = 0;
  /** Signatures this node never lists (a lagging index), for every call. */
  readonly hidden = new Set<string>();
  /** Options of every getSignaturesForAddress call. */
  readonly sigCalls: { before?: string; until?: string; limit?: number; minContextSlot?: number }[] = [];
  private n = 0;

  push(logs: string[], opts: { sigErr?: boolean; metaErr?: boolean } = {}): string {
    this.n++;
    const signature = `sig${String(this.n).padStart(6, "0")}`;
    this.txs.push({ signature, slot: 1_000 + this.n, logs, sigErr: !!opts.sigErr, metaErr: !!opts.metaErr });
    return signature;
  }

  private count(m: string) {
    this.calls[m] = (this.calls[m] ?? 0) + 1;
  }

  async getSignaturesForAddress(
    _address: PublicKey,
    opts: { before?: string; until?: string; limit?: number; minContextSlot?: number } = {},
  ) {
    this.count("getSignaturesForAddress");
    this.sigCalls.push({ ...opts });
    if (this.failSigs.n > 0) {
      this.failSigs.n--;
      throw this.failSigs.error;
    }
    const newestFirst = this.txs.filter((t) => !this.hidden.has(t.signature)).reverse();
    let start = 0;
    if (opts.before) {
      const i = newestFirst.findIndex((t) => t.signature === opts.before);
      if (i < 0 || this.unknownBefore > 0) {
        if (this.unknownBefore > 0) this.unknownBefore--;
        return []; // what a real node answers for a `before` it does not know
      }
      start = i + 1;
    }
    let until = opts.until;
    if (this.unknownUntil > 0) {
      this.unknownUntil--;
      until = undefined;
    }
    const out = [];
    for (let i = start; i < newestFirst.length && out.length < (opts.limit ?? 1_000); i++) {
      const t = newestFirst[i];
      if (t.signature === until) break;
      out.push({ signature: t.signature, slot: t.slot, err: t.sigErr ? { InstructionError: [0, "Custom"] } : null, memo: null, blockTime: null });
    }
    return out;
  }

  async getTransaction(signature: string) {
    this.count("getTransaction");
    const left = this.nullTx.get(signature) ?? 0;
    if (left > 0) {
      this.nullTx.set(signature, left - 1);
      return null;
    }
    const t = this.txs.find((x) => x.signature === signature);
    if (!t) return null;
    return { slot: t.slot, blockTime: this.blockTime, meta: { err: t.sigErr || t.metaErr ? { InstructionError: [0, "Custom"] } : null, logMessages: t.logs } };
  }
}
