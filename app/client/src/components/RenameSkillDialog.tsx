import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { Button } from "./ui/primitives";
import { Icon } from "./ui/icons";

/**
 * Modal for renaming an existing skill. Server enforces slug rules,
 * collision checks, and refuses (409 RenameBlockedError) if any
 * provider still has the old name as a symlink/junction. We surface
 * that message verbatim — the user must address the blocking provider
 * (remove or re-push) before the rename can proceed.
 */
export function RenameSkillDialog({
  oldName,
  onClose,
  onRenamed,
}: {
  oldName: string;
  onClose: () => void;
  onRenamed: (newName: string) => void;
}) {
  const [newName, setNewName] = useState(oldName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const unchanged = newName === oldName;
  const canSubmit = !!newName && !unchanged && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await api.renameSkill(oldName, { new_name: newName });
      onRenamed(result.name);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Rename failed");
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "oklch(0.2 0.01 60 / 0.4)",
          backdropFilter: "blur(2px)",
        }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal
        style={{
          position: "relative",
          width: 420,
          maxWidth: "90%",
          background: "var(--bg)",
          border: "0.5px solid var(--border-2)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 10px 40px oklch(0.2 0.01 60 / 0.2)",
        }}
      >
        <header
          style={{
            height: 52,
            flexShrink: 0,
            borderBottom: "0.5px solid var(--border)",
            padding: "0 18px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
            Rename <code style={{ fontFamily: "var(--mono)" }}>{oldName}</code>
          </span>
          <Button kind="ghost" size="sm" icon={Icon.x} onClick={onClose}>
            Close
          </Button>
        </header>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--ink-3)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontWeight: 600,
              }}
            >
              New name
            </span>
            <input
              ref={inputRef}
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                if (error) setError(undefined);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              style={{
                height: 32,
                padding: "0 10px",
                background: "var(--surface)",
                border: `0.5px solid ${error ? "var(--bad)" : "var(--border-2)"}`,
                borderRadius: 6,
                fontFamily: "var(--mono)",
                fontSize: 13,
                color: "var(--ink)",
                outline: 0,
              }}
            />
            {error && (
              <span style={{ fontSize: 12, color: "var(--bad)" }}>{error}</span>
            )}
            <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>
              The folder is moved and the manifest key is updated;
              targets, stage, and source are preserved.
            </span>
          </label>
        </div>

        <footer
          style={{
            padding: "12px 18px",
            borderTop: "0.5px solid var(--border)",
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <Button kind="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            kind="primary"
            size="sm"
            onClick={submit}
            disabled={!canSubmit}
          >
            {submitting ? "Renaming…" : "Rename"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
