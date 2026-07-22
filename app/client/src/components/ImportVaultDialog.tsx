import { useState, type CSSProperties } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Button } from "./ui/primitives";
import { Icon } from "./ui/icons";

interface ScanResult {
  name: string;
  stage: string;
  targets: string[];
  conflict: boolean;
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
  width: 640,
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
  flex: 1,
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

export default function ImportVaultDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [vaultPath, setVaultPath] = useState("");
  const [results, setResults] = useState<ScanResult[] | null>(null);
  const [sourcePath, setSourcePath] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [scanError, setScanError] = useState("");

  const scan = useMutation({
    mutationFn: () => api.importScan(vaultPath.trim()),
    onSuccess: (data) => {
      setSourcePath(data.source);
      setResults(data.results);
      setScanError("");
      const initial: Record<string, boolean> = {};
      for (const r of data.results) {
        initial[r.name] = !r.conflict;
      }
      setSelected(initial);
      if (data.results.length === 0) {
        setScanError("No skills found in that vault.");
      }
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : "Scan failed";
      setScanError(msg);
      toast.error(msg);
    },
  });

  const merge = useMutation({
    mutationFn: () => {
      const names = Object.entries(selected).filter(([, v]) => v).map(([k]) => k);
      return api.importMerge(sourcePath, names);
    },
    onSuccess: (data) => {
      toast.success(`Imported ${data.imported.length} skill(s)`);
      qc.invalidateQueries({ queryKey: ["skills"] });
      onClose();
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Merge failed");
    },
  });

  const selectedCount = Object.values(selected).filter(Boolean).length;

  function toggleSkill(name: string) {
    setSelected((s) => ({ ...s, [name]: !s[name] }));
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--ink)" }}>
            Import from another vault
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{ border: 0, background: "transparent", color: "var(--ink-3)", cursor: "pointer", display: "inline-flex" }}
          >
            {Icon.x}
          </button>
        </div>

        {/* Step 1: path + scan */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>Source vault path</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={vaultPath}
              onChange={(e) => { setVaultPath(e.target.value); setResults(null); setScanError(""); }}
              placeholder="C:\Users\other\.skill-vault\vault"
              autoFocus
              style={inputStyle}
            />
            <Button
              kind="primary"
              onClick={() => scan.mutate()}
              disabled={!vaultPath.trim() || scan.isPending}
            >
              {scan.isPending ? "Scanning…" : "Scan"}
            </Button>
          </div>
          {scanError && (
            <div style={{ fontSize: 11, color: "var(--bad)", fontFamily: "var(--mono)", marginTop: 5 }}>
              {scanError}
            </div>
          )}
        </div>

        {/* Step 2: results table */}
        {results && results.length > 0 && (
          <>
            <div style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 10 }}>
              Found {results.length} skill(s) in source vault.
              {results.some((r) => r.conflict) && (
                <span style={{ color: "var(--ink-3)" }}>
                  {" "}Greyed items already exist in your vault.
                </span>
              )}
            </div>

            <div
              style={{
                border: "0.5px solid var(--border)",
                borderRadius: 8,
                overflow: "hidden",
                marginBottom: 16,
              }}
            >
              {/* Table header */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "28px 1fr 80px 1fr",
                  gap: 8,
                  padding: "8px 12px",
                  background: "var(--surface)",
                  borderBottom: "0.5px solid var(--border)",
                  fontSize: 10,
                  fontWeight: 600,
                  fontFamily: "var(--mono)",
                  color: "var(--ink-3)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                <span />
                <span>Name</span>
                <span>Stage</span>
                <span>Targets</span>
              </div>

              {/* Table rows */}
              {results.map((r) => (
                <div
                  key={r.name}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "28px 1fr 80px 1fr",
                    gap: 8,
                    padding: "8px 12px",
                    alignItems: "center",
                    borderBottom: "0.5px solid var(--border)",
                    opacity: r.conflict ? 0.45 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!!selected[r.name]}
                    disabled={r.conflict}
                    onChange={() => toggleSkill(r.name)}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--ink)" }}>
                      {r.name}
                    </span>
                    {r.conflict && (
                      <span
                        style={{
                          fontSize: 10,
                          fontFamily: "var(--mono)",
                          color: "var(--ink-3)",
                          background: "var(--surface)",
                          border: "0.5px solid var(--border)",
                          borderRadius: 3,
                          padding: "1px 5px",
                        }}
                      >
                        in vault
                      </span>
                    )}
                  </div>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-2)" }}>
                    {r.stage}
                  </span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)" }}>
                    {r.targets.length > 0 ? r.targets.join(", ") : "—"}
                  </span>
                </div>
              ))}
            </div>

            {/* Actions */}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button kind="ghost" onClick={onClose}>Cancel</Button>
              <Button
                kind="primary"
                onClick={() => merge.mutate()}
                disabled={selectedCount === 0 || merge.isPending}
              >
                {merge.isPending ? "Importing…" : `Import ${selectedCount} skill(s)`}
              </Button>
            </div>
          </>
        )}

        {/* No results yet and no scan running — just show cancel */}
        {!results && !scan.isPending && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <Button kind="ghost" onClick={onClose}>Cancel</Button>
          </div>
        )}
      </div>
    </div>
  );
}
