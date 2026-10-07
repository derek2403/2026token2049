"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CloseIcon } from "./icons";

export type ToastKind = "info" | "success" | "warn" | "error";

export type Toast = {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  link?: { href: string; label: string };
  action?: { label: string; onClick: () => void };
  /** ms; 0 keeps it until dismissed. */
  duration?: number;
};

type Ctx = { toasts: Toast[]; push: (t: Omit<Toast, "id">) => number; dismiss: (id: number) => void };

const ToastCtx = createContext<Ctx | null>(null);

export function useToasts(): Ctx {
  const c = useContext(ToastCtx);
  if (!c) throw new Error("useToasts outside ToastProvider");
  return c;
}

/** Pill background per state, as 1inch's event toasts: white text on the status colour. */
export const TOAST_TONE: Record<ToastKind, string> = {
  info: "bg-accent text-white",
  success: "bg-good text-black",
  warn: "bg-warn text-black",
  error: "bg-bad text-white",
};

/** Finished toasts auto-hide after this long, with a bar that fills over the same time. */
const TOAST_MS = 10_000;
/** At most this many toasts show at once (1inch shows two). */
const MAX_VISIBLE = 2;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = nextId.current++;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      const duration = t.duration ?? (t.action ? 0 : TOAST_MS);
      if (duration > 0) setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss],
  );
  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return <ToastCtx.Provider value={value}>{children}</ToastCtx.Provider>;
}

/**
 * Bottom-centre stack: `children` (the live order tracker) sits above the toasts and
 * counts toward the visible limit. Toasts with an action stay visible first; the rest
 * stay mounted but hidden, so their timer bars keep running.
 */
export function ToastViewport({ children, shifted = false }: { children?: ReactNode; shifted?: boolean }) {
  const { toasts, dismiss } = useToasts();
  const room = Math.max(0, MAX_VISIBLE - (children ? 1 : 0));
  const pinned = toasts.filter((t) => t.action);
  const visible = new Set(
    [...pinned, ...toasts.filter((t) => !t.action).reverse()].slice(0, room).map((t) => t.id),
  );
  return (
    <div
      className={`pointer-events-none fixed inset-x-2 bottom-2 z-[60] mx-auto flex max-w-[396px] flex-col items-stretch gap-2 ${
        shifted ? "md:right-[448px] md:left-2" : ""
      }`}
    >
      {children}
      <div aria-live="polite" className="flex flex-col items-stretch gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            aria-hidden={!visible.has(t.id)}
            className={`toast-in relative flex items-start gap-3 overflow-hidden rounded-[36px] px-6 py-4 ${TOAST_TONE[t.kind]} ${
              visible.has(t.id) ? "pointer-events-auto" : "invisible absolute h-0 !p-0"
            }`}
          >
            <div className="min-w-0 flex-1">
              <p className="text-base leading-6 font-medium">{t.title}</p>
              {t.body && <p className="mt-0.5 text-sm leading-5 opacity-80">{t.body}</p>}
              {(t.link || t.action) && (
                <div className="mt-2 flex gap-4 text-sm font-medium">
                  {t.action && (
                    <button
                      className="underline-offset-2 hover:underline"
                      onClick={() => {
                        t.action!.onClick();
                        dismiss(t.id);
                      }}
                    >
                      {t.action.label}
                    </button>
                  )}
                  {t.link && (
                    <a className="opacity-80 hover:opacity-100" href={t.link.href} target="_blank" rel="noreferrer">
                      {t.link.label} ↗
                    </a>
                  )}
                </div>
              )}
            </div>
            <button
              aria-label="Dismiss"
              className="-mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full opacity-70 hover:opacity-100"
              onClick={() => dismiss(t.id)}
            >
              <CloseIcon size={16} />
            </button>
            {(t.duration ?? (t.action ? 0 : TOAST_MS)) > 0 && (
              <span
                className="toast-timer absolute bottom-0 left-0 h-2 bg-black/15"
                style={{ animationDuration: `${t.duration ?? TOAST_MS}ms` }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
