import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  useState,
} from "react";

/* ── StatusBadge ─────────────────────────────────────────────────── */

export type SkillStatus =
  | "synced"
  | "stale"
  | "vault-only"
  | "staging"
  | "new"
  | "missing";

export const STATUS_META: Record<
  SkillStatus,
  { label: string; color: string; bg: string; dot: string }
> = {
  synced:       { label: "synced",     color: "var(--ok)",      bg: "var(--ok-bg)",      dot: "var(--ok)" },
  stale:        { label: "stale",      color: "var(--warn)",    bg: "var(--warn-bg)",    dot: "var(--warn)" },
  "vault-only": { label: "vault-only", color: "var(--neutral)", bg: "var(--neutral-bg)", dot: "var(--neutral)" },
  staging:      { label: "staging",    color: "var(--info)",    bg: "var(--info-bg)",    dot: "var(--info)" },
  new:          { label: "new",        color: "var(--new)",     bg: "var(--new-bg)",     dot: "var(--ink-2)" },
  missing:      { label: "missing",    color: "var(--bad)",     bg: "var(--bad-bg)",     dot: "var(--bad)" },
};

export function StatusBadge({
  status,
  size = "sm",
}: {
  status: SkillStatus;
  size?: "sm" | "lg";
}) {
  const m = STATUS_META[status];
  const sz = size === "lg" ? { fs: 11, py: 3, px: 8 } : { fs: 10, py: 2, px: 7 };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: "var(--mono)",
        fontSize: sz.fs,
        fontWeight: 500,
        color: m.color,
        background: m.bg,
        padding: `${sz.py}px ${sz.px}px`,
        borderRadius: 4,
        letterSpacing: "0.01em",
        whiteSpace: "nowrap",
        border: `0.5px solid ${m.color}22`,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: m.dot }} />
      {m.label}
    </span>
  );
}

/* ── DesktopBadge ────────────────────────────────────────────────── */

/**
 * Claude Desktop packaging state. Rendered only when the skill was ever
 * packaged — "not-packaged" is the silent default, since packaging is
 * opt-in per skill.
 */
export function DesktopBadge({
  status,
  size = "sm",
}: {
  status: "current" | "outdated" | "not-packaged";
  size?: "sm" | "lg";
}) {
  if (status === "not-packaged") return null;
  const current = status === "current";
  const color = current ? "var(--ok)" : "var(--warn)";
  const bg = current ? "var(--ok-bg)" : "var(--warn-bg)";
  const sz = size === "lg" ? { fs: 11, py: 3, px: 8 } : { fs: 10, py: 2, px: 7 };
  return (
    <span
      title={
        current
          ? "Packaged for Claude Desktop — zip matches the vault copy"
          : "Vault copy changed since it was packaged for Claude Desktop — re-package and re-upload"
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: "var(--mono)",
        fontSize: sz.fs,
        fontWeight: 500,
        color,
        background: bg,
        padding: `${sz.py}px ${sz.px}px`,
        borderRadius: 4,
        letterSpacing: "0.01em",
        whiteSpace: "nowrap",
        border: `0.5px solid ${color}22`,
      }}
    >
      {current ? "desktop ✓" : "desktop outdated"}
    </span>
  );
}

/* ── ProviderChip ────────────────────────────────────────────────── */

export function ProviderChip({
  slug,
  active = true,
  onClick,
  removable = false,
  onRemove,
}: {
  slug: string;
  active?: boolean;
  onClick?: () => void;
  removable?: boolean;
  onRemove?: () => void;
}) {
  return (
    <span
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontFamily: "var(--mono)",
        fontSize: 11,
        fontWeight: 500,
        color: active ? "var(--ink)" : "var(--ink-3)",
        background: active ? "var(--surface-2)" : "transparent",
        padding: "2px 7px",
        borderRadius: 4,
        border: `0.5px solid ${active ? "var(--border-2)" : "var(--border)"}`,
        cursor: onClick ? "pointer" : "default",
        userSelect: "none",
      }}
    >
      {slug}
      {removable && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove?.();
          }}
          style={{
            border: 0,
            background: "transparent",
            color: "var(--ink-3)",
            padding: 0,
            marginLeft: 2,
            lineHeight: 1,
            fontSize: 12,
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

/* ── Button ──────────────────────────────────────────────────────── */

type ButtonKind = "default" | "primary" | "accent" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

export function Button({
  children,
  kind = "default",
  size = "md",
  onClick,
  disabled,
  icon,
  type = "button",
  title,
  style,
}: {
  children?: ReactNode;
  kind?: ButtonKind;
  size?: ButtonSize;
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  icon?: ReactElement;
  type?: "button" | "submit";
  title?: string;
  style?: CSSProperties;
}) {
  const sizes = {
    sm: { h: 26, px: 10, fs: 12 },
    md: { h: 30, px: 12, fs: 13 },
    lg: { h: 36, px: 16, fs: 14 },
  }[size];
  const kinds = {
    default: { bg: "var(--surface)", fg: "var(--ink)",    bd: "var(--border-2)", hover: "var(--surface-2)" },
    primary: { bg: "var(--ink)",     fg: "var(--bg)",     bd: "var(--ink)",      hover: "oklch(0.32 0.012 60)" },
    accent:  { bg: "var(--accent)",  fg: "#fff",          bd: "var(--accent)",   hover: "var(--accent-2)" },
    ghost:   { bg: "transparent",    fg: "var(--ink-2)",  bd: "transparent",     hover: "var(--surface-2)" },
    danger:  { bg: "transparent",    fg: "var(--bad)",    bd: "color-mix(in oklab, var(--bad) 30%, transparent)", hover: "var(--bad-bg)" },
  }[kind];
  const [hover, setHover] = useState(false);
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: sizes.h,
        padding: `0 ${sizes.px}px`,
        background: hover && !disabled ? kinds.hover : kinds.bg,
        color: kinds.fg,
        border: `0.5px solid ${kinds.bd}`,
        borderRadius: 6,
        fontSize: sizes.fs,
        fontWeight: 500,
        fontFamily: "var(--sans)",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 120ms",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {icon && <span style={{ display: "inline-flex" }}>{icon}</span>}
      {children}
    </button>
  );
}

/* ── Rule (section divider) ──────────────────────────────────────── */

export function Rule({ label, action }: { label: string; action?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 12px", userSelect: "none" }}>
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          fontWeight: 600,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        ── {label}
      </span>
      <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
      {action}
    </div>
  );
}

/* ── KBD ────────────────────────────────────────────────────────── */

export function KBD({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 18,
        height: 18,
        padding: "0 5px",
        fontFamily: "var(--mono)",
        fontSize: 10.5,
        fontWeight: 500,
        color: "var(--ink-2)",
        background: "var(--surface)",
        border: "0.5px solid var(--border-2)",
        borderBottom: "1.5px solid var(--border-2)",
        borderRadius: 4,
      }}
    >
      {children}
    </span>
  );
}

/* ── SkillCount (banner stat) ───────────────────────────────────── */

export function SkillCount({ n, label }: { n: number; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 5 }}>
      <span style={{ fontFamily: "var(--mono)", fontWeight: 600, color: "var(--ink)" }}>{n}</span>
      <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{label}</span>
    </span>
  );
}
