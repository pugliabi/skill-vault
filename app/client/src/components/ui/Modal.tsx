/**
 * A plain modal: dimmed backdrop, focus moved in and trapped, Escape and
 * backdrop click close it (unless busy), focus returned to the opener.
 */
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function Modal({
  title,
  busy = false,
  onClose,
  children,
  width = 520,
}: {
  title: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const trapTab = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      e.preventDefault();
      panel.current.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!panel.current.contains(active) || (e.shiftKey && (active === first || active === panel.current))) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      onClick={() => !busy && onClose()}
      onKeyDown={trapTab}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "grid", placeItems: "center", zIndex: 50 }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: `min(${width}px, calc(100vw - 32px))`,
          maxHeight: "calc(100vh - 64px)",
          overflow: "auto",
          background: "var(--surface)",
          border: "0.5px solid var(--border)",
          borderRadius: 10,
          padding: "18px 20px",
          outline: 0,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          fontSize: 13,
          color: "var(--ink-2)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{title}</div>
        {children}
      </div>
    </div>
  );
}
