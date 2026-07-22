import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Button } from "./ui/primitives";

/**
 * Install one vault skill into the OpenClaw agent (WSL). Runs
 * `openclaw skills install` inside the isolated distro — see
 * server/services/openclaw.ts. `--global` installs into the shared
 * `~/.openclaw/skills` (all agents); `--force` overwrites an existing one.
 */
export function ExportOpenClawDialog({
  skillName,
  onClose,
}: {
  skillName: string;
  onClose: () => void;
}) {
  const [global, setGlobal] = useState(true);
  const [force, setForce] = useState(true);

  const exportMut = useMutation({
    mutationFn: () => api.exportToOpenClaw(skillName, { global, force }),
    onSuccess: (r) => {
      toast.success(`Installed ${r.skill} into OpenClaw`);
      onClose();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Export failed"),
  });

  const row: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: "var(--ink)",
    cursor: "pointer",
    padding: "4px 0",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "oklch(0.15 0.005 60 / 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "var(--bg)",
          border: "0.5px solid var(--border-2)",
          borderRadius: 10,
          padding: "20px 24px",
          width: 440,
          boxShadow: "0 12px 40px oklch(0.1 0.01 60 / 0.3)",
        }}
      >
        <h3 style={{ margin: "0 0 6px", fontSize: 15, fontWeight: 600, color: "var(--ink)" }}>
          Export to OpenClaw
        </h3>
        <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--ink-2)" }}>
          Installs{" "}
          <code style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--ink)" }}>
            {skillName}
          </code>{" "}
          into the OpenClaw agent via <code style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>openclaw skills install</code> (WSL).
        </p>

        <label style={row}>
          <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
          <span>
            <strong>Global</strong> — install into <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>~/.openclaw/skills</code> (all agents)
          </span>
        </label>
        <label style={row}>
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
          <span><strong>Force</strong> — overwrite if it already exists</span>
        </label>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
          <Button kind="ghost" size="sm" onClick={onClose} disabled={exportMut.isPending}>
            Cancel
          </Button>
          <Button kind="primary" size="sm" onClick={() => exportMut.mutate()} disabled={exportMut.isPending}>
            {exportMut.isPending ? "Installing…" : "Install"}
          </Button>
        </div>
      </div>
    </div>
  );
}
