import { type DragEvent, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Layout } from "../components/Layout";
import { Icon } from "../components/ui/icons";
import { Button, ProviderChip } from "../components/ui/primitives";
import { SelectAllControl, useChecklistSelection } from "../components/Checklist";
import type { AdoptScanResult } from "../lib/types";

type Mode = "path" | "provider" | "discover" | "git";

/** Mirror of the server's DEFAULT_ADOPT_PATH — the folder Path mode opens to. */
const DEFAULT_ADOPT_PATH = "C:\\Github\\skills-repos";

/**
 * Above this many new skills, a scan does NOT pre-select everything — a
 * recursive scan of a repos root can return thousands, and auto-selecting
 * all of them (then adopting on one click) is never what the user wants.
 * Below it, pre-selecting all-new keeps the small flat-dir flow one-click.
 */
const AUTO_SELECT_MAX = 200;

/** Max rows painted at once. The full result set still drives counts, search,
 * and select-all; this only bounds the DOM so an 11k-row scan stays smooth. */
const RENDER_CAP = 400;

/**
 * Build the {name, path} import list from the picked set.
 *
 * Selection is keyed by absolute path (not name) so that the same skill name
 * found in multiple repos under a scanned parent folder stays independently
 * selectable. Sending explicit paths is also what makes nested/recursive
 * adoption work: the skill may live at `<repo>/skills/<name>`, not
 * `<source>/<name>`.
 */
function pickedItems(
  results: AdoptScanResult[] | null,
  picked: Set<string>,
): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (const r of results ?? []) {
    if (picked.has(r.path)) out.push({ name: r.name, path: r.path });
  }
  return out;
}

/** Directory portion of a result's rel_path, formatted as a dim breadcrumb. */
function relDir(r: AdoptScanResult): string {
  const rel = r.rel_path ?? "";
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  parts.pop(); // drop the skill folder itself
  return parts.join(" / ");
}

function relSegs(rel?: string): number {
  return (rel ?? "").split(/[\\/]+/).filter(Boolean).length;
}

/**
 * Collapse the (already content-deduped) rows to one per skill NAME — the
 * default "no duplicates" view. The vault holds a single skill per name, so
 * showing every variant is noise for most users. The representative is the
 * most-copied version (likely the canonical one), tie-broken by shallowest
 * path. `dup_count` becomes total copies across all variants; `variant_count`
 * records how many distinct contents share the name (>1 ⇒ real variants).
 */
function groupByName(rows: AdoptScanResult[]): AdoptScanResult[] {
  const groups = new Map<string, { rep: AdoptScanResult; copies: number; variants: number }>();
  for (const r of rows) {
    const copies = r.dup_count ?? 1;
    const g = groups.get(r.name);
    if (!g) {
      groups.set(r.name, { rep: r, copies, variants: 1 });
    } else {
      g.copies += copies;
      g.variants += 1;
      const repCopies = g.rep.dup_count ?? 1;
      if (copies > repCopies || (copies === repCopies && relSegs(r.rel_path) < relSegs(g.rep.rel_path))) {
        g.rep = r;
      }
    }
  }
  return [...groups.values()].map((g) => ({ ...g.rep, dup_count: g.copies, variant_count: g.variants }));
}

/** Toast text for an import result, noting any skipped (collision) skills. */
function adoptSummary(res: { imported: string[]; skipped: string[] }): string {
  const base = `Adopted ${res.imported.length} skill(s)`;
  const n = res.skipped?.length ?? 0;
  return n > 0 ? `${base} · ${n} skipped (name already taken)` : base;
}

export default function Adopt() {
  const [mode, setMode] = useState<Mode>("path");
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const items = e.dataTransfer?.items;
    if (items && items.length > 0) {
      const entry = (items[0] as any).webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        setMode("path");
        setDroppedPath(entry.fullPath || entry.name);
        return;
      }
    }
    const text = e.dataTransfer?.getData("text/plain");
    if (text) {
      setMode("path");
      setDroppedPath(text);
    }
  };

  const [droppedPath, setDroppedPath] = useState<string | null>(null);

  return (
    <Layout>
      <div
        className="sv-fade-in"
        style={{ maxWidth: 1320, margin: "0 auto", padding: "32px 28px", position: "relative" }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {dragOver && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "color-mix(in oklab, var(--accent) 8%, var(--bg))",
              border: "2px dashed var(--accent)",
              borderRadius: 12,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              zIndex: 20,
              pointerEvents: "none",
            }}
          >
            <span style={{ color: "var(--accent)" }}>{Icon.folder}</span>
            <span style={{ fontSize: 14, fontWeight: 500, color: "var(--accent)" }}>
              Drop folder to scan
            </span>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--ink)", letterSpacing: "-0.01em" }}>
            Adopt
          </h1>
          <code style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-4)" }}>
            $ sv adopt
          </code>
        </div>

        {/* Mode selector */}
        <div
          style={{
            display: "inline-flex",
            gap: 0,
            background: "var(--surface)",
            border: "0.5px solid var(--border-2)",
            borderRadius: 6,
            padding: 2,
            marginBottom: 20,
          }}
        >
          {([
            { id: "path", label: "Path" },
            { id: "provider", label: "Provider" },
            { id: "discover", label: "Discover" },
            { id: "git", label: "Git URL" },
          ] as Array<{ id: Mode; label: string }>).map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              style={{
                padding: "5px 14px",
                border: 0,
                background: mode === m.id ? "var(--bg)" : "transparent",
                color: mode === m.id ? "var(--ink)" : "var(--ink-3)",
                fontSize: 12.5,
                fontWeight: mode === m.id ? 500 : 400,
                borderRadius: 4,
                cursor: "pointer",
                boxShadow: mode === m.id ? "0 0 0 0.5px var(--border-2)" : "none",
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        {mode === "path" && <PathMode droppedPath={droppedPath} onDropConsumed={() => setDroppedPath(null)} />}
        {mode === "provider" && <ProviderMode />}
        {mode === "discover" && <DiscoverMode />}
        {mode === "git" && <GitUrlMode />}
      </div>
    </Layout>
  );
}

/* ── Path mode ─────────────────────────────────────────────────── */

function PathMode({ droppedPath, onDropConsumed }: { droppedPath: string | null; onDropConsumed: () => void }) {
  const qc = useQueryClient();
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: () => api.getConfig() });
  // Default to the user's repos checkout root, scanned recursively — that
  // folder holds many skill repos, each with skills nested under
  // `skills/<name>`, so a flat scan would find nothing.
  const [scanPath, setScanPath] = useState(DEFAULT_ADOPT_PATH);
  const [recursive, setRecursive] = useState(true);
  const [results, setResults] = useState<AdoptScanResult[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const providers = config?.providers ?? [];

  // Handle dropped path from parent
  if (droppedPath && droppedPath !== scanPath) {
    setScanPath(droppedPath);
    onDropConsumed();
  }

  const doScan = async () => {
    if (!scanPath.trim()) return;
    setScanning(true);
    try {
      const res = await api.scanForAdopt(scanPath.trim(), recursive);
      setResults(res.results);
      setTruncated(res.truncated);
      const newSkills = res.results.filter((r) => !r.already_in_vault);
      setPicked(new Set(newSkills.length <= AUTO_SELECT_MAX ? newSkills.map((r) => r.path) : []));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  };

  const doAdopt = async () => {
    if (picked.size === 0) return;
    setAdopting(true);
    try {
      const res = await api.importAdopt({
        source_path: scanPath.trim(),
        items: pickedItems(results, picked),
      });
      toast.success(adoptSummary(res));
      qc.invalidateQueries({ queryKey: ["skills"] });
      setResults(null);
      setPicked(new Set());
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Adopt failed");
    } finally {
      setAdopting(false);
    }
  };

  return (
    <div>
      {providers.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          {providers.map((p) => (
            <button
              key={p.id}
              onClick={() => setScanPath(p.path)}
              style={{ border: 0, background: "transparent", cursor: "pointer", padding: 0 }}
            >
              <ProviderChip slug={p.id} />
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={scanPath}
          onChange={(e) => setScanPath(e.target.value)}
          placeholder="Path to scan (or drag a folder onto this page)…"
          style={{
            flex: 1,
            height: 34,
            padding: "0 12px",
            background: "var(--surface)",
            border: "0.5px solid var(--border-2)",
            borderRadius: 6,
            fontFamily: "var(--mono)",
            fontSize: 12.5,
            color: "var(--ink)",
            outline: 0,
          }}
          onKeyDown={(e) => { if (e.key === "Enter") doScan(); }}
        />
        <Button kind="default" size="sm" icon={Icon.folder} onClick={() => setPickerOpen(true)}>
          Browse…
        </Button>
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--ink-2)", cursor: "pointer" }}>
          <input type="checkbox" checked={recursive} onChange={() => setRecursive(!recursive)} style={{ accentColor: "var(--accent)" }} />
          recursive
        </label>
        <Button kind="primary" size="sm" onClick={doScan} disabled={!scanPath.trim() || scanning}>
          {scanning ? "Scanning…" : "Scan"}
        </Button>
      </div>

      {results && <ResultsTable results={results} picked={picked} setPicked={setPicked} onAdopt={doAdopt} adopting={adopting} truncated={truncated} />}

      {pickerOpen && (
        <FolderPicker
          initialPath={scanPath.trim() || DEFAULT_ADOPT_PATH}
          onClose={() => setPickerOpen(false)}
          onPick={(p) => {
            setScanPath(p);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

/* ── Provider mode ──────────────────────────────────────────────── */

function ProviderMode() {
  const qc = useQueryClient();
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: () => api.getConfig() });
  const providers = config?.providers ?? [];
  const [selectedProvider, setSelectedProvider] = useState("");
  const [results, setResults] = useState<AdoptScanResult[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [adopting, setAdopting] = useState(false);

  const doScan = async (provId: string) => {
    const prov = providers.find((p) => p.id === provId);
    if (!prov) return;
    setScanning(true);
    try {
      const res = await api.scanForAdopt(prov.path, false);
      setResults(res.results);
      const newSkills = res.results.filter((r) => !r.already_in_vault);
      setPicked(new Set(newSkills.length <= AUTO_SELECT_MAX ? newSkills.map((r) => r.path) : []));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  };

  const doAdopt = async () => {
    if (picked.size === 0) return;
    const prov = providers.find((p) => p.id === selectedProvider);
    if (!prov) return;
    setAdopting(true);
    try {
      const res = await api.importAdopt({
        source_path: prov.path,
        items: pickedItems(results, picked),
        provider_id: selectedProvider,
      });
      toast.success(adoptSummary(res));
      qc.invalidateQueries({ queryKey: ["skills"] });
      setResults(null);
      setPicked(new Set());
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Adopt failed");
    } finally {
      setAdopting(false);
    }
  };

  if (providers.length === 0) {
    return (
      <div style={{ fontSize: 13, color: "var(--ink-3)", padding: "16px 0" }}>
        No providers configured. Add one in Settings first.
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <select
          value={selectedProvider}
          onChange={(e) => {
            setSelectedProvider(e.target.value);
            if (e.target.value) doScan(e.target.value);
          }}
          style={{
            height: 34,
            padding: "0 12px",
            background: "var(--surface)",
            border: "0.5px solid var(--border-2)",
            borderRadius: 6,
            fontSize: 13,
            color: "var(--ink)",
            minWidth: 180,
          }}
        >
          <option value="">Select a provider…</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.id}</option>
          ))}
        </select>
        {scanning && <span style={{ fontSize: 12, color: "var(--ink-3)", alignSelf: "center" }}>Scanning…</span>}
      </div>

      {results && <ResultsTable results={results} picked={picked} setPicked={setPicked} onAdopt={doAdopt} adopting={adopting} />}
    </div>
  );
}

/* ── Discover mode ──────────────────────────────────────────────── */

function DiscoverMode() {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["discover"],
    queryFn: () => api.discover(),
    enabled: true,
  });
  const [adopting, setAdopting] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const results = data?.results ?? [];
  const allNew = results.flatMap((r) => r.skills.filter((s) => s.status === "new"));
  const newKeys = allNew.map((s) => s.name);
  const sel = useChecklistSelection(newKeys, picked, setPicked);

  // Seed selection with every new skill once results first arrive.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || allNew.length === 0) return;
    seeded.current = true;
    setPicked(new Set(newKeys));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allNew.length]);

  const adoptSkill = async (skill: { name: string; path: string; provider_id: string }) => {
    setAdopting(skill.name);
    try {
      const parentPath = skill.path.replace(/[\\/][^\\/]+$/, "");
      await api.importAdopt({
        source_path: parentPath,
        skills: [skill.name],
        provider_id: skill.provider_id,
      });
      toast.success(`Adopted ${skill.name}`);
      qc.invalidateQueries({ queryKey: ["skills"] });
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Adopt failed");
    } finally {
      setAdopting(null);
    }
  };

  const adoptSelected = async () => {
    for (const skill of allNew) {
      if (picked.has(skill.name)) await adoptSkill(skill);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
          Scanning all providers for skills…
        </span>
        {allNew.length > 0 && (
          <>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--info)" }}>
              {allNew.length} new
            </span>
            <SelectAllControl selection={sel} />
            <span style={{ flex: 1 }} />
            <Button kind="primary" size="sm" onClick={adoptSelected} disabled={!!adopting || picked.size === 0}>
              Adopt {picked.size} selected
            </Button>
          </>
        )}
      </div>

      {isLoading ? (
        <div style={{ color: "var(--ink-3)", fontSize: 13 }}>Discovering…</div>
      ) : results.length === 0 ? (
        <div style={{ color: "var(--ink-3)", fontSize: 13, padding: "16px 0" }}>
          No skills found in any provider directory.
        </div>
      ) : (
        results.map((group) => (
          <div key={group.provider_id} style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <ProviderChip slug={group.provider_id} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)" }}>
                {group.skills.length} skill{group.skills.length === 1 ? "" : "s"}
              </span>
            </div>
            <div style={{ border: "0.5px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
              {group.skills.map((s) => {
                const selectable = s.status === "new";
                return (
                  <div
                    key={s.name}
                    onMouseDown={(e) => { if (selectable && e.shiftKey) e.preventDefault(); }}
                    onClick={(e) => { if (selectable) sel.onItemClick(s.name, e); }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "9px 14px",
                      borderBottom: "0.5px solid var(--border)",
                      cursor: selectable ? "pointer" : "default",
                      userSelect: "none",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectable && picked.has(s.name)}
                      disabled={!selectable}
                      readOnly
                      style={{ accentColor: "var(--accent)", visibility: selectable ? "visible" : "hidden" }}
                    />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--ink)", flex: 1 }}>
                      {s.name}
                    </span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-4)" }}>
                      {s.file_count} files
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 10.5,
                        fontWeight: 500,
                        color: s.status === "new" ? "var(--info)" : s.status === "synced" ? "var(--ok)" : "var(--warn)",
                      }}
                    >
                      {s.status}
                    </span>
                    {s.status === "new" && (
                      <Button kind="primary" size="sm" onClick={(e) => { e.stopPropagation(); adoptSkill(s); }} disabled={adopting === s.name}>
                        {adopting === s.name ? "…" : "Adopt"}
                      </Button>
                    )}
                    {s.status === "diverged" && (
                      <Button kind="ghost" size="sm" onClick={(e) => { e.stopPropagation(); adoptSkill(s); }} disabled={adopting === s.name}>
                        Pull
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/* ── Git URL mode ──────────────────────────────────────────────── */

function GitUrlMode() {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [cloning, setCloning] = useState(false);
  const [tmpPath, setTmpPath] = useState<string | null>(null);
  const [results, setResults] = useState<AdoptScanResult[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adopting, setAdopting] = useState(false);

  const doClone = async () => {
    if (!url.trim()) return;
    setCloning(true);
    try {
      const res = await api.adoptClone({ url: url.trim(), branch: branch.trim() || undefined });
      setTmpPath(res.tmp_path);
      setResults(res.results);
      setTruncated(Boolean(res.truncated));
      const newSkills = res.results.filter((r: AdoptScanResult) => !r.already_in_vault);
      setPicked(new Set(newSkills.length <= AUTO_SELECT_MAX ? newSkills.map((r: AdoptScanResult) => r.path) : []));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Clone failed");
    } finally {
      setCloning(false);
    }
  };

  const doAdopt = async () => {
    if (picked.size === 0 || !tmpPath) return;
    setAdopting(true);
    try {
      const res = await api.importAdopt({
        source_path: tmpPath,
        items: pickedItems(results, picked),
      });
      toast.success(adoptSummary(res));
      qc.invalidateQueries({ queryKey: ["skills"] });
      await api.adoptCleanup({ tmp_path: tmpPath }).catch(() => {});
      setResults(null);
      setPicked(new Set());
      setTmpPath(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Adopt failed");
    } finally {
      setAdopting(false);
    }
  };

  const doCancel = async () => {
    if (tmpPath) {
      await api.adoptCleanup({ tmp_path: tmpPath }).catch(() => {});
    }
    setResults(null);
    setPicked(new Set());
    setTmpPath(null);
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo.git"
          style={{
            flex: 1,
            minWidth: 300,
            height: 34,
            padding: "0 12px",
            background: "var(--surface)",
            border: "0.5px solid var(--border-2)",
            borderRadius: 6,
            fontFamily: "var(--mono)",
            fontSize: 12.5,
            color: "var(--ink)",
            outline: 0,
          }}
          onKeyDown={(e) => { if (e.key === "Enter") doClone(); }}
        />
        <input
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="branch (optional)"
          style={{
            width: 140,
            height: 34,
            padding: "0 12px",
            background: "var(--surface)",
            border: "0.5px solid var(--border-2)",
            borderRadius: 6,
            fontFamily: "var(--mono)",
            fontSize: 12.5,
            color: "var(--ink)",
            outline: 0,
          }}
        />
        <Button kind="primary" size="sm" onClick={doClone} disabled={!url.trim() || cloning}>
          {cloning ? "Cloning…" : "Clone & scan"}
        </Button>
      </div>

      {results && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <Button kind="ghost" size="sm" onClick={doCancel}>
              Cancel
            </Button>
          </div>
          <ResultsTable results={results} picked={picked} setPicked={setPicked} onAdopt={doAdopt} adopting={adopting} truncated={truncated} />
        </>
      )}
    </div>
  );
}

/* ── Shared results table ───────────────────────────────────────── */

function ResultsTable({
  results,
  picked,
  setPicked,
  onAdopt,
  adopting,
  truncated = false,
}: {
  results: AdoptScanResult[];
  picked: Set<string>;
  setPicked: (s: Set<string>) => void;
  onAdopt: () => void;
  adopting: boolean;
  truncated?: boolean;
}) {
  const [query, setQuery] = useState("");
  // Group to one row per name by default — the "no duplicates" view. Toggle
  // off to see every source/variant (each independently selectable).
  const [collapse, setCollapse] = useState(true);

  const base = collapse ? groupByName(results) : results;

  // Filter the visible rows by a case-insensitive substring match on the
  // skill name, description, OR source path — so search can narrow by what
  // a skill does, or by which repo/folder it came from.
  const q = query.trim().toLowerCase();
  const filtered = q
    ? base.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.description ?? "").toLowerCase().includes(q) ||
          (r.rel_path ?? "").toLowerCase().includes(q),
      )
    : base;

  const newResults = base.filter((r) => !r.already_in_vault);
  // Count how many times each name appears in the current view — only
  // meaningful when expanded, where same-name-different-content rows coexist.
  const nameCounts = new Map<string, number>();
  for (const r of base) nameCounts.set(r.name, (nameCounts.get(r.name) ?? 0) + 1);

  // Selection is keyed by absolute PATH (each row is unique) — not name —
  // so duplicate-named rows are independently selectable. Select-all targets
  // exactly the new, currently-shown rows, so a search narrows the picks.
  const selectableKeys = filtered.filter((r) => !r.already_in_vault).map((r) => r.path);
  const sel = useChecklistSelection(selectableKeys, picked, setPicked);

  const toggleCollapse = () => {
    setCollapse((c) => !c);
    setPicked(new Set()); // selection keys differ between views; reset to avoid stragglers
  };

  // Only paint the first RENDER_CAP filtered rows — the DOM can't smoothly
  // hold thousands. Counts, search, and select-all use the full set above.
  const visible = filtered.slice(0, RENDER_CAP);
  const hiddenCount = filtered.length - visible.length;

  // How many distinct names the current selection covers — i.e. how many
  // skills will actually import (the rest collide and get skipped).
  const pickedNames = new Set<string>();
  for (const r of results) if (picked.has(r.path)) pickedNames.add(r.name);
  const collisions = picked.size - pickedNames.size;

  return (
    <div>
      {truncated && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 10,
            padding: "8px 12px",
            background: "color-mix(in oklab, var(--warn) 10%, var(--bg))",
            border: "0.5px solid var(--warn)",
            borderRadius: 6,
            fontSize: 12,
            color: "var(--ink-2)",
          }}
        >
          <span style={{ color: "var(--warn)", display: "flex" }}>{Icon.warn}</span>
          Showing the first {results.length} skills — the scan hit its limit. Point at a more
          specific folder to see the rest.
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)" }}>
          {base.length} {collapse ? "skills" : "rows"} · {newResults.length} new
          {collapse && results.length !== base.length && ` · ${results.length} sources`}
          {q && ` · ${filtered.length} shown`}
        </span>
        {selectableKeys.length > 0 && (
          <SelectAllControl selection={sel} />
        )}
        <label
          title="Group identical/same-named skills into one row"
          style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--ink-3)", cursor: "pointer", userSelect: "none" }}
        >
          <input type="checkbox" checked={collapse} onChange={toggleCollapse} style={{ accentColor: "var(--accent)", cursor: "pointer" }} />
          Group duplicates
        </label>
        <span style={{ flex: 1 }} />
        <div style={{ position: "relative", width: 260 }}>
          <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--ink-4)", pointerEvents: "none" }}>
            {Icon.search}
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, description, or repo…"
            style={{
              width: "100%",
              height: 30,
              padding: "0 26px 0 28px",
              background: "var(--surface)",
              border: "0.5px solid var(--border-2)",
              borderRadius: 6,
              fontSize: 12.5,
              color: "var(--ink)",
              outline: 0,
            }}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              title="Clear search"
              style={{
                position: "absolute",
                right: 6,
                top: "50%",
                transform: "translateY(-50%)",
                border: 0,
                background: "transparent",
                color: "var(--ink-4)",
                cursor: "pointer",
                display: "flex",
                padding: 2,
              }}
            >
              {Icon.x}
            </button>
          )}
        </div>
        {picked.size > 0 && (
          <Button kind="primary" size="sm" onClick={onAdopt} disabled={adopting}>
            {adopting ? "Adopting…" : `Adopt ${pickedNames.size}`}
          </Button>
        )}
      </div>

      {collisions > 0 && (
        <div style={{ fontSize: 11.5, color: "var(--warn)", marginBottom: 8 }}>
          {collisions} selected {collisions === 1 ? "row shares a name" : "rows share names"} with another —
          only one copy of each name can be adopted; the rest will be skipped.
        </div>
      )}

      <div style={{ border: "0.5px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
        {filtered.length === 0 ? (
          <div style={{ padding: "14px", fontSize: 12.5, color: "var(--ink-3)" }}>
            No skills match “{query}”.
          </div>
        ) : (
          visible.map((r) => {
            const inVault = r.already_in_vault;
            const dir = relDir(r);
            // Expanded view: this name also appears with DIFFERENT content elsewhere.
            const sameNameOther = !collapse && (nameCounts.get(r.name) ?? 0) > 1;
            const copies = r.dup_count ?? 1;
            const variants = r.variant_count ?? 1;
            return (
              <div
                key={r.path}
                onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
                onClick={(e) => { if (!inVault) sel.onItemClick(r.path, e); }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 14px",
                  borderBottom: "0.5px solid var(--border)",
                  cursor: inVault ? "default" : "pointer",
                  opacity: inVault ? 0.5 : 1,
                  userSelect: "none",
                }}
              >
                <input
                  type="checkbox"
                  checked={picked.has(r.path)}
                  disabled={inVault}
                  readOnly
                  style={{ accentColor: "var(--accent)", flexShrink: 0 }}
                />
                <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--ink)", width: 200, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.name}
                </span>
                {dir && (
                  <span
                    title={r.rel_path}
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      color: "var(--ink-4)",
                      width: 220,
                      flexShrink: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {dir}
                  </span>
                )}
                <span
                  title={r.description || undefined}
                  style={{
                    fontSize: 12,
                    color: "var(--ink-3)",
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.description || <span style={{ color: "var(--ink-4)", fontStyle: "italic" }}>no description</span>}
                </span>
                {collapse && variants > 1 && (
                  <span title={`${variants} different versions share this name — showing the most common`} style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--warn)", flexShrink: 0 }}>
                    {variants} variants
                  </span>
                )}
                {copies > 1 && (
                  <span title={`Found in ${copies} ${copies === 1 ? "location" : "locations"} (identical copies)`} style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-4)", flexShrink: 0 }}>
                    ×{copies}
                  </span>
                )}
                {sameNameOther && !inVault && (
                  <span title="This name also appears with different content in another row" style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--warn)", flexShrink: 0 }}>
                    dup
                  </span>
                )}
                <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-4)", flexShrink: 0 }}>
                  {r.file_count} files
                </span>
                {r.has_skill_md && (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ok)", flexShrink: 0 }}>SKILL.md</span>
                )}
                {inVault && (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--neutral)", flexShrink: 0 }}>in vault</span>
                )}
              </div>
            );
          })
        )}
        {hiddenCount > 0 && (
          <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--ink-3)", background: "var(--surface)" }}>
            +{hiddenCount} more not shown — search to narrow the list. Counts and “Select all”
            still cover all {filtered.length}.
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Folder picker ──────────────────────────────────────────────── */

/**
 * Server-backed directory browser. The app runs in a browser, so it can't
 * use a native OS folder dialog — instead it navigates the server's
 * filesystem via `/api/adopt/browse`. The user drills into subfolders,
 * goes up to the parent, or types a path directly, then confirms with
 * "Select this folder".
 */
function FolderPicker({
  initialPath,
  onPick,
  onClose,
}: {
  initialPath: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState(initialPath);
  const [parent, setParent] = useState<string | null>(null);
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [edit, setEdit] = useState(initialPath);

  const load = async (p?: string) => {
    setLoading(true);
    try {
      const res = await api.adoptBrowse(p);
      setCurrent(res.path);
      setEdit(res.path);
      setParent(res.parent);
      setDirs(res.dirs);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Cannot open folder");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(initialPath);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div
        style={{ position: "absolute", inset: 0, background: "oklch(0.2 0.01 60 / 0.4)", backdropFilter: "blur(2px)" }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal
        style={{
          position: "relative",
          width: 560,
          maxWidth: "92%",
          maxHeight: "80vh",
          background: "var(--bg)",
          border: "0.5px solid var(--border-2)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 10px 40px oklch(0.2 0.01 60 / 0.2)",
        }}
      >
        <header
          style={{
            height: 52,
            flexShrink: 0,
            borderBottom: "0.5px solid var(--border)",
            padding: "0 18px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>Choose a folder</span>
          <Button kind="ghost" size="sm" icon={Icon.x} onClick={onClose}>Close</Button>
        </header>

        <div style={{ padding: 14, display: "flex", gap: 8, borderBottom: "0.5px solid var(--border)" }}>
          <Button
            kind="default"
            size="sm"
            onClick={() => parent && load(parent)}
            disabled={!parent || loading}
            title="Up to parent folder"
          >
            ↑ Up
          </Button>
          <input
            value={edit}
            onChange={(e) => setEdit(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") load(edit.trim()); }}
            placeholder="Type a path and press Enter…"
            style={{
              flex: 1,
              height: 30,
              padding: "0 10px",
              background: "var(--surface)",
              border: "0.5px solid var(--border-2)",
              borderRadius: 6,
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "var(--ink)",
              outline: 0,
            }}
          />
          <Button kind="default" size="sm" onClick={() => load(edit.trim())} disabled={loading}>
            Go
          </Button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", minHeight: 160 }}>
          {loading ? (
            <div style={{ padding: 14, fontSize: 12.5, color: "var(--ink-3)" }}>Loading…</div>
          ) : dirs.length === 0 ? (
            <div style={{ padding: 14, fontSize: 12.5, color: "var(--ink-3)" }}>No subfolders here.</div>
          ) : (
            dirs.map((d) => (
              <button
                key={d.path}
                onClick={() => load(d.path)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  width: "100%",
                  padding: "8px 16px",
                  border: 0,
                  borderBottom: "0.5px solid var(--border)",
                  background: "transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  color: "var(--ink)",
                }}
              >
                <span style={{ color: "var(--ink-4)", display: "flex" }}>{Icon.folder}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, flex: 1 }}>{d.name}</span>
                <span style={{ color: "var(--ink-4)", display: "flex" }}>{Icon.chevron}</span>
              </button>
            ))
          )}
        </div>

        <footer
          style={{
            padding: "12px 18px",
            borderTop: "0.5px solid var(--border)",
            display: "flex",
            gap: 8,
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <code style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {current}
          </code>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <Button kind="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button kind="primary" size="sm" onClick={() => onPick(current)} disabled={loading}>
              Select this folder
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
