import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import { Button } from "./ui/primitives";

/**
 * File preview / editor for a single file inside a skill's folder.
 *
 * Mounts inside the Skills detail panel's Files tab when the user
 * clicks a file in the tree. The parent passes `onClose` so the
 * preview can return to the tree view via a back arrow.
 *
 * Editing is opt-in (Edit toggle in the header). Save uses optimistic
 * concurrency: server's GET sha256 is the baseline; PUT echoes it as
 * expected_sha256; mismatch returns 409 and we toast + refetch so the
 * user sees the new content (and loses unsaved edits — that's the
 * point of the warning).
 *
 * Dirty-close prompt fires (window.confirm) before losing unsaved
 * edits — the parent SHOULD also trigger this prompt before unmounting
 * the pane (file switch / tab switch / panel close / rename).
 */
export function FilePreviewPane({
  skillName,
  filePath,
  onClose,
  onDirtyChange,
}: {
  skillName: string;
  filePath: string;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [viewMode, setViewMode] = useState<"preview" | "code">(
    filePath.endsWith(".md") ? "preview" : "code"
  );
  const [draft, setDraft] = useState<string>("");
  const [baselineSha, setBaselineSha] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["file", skillName, filePath],
    queryFn: () => api.getFile(skillName, filePath),
    // Don't refetch behind the user's back while they're editing.
    staleTime: editing ? Infinity : 0,
  });

  const isDirty = editing && data?.content !== null && draft !== (data?.content ?? "");

  // Reset view mode when switching files
  useEffect(() => {
    setViewMode(filePath.endsWith(".md") ? "preview" : "code");
  }, [filePath]);

  // Reset draft + baseline whenever a fresh fetch lands.
  useEffect(() => {
    if (data && !editing) {
      setDraft(data.content ?? "");
      setBaselineSha(data.sha256);
    }
  }, [data, editing]);

  // Report dirty state changes to parent.
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Cleanup on unmount: clear the dirty bit so the parent's gate is sane
  // after the pane goes away (e.g., the parent forced unmount).
  useEffect(() => {
    return () => {
      onDirtyChange?.(false);
    };
  }, [onDirtyChange]);

  const save = useMutation({
    mutationFn: () => {
      if (baselineSha === null) {
        throw new Error("no baseline sha — cannot save");
      }
      return api.writeFile(skillName, filePath, {
        content: draft,
        expected_sha256: baselineSha,
      });
    },
    onSuccess: (result) => {
      toast.success("Saved");
      setEditing(false);
      setBaselineSha(result.sha256);
      // Invalidate skill detail so drift status refreshes.
      qc.invalidateQueries({ queryKey: ["skill", skillName] });
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["file", skillName, filePath] });
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : "Save failed";
      toast.error(msg);
      // Stale-baseline path: refetch so the user sees the new content.
      if (err instanceof ApiError && err.status === 409) {
        refetch();
        setEditing(false);
      }
    },
  });

  const promptIfDirty = (action: () => void): void => {
    if (
      isDirty &&
      !window.confirm(
        "You have unsaved changes. Discard them?",
      )
    ) {
      return;
    }
    action();
  };

  const cancelEdit = (): void => {
    promptIfDirty(() => {
      setEditing(false);
      setDraft(data?.content ?? "");
    });
  };

  const handleClose = (): void => {
    promptIfDirty(onClose);
  };

  // Cmd/Ctrl+S to save; Esc to cancel; Tab to insert \t at cursor.
  // Scoped to the textarea via onKeyDown — does not pollute global.
  const onTextareaKey: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (!save.isPending) save.mutate();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = draft.slice(0, start) + "\t" + draft.slice(end);
      setDraft(next);
      // Restore cursor AFTER React re-renders.
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 1;
      });
    }
  };

  // Header — back arrow + filename + Edit/Save/Cancel.
  const Header = useMemo(
    () => (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 0",
          borderBottom: "0.5px solid var(--border)",
          marginBottom: 12,
        }}
      >
        <Button kind="ghost" size="sm" onClick={handleClose}>
          ← Back
        </Button>
        <span
          style={{
            flex: 1,
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "var(--ink)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={filePath}
        >
          {filePath}
        </span>
        {data && data.size != null && (
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--ink-4)",
            }}
          >
            {data.size} B
          </span>
        )}
        {!editing && data && !data.binary && !data.too_large && (
          <Button kind="ghost" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        {editing && (
          <>
            <Button kind="ghost" size="sm" onClick={cancelEdit}>
              Cancel
            </Button>
            <Button
              kind="primary"
              size="sm"
              onClick={() => save.mutate()}
              disabled={!isDirty || save.isPending || baselineSha === null}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        )}
      </div>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, editing, isDirty, save.isPending, baselineSha, filePath],
  );

  if (isLoading) {
    return (
      <div>
        {Header}
        <div style={{ color: "var(--ink-3)", fontSize: 13 }}>Loading…</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div>
        {Header}
        <div style={{ color: "var(--bad)", fontSize: 13 }}>
          Failed to load file.
        </div>
      </div>
    );
  }

  if (data.binary) {
    return (
      <div>
        {Header}
        <div
          style={{
            color: "var(--ink-3)",
            fontSize: 13,
            padding: "16px 12px",
            background: "var(--surface)",
            border: "0.5px solid var(--border)",
            borderRadius: 6,
          }}
        >
          Binary file — cannot edit ({data.size} bytes)
        </div>
      </div>
    );
  }

  if (data.too_large) {
    return (
      <div>
        {Header}
        <div
          style={{
            color: "var(--ink-3)",
            fontSize: 13,
            padding: "16px 12px",
            background: "var(--surface)",
            border: "0.5px solid var(--border)",
            borderRadius: 6,
          }}
        >
          File too large to preview (&gt;1 MB) — {data.size} bytes
        </div>
      </div>
    );
  }

  if (editing) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {Header}
        <textarea
          ref={textareaRef}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onTextareaKey}
          spellCheck={false}
          style={{
            flex: 1,
            minHeight: 240,
            padding: "10px 12px",
            background: "var(--surface)",
            border: "0.5px solid var(--border-2)",
            borderRadius: 6,
            outline: 0,
            fontFamily: "var(--mono)",
            fontSize: 12.5,
            color: "var(--ink)",
            lineHeight: 1.5,
            resize: "none",
            tabSize: 2,
          }}
        />
      </div>
    );
  }

  const isMarkdown = filePath.endsWith(".md");
  const content = data.content ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {Header}

      {/* View mode toggle for text files */}
      {!editing && (
        <div style={{ display: "flex", gap: 0, marginBottom: 10 }}>
          <button
            onClick={() => setViewMode("preview")}
            style={{
              padding: "4px 12px",
              border: "0.5px solid var(--border-2)",
              borderRight: 0,
              borderRadius: "4px 0 0 4px",
              background: viewMode === "preview" ? "var(--surface-2)" : "var(--surface)",
              color: viewMode === "preview" ? "var(--ink)" : "var(--ink-3)",
              fontSize: 11.5,
              fontWeight: viewMode === "preview" ? 500 : 400,
              cursor: "pointer",
            }}
          >
            {isMarkdown ? "Preview" : "Wrap"}
          </button>
          <button
            onClick={() => setViewMode("code")}
            style={{
              padding: "4px 12px",
              border: "0.5px solid var(--border-2)",
              borderRadius: "0 4px 4px 0",
              background: viewMode === "code" ? "var(--surface-2)" : "var(--surface)",
              color: viewMode === "code" ? "var(--ink)" : "var(--ink-3)",
              fontSize: 11.5,
              fontWeight: viewMode === "code" ? 500 : 400,
              cursor: "pointer",
            }}
          >
            Code
          </button>
        </div>
      )}

      {viewMode === "preview" && isMarkdown ? (
        <div
          className="sv-scroll sv-markdown"
          style={{
            flex: 1,
            padding: "14px 16px",
            background: "var(--surface)",
            border: "0.5px solid var(--border)",
            borderRadius: 6,
            fontSize: 13.5,
            color: "var(--ink)",
            lineHeight: 1.6,
            overflowY: "auto",
          }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
        />
      ) : (
        <pre
          className="sv-scroll"
          style={{
            flex: 1,
            margin: 0,
            padding: "10px 12px",
            background: "var(--surface)",
            border: "0.5px solid var(--border)",
            borderRadius: 6,
            fontFamily: "var(--mono)",
            fontSize: 12.5,
            color: "var(--ink-2)",
            lineHeight: 1.5,
            whiteSpace: viewMode === "preview" ? "pre-wrap" : "pre",
            wordBreak: viewMode === "preview" ? "break-word" : "normal",
            overflowY: "auto",
            overflowX: viewMode === "code" ? "auto" : "hidden",
          }}
        >
          {content}
        </pre>
      )}
    </div>
  );
}
