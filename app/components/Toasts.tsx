"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

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

type Ctx = { push: (t: Omit<Toast, "id">) => number; dismiss: (id: number) => void };

const ToastCtx = createContext<Ctx | null>(null);

export function useToasts(): Ctx {
  const c = useContext(ToastCtx);
  if (!c) throw new Error("useToasts outside ToastProvider");
  return c;
}

const TONE: Record<ToastKind, string> = {
  info: "bg-accent",
  success: "bg-good",
  warn: "bg-warn",
  error: "bg-bad",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = nextId.current++;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      const duration = t.duration ?? (t.action ? 0 : 7000);
      if (duration > 0) setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss],
  );
  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:items-end"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="toast-in pointer-events-auto flex w-full max-w-sm gap-3 rounded-2xl border border-line bg-panel p-4 shadow-2xl shadow-black/40"
          >
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE[t.kind]}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg">{t.title}</p>
              {t.body && <p className="mt-0.5 text-sm text-muted">{t.body}</p>}
              {(t.link || t.action) && (
                <div className="mt-2 flex gap-4 text-sm">
                  {t.action && (
                    <button
                      className="font-medium text-accent hover:text-accent-hover"
                      onClick={() => {
                        t.action!.onClick();
                        dismiss(t.id);
                      }}
                    >
                      {t.action.label}
                    </button>
                  )}
                  {t.link && (
                    <a className="text-muted hover:text-fg" href={t.link.href} target="_blank" rel="noreferrer">
                      {t.link.label} ↗
                    </a>
                  )}
                </div>
              )}
            </div>
            <button aria-label="Dismiss" className="h-6 w-6 shrink-0 text-faint hover:text-fg" onClick={() => dismiss(t.id)}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
