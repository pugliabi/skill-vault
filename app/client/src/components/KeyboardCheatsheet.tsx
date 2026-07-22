import { useEffect, useState } from "react";
import { KBD } from "./ui/primitives";

/**
 * Keyboard shortcut cheatsheet. Toggled with `?` (ignored while typing in an
 * input/textarea), closed with `?` again or Esc. Self-contained — mounted
 * once at the app level.
 */
const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ["/"], label: "Focus the skills search" },
  { keys: ["j"], label: "Next skill" },
  { keys: ["k"], label: "Previous skill" },
  { keys: ["⌘", "K"], label: "Command palette / jump to skill" },
  { keys: ["Esc"], label: "Close dialog / clear selection" },
  { keys: ["?"], label: "Toggle this help" },
];

export function KeyboardCheatsheet() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.key === "?" && !isInput && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!open) return null;
  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 110,
        background: "oklch(0.15 0.005 60 / 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420,
          background: "var(--bg)",
          border: "0.5px solid var(--border-2)",
          borderRadius: 10,
          boxShadow: "0 20px 60px oklch(0.2 0.01 60 / 0.3)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "14px 18px", borderBottom: "0.5px solid var(--border)" }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
            Keyboard shortcuts
          </h3>
        </div>
        <div style={{ padding: "8px 18px 14px" }}>
          {SHORTCUTS.map((s) => (
            <div
              key={s.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 0",
                borderBottom: "0.5px solid var(--border)",
              }}
            >
              <span style={{ flex: 1, fontSize: 13, color: "var(--ink)" }}>{s.label}</span>
              <span style={{ display: "inline-flex", gap: 3 }}>
                {s.keys.map((k) => (
                  <KBD key={k}>{k}</KBD>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
