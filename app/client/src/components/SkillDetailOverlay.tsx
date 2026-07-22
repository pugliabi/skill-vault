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
import { ExportOpenClawDialog } from "./ExportOpenClawDialog";
import { TagChips } from "./TagChips";
import type { SkillDetail as SkillDetailT } from "../lib/types";

const RENAME_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export function SkillDetailOverlay({
  skillName,
  onClose,
  onEditorDirtyChange,
}: {
  skillName: string;
  onClose: () => void;
  onEditorDirtyChange?: (dirty: boolean) => void;
}) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"overview" | "targets" | "files">("overview");
  const [pushOpen, setPushOpen] = useState(false);
  const [openclawOpen, setOpenclawOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [stageMenuOpen, setStageMenuOpen] = useState(false);
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
  const { data: openclaw } = useQuery({
    queryKey: ["openclaw-status"],
    queryFn: () => api.openclawStatus(),
    staleTime: 30000,
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
    setStageMenuOpen(false);
  }, [skillName]);

  // Esc to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pushOpen) {
        if (confirmDiscardIfDirty()) onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, pushOpen, editorDirty]);

  // Close menus on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (stageMenuOpen && stageMenuRef.current && !stageMenuRef.current.contains(e.target as Node))
        setStageMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [stageMenuOpen]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["skill", skillName] });
    qc.invalidateQueries({ queryKey: ["skills"] });
    qc.invalidateQueries({ queryKey: ["tags"] });
  };

  const renameSkillMut = useMutation({
    mutationFn: (newName: string) =>
      api.renameSkill(skillName, { new_name: newName }),
    onSuccess: (s) => {
      toast.success(`Renamed to ${s.name}`);
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["skill", skillName] });
      qc.invalidateQueries({ queryKey: ["skill", s.name] });
      navigate(`/skills/${encodeURIComponent(s.name)}`);
      setRenaming(false);
      setRenameError(null);
    },
    onError: (err) => {
      setRenameError(err instanceof ApiError ? err.message : "Rename failed");
    },
  });

  const startRename = (): void => {
    setRenameValue(skillName);
    setRenameError(null);
    setRenaming(true);
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
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Remove failed"),
  });

  const providers = config?.providers ?? [];
  const firstTarget = skill?.targets[0];

  const pullMut = useMutation({
    mutationFn: () => api.pull({ skill: skillName, provider_id: firstTarget! }),
    onSuccess: (r) => {
      toast.success(r.action === "no-op" ? "Already up to date" : "Pulled");
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Pull failed"),
  });

  const zipMut = useMutation({
    mutationFn: () => api.zipSkills([skillName]),
    onSuccess: (r) => {
      if (r.zips.length > 0) {
        toast.success(`Zipped → ${r.zips[0].path}`);
      } else if (r.failed.length > 0) {
        toast.error(r.failed[0].error || "Zip failed");
      }
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Zip failed"),
  });

  const handleBackdropClick = () => {
    if (confirmDiscardIfDirty()) onClose();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Backdrop */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "oklch(0.12 0.01 60 / 0.55)",
          backdropFilter: "blur(6px)",
        }}
        onClick={handleBackdropClick}
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal
        className="sv-fade-in"
        style={{
          position: "relative",
          width: "88vw",
          height: "88vh",
          maxWidth: 1280,
          maxHeight: 800,
          background: "var(--bg)",
          border: "0.5px solid var(--border-2)",
          borderRadius: 12,
          boxShadow: "0 24px 80px oklch(0.1 0.01 60 / 0.5)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Compact header: skill name + actions + tabs — all in one bar area */}
        <div style={{ flexShrink: 0, borderBottom: "0.5px solid var(--border)" }}>
          {/* Top row: name + stage + actions + close */}
          <div style={{ padding: "14px 28px 0", display: "flex", alignItems: "center", gap: 10 }}>
            {!skill ? (
              <div style={{ color: "var(--ink-3)", fontSize: 14, flex: 1 }}>Loading…</div>
            ) : (
              <>
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
                    <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: "var(--bg)", border: "0.5px solid var(--border-2)", borderRadius: 6, boxShadow: "0 4px 12px oklch(0.2 0.01 60 / 0.15)", zIndex: 50, minWidth: 180, padding: 4 }}>
                      {skill.stage === "staging" ? (
                        <>
                          <MenuAction label="Promote to production" onClick={() => updateStage.mutate("production")} disabled={updateStage.isPending} />
                          <MenuAction label="Promote and push" onClick={async () => { await updateStage.mutateAsync("production"); setPushOpen(true); }} disabled={updateStage.isPending || !providers.length} />
                        </>
                      ) : (
                        <MenuAction label="Demote to staging" onClick={() => updateStage.mutate("staging")} disabled={updateStage.isPending} />
                      )}
                    </div>
                  )}
                </div>

                {renaming ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => { setRenameValue(e.target.value); setRenameError(null); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); submitRename(); }
                        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelRename(); }
                      }}
                      style={{ width: 280, height: 30, padding: "0 8px", background: "var(--surface)", border: `0.5px solid ${renameError || (renameValue.trim() && !RENAME_SLUG_RE.test(renameValue.trim())) ? "var(--bad)" : "var(--border-2)"}`, borderRadius: 6, outline: 0, fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600, color: "var(--ink)" }}
                    />
                    <Button kind="primary" size="sm" onClick={submitRename} disabled={!RENAME_SLUG_RE.test(renameValue.trim()) || renameValue.trim() === skillName || renameSkillMut.isPending}>
                      {renameSkillMut.isPending ? "…" : "✓"}
                    </Button>
                    <Button kind="ghost" size="sm" onClick={cancelRename}>×</Button>
                  </div>
                ) : (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600, color: "var(--ink)", flexShrink: 0 }}>
                    {skill.name}
                  </span>
                )}

                <div
                  className="sv-scroll"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflowX: "auto",
                    overflowY: "hidden",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <TagChips
                    tags={skill.tags}
                    allTags={tagsData?.tags}
                    editable
                    onAdd={(tag) => api.updateSkill(skillName, { tags: [...skill.tags, tag] }).then(invalidate)}
                    onRemove={(tag) => api.updateSkill(skillName, { tags: skill.tags.filter(t => t !== tag) }).then(invalidate)}
                  />
                </div>

                <Button kind="primary" size="sm" icon={Icon.push} onClick={() => setPushOpen(true)} disabled={!providers.length}>Push</Button>
                <Button kind="default" size="sm" icon={Icon.pull} onClick={() => pullMut.mutate()} disabled={!firstTarget || pullMut.isPending}>
                  {pullMut.isPending ? "…" : "Pull"}
                </Button>
                <Button kind="default" size="sm" icon={Icon.archive} onClick={() => zipMut.mutate()} disabled={zipMut.isPending}>
                  {zipMut.isPending ? "Zipping…" : "Zip"}
                </Button>
                {openclaw?.available && (
                  <Button kind="default" size="sm" icon={Icon.upload} onClick={() => setOpenclawOpen(true)} title="Install into the OpenClaw agent (WSL)">
                    OpenClaw
                  </Button>
                )}
                <Button kind="default" size="sm" icon={Icon.edit} onClick={startRename} disabled={renaming}>Rename</Button>
                <Button kind="danger" size="sm" icon={Icon.trash} onClick={() => { if (window.confirm(`Delete "${skill.name}"?`)) remove.mutate(); }} disabled={remove.isPending}>Remove</Button>
              </>
            )}

            <button onClick={() => { if (confirmDiscardIfDirty()) onClose(); }} title="Close (Esc)" style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", border: "0.5px solid var(--border-2)", background: "var(--surface)", borderRadius: 6, cursor: "pointer", color: "var(--ink-2)", marginLeft: 4 }}>{Icon.x}</button>
          </div>

          {/* Tabs row */}
          <div style={{ display: "flex", gap: 0, padding: "0 28px" }}>
            {(["overview", "targets", "files"] as const).map((t) => (
              <button
                key={t}
                onClick={() => { if (confirmDiscardIfDirty()) { setTab(t); if (t !== "files") setSelectedFile(null); } }}
                style={{ padding: "10px 0", marginRight: 20, border: 0, background: "transparent", fontSize: 13, fontWeight: 500, color: tab === t ? "var(--ink)" : "var(--ink-3)", borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent", marginBottom: -1, cursor: "pointer" }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div
          className="sv-scroll"
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            overflowY: tab === "files" ? "hidden" : "auto",
          }}
        >
          {skill && tab === "overview" && (
            <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
              <DetailRow label="files" value={String(skill.file_count)} mono />
              <DetailRow label="updated" value={timeAgo(skill.modified_at)} />
              <DetailRow label="stage" value={skill.stage} mono />
              <DetailRow label="source" value={skill.source || "manual"} />
              <DetailRow label="path" value={`vault/skills/${skill.name}/`} mono small />
              <DetailRow label="SKILL.md" value={skill.has_skill_md ? "present" : "missing"} mono />
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, fontSize: 14 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>tags</span>
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

          {skill && tab === "targets" && (
            <div style={{ padding: "24px 32px", maxWidth: 600 }}>
              <TargetsTab skill={skill} />
            </div>
          )}

          {skill && tab === "files" && (
            <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
              {/* File tree — 30% */}
              <div
                className="sv-scroll"
                style={{
                  width: "30%",
                  minWidth: 200,
                  maxWidth: 320,
                  overflowY: "auto",
                  borderRight: "0.5px solid var(--border)",
                  padding: "16px 20px",
                }}
              >
                <FileTreeView
                  node={skill.files}
                  selectedPath={selectedFile}
                  onFileClick={(path) => {
                    if (confirmDiscardIfDirty()) setSelectedFile(path);
                  }}
                />
              </div>
              {/* File preview — 70% */}
              <div
                className="sv-scroll"
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: "16px 28px",
                }}
              >
                {selectedFile ? (
                  <FilePreviewPane
                    skillName={skill.name}
                    filePath={selectedFile}
                    onClose={() => setSelectedFile(null)}
                    onDirtyChange={setEditorDirty}
                  />
                ) : (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      height: "100%",
                      color: "var(--ink-4)",
                      fontSize: 13,
                      fontFamily: "var(--mono)",
                    }}
                  >
                    select a file to preview
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {pushOpen && skill && (
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

      {openclawOpen && skill && (
        <ExportOpenClawDialog
          skillName={skill.name}
          onClose={() => {
            setOpenclawOpen(false);
            qc.invalidateQueries({ queryKey: ["openclaw-status"] });
          }}
        />
      )}
    </div>
  );
}

/* ── helpers ─────────────────────────────────────────────────────── */

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
        fontSize: 13,
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
        gap: 16,
        fontSize: 14,
      }}
    >
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 12,
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
          fontSize: small ? 12.5 : 14,
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
  selectedPath,
  onFileClick,
}: {
  node: SkillDetailT["files"];
  depth?: number;
  selectedPath?: string | null;
  onFileClick?: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  if (node.type === "file") {
    const isActive = node.path === selectedPath;
    return (
      <div
        onClick={() => onFileClick?.(node.path)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 6px",
          paddingLeft: depth * 14 + 6,
          color: isActive ? "var(--ink)" : "var(--ink-2)",
          fontFamily: "var(--mono)",
          fontSize: 12.5,
          cursor: onFileClick ? "pointer" : "default",
          background: isActive ? "var(--surface-2)" : "transparent",
          borderRadius: 4,
        }}
        onMouseEnter={(e) => {
          if (onFileClick && !isActive) e.currentTarget.style.background = "var(--surface)";
        }}
        onMouseLeave={(e) => {
          if (!isActive) e.currentTarget.style.background = "transparent";
        }}
      >
        <span style={{ color: "var(--ink-4)" }}>·</span>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {node.name}
        </span>
        {node.size != null && (
          <span style={{ color: "var(--ink-4)", fontSize: 10.5, flexShrink: 0 }}>
            {node.size} B
          </span>
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
          padding: "4px 6px",
          paddingLeft: depth * 14 + 6,
          color: "var(--ink)",
          fontFamily: "var(--mono)",
          fontSize: 12.5,
          background: "transparent",
          border: 0,
          cursor: "pointer",
          width: "100%",
          textAlign: "left",
          borderRadius: 4,
        }}
      >
        <span style={{ color: "var(--accent)" }}>{Icon.folder}</span>
        <span>{node.name}</span>
      </button>
      {open && node.children?.map((child) => (
        <FileTreeView
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onFileClick={onFileClick}
        />
      ))}
    </div>
  );
}
