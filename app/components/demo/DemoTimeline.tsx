// The pipeline for one run, with a pill on every step saying who does it.
// Ported from frontier apps/web/components/Timeline.tsx (prior work).

import type { ReactNode } from "react";
import { ActorPill, type Actor } from "./ActorPill";

export type Step = "idle" | "active" | "done" | "error";

export type TimelineKey = "request" | "sigRequested" | "sign" | "finalize" | "broadcast" | "receipt";

export type TimelineState = Record<TimelineKey, Step>;

export const INITIAL_TIMELINE: TimelineState = {
  request: "idle",
  sigRequested: "idle",
  sign: "idle",
  finalize: "idle",
  broadcast: "idle",
  receipt: "idle",
};

export type TimelineRow = {
  key: TimelineKey;
  label: string;
  sub: string;
  actors: { actor: Actor; label?: string }[];
  /** Extra line (a link, a label) once the step has data. */
  extra?: ReactNode;
};

function Dot({ step }: { step: Step }) {
  const base = "h-2.5 w-2.5 rounded-full";
  if (step === "done") return <div className={`${base} bg-good`} />;
  if (step === "active") return <div className={`${base} animate-pulse bg-warn`} />;
  if (step === "error") return <div className={`${base} bg-bad`} />;
  return <div className={`${base} bg-panel-hover`} />;
}

export function DemoTimeline({ state, rows }: { state: TimelineState; rows: TimelineRow[] }) {
  return (
    <section className="bg-card p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-medium">Pipeline</h2>
        <span className="text-[11px] text-faint">one Phantom approval, everything else automatic</span>
      </div>
      <ol className="mt-4 space-y-0.5">
        {rows.map((r) => {
          const step = state[r.key];
          return (
            <li key={r.key} className="flex items-start gap-3 bg-panel px-4 py-3">
              <div className="pt-1.5">
                <Dot step={step} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={`text-sm ${step === "idle" ? "text-muted" : "text-fg"}`}>{r.label}</span>
                  <span className="flex flex-wrap gap-1">
                    {r.actors.map((a, i) => (
                      <ActorPill key={i} actor={a.actor} label={a.label} />
                    ))}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-faint">{r.sub}</div>
                {r.extra ? <div className="mt-1.5 text-xs">{r.extra}</div> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
