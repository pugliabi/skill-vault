import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../lib/api";
import { Button } from "./ui/primitives";

export function ExportSkillDialog({
  skillName,
  onClose,
}: {
  skillName: string;
  onClose: () => void;
}) {
  const [outputDir, setOutputDir] = useState("");

  const exportMut = useMutation({
    mutationFn: () => api.packageSkill(skillName, { output_dir: outputDir.trim() }),
    onSuccess: (data) => {
      toast.success(`Exported to ${data.output_path}`);
      onClose();
    },
    onError: (err) => toast.error(String(err)),
  });

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
          width: 420,
          boxShadow: "0 12px 40px oklch(0.1 0.01 60 / 0.3)",
        }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600, color: "var(--ink)" }}>
          Export skill
        </h3>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
            Skill
          </label>
          <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--ink)", marginTop: 4 }}>
            {skillName}
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
            Output directory
          </label>
          <input
            autoFocus
            value={outputDir}
            onChange={(e) => setOutputDir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && outputDir.trim()) exportMut.mutate();
              if (e.key === "Escape") onClose();
            }}
            placeholder="C:\exports or /tmp/skills"
            style={{
              display: "block",
              width: "100%",
              marginTop: 6,
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "var(--ink)",
              background: "var(--surface)",
              border: "0.5px solid var(--border-2)",
              borderRadius: 5,
              padding: "0 10px",
              height: 32,
              outline: 0,
              boxSizing: "border-box",
            }}
          />
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button kind="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            kind="primary"
            size="sm"
            onClick={() => exportMut.mutate()}
            disabled={!outputDir.trim() || exportMut.isPending}
          >
            {exportMut.isPending ? "Exporting…" : "Export"}
          </Button>
        </div>
      </div>
    </div>
  );
}
