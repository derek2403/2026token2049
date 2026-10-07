// Display helpers for the swap page.

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const WEI_PER_ETH = 10n ** 18n;

/** "1.5" → 1_500_000_000n; null when not a valid non-negative SOL amount. */
export function parseSol(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 9) return null;
  return BigInt(whole || "0") * LAMPORTS_PER_SOL + BigInt(frac.padEnd(9, "0") || "0");
}

function formatUnits(v: bigint, decimals: number, maxDecimals: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(decimals, "0").slice(0, maxDecimals).replace(/0+$/, "");
  if (whole === 0n && frac === "" && abs !== 0n) return `${neg ? "-" : ""}<0.${"0".repeat(maxDecimals - 1)}1`;
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? "." + frac : ""}`;
}

export const formatSol = (lamports: bigint, maxDecimals = 4) => formatUnits(lamports, 9, maxDecimals);
export const formatEthAmount = (wei: bigint, maxDecimals = 6) => formatUnits(wei, 18, maxDecimals);

/** Exact SOL string for an input box (no grouping, up to 9 decimals). */
export function solInputString(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function toFloat(v: bigint, decimals: number): number {
  return Number(v) / 10 ** decimals;
}

export function formatUsd(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export function shortAddr(a: string, head = 4, tail = 4): string {
  return a.length <= head + tail + 3 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/** ms → "412 ms", "12.3 s", "4m 05s". */
export function formatDuration(ms: number, preferMs = false): string {
  if (ms < 0) ms = 0;
  if (ms < 1000 || (preferMs && ms < 10_000)) return `${Math.round(ms).toLocaleString("en-US")} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export function formatCountdown(sec: number): string {
  if (sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatClock(ms: number): string {
  const d = new Date(ms);
  const hms = d.toLocaleTimeString("en-GB", { hour12: false });
  return `${hms}.${d.getMilliseconds().toString().padStart(3, "0")}`;
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
