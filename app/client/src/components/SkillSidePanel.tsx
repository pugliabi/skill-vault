import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Icon } from "./ui/icons";
import { Button, StatusBadge } from "./ui/primitives";
import { timeAgo } from "../lib/status";
import { FilePreviewPane } from "./FilePreviewPane";
import { TargetsTab } from "./TargetsTab";
import { PushDrawer } from "./PushDrawer";
import { ExportSkillDialog } from "./ExportSkillDialog";
import { TagChips } from "./TagChips";
import type { SkillDetail as SkillDetailT } from "../lib/types";

const RENAME_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export function SkillSidePanel({
  skillName,
  onEditorDirtyChange,
}: {
  skillName: string;
  onEditorDirtyChange?: (dirty: boolean) => void;
}) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"overview" | "targets" | "files">("overview");
  const [pushOpen, setPushOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [stageMenuOpen, setStageMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const stageMenuRef = useRef<HTMLDivElement>(null);

  const { data: skill } = useQuery<SkillDetailT>({
    queryKey: ["skill", skillName],
    queryFn: () => api.getSkill(skillName),
  });
  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: () => api.getConfig(),
  });
  const { data: tagsData } = useQuery({
    queryKey: ["tags"],
    queryFn: () => api.listTags(),
  });

  const confirmDiscardIfDirty = (): boolean => {
    if (!editorDirty) return true;
    return window.confirm("You have unsaved changes. Discard them?");
  };

  useEffect(() => {
    onEditorDirtyChange?.(editorDirty);
  }, [editorDirty, onEditorDirtyChange]);

  useEffect(() => {
    return () => { onEditorDirtyChange?.(false); };
  }, [onEditorDirtyChange]);

  useEffect(() => {
    setSelectedFile(null);
    setEditorDirty(false);
    setRenaming(false);
    setRenameError(null);
    setMenuOpen(false);
    setStageMenuOpen(false);
  }, [skillName]);

  // Close menus on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuOpen && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
      if (stageMenuOpen && stageMenuRef.current && !stageMenuRef.current.contains(e.target as Node)) {
        setStageMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen, stageMenuOpen]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["skill", skillName] });
    qc.invalidateQueries({ queryKey: ["skills"] });
    qc.invalidateQueries({ queryKey: ["tags"] });
  };

  const renameSkillMut = useMutation({
    mutationFn: (newName: string) =>
      api.renameSkill(skillName, { new_name: newName }),
    onSuccess: (skill) => {
      toast.success(`Renamed to ${skill.name}`);
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["skill", skillName] });
      qc.invalidateQueries({ queryKey: ["skill", skill.name] });
      navigate(`/skills/${encodeURIComponent(skill.name)}`);
      setRenaming(false);
      setRenameError(null);
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : "Rename failed";
      setRenameError(msg);
    },
  });

  const startRename = (): void => {
    setRenameValue(skillName);
    setRenameError(null);
    setRenaming(true);
    setMenuOpen(false);
  };

  const submitRename = (): void => {
    const trimmed = renameValue.trim();
    if (!RENAME_SLUG_RE.test(trimmed) || trimmed === skillName) return;
    if (!confirmDiscardIfDirty()) return;
    renameSkillMut.mutate(trimmed);
  };

  const cancelRename = (): void => {
    setRenaming(false);
    setRenameError(null);
  };

  const updateStage = useMutation({
    mutationFn: (stage: "production" | "staging") =>
      api.updateSkill(skillName, { stage }),
    onSuccess: (_, stage) => {
      toast.success(stage === "production" ? "Promoted" : "Demoted");
      invalidate();
      setStageMenuOpen(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Update failed"),
  });

  const remove = useMutation({
    mutationFn: () => api.removeSkill(skillName),
    onSuccess: () => {
      toast.success("Removed");
      qc.invalidateQueries({ queryKey: ["skills"] });
      navigate("/skills");
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Remove failed"),
  });

  if (!skill) {
    return (
      <aside
        style={{
          width: 380,
          flexShrink: 0,
          background: "var(--bg)",
          padding: 22,
          color: "var(--ink-3)",
          fontSize: 13,
        }}
      >
        Loading…
      </aside>
    );
  }

  const providers = config?.providers ?? [];

  return (
    <aside
      className="sv-scroll"
      style={{
        width: 380,
        flexShrink: 0,
        background: "var(--bg)",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ padding: "18px 22px 14px", borderBottom: "0.5px solid var(--border)" }}>
        {/* Open full view */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
          <button
            onClick={() => navigate(`/skills/${encodeURIComponent(skillName)}`)}
            title="Open full view"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              border: 0,
              background: "transparent",
              color: "var(--ink-3)",
              fontSize: 11,
              fontFamily: "var(--mono)",
              cursor: "pointer",
              padding: "2px 4px",
              borderRadius: 3,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--ink)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--ink-3)"; }}
          >
            open full view ↗
          </button>
        </div>

        {/* Stage badge (interactive) + status */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <StatusBadge status={skill.status} size="lg" />
          <div ref={stageMenuRef} style={{ position: "relative" }}>
            <button
              onClick={() => setStageMenuOpen(!stageMenuOpen)}
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: skill.stage === "staging" ? "var(--info)" : "var(--ok)",
                background: "var(--surface)",
                border: "0.5px solid var(--border-2)",
                borderRadius: 4,
                padding: "2px 8px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              {skill.stage}
              <span style={{ fontSize: 9 }}>▾</span>
            </button>
            {stageMenuOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  marginTop: 4,
                  background: "var(--bg)",
                  border: "0.5px solid var(--border-2)",
                  borderRadius: 6,
                  boxShadow: "0 4px 12px oklch(0.2 0.01 60 / 0.15)",
                  zIndex: 50,
                  minWidth: 160,
                  padding: 4,
                }}
              >
                {skill.stage === "staging" ? (
                  <>
                    <MenuAction
                      label="Promote to production"
                      onClick={() => updateStage.mutate("production")}
                      disabled={updateStage.isPending}
                    />
                    <MenuAction
                      label="Promote and push"
                      onClick={async () => {
                        await updateStage.mutateAsync("production");
                        setPushOpen(true);
                      }}
                      disabled={updateStage.isPending || !providers.length}
                    />
                  </>
                ) : (
                  <MenuAction
                    label="Demote to staging"
                    onClick={() => updateStage.mutate("staging")}
                    disabled={updateStage.isPending}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {/* Name + rename */}
        {renaming ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => {
                  setRenameValue(e.target.value);
                  setRenameError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); submitRename(); }
                  else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                }}
                style={{
                  flex: 1,
                  height: 30,
                  padding: "0 8px",
                  background: "var(--surface)",
                  border: `0.5px solid ${
                    renameError || (renameValue.trim() && !RENAME_SLUG_RE.test(renameValue.trim()))
                      ? "var(--bad)" : "var(--border-2)"
                  }`,
                  borderRadius: 6,
                  outline: 0,
                  fontFamily: "var(--mono)",
                  fontSize: 16,
                  fontWeight: 600,
                  color: "var(--ink)",
                }}
              />
              <Button
                kind="primary"
                size="sm"
                onClick={submitRename}
                disabled={
                  !RENAME_SLUG_RE.test(renameValue.trim()) ||
                  renameValue.trim() === skillName ||
                  renameSkillMut.isPending
                }
              >
                {renameSkillMut.isPending ? "Saving…" : "✓"}
              </Button>
              <Button kind="ghost" size="sm" onClick={cancelRename}>×</Button>
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: renameError || (renameValue.trim() && !RENAME_SLUG_RE.test(renameValue.trim()))
                  ? "var(--bad)" : "var(--ink-3)",
                lineHeight: 1.4,
              }}
            >
              {renameError ?? "lowercase letters, digits, hyphens; 2–64 chars; cannot start or end with -"}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <h2
              style={{
                margin: 0,
                fontSize: 18,
                fontWeight: 600,
                color: "var(--ink)",
                fontFamily: "var(--mono)",
                letterSpacing: "-0.01em",
                wordBreak: "break-all",
                flex: 1,
              }}
            >
              {skill.name}
            </h2>
          </div>
        )}

        <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
          {skill.description || (
            <span style={{ color: "var(--ink-4)", fontStyle: "italic" }}>No description</span>
          )}
        </p>

        {/* Action row: Push (primary) + overflow menu */}
        <div style={{ display: "flex", gap: 6, marginTop: 14, alignItems: "center" }}>
          <Button
            kind="primary"
            size="sm"
            icon={Icon.push}
            onClick={() => setPushOpen(true)}
            disabled={!providers.length}
            title={providers.length ? undefined : "Add a provider in Settings first"}
          >
            Push
          </Button>

          {/* Overflow menu */}
          <div ref={menuRef} style={{ position: "relative", marginLeft: "auto" }}>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              title="More actions"
              style={{
                width: 28,
                height: 28,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "0.5px solid var(--border-2)",
                background: menuOpen ? "var(--surface-2)" : "var(--surface)",
                borderRadius: 6,
                cursor: "pointer",
                color: "var(--ink-2)",
                fontSize: 14,
              }}
            >
              •••
            </button>
            {menuOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  right: 0,
                  marginTop: 4,
                  background: "var(--bg)",
                  border: "0.5px solid var(--border-2)",
                  borderRadius: 6,
                  boxShadow: "0 4px 12px oklch(0.2 0.01 60 / 0.15)",
                  zIndex: 50,
                  minWidth: 180,
                  padding: 4,
                }}
              >
                {skill.stage === "staging" ? (
                  <MenuAction
                    label="Promote to production"
                    onClick={() => { updateStage.mutate("production"); setMenuOpen(false); }}
                    disabled={updateStage.isPending}
                  />
                ) : (
                  <MenuAction
                    label="Demote to staging"
                    onClick={() => { updateStage.mutate("staging"); setMenuOpen(false); }}
                    disabled={updateStage.isPending}
                  />
                )}
                <MenuAction label="Rename…" onClick={startRename} />
                <MenuAction label="Export…" onClick={() => { setMenuOpen(false); setExportOpen(true); }} />
                <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
                <MenuAction
                  label="Remove skill"
                  danger
                  onClick={() => {
                    setMenuOpen(false);
                    if (window.confirm(`Delete "${skill.name}" from the vault? This removes the folder and the manifest entry.`)) {
                      remove.mutate();
                    }
                  }}
                  disabled={remove.isPending}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: 0,
          padding: "0 22px",
          borderBottom: "0.5px solid var(--border)",
        }}
      >
        {(["overview", "targets", "files"] as const).map((t) => (
          <button
            key={t}
            onClick={() => {
              if (confirmDiscardIfDirty()) {
                setTab(t);
                if (t !== "files") setSelectedFile(null);
              }
            }}
            style={{
              padding: "10px 0",
              marginRight: 18,
              border: 0,
              background: "transparent",
              fontSize: 12.5,
              fontWeight: 500,
              color: tab === t ? "var(--ink)" : "var(--ink-3)",
              borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
              marginBottom: -1,
              cursor: "pointer",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      <div style={{ padding: "16px 22px", flex: 1 }}>
        {tab === "overview" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <DetailRow label="files" value={String(skill.file_count)} mono />
            <DetailRow label="updated" value={timeAgo(skill.modified_at)} />
            <DetailRow label="stage" value={skill.stage} mono />
            <DetailRow label="source" value={skill.source || "manual"} />
            <DetailRow label="path" value={`vault/skills/${skill.name}/`} mono small />
            <DetailRow label="SKILL.md" value={skill.has_skill_md ? "present" : "missing"} mono />
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>tags</span>
              <TagChips
                tags={skill.tags}
                allTags={tagsData?.tags}
                editable
                onAdd={(tag) => api.updateSkill(skillName, { tags: [...skill.tags, tag] }).then(invalidate)}
                onRemove={(tag) => api.updateSkill(skillName, { tags: skill.tags.filter(t => t !== tag) }).then(invalidate)}
              />
            </div>
          </div>
        )}

        {tab === "targets" && <TargetsTab skill={skill} />}

        {tab === "files" &&
          (selectedFile ? (
            <FilePreviewPane
              skillName={skill.name}
              filePath={selectedFile}
              onClose={() => setSelectedFile(null)}
              onDirtyChange={setEditorDirty}
            />
          ) : (
            <FileTreeView
              node={skill.files}
              onFileClick={(path) => {
                if (confirmDiscardIfDirty()) setSelectedFile(path);
              }}
            />
          ))}
      </div>

      {pushOpen && (
        <PushDrawer
          skills={[skill.name]}
          onClose={() => setPushOpen(false)}
          onSuccess={() => {
            setPushOpen(false);
            qc.invalidateQueries({ queryKey: ["skill", skill.name] });
            qc.invalidateQueries({ queryKey: ["skills"] });
          }}
        />
      )}

      {exportOpen && (
        <ExportSkillDialog
          skillName={skill.name}
          onClose={() => setExportOpen(false)}
        />
      )}
    </aside>
  );
}

/* ── helper components ─────────────────────────────────────────── */

function MenuAction({
  label,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "7px 10px",
        border: 0,
        background: "transparent",
        fontSize: 12.5,
        color: danger ? "var(--bad)" : "var(--ink)",
        cursor: disabled ? "default" : "pointer",
        borderRadius: 4,
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "var(--surface)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {label}
    </button>
  );
}

function DetailRow({
  label,
  value,
  mono,
  small,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 12,
        fontSize: 13,
      }}
    >
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: mono ? "var(--mono)" : "var(--sans)",
          fontSize: small ? 11.5 : 13,
          color: "var(--ink)",
          textAlign: "right",
          wordBreak: "break-all",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function FileTreeView({
  node,
  depth = 0,
  onFileClick,
}: {
  node: SkillDetailT["files"];
  depth?: number;
  onFileClick?: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  if (node.type === "file") {
    return (
      <div
        onClick={() => onFileClick?.(node.path)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "3px 0",
          paddingLeft: depth * 14,
          color: "var(--ink-2)",
          fontFamily: "var(--mono)",
          fontSize: 12,
          cursor: onFileClick ? "pointer" : "default",
        }}
        onMouseEnter={(e) => {
          if (onFileClick) e.currentTarget.style.background = "var(--surface)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        <span style={{ color: "var(--ink-4)" }}>·</span>
        <span style={{ flex: 1 }}>{node.name}</span>
        {node.size != null && (
          <span style={{ color: "var(--ink-4)", fontSize: 10.5 }}>{node.size} B</span>
        )}
      </div>
    );
  }
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "3px 0",
          paddingLeft: depth * 14,
          color: "var(--ink)",
          fontFamily: "var(--mono)",
          fontSize: 12,
          background: "transparent",
          border: 0,
          cursor: "pointer",
          width: "100%",
          textAlign: "left",
        }}
      >
        <span style={{ color: "var(--accent)" }}>{Icon.folder}</span>
        <span>{node.name}</span>
      </button>
      {open && node.children?.map((child) => (
        <FileTreeView key={child.path} node={child} depth={depth + 1} onFileClick={onFileClick} />
      ))}
    </div>
  );
}
