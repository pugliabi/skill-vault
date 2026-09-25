import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Button } from "./ui/primitives";

export function DeletedSkillsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({ queryKey: ["history-deleted"], queryFn: api.listDeletedSkills });
  const restore = useMutation({
    mutationFn: async (name: string) => {
      // Newest first: the delete version is the final state before deletion.
      const { versions } = await api.listHistory(name);
      const target = versions[0];
      if (!target) throw new Error(`No versions recorded for ${name}`);
      return api.restoreVersion(name, target.id);
    },
    onSuccess: (_r, name) => {
      toast.success(`Restored ${name}`);
      qc.invalidateQueries({ queryKey: ["history-deleted"] });
      qc.invalidateQueries({ queryKey: ["history", name] });
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Restore failed"),
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const skills = data?.skills ?? [];
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Deleted skills"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "grid", placeItems: "center", zIndex: 50 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(520px, 92vw)", maxHeight: "70vh", overflow: "auto", background: "var(--bg)", border: "0.5px solid var(--border-2)", borderRadius: 8, padding: 16 }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Deleted skills</div>
        {isLoading && <div style={{ color: "var(--ink-3)" }}>Loading…</div>}
        {isError && (
          <div style={{ color: "var(--bad)" }}>
            Couldn&apos;t load deleted skills: {error instanceof ApiError ? error.message : String(error)}
          </div>
        )}
        {!isLoading && !isError && skills.length === 0 && <div style={{ color: "var(--ink-3)" }}>No deleted skills in history.</div>}
        {skills.map((s) => (
          <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "0.5px solid var(--border)" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 12.5 }}>{s.name}</div>
              <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                deleted {new Date(s.deleted_at).toLocaleString()} · {s.versions} versions
              </div>
            </div>
            <Button onClick={() => restore.mutate(s.name)} disabled={restore.isPending}>Restore</Button>
          </div>
        ))}
      </div>
    </div>
  );
}
