import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Button } from "./ui/primitives";
import { ChangeMark, DiffBody } from "./DiffDrawer";
import type { HistoryVersionSummary } from "../lib/types";

const SOURCE_LABEL: Record<string, string> = {
  "vault-edit": "Edited in app",
  "external-edit": "External edit",
  pull: "Pulled",
  "push-notion-copy": "Notion copy",
  "notion-edit": "Notion edit",
  "claude-merge": "Claude merge",
  "force-push": "Force push",
  "force-pull": "Force pull",
  restore: "Restored",
  rename: "Renamed",
  delete: "Deleted",
  adopt: "Adopted",
  update: "Updated from source",
  "legacy-snapshot": "Legacy snapshot",
};

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function HistoryTab({ skillName }: { skillName: string }) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["history", skillName],
    queryFn: () => api.listHistory(skillName),
  });
  const versions = data?.versions ?? [];
  useEffect(() => {
    if (!selectedId && versions[0]) setSelectedId(versions[0].id);
  }, [versions, selectedId]);

  const { data: diff, isError: diffFailed, error: diffError, isLoading: diffLoading } = useQuery({
    queryKey: ["history-diff", skillName, selectedId],
    queryFn: () => api.historyDiff(skillName, selectedId!),
    enabled: !!selectedId,
  });
  const changed = useMemo(() => (diff?.files ?? []).filter((f) => f.change !== "same"), [diff]);
  useEffect(() => {
    setSelectedFile(changed[0]?.path ?? null);
  }, [changed]);

  const restore = useMutation({
    mutationFn: (v: HistoryVersionSummary) => api.restoreVersion(skillName, v.id),
    onSuccess: () => {
      toast.success("Version restored — the previous state is saved in history");
      qc.invalidateQueries({ queryKey: ["history", skillName] });
      qc.invalidateQueries({ queryKey: ["history-diff", skillName] });
      qc.invalidateQueries({ queryKey: ["skill", skillName] });
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Restore failed"),
  });

  if (isLoading) return <div style={{ padding: 16, color: "var(--ink-3)" }}>Loading history…</div>;
  if (isError)
    return (
      <div style={{ padding: 16, color: "var(--bad)" }}>
        Couldn&apos;t load history: {error instanceof ApiError ? error.message : String(error)}
      </div>
    );
  if (versions.length === 0)
    return <div style={{ padding: 16, color: "var(--ink-3)" }}>No versions recorded yet.</div>;

  const selected = versions.find((v) => v.id === selectedId) ?? null;
  const file = changed.find((f) => f.path === selectedFile) ?? null;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", height: "100%", minHeight: 0 }}>
      <div style={{ borderRight: "0.5px solid var(--border-2)", overflowY: "auto" }}>
        {versions.map((v) => (
          <button
            key={v.id}
            onClick={() => setSelectedId(v.id)}
            style={{
              display: "block", width: "100%", textAlign: "left", padding: "8px 12px",
              border: 0, borderBottom: "0.5px solid var(--border)", cursor: "pointer",
              background: v.id === selectedId ? "var(--surface-2, var(--surface))" : "transparent",
            }}
          >
            <div style={{ fontSize: 12.5, color: "var(--ink)" }}>
              {SOURCE_LABEL[v.source] ?? v.source}
              <span style={{ marginLeft: 6, fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-3)" }}>
                {v.side}
              </span>
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{when(v.at)}</div>
            {v.note && <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{v.note}</div>}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        {selected && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "0.5px solid var(--border-2)" }}>
            <div style={{ flex: 1, fontSize: 12, color: "var(--ink-2)" }}>
              {diffFailed ? (
                <span style={{ color: "var(--bad)" }}>
                  Couldn&apos;t compare with the current skill:{" "}
                  {diffError instanceof ApiError ? diffError.message : String(diffError)}
                </span>
              ) : diffLoading ? (
                "Comparing…"
              ) : changed.length === 0 ? (
                "Identical to the current skill"
              ) : (
                `${changed.length} file(s) differ from the current skill`
              )}
            </div>
            <Button
              size="sm"
              disabled={diffFailed || diffLoading || changed.length === 0 || restore.isPending}
              onClick={() => {
                if (confirm(`Restore ${skillName} to the version from ${when(selected.at)}?`)) restore.mutate(selected);
              }}
            >
              Restore this version
            </Button>
          </div>
        )}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "6px 12px" }}>
          {changed.map((f) => (
            <button
              key={f.path}
              onClick={() => setSelectedFile(f.path)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--mono)", fontSize: 11,
                padding: "2px 6px", borderRadius: 4, cursor: "pointer",
                border: `0.5px solid ${f.path === selectedFile ? "var(--accent)" : "var(--border-2)"}`,
                background: "var(--surface)",
              }}
            >
              <ChangeMark change={f.change} /> {f.path}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          {file && <DiffBody file={file} labels={{ left: "this version", right: "current" }} />}
        </div>
      </div>
    </div>
  );
}
