import { useState, useEffect, type CSSProperties, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Button } from "./ui/primitives";
import { Icon } from "./ui/icons";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

function basename(p: string): string {
  const segs = p.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return segs[segs.length - 1] ?? "";
}

function toSlug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 90,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "oklch(0.2 0.01 60 / 0.4)",
  backdropFilter: "blur(2px)",
};

const card: CSSProperties = {
  width: 560,
  maxHeight: "85vh",
  overflow: "auto",
  background: "var(--bg)",
  border: "0.5px solid var(--border-2)",
  borderRadius: 12,
  boxShadow: "0 12px 40px oklch(0 0 0 / 0.18)",
  padding: "24px 28px",
  fontFamily: "var(--sans)",
};

const inputStyle: CSSProperties = {
  width: "100%",
  fontFamily: "var(--mono)",
  fontSize: 12,
  color: "var(--ink)",
  background: "var(--surface)",
  border: "0.5px solid var(--border-2)",
  borderRadius: 6,
  padding: "0 10px",
  height: 32,
  outline: 0,
  boxSizing: "border-box",
};

const labelStyle: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--ink-3)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 4,
};

const errStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--bad)",
  fontFamily: "var(--mono)",
  marginTop: 3,
};

export default function AddExistingDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: () => api.getConfig() });
  const providers = config?.providers ?? [];

  const [folderPath, setFolderPath] = useState("");
  const [name, setName] = useState("");
  const [nameManual, setNameManual] = useState(false);
  const [targets, setTargets] = useState<Record<string, boolean>>({});
  const [stage, setStage] = useState<"staging" | "production">("staging");
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!nameManual && folderPath) {
      setName(toSlug(basename(folderPath)));
    }
  }, [folderPath, nameManual]);

  const mutation = useMutation({
    mutationFn: () => {
      const selected = Object.entries(targets).filter(([, v]) => v).map(([k]) => k);
      return api.addExistingSkill({ path: folderPath.trim(), name: name.trim(), targets: selected });
    },
    onSuccess: () => {
      toast.success(`Skill "${name}" added`);
      qc.invalidateQueries({ queryKey: ["skills"] });
      onClose();
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : "Failed to add skill";
      toast.error(msg);
      setErrors((e) => ({ ...e, submit: msg }));
    },
  });

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!folderPath.trim()) e.path = "Folder path is required";
    if (!name.trim()) e.name = "Name is required";
    else if (!SLUG_RE.test(name.trim())) e.name = "Must be lowercase alphanumeric, dashes, 2-64 chars";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function handleSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (validate()) mutation.mutate();
  }

  function toggleTarget(id: string) {
    setTargets((t) => ({ ...t, [id]: !t[id] }));
  }

  return (
    <div style={overlay} onClick={onClose}>
      <form style={card} onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--ink)" }}>
            Add existing skill
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{ border: 0, background: "transparent", color: "var(--ink-3)", cursor: "pointer", display: "inline-flex" }}
          >
            {Icon.x}
          </button>
        </div>

        {/* Folder path */}
        <div style={{ marginBottom: 14 }}>
          <div style={labelStyle}>Folder path</div>
          <input
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
            placeholder="C:\Users\me\.claude\skills\my-skill"
            autoFocus
            style={inputStyle}
          />
          {errors.path && <div style={errStyle}>{errors.path}</div>}
        </div>

        {/* Name */}
        <div style={{ marginBottom: 14 }}>
          <div style={labelStyle}>Name</div>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); setNameManual(true); }}
            placeholder="my-skill"
            style={inputStyle}
          />
          {errors.name && <div style={errStyle}>{errors.name}</div>}
        </div>

        {/* Targets */}
        {providers.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={labelStyle}>Targets</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 2 }}>
              {providers.map((p) => (
                <label
                  key={p.id}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 13,
                    color: "var(--ink)",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!!targets[p.id]}
                    onChange={() => toggleTarget(p.id)}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{p.id}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Stage */}
        <div style={{ marginBottom: 20 }}>
          <div style={labelStyle}>Stage</div>
          <div style={{ display: "flex", gap: 16, marginTop: 2 }}>
            {(["staging", "production"] as const).map((s) => (
              <label
                key={s}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  color: "var(--ink)",
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <input
                  type="radio"
                  name="stage"
                  checked={stage === s}
                  onChange={() => setStage(s)}
                  style={{ accentColor: "var(--accent)" }}
                />
                {s}
              </label>
            ))}
          </div>
        </div>

        {/* Submit error */}
        {errors.submit && <div style={{ ...errStyle, marginBottom: 10 }}>{errors.submit}</div>}

        {/* Actions */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button kind="ghost" onClick={onClose}>Cancel</Button>
          <Button kind="primary" type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Adding…" : "Add skill"}
          </Button>
        </div>
      </form>
    </div>
  );
}
