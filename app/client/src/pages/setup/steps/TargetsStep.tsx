import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { setupApi, type DetectedTarget, type SetupTarget } from "../../../lib/setup";
import { Button } from "../../../components/ui/primitives";
import type { StepProps } from "../types";
import { FolderField, Hint, StepHeader, StepNav, inputStyle, labelStyle, listBox, rowStyle } from "../ui";

interface Row extends SetupTarget {
  label: string;
  status?: DetectedTarget["status"];
}

const STATUS_TEXT: Record<DetectedTarget["status"], string> = {
  found: "Found",
  installed: "Installed, no skills folder yet",
  not_found: "Not found",
};

/** First visit: configured targets keep their settings; on a first run, found tools start ticked and default. */
function initialRows(detected: DetectedTarget[], saved: SetupTarget[] | null): Row[] {
  if (saved) {
    const byId = new Map(detected.map((d) => [d.id, d]));
    const rows: Row[] = saved.map((t) => ({ ...t, label: byId.get(t.id)?.label ?? t.id, status: byId.get(t.id)?.status }));
    for (const d of detected) if (!saved.some((t) => t.id === d.id)) rows.push({ id: d.id, path: d.path, enabled: false, is_default: false, known: d.known, label: d.label, status: d.status });
    return rows;
  }
  const anyConfigured = detected.some((d) => d.configured);
  return detected.map((d) => {
    const enabled = d.configured || (!anyConfigured && d.status === "found");
    return { id: d.id, path: d.path, enabled, is_default: d.configured ? d.is_default : enabled, known: d.known, label: d.label, status: d.status };
  });
}

export function TargetsStep({ draft, commit, goTo, folderDialog }: StepProps) {
  const { data, error } = useQuery({ queryKey: ["setup-targets"], queryFn: () => setupApi.targets() });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");

  useEffect(() => {
    if (data && !rows) setRows(initialRows(data.targets, draft.targets));
  }, [data, rows, draft.targets]);

  const update = (id: string, patch: Partial<Row>) =>
    setRows((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, ...patch, is_default: (patch.enabled ?? r.enabled) && (patch.is_default ?? r.is_default) } : r)));

  const nameTaken = rows?.some((r) => r.id.toLowerCase() === name.trim().toLowerCase()) ?? false;
  const badName = /[\\/]/.test(name);
  const addCustom = () => {
    setRows((rs) => [...(rs ?? []), { id: name.trim(), path: folder.trim(), enabled: true, is_default: true, known: false, label: name.trim() }]);
    setName("");
    setFolder("");
  };

  const next = () => commit({ targets: (rows ?? []).map(({ id, path, enabled, is_default, known }) => ({ id, path, enabled, is_default, known })) }, "skills");

  return (
    <div>
      <StepHeader title="The tools you use">
        Each tool you tick gets your vault's skills. "Default" tools also get every new skill you add.
      </StepHeader>

      {error && <Hint tone="bad">{(error as Error).message}</Hint>}
      {rows && (
        <div style={listBox}>
          <div style={{ ...rowStyle, color: "var(--ink-3)", fontSize: 11, fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            <span style={{ width: 22 }}>use</span>
            <span style={{ flex: 1 }}>tool</span>
            <span style={{ width: 64, textAlign: "center" }}>default</span>
          </div>
          {rows.map((r) => (
            <div key={r.id} style={rowStyle}>
              <input type="checkbox" aria-label={`Use ${r.label}`} checked={r.enabled} onChange={(e) => update(r.id, { enabled: e.target.checked })} style={{ width: 22 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{r.label}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--ink-3)", wordBreak: "break-all" }}>
                  {r.path}
                  {r.status ? ` · ${STATUS_TEXT[r.status]}` : ""}
                </div>
              </div>
              <input
                type="checkbox"
                aria-label={`${r.label} is a default target`}
                checked={r.is_default}
                disabled={!r.enabled}
                onChange={(e) => update(r.id, { is_default: e.target.checked })}
                style={{ width: 64 }}
              />
            </div>
          ))}
        </div>
      )}
      <Hint>Unticking a tool you already use only removes it from Skill Vault's settings. No files are deleted.</Hint>

      <div style={{ marginTop: 22 }}>
        <span style={labelStyle}>add a custom target</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input aria-label="Target name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. my-project" style={inputStyle} />
          <FolderField id="custom-target" label="its skills folder" value={folder} onChange={setFolder} folderDialog={folderDialog} dialogTitle="Choose the tool's skills folder" />
          <div>
            <Button onClick={addCustom} disabled={!name.trim() || !folder.trim() || nameTaken || badName}>
              Add target
            </Button>
          </div>
          {nameTaken && <Hint tone="bad">That name is already in the list.</Hint>}
          {badName && <Hint tone="bad">Names can't contain \ or /.</Hint>}
        </div>
      </div>

      <StepNav onBack={() => goTo("vault")} onSkip={() => commit({ targets: null }, "skills")} onNext={next} nextDisabled={!rows} />
    </div>
  );
}
