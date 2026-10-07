"use client";

import { useEffect, type ReactNode } from "react";
import { CloseIcon } from "./icons";

/** Right-hand side panel (bottom sheet on mobile) shared by Activity and Order. */
export function Drawer({
  label,
  header,
  headerClassName = "",
  footer,
  onClose,
  children,
}: {
  label: string;
  header: ReactNode;
  /** Tint behind the header (1inch colours order details by status). */
  headerClassName?: string;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-stretch md:justify-end">
      <button aria-label={`Close ${label.toLowerCase()}`} className="absolute inset-0 bg-black/70" onClick={onClose} />
      <aside
        role="dialog"
        aria-label={label}
        className="drawer-panel relative flex max-h-[92vh] w-full flex-col overflow-hidden border-line bg-card max-md:border-t md:h-full md:max-h-none md:w-[440px] md:border-l"
      >
        <header className={`flex items-center justify-between gap-3 px-6 py-5 ${headerClassName}`}>
          <div className="min-w-0">{header}</div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-panel-hover text-muted transition hover:text-fg"
          >
            <CloseIcon />
          </button>
        </header>
        <div className="h-0.5 shrink-0 bg-bg" />
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && (
          <>
            <div className="h-0.5 shrink-0 bg-bg" />
            <footer className="px-6 py-4 text-sm">{footer}</footer>
          </>
        )}
      </aside>
    </div>
  );
}
