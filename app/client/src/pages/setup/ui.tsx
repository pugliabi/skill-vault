import { useState, type CSSProperties, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "../../components/ui/primitives";
import { setupApi } from "../../lib/setup";

export const labelStyle: CSSProperties = {
  display: "block",
  fontFamily: "var(--mono)",
  fontSize: 11,
  color: "var(--ink-3)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  fontWeight: 600,
  marginBottom: 6,
};

export const inputStyle: CSSProperties = {
  width: "100%",
  fontFamily: "var(--mono)",
  fontSize: 13,
  color: "var(--ink)",
  background: "var(--surface)",
  border: "0.5px solid var(--border-2)",
  borderRadius: 6,
  padding: "0 12px",
  height: 36,
  outline: 0,
};

export function StepHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h1 style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 600, color: "var(--ink)", letterSpacing: "-0.02em" }}>{title}</h1>
      {children && <p style={{ margin: 0, fontSize: 14, color: "var(--ink-2)", lineHeight: 1.6 }}>{children}</p>}
    </div>
  );
}

const TONE = { info: "var(--ink-2)", good: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)" } as const;

export function Hint({ tone = "info", children }: { tone?: keyof typeof TONE; children: ReactNode }) {
  return <p style={{ margin: "8px 0 0", fontSize: 12.5, lineHeight: 1.6, color: TONE[tone] }}>{children}</p>;
}

/** A path box with an optional Browse… button that opens the Windows folder dialog. */
export function FolderField({
  id,
  label,
  value,
  onChange,
  folderDialog,
  dialogTitle,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  folderDialog: boolean;
  dialogTitle: string;
  placeholder?: string;
}) {
  const [picking, setPicking] = useState(false);
  const browse = async () => {
    setPicking(true);
    try {
      const r = await setupApi.pickFolder({ title: dialogTitle, initial: value.trim() || undefined });
      if ("path" in r) onChange(r.path);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPicking(false);
    }
  };
  return (
    <div>
      <label htmlFor={id} style={labelStyle}>
        {label}
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <input id={id} type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={inputStyle} />
        {folderDialog && (
          <Button size="lg" onClick={browse} disabled={picking}>
            {picking ? "Waiting…" : "Browse…"}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ChoiceCard({
  selected,
  title,
  description,
  onSelect,
}: {
  selected: boolean;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        textAlign: "left",
        width: "100%",
        padding: "12px 14px",
        borderRadius: 8,
        cursor: "pointer",
        background: selected ? "var(--surface-2)" : "var(--surface)",
        border: `0.5px solid ${selected ? "var(--ink)" : "var(--border-2)"}`,
        fontFamily: "var(--sans)",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{title}</div>
      <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 4, lineHeight: 1.5 }}>{description}</div>
    </button>
  );
}

/** Back / Skip / Next row at the bottom of a step. */
export function StepNav({
  onBack,
  onSkip,
  onNext,
  nextLabel = "Next",
  nextDisabled,
  busy,
}: {
  onBack?: () => void;
  onSkip?: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  busy?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 28, alignItems: "center" }}>
      {onBack && (
        <Button kind="ghost" size="md" onClick={onBack} disabled={busy}>
          Back
        </Button>
      )}
      <div style={{ flex: 1 }} />
      {onSkip && (
        <Button kind="ghost" size="md" onClick={onSkip} disabled={busy}>
          Skip
        </Button>
      )}
      <Button kind="primary" size="md" onClick={onNext} disabled={nextDisabled || busy}>
        {busy ? "Working…" : nextLabel}
      </Button>
    </div>
  );
}

export const listBox: CSSProperties = {
  background: "var(--surface)",
  border: "0.5px solid var(--border)",
  borderRadius: 8,
  padding: "6px 0",
  maxHeight: 260,
  overflowY: "auto",
};

export const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 14px",
  fontSize: 13,
  color: "var(--ink)",
};
