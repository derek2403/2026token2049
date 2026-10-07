// Solver pricing (HANDOVER §3.6 step 2): a constant-product curve over virtual
// reserves sized from the solver's own ETH inventory, re-anchored to Pyth every
// minute, minus SPREAD_BPS and the Base gas + L1 buffer the ledger is charged.

import { GAS_LIMIT } from "../../../lib/intents";

/** soda SigRequest rent the solver pays per fill or bump, never refunded (§1.4). */
export const SIG_REQUEST_RENT_LAMPORTS = 2_413_000n;
/** One signature's base fee. */
export const SOLANA_BASE_FEE_LAMPORTS = 5_000n;

const LAMPORTS_PER_SOL = 10n ** 9n;
const BPS = 10_000n;

export type Reserves = { solLamports: bigint; ethWei: bigint };

/**
 * Reserves whose marginal price equals the oracle's: ethWei / solLamports =
 * solUsd / ethUsd · 1e18 / 1e9. Depth is inventory · depthMult, so a trade worth
 * the whole inventory moves the price by roughly 1/depthMult.
 */
export function virtualReserves(
  solUsd18: bigint,
  ethUsd18: bigint,
  inventoryWei: bigint,
  depthMult: bigint,
): Reserves {
  if (solUsd18 <= 0n || ethUsd18 <= 0n) throw new Error("prices must be positive");
  const ethWei = inventoryWei > 0n ? inventoryWei * depthMult : 0n;
  const solLamports = (ethWei * ethUsd18) / (solUsd18 * LAMPORTS_PER_SOL);
  return { solLamports, ethWei };
}

/** x·y = k: ETH out for dx lamports in. */
export function cpOut(r: Reserves, dxLamports: bigint): bigint {
  if (dxLamports <= 0n || r.ethWei <= 0n) return 0n;
  return (r.ethWei * dxLamports) / (r.solLamports + dxLamports);
}

/** Reserves after selling dx into the pool along the curve. */
export function cpApply(r: Reserves, dxLamports: bigint): Reserves {
  if (dxLamports <= 0n || r.ethWei <= 0n) return r;
  const solLamports = r.solLamports + dxLamports;
  return { solLamports, ethWei: (r.solLamports * r.ethWei) / solLamports };
}

export type QuoteCosts = {
  spreadBps: bigint;
  gasPrice: bigint;
  l1FeeBufferWei: bigint;
  /** SOL the solver spends to fill (SigRequest rent + fees), taken off the input. */
  solCostLamports: bigint;
};

/** The most ETH this solver will deliver for inLamports (0 if not worth it). */
export function maxOutWei(r: Reserves, inLamports: bigint, c: QuoteCosts): bigint {
  const dx = inLamports - c.solCostLamports;
  const gross = cpOut(r, dx);
  const net = (gross * (BPS - c.spreadBps)) / BPS - c.gasPrice * GAS_LIMIT - c.l1FeeBufferWei;
  return net > 0n ? net : 0n;
}

export type Anchor = {
  solUsd18: bigint;
  ethUsd18: bigint;
  inventoryWei: bigint;
  atMs: number;
  sources: { sol: string; eth: string };
};

/** Holds the current anchor and moves along the curve as this solver fills. */
export class Pricer {
  private reserves: Reserves | null = null;
  anchor: Anchor | null = null;

  constructor(private readonly depthMult: bigint) {}

  reanchor(a: Anchor): void {
    this.anchor = a;
    this.reserves = virtualReserves(a.solUsd18, a.ethUsd18, a.inventoryWei, this.depthMult);
  }

  /** No usable price: stop quoting until the next good re-anchor. */
  invalidate(): void {
    this.reserves = null;
    this.anchor = null;
  }

  get ready(): boolean {
    return this.reserves !== null && this.reserves.ethWei > 0n;
  }

  maxOut(inLamports: bigint, c: QuoteCosts): bigint {
    return this.reserves ? maxOutWei(this.reserves, inLamports, c) : 0n;
  }

  /** After a fill, later quotes in this minute get worse until the next re-anchor. */
  applyFill(inLamports: bigint, solCostLamports: bigint): void {
    if (this.reserves) this.reserves = cpApply(this.reserves, inLamports - solCostLamports);
  }

  /** Oracle ETH per SOL, 1e18 fixed point (for /health). */
  oracleEthPerSol18(): bigint | null {
    return this.anchor ? (this.anchor.solUsd18 * 10n ** 18n) / this.anchor.ethUsd18 : null;
  }
}
