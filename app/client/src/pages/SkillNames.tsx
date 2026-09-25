import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Layout } from "../components/Layout";
import { Button } from "../components/ui/primitives";
import type { SkillNameMismatch } from "../lib/types";

/**
 * /skill-names — skills whose folder name and SKILL.md `name` disagree.
 * Such skills are invalid for Claude packages and agents, and Notion
 * refuses to upload them, so pushes and upgrades fail for them until the
 * user picks which name is right: rename the folder to SKILL.md's name, or
 * change SKILL.md's name to the folder. Nothing is changed automatically.
 */

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const raw = err.raw as { message?: string } | null;
    return (err.message === "busy" ? raw?.message : err.message) || fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

export default function SkillNames() {
  const search = useSearch();
  const highlighted = new URLSearchParams(search).get("skill");
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["skill-name-mismatches"],
    queryFn: () => api.skillNameMismatches(),
    retry: false,
  });
  const rows = data?.skills ?? [];

  const fix = useMutation({
    mutationFn: (v: { folder: string; use: "name" | "folder" }) => api.fixSkillName(v.folder, v.use),
    onSuccess: (r, v) => {
      // Provider links follow a folder rename; copies are left where they are.
      const notes = (r.providers ?? [])
        .filter((p) => p.outcome !== "relinked")
        .map((p) => `${p.provider_id}: ${p.message}`);
      toast.success(v.use === "name" ? `Renamed folder "${v.folder}" to "${r.name}"` : `SKILL.md name set to "${r.name}"`, {
        ...(notes.length ? { description: notes.join(" · "), duration: 12000 } : {}),
      });
      qc.invalidateQueries({ queryKey: ["skill-name-mismatches"] });
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["history"] });
      qc.invalidateQueries({ queryKey: ["notion-plan"] });
      qc.invalidateQueries({ queryKey: ["notion-legacy"] });
    },
    onError: (err) => toast.error(errorText(err, "Couldn't fix the name")),
  });

  return (
    <Layout>
      <div className="sv-fade-in" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 24px 14px", borderBottom: "0.5px solid var(--border)", flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--ink)", letterSpacing: "-0.01em" }}>
            Name mismatches
          </h1>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            A skill's folder name and its SKILL.md <code>name</code> must be the same — Claude packages, agents and Notion rely on it.
          </span>
        </div>
        <div className="sv-scroll" style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
          {isLoading ? (
            <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>Loading…</div>
          ) : error ? (
            <div style={{ padding: 24, color: "var(--bad)", fontSize: 13 }}>{errorText(error, "Couldn't load name mismatches")}</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>No mismatches — every folder matches its SKILL.md name.</div>
          ) : (
            rows.map((m) => (
              <MismatchRow
                key={m.folder}
                m={m}
                highlighted={m.folder === highlighted}
                busy={fix.isPending}
                onFix={(use) => {
                  const text =
                    use === "name"
                      ? `Rename the folder "${m.folder}" to "${m.name}"? Its history and Notion link move with it.`
                      : `Change the name in "${m.folder}/SKILL.md" from "${m.name || "(none)"}" to "${m.folder}"? The previous file is kept in history.`;
                  if (window.confirm(text)) fix.mutate({ folder: m.folder, use });
                }}
              />
            ))
          )}
        </div>
      </div>
    </Layout>
  );
}

function MismatchRow({
  m,
  highlighted,
  busy,
  onFix,
}: {
  m: SkillNameMismatch;
  highlighted: boolean;
  busy: boolean;
  onFix: (use: "name" | "folder") => void;
}) {
  const canRename = m.name_is_valid && !m.folder_exists_for_name;
  return (
    <div
      ref={(el) => {
        if (el && highlighted) el.scrollIntoView({ block: "nearest" });
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "12px 24px",
        borderBottom: "0.5px solid var(--border)",
        borderLeft: `2px solid ${highlighted ? "var(--accent)" : "transparent"}`,
        background: highlighted ? "var(--surface-2)" : "transparent",
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 260 }}>
        <span style={{ fontSize: 12.5, color: "var(--ink)" }}>
          folder <code style={{ fontFamily: "var(--mono)" }}>{m.folder}</code> · SKILL.md name{" "}
          <code style={{ fontFamily: "var(--mono)" }}>{m.name || "(none)"}</code>
        </span>
        {m.notion_title && (
          <span style={{ fontSize: 11, color: "var(--ink-3)" }}>Notion: {m.notion_title}</span>
        )}
        {m.folder_exists_for_name && (
          <span style={{ fontSize: 11.5, color: "var(--warn)" }}>
            A skill named "{m.name}" already exists — compare the two and remove the duplicate, or change this SKILL.md name.
          </span>
        )}
        {m.name && !m.name_is_valid && (
          <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>"{m.name}" isn't a valid folder name.</span>
        )}
      </div>
      <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button
          size="sm"
          disabled={busy || !canRename}
          title={canRename ? undefined : m.folder_exists_for_name ? "A skill with that name already exists" : "Not a valid folder name"}
          onClick={() => onFix("name")}
        >
          Rename folder to '{m.name || "(none)"}'
        </Button>
        <Button size="sm" disabled={busy || !m.folder_is_valid} onClick={() => onFix("folder")}>
          Change SKILL.md name to '{m.folder}'
        </Button>
      </span>
    </div>
  );
}
