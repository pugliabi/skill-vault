import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Icon } from "./ui/icons";
import { Button } from "./ui/primitives";
import type { FileDiff, SkillDiff } from "../lib/types";

/**
 * Conflict resolution drawer.
 *
 * Shows file-level diffs between the vault copy and a provider's copy
 * for a stale skill. Resolution is whole-skill: "Keep vault" runs
 * push, "Keep provider" runs pull. There's no per-file merge — that
 * would require three-way diff history we don't track.
 */
export function DiffDrawer({
  skillName,
  providerId,
  onClose,
  onResolved,
}: {
  skillName: string;
  providerId: string;
  onClose: () => void;
  onResolved: () => void;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["diff", skillName, providerId],
    queryFn: () => api.diff(skillName, providerId),
  });

  const changedFiles = useMemo(
    () => (data?.files ?? []).filter((f) => f.change !== "same"),
    [data],
  );

  // Auto-select the first changed file once results land.
  useEffect(() => {
    if (!selected && changedFiles[0]) setSelected(changedFiles[0].path);
  }, [changedFiles, selected]);

  const invalidateAndClose = () => {
    qc.invalidateQueries({ queryKey: ["skill", skillName] });
    qc.invalidateQueries({ queryKey: ["skills"] });
    onResolved();
  };

  const push = useMutation({
    mutationFn: () =>
      api.push({ skill: skillName, provider_id: providerId, method: "auto" }),
    onSuccess: () => {
      toast.success("Pushed — vault wins");
      invalidateAndClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Push failed"),
  });

  const pull = useMutation({
    mutationFn: () => api.pull({ skill: skillName, provider_id: providerId }),
    onSuccess: () => {
      toast.success("Pulled — provider wins");
      invalidateAndClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Pull failed"),
  });

  const file = changedFiles.find((f) => f.path === selected);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 90, display: "flex" }}>
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
          marginLeft: "auto",
          width: "min(960px, 95vw)",
          height: "100%",
          background: "var(--bg)",
          borderLeft: "0.5px solid var(--border-2)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            height: 56,
            flexShrink: 0,
            borderBottom: "0.5px solid var(--border)",
            padding: "0 22px",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
            <code style={{ fontFamily: "var(--mono)" }}>{skillName}</code>{" "}
            <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>vs</span>{" "}
            <code style={{ fontFamily: "var(--mono)" }}>{providerId}</code>
          </span>
          {data && (
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--ink-3)",
              }}
            >
              +{data.summary.added} −{data.summary.removed} ~{data.summary.modified}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <Button kind="ghost" size="sm" icon={Icon.x} onClick={onClose}>
            Close
          </Button>
        </header>

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {/* File list */}
          <div
            className="sv-scroll"
            style={{
              width: 260,
              flexShrink: 0,
              borderRight: "0.5px solid var(--border)",
              overflowY: "auto",
            }}
          >
            {isLoading && (
              <div style={{ padding: 16, color: "var(--ink-3)", fontSize: 12 }}>
                Computing diff…
              </div>
            )}
            {error && (
              <div style={{ padding: 16, color: "var(--bad)", fontSize: 12 }}>
                {(error as Error).message}
              </div>
            )}
            {data && changedFiles.length === 0 && (
              <div style={{ padding: 16, color: "var(--ink-3)", fontSize: 12 }}>
                No content differences.
              </div>
            )}
            {changedFiles.map((f) => (
              <button
                key={f.path}
                onClick={() => setSelected(f.path)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "8px 12px",
                  border: 0,
                  background: selected === f.path ? "var(--surface-2)" : "transparent",
                  borderLeft: `2px solid ${selected === f.path ? "var(--accent)" : "transparent"}`,
                  color: "var(--ink)",
                  fontSize: 12,
                  fontFamily: "var(--mono)",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <ChangeMark change={f.change} />
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={f.path}
                >
                  {f.path}
                </span>
              </button>
            ))}
          </div>

          {/* Diff body */}
          <div className="sv-scroll" style={{ flex: 1, overflow: "auto", padding: 0 }}>
            {file ? <DiffBody file={file} /> : (
              <div style={{ padding: 22, color: "var(--ink-3)", fontSize: 13 }}>
                {isLoading ? "Loading…" : "Pick a file."}
              </div>
            )}
          </div>
        </div>

        <footer
          style={{
            height: 64,
            flexShrink: 0,
            borderTop: "0.5px solid var(--border)",
            padding: "0 22px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            Resolution applies to the whole skill.
          </span>
          <span style={{ display: "flex", gap: 8 }}>
            <Button
              kind="default"
              size="md"
              icon={Icon.pull}
              onClick={() => pull.mutate()}
              disabled={pull.isPending || push.isPending}
              title="Copy provider's version into the vault"
            >
              {pull.isPending ? "Pulling…" : "Keep provider"}
            </Button>
            <Button
              kind="primary"
              size="md"
              icon={Icon.push}
              onClick={() => push.mutate()}
              disabled={pull.isPending || push.isPending}
              title="Push vault's version to the provider"
            >
              {push.isPending ? "Pushing…" : "Keep vault"}
            </Button>
          </span>
        </footer>
      </div>
    </div>
  );
}

function ChangeMark({ change }: { change: FileDiff["change"] }) {
  const meta = {
    added:    { label: "+", color: "var(--ok)" },
    removed:  { label: "−", color: "var(--bad)" },
    modified: { label: "~", color: "var(--warn)" },
    same:     { label: "·", color: "var(--ink-4)" },
  }[change];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 14,
        height: 14,
        fontFamily: "var(--mono)",
        fontWeight: 700,
        fontSize: 12,
        color: meta.color,
        flexShrink: 0,
      }}
    >
      {meta.label}
    </span>
  );
}

function DiffBody({ file }: { file: FileDiff }) {
  if (file.change === "added" || file.change === "removed") {
    return (
      <div style={{ padding: 22, fontSize: 13, color: "var(--ink-2)" }}>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "var(--ink-3)",
            marginBottom: 6,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontWeight: 600,
          }}
        >
          {file.change === "added" ? "Only in provider" : "Only in vault"}
        </div>
        <p style={{ margin: 0 }}>
          <code style={{ fontFamily: "var(--mono)" }}>{file.path}</code>{" "}
          ({file.target_size ?? file.vault_size ?? 0} B)
        </p>
      </div>
    );
  }

  if (file.reason === "binary") {
    return (
      <div style={{ padding: 22, fontSize: 13, color: "var(--ink-2)" }}>
        Binary file differs. Vault: {file.vault_size} B · Provider: {file.target_size} B
      </div>
    );
  }
  if (file.reason === "too-large") {
    return (
      <div style={{ padding: 22, fontSize: 13, color: "var(--ink-2)" }}>
        File too large to diff (vault: {file.vault_size} B · provider: {file.target_size} B).
      </div>
    );
  }
  if (!file.hunks) {
    return null;
  }

  return (
    <div
      style={{
        fontFamily: "var(--mono)",
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <div
        style={{
          padding: "10px 18px",
          borderBottom: "0.5px solid var(--border)",
          fontSize: 11.5,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 600,
        }}
      >
        {file.path}{" "}
        <span style={{ color: "var(--ink-4)", fontWeight: 400 }}>
          · vault {file.vault_size}B → provider {file.target_size}B
        </span>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "8px 0",
          color: "var(--ink-2)",
          fontFamily: "var(--mono)",
        }}
      >
        {file.hunks.map((line, i) => {
          const bg =
            line.type === "add"
              ? "color-mix(in oklab, var(--ok) 8%, transparent)"
              : line.type === "del"
                ? "color-mix(in oklab, var(--bad) 8%, transparent)"
                : "transparent";
          const sign = line.type === "add" ? "+" : line.type === "del" ? "−" : " ";
          const color =
            line.type === "add"
              ? "var(--ok)"
              : line.type === "del"
                ? "var(--bad)"
                : "var(--ink-2)";
          return (
            <span
              key={i}
              style={{
                display: "block",
                background: bg,
                padding: "0 18px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 16,
                  color,
                  userSelect: "none",
                  textAlign: "center",
                }}
              >
                {sign}
              </span>
              {line.text || "​"}
            </span>
          );
        })}
      </pre>
    </div>
  );
}
