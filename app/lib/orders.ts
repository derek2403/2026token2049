// Per-browser record of measured step times (ms) for orders opened or watched
// here. A convenience only: everything else is read back from the chain.

export type MeasuredStep = "open" | "matched" | "signing" | "signed" | "broadcast" | "completed" | "cancelled";

export type LocalOrder = {
  intent: string;
  /** open_intent signature, and when Phantom handed it to the network / when it confirmed. */
  openSig?: string;
  sentAt?: number;
  /** Measured client-side, ms since epoch. */
  observed: Partial<Record<MeasuredStep, number>>;
  /** Signatures of user actions sent from this page. */
  cancelSig?: string;
  closeSig?: string;
};

const KEY = "soda-intents:orders:v1";

function readAll(): Record<string, LocalOrder> {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, LocalOrder>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, LocalOrder>) {
  try {
    // Keep the 50 most recent.
    const entries = Object.entries(all).slice(-50);
    window.localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

export function loadOrder(intent: string): LocalOrder {
  return readAll()[intent] ?? { intent, observed: {} };
}

export function saveOrder(order: LocalOrder) {
  const all = readAll();
  delete all[order.intent];
  all[order.intent] = order;
  writeAll(all);
}

export function updateOrder(intent: string, fn: (o: LocalOrder) => LocalOrder): LocalOrder {
  const next = fn(loadOrder(intent));
  saveOrder(next);
  return next;
}

/** Record a step's observed time once; later observations never overwrite it. */
export function observe(intent: string, step: MeasuredStep, at = Date.now()): LocalOrder {
  return updateOrder(intent, (o) => (o.observed[step] ? o : { ...o, observed: { ...o.observed, [step]: at } }));
}
