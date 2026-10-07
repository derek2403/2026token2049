import type { OrderStatus } from "@/lib/intents";

const STYLE: Record<OrderStatus | "closed" | "filled", { label: string; cls: string; pulse?: boolean }> = {
  open: { label: "Auction", cls: "bg-accent-soft text-accent", pulse: true },
  matched: { label: "Matched", cls: "bg-accent-soft text-accent", pulse: true },
  signing: { label: "Signing", cls: "bg-accent-soft text-accent", pulse: true },
  signed: { label: "Signed", cls: "bg-accent-soft text-accent", pulse: true },
  broadcast: { label: "On Base", cls: "bg-accent-soft text-accent", pulse: true },
  filled: { label: "Filled", cls: "bg-accent-soft text-accent" },
  completed: { label: "Completed", cls: "bg-good-soft text-good" },
  reverted: { label: "Reverted", cls: "bg-bad-soft text-bad" },
  expired: { label: "Expired", cls: "bg-warn-soft text-warn" },
  cancelled: { label: "Refunded", cls: "bg-panel text-muted" },
  closed: { label: "Closed", cls: "bg-panel text-faint" },
};

export function StatusPill({ status }: { status: OrderStatus | "closed" | "filled" }) {
  const s = STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.pulse && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {s.label}
    </span>
  );
}
