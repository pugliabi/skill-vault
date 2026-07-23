import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useParams, useSearch } from "wouter";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Layout } from "../components/Layout";
import { Icon } from "../components/ui/icons";
import {
  Button,
  DesktopBadge,
  KBD,
  ProviderChip,
  StatusBadge,
} from "../components/ui/primitives";
import { SkillSidePanel } from "../components/SkillSidePanel";
import { SkillDetailOverlay } from "../components/SkillDetailOverlay";
import { NewSkillDrawer } from "../components/NewSkillDrawer";
import { PushDrawer } from "../components/PushDrawer";
import { BulkActionBar } from "../components/BulkActionBar";
import { SkillCardView } from "../components/SkillCardView";
import { SkillGroupedView } from "../components/SkillGroupedView";
import { SkillMatrixView } from "../components/SkillMatrixView";
import { FilterBar, type ActiveFilters } from "../components/FilterBar";
import { AutoTagDialog } from "../components/AutoTagDialog";
import { HealthDialog } from "../components/HealthDialog";
import { UpdateDialog } from "../components/UpdateDialog";
import { TagChips } from "../components/TagChips";
import { loadPrefs, savePrefs, type SavedView, type SkillsPreferences } from "../lib/preferences";
import type { Skill } from "../lib/types";

type Filter =
  | "all"
  | "production"
  | "staging"
  | "stale"
  | "vault-only"
  | "missing"
  | "desktop-outdated";

export default function Skills() {
  const params = useParams<{ name?: string }>();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const searchRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.listSkills(),
  });
  const skills = data?.skills ?? [];

  const { data: configData } = useQuery({
    queryKey: ["config"],
    queryFn: () => api.getConfig(),
  });

  // OpenClaw (WSL) availability — gates the bulk "Export to OpenClaw" action.
  const { data: openclaw } = useQuery({
    queryKey: ["openclaw-status"],
    queryFn: () => api.openclawStatus(),
    staleTime: 30000,
  });

  const urlFilter = searchParams.get("filter") as Filter | null;
  const [filter, setFilter] = useState<Filter>(
    urlFilter && ["all", "production", "staging", "stale", "vault-only", "missing"].includes(urlFilter)
      ? urlFilter
      : "all"
  );
  const [query, setQuery] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [autoTagOpen, setAutoTagOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [bulkPushOpen, setBulkPushOpen] = useState(false);
  // Update-from-source dialog: null = closed, [] = check all adopted,
  // non-empty = check exactly these skills.
  const [updateScope, setUpdateScope] = useState<string[] | null>(null);
  const [panelEditorDirty, setPanelEditorDirty] = useState(false);
  const [overlayEditorDirty, setOverlayEditorDirty] = useState(false);

  // New state: preferences, multi-select, advanced filters
  const [prefs, setPrefs] = useState<SkillsPreferences>(loadPrefs);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<string | null>(null);
  const activeFilters = prefs.filters;

  const updatePrefs = (patch: Partial<SkillsPreferences>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(next);
  };

  const setActiveFilters = (filters: ActiveFilters) => {
    updatePrefs({ filters });
  };

  // Saved views — named snapshots of the filter/sort/layout state.
  const applyView = (v: SavedView) => {
    setFilter(v.filter);
    updatePrefs({
      filters: v.filters,
      sortBy: v.sortBy,
      sortDir: v.sortDir,
      layout: v.layout,
      groupBy: v.groupBy,
    });
  };
  const saveCurrentView = () => {
    const name = window.prompt("Name this view:")?.trim();
    if (!name) return;
    const view: SavedView = {
      name,
      filter,
      filters: activeFilters,
      sortBy: prefs.sortBy,
      sortDir: prefs.sortDir,
      layout: prefs.layout,
      groupBy: prefs.groupBy,
    };
    updatePrefs({ savedViews: [...prefs.savedViews.filter((v) => v.name !== name), view] });
  };
  const deleteView = (name: string) => {
    updatePrefs({ savedViews: prefs.savedViews.filter((v) => v.name !== name) });
  };

  // Deep-link support: `/skills?target=cursor&targetState=missing` (e.g. from
  // the Dashboard provider health bars) applies the target filter once on mount.
  const appliedUrlTarget = useRef(false);
  useEffect(() => {
    if (appliedUrlTarget.current) return;
    const t = searchParams.get("target");
    if (!t) return;
    appliedUrlTarget.current = true;
    const ts = searchParams.get("targetState") as ActiveFilters["targetState"] | null;
    updatePrefs({
      filters: { ...prefs.filters, target: t, targetState: ts ?? "configured" },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive unique tags from all skills
  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const sk of skills) for (const t of sk.tags) s.add(t);
    return [...s].sort();
  }, [skills]);

  const providerIds = useMemo(
    () => (configData?.providers ?? []).map((p) => p.id),
    [configData],
  );

  // Full-text search over SKILL.md bodies — debounced, unioned into the
  // name/description filter so "the skill that mentions ffmpeg" is findable.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(t);
  }, [query]);
  const { data: searchData } = useQuery({
    queryKey: ["skill-search", debouncedQuery],
    queryFn: () => api.searchSkills(debouncedQuery),
    enabled: debouncedQuery.trim().length >= 2,
    staleTime: 10000,
  });
  const fullTextNames = useMemo(
    () => new Set((searchData?.matches ?? []).map((m) => m.name)),
    [searchData],
  );

  // Self-heal persisted filters: drop a `target` (or advanced `providers`
  // entries) for a provider that no longer exists — e.g. after removing
  // openclaw — so a stale value can't sit invisibly filtering the list to 0.
  useEffect(() => {
    if (!configData) return;
    const staleTarget =
      !!activeFilters.target && !providerIds.includes(activeFilters.target);
    const cleanProviders = activeFilters.providers?.filter((p) =>
      providerIds.includes(p),
    );
    const providersChanged =
      !!activeFilters.providers &&
      cleanProviders!.length !== activeFilters.providers.length;
    if (staleTarget || providersChanged) {
      setActiveFilters({
        ...activeFilters,
        ...(staleTarget ? { target: undefined, targetState: undefined } : {}),
        ...(providersChanged
          ? { providers: cleanProviders && cleanProviders.length ? cleanProviders : undefined }
          : {}),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configData, providerIds]);

  const filtered = useMemo(() => {
    return skills.filter((s) => {
      if (filter === "production" && s.stage !== "production") return false;
      if (filter === "staging" && s.stage !== "staging") return false;
      if (filter === "stale" && s.status !== "stale") return false;
      if (filter === "vault-only" && s.status !== "vault-only") return false;
      if (filter === "missing" && s.status !== "missing") return false;
      if (filter === "desktop-outdated" && s.desktop_status !== "outdated")
        return false;
      if (query) {
        const ql = query.toLowerCase();
        const localMatch =
          s.name.toLowerCase().includes(ql) ||
          s.description.toLowerCase().includes(ql);
        // fullTextNames comes from the (debounced) body search — union it so
        // body-only hits still show without losing instant name/desc filtering.
        if (!localMatch && !fullTextNames.has(s.name)) return false;
      }
      // Advanced filters
      if (activeFilters.providers && activeFilters.providers.length > 0) {
        if (!s.targets.some((t) => activeFilters.providers!.includes(t))) return false;
      }
      if (activeFilters.tags && activeFilters.tags.length > 0) {
        if (!s.tags.some((t) => activeFilters.tags!.includes(t))) return false;
      }
      if (activeFilters.hasSkillMd && !s.has_skill_md) return false;
      if (activeFilters.minFiles != null && s.file_count <= activeFilters.minFiles) return false;
      // Target filter: "configured" matches the skill's targets list; the
      // other states match the on-disk sync state in that provider.
      // Guard on providerIds so a persisted target for a provider that no
      // longer exists (e.g. a removed openclaw) can't silently filter the
      // whole list to 0 while the dropdown reads "any". Only applied once
      // config has loaded (providerIds non-empty).
      if (activeFilters.target && providerIds.includes(activeFilters.target)) {
        const t = activeFilters.target;
        const state = activeFilters.targetState ?? "configured";
        if (state === "configured") {
          if (!s.targets.includes(t)) return false;
        } else if (s.target_status[t] !== state) {
          return false;
        }
      }
      return true;
    });
  }, [skills, filter, query, activeFilters, providerIds, fullTextNames]);

  // Sorting
  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = prefs.sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      switch (prefs.sortBy) {
        case "name":
          return dir * a.name.localeCompare(b.name);
        case "modified":
          return dir * a.modified_at.localeCompare(b.modified_at);
        case "created":
          return dir * a.created_at.localeCompare(b.created_at);
        case "file_count":
          return dir * (a.file_count - b.file_count);
        case "status":
          return dir * a.status.localeCompare(b.status);
        default:
          return 0;
      }
    });
    return arr;
  }, [filtered, prefs.sortBy, prefs.sortDir]);

  // URL model
  const overlayName = params.name ? decodeURIComponent(params.name) : undefined;
  const previewName = searchParams.get("preview")
    ? decodeURIComponent(searchParams.get("preview")!)
    : undefined;
  const activeName = overlayName ?? previewName;

  const activeSkill = useMemo(
    () => skills.find((s) => s.name === activeName),
    [skills, activeName],
  );

  useEffect(() => {
    if (!activeName) return;
    if (filtered.find((s) => s.name === activeName)) return;
    if (!filtered[0]) return;
    if (overlayName) {
      navigate(`/skills/${encodeURIComponent(filtered[0].name)}`, { replace: true });
    } else if (previewName) {
      navigate(`/skills?preview=${encodeURIComponent(filtered[0].name)}`, { replace: true });
    }
  }, [filtered, activeName, overlayName, previewName, navigate]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !isInput) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }

      if (isInput) return;

      if ((e.key === "j" || e.key === "k") && sorted.length > 0) {
        e.preventDefault();
        const currentIdx = sorted.findIndex((s) => s.name === activeName);
        let nextIdx = currentIdx === -1 ? 0 : currentIdx;
        if (e.key === "j") nextIdx = Math.min(currentIdx + 1, sorted.length - 1);
        if (e.key === "k") nextIdx = Math.max(currentIdx - 1, 0);
        if (nextIdx !== currentIdx && sorted[nextIdx]) {
          const dirty = overlayName ? overlayEditorDirty : panelEditorDirty;
          if (dirty && !window.confirm("You have unsaved changes. Discard them?")) return;
          const next = encodeURIComponent(sorted[nextIdx].name);
          if (overlayName) {
            navigate(`/skills/${next}`);
          } else if (previewName) {
            navigate(`/skills?preview=${next}`);
          } else {
            navigate(`/skills/${next}`);
          }
        }
      }

      // Escape clears selection
      if (e.key === "Escape" && selected.size > 0) {
        setSelected(new Set());
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [sorted, activeName, overlayName, previewName, overlayEditorDirty, panelEditorDirty, navigate, selected]);

  // Multi-select helpers
  const handleToggleSelect = (name: string, e?: React.MouseEvent) => {
    const next = new Set(selected);
    if (e?.shiftKey && lastClicked) {
      const list = sorted.map((s) => s.name);
      const a = list.indexOf(lastClicked);
      const b = list.indexOf(name);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) next.add(list[i]);
      }
    } else if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }
    setLastClicked(name);
    setSelected(next);
  };

  const handleSelectAll = () => {
    if (selected.size === sorted.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sorted.map((s) => s.name)));
    }
  };

  // Add existing skill
  const addExisting = useMutation({
    mutationFn: (path: string) => api.addExistingSkill({ path }),
    onSuccess: (skill) => {
      toast.success(`Added ${skill.name}`);
      qc.invalidateQueries({ queryKey: ["skills"] });
      navigate(`/skills/${encodeURIComponent(skill.name)}`);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to add skill");
    },
  });

  const handleAddExisting = () => {
    const path = window.prompt("Path to an existing skill folder:");
    if (!path?.trim()) return;
    addExisting.mutate(path.trim());
  };

  // Bulk actions
  const selectedSkills = useMemo(
    () => skills.filter((s) => selected.has(s.name)),
    [skills, selected],
  );

  const handleBulkPush = () => {
    if (selected.size === 0) return;
    setBulkPushOpen(true);
  };

  const handleBulkPull = async () => {
    if (selected.size === 0) return;
    const eligible = selectedSkills.filter((s) => s.targets.length > 0);
    const skipped = selectedSkills.length - eligible.length;
    if (eligible.length === 0) {
      toast.error("None of the selected skills have a target to pull from");
      return;
    }
    const results = await Promise.allSettled(
      eligible.map((s) => api.pull({ skill: s.name, provider_id: s.targets[0] })),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.length - ok;
    if (ok > 0) toast.success(`Pulled ${ok} skill${ok === 1 ? "" : "s"}`);
    if (fail > 0) toast.error(`${fail} pull${fail === 1 ? "" : "s"} failed`);
    if (skipped > 0) toast.info(`${skipped} skipped (no target)`);
    qc.invalidateQueries({ queryKey: ["skills"] });
  };

  const handleBulkPromote = async () => {
    if (selected.size === 0) return;
    const eligible = selectedSkills.filter((s) => s.stage === "staging");
    const skipped = selectedSkills.length - eligible.length;
    if (eligible.length === 0) {
      toast.info("All selected skills are already in production");
      return;
    }
    const results = await Promise.allSettled(
      eligible.map((s) => api.updateSkill(s.name, { stage: "production" })),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.length - ok;
    if (ok > 0) toast.success(`Promoted ${ok} skill${ok === 1 ? "" : "s"}`);
    if (fail > 0) toast.error(`${fail} promotion${fail === 1 ? "" : "s"} failed`);
    if (skipped > 0) toast.info(`${skipped} skipped (already production)`);
    qc.invalidateQueries({ queryKey: ["skills"] });
  };

  const handleBulkDemote = async () => {
    if (selected.size === 0) return;
    const eligible = selectedSkills.filter((s) => s.stage === "production");
    const skipped = selectedSkills.length - eligible.length;
    if (eligible.length === 0) {
      toast.info("All selected skills are already in staging");
      return;
    }
    const results = await Promise.allSettled(
      eligible.map((s) => api.updateSkill(s.name, { stage: "staging" })),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.length - ok;
    if (ok > 0) toast.success(`Demoted ${ok} skill${ok === 1 ? "" : "s"}`);
    if (fail > 0) toast.error(`${fail} demotion${fail === 1 ? "" : "s"} failed`);
    if (skipped > 0) toast.info(`${skipped} skipped (already staging)`);
    qc.invalidateQueries({ queryKey: ["skills"] });
  };

  const handleBulkAddProvider = async (providerId: string) => {
    if (selected.size === 0) return;
    const eligible = selectedSkills.filter((s) => !s.targets.includes(providerId));
    const skipped = selectedSkills.length - eligible.length;
    if (eligible.length === 0) {
      toast.info(`All selected skills already target ${providerId}`);
      return;
    }
    const results = await Promise.allSettled(
      eligible.map((s) =>
        api.updateSkill(s.name, {
          targets: [...new Set([...s.targets, providerId])],
        }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.length - ok;
    if (ok > 0)
      toast.success(`Added provider ${providerId} to ${ok} skill${ok === 1 ? "" : "s"}`);
    if (fail > 0) toast.error(`${fail} update${fail === 1 ? "" : "s"} failed`);
    if (skipped > 0) toast.info(`${skipped} skipped (already targets ${providerId})`);
    qc.invalidateQueries({ queryKey: ["skills"] });
  };

  const handleBulkAddAllProviders = async () => {
    if (selected.size === 0 || providerIds.length === 0) return;
    const eligible = selectedSkills.filter(
      (s) => !providerIds.every((p) => s.targets.includes(p)),
    );
    if (eligible.length === 0) {
      toast.info("All selected skills already target every provider");
      return;
    }
    const results = await Promise.allSettled(
      eligible.map((s) =>
        api.updateSkill(s.name, {
          targets: [...new Set([...s.targets, ...providerIds])],
        }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.length - ok;
    if (ok > 0)
      toast.success(`Added all ${providerIds.length} providers to ${ok} skill${ok === 1 ? "" : "s"}`);
    if (fail > 0) toast.error(`${fail} update${fail === 1 ? "" : "s"} failed`);
    qc.invalidateQueries({ queryKey: ["skills"] });
  };

  const handleBulkZip = async () => {
    if (selected.size === 0) return;
    const names = [...selected];
    try {
      const r = await api.zipSkills(names);
      if (r.zips.length > 0) {
        const first = r.zips[0].path;
        const dir = first.replace(/[\\/][^\\/]+$/, "");
        toast.success(`Zipped ${r.zips.length} skill${r.zips.length === 1 ? "" : "s"} → ${dir}`);
      }
      if (r.failed.length > 0) {
        toast.error(`${r.failed.length} zip${r.failed.length === 1 ? "" : "s"} failed`);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Zip failed");
    }
  };

  const handleBulkExportOpenClaw = async () => {
    if (selected.size === 0) return;
    const names = [...selected];
    if (
      !window.confirm(
        `Install ${names.length} skill${names.length === 1 ? "" : "s"} into the OpenClaw agent (WSL)? This runs \`openclaw skills install\` for each.`,
      )
    ) {
      return;
    }
    // Sequential — each export spawns wsl.exe + tar; don't stampede the gateway.
    const id = toast.loading(`Exporting to OpenClaw… 0/${names.length}`);
    let ok = 0;
    let fail = 0;
    for (const n of names) {
      try {
        await api.exportToOpenClaw(n, { global: true, force: true });
        ok++;
      } catch {
        fail++;
      }
      toast.loading(`Exporting to OpenClaw… ${ok + fail}/${names.length}`, { id });
    }
    if (fail === 0) {
      toast.success(`Installed ${ok} skill${ok === 1 ? "" : "s"} into OpenClaw`, { id });
    } else {
      toast.error(`OpenClaw: ${ok} installed, ${fail} failed`, { id });
    }
    qc.invalidateQueries({ queryKey: ["openclaw-status"] });
  };

  const handleBulkRemove = async () => {
    if (selected.size === 0) return;
    const count = selected.size;
    if (!window.confirm(`Remove ${count} skill${count === 1 ? "" : "s"}? This cannot be undone.`)) {
      return;
    }
    const names = [...selected];
    const results = await Promise.allSettled(names.map((n) => api.removeSkill(n)));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.length - ok;
    if (ok > 0) toast.success(`Removed ${ok} skill${ok === 1 ? "" : "s"}`);
    if (fail > 0) toast.error(`${fail} removal${fail === 1 ? "" : "s"} failed`);
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ["skills"] });
  };

  // Matrix view actions — push a single cell, or a whole provider column.
  const pushOne = async (skill: string, provider_id: string) => {
    try {
      await api.push({ skill, provider_id, method: "auto" });
      toast.success(`Pushed ${skill} → ${provider_id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Push failed");
    }
    qc.invalidateQueries({ queryKey: ["skills"] });
  };

  const pushColumn = async (provider_id: string) => {
    const eligible = sorted.filter((s) => {
      const st = s.target_status[provider_id];
      return st === "missing" || st === "stale" || (s.targets.includes(provider_id) && !st);
    });
    if (eligible.length === 0) {
      toast.info(`Nothing missing or stale for ${provider_id}`);
      return;
    }
    const results = await Promise.allSettled(
      eligible.map((s) => api.push({ skill: s.name, provider_id, method: "auto" })),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.length - ok;
    if (ok > 0) toast.success(`Pushed ${ok} → ${provider_id}`);
    if (fail > 0) toast.error(`${fail} push${fail === 1 ? "" : "es"} failed`);
    qc.invalidateQueries({ queryKey: ["skills"] });
  };

  const anySelected = selected.size > 0;

  return (
    <Layout>
      <div className="sv-fade-in" style={{ display: "flex", height: "100%" }}>
        {/* List pane */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            borderRight: previewName ? "0.5px solid var(--border)" : undefined,
          }}
        >
          {/* Toolbar */}
          <div
            style={{
              padding: "14px 22px 12px",
              borderBottom: "0.5px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h1
                style={{
                  margin: 0,
                  fontSize: 18,
                  fontWeight: 600,
                  color: "var(--ink)",
                  letterSpacing: "-0.01em",
                }}
              >
                Skills
              </h1>
              <span
                style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-3)" }}
              >
                {sorted.length}/{skills.length}
              </span>
              <span style={{ flex: 1 }} />
              <Button
                kind="primary"
                size="sm"
                icon={Icon.plus}
                onClick={() => setNewOpen(true)}
              >
                New
              </Button>
              <Button
                kind="ghost"
                size="sm"
                icon={Icon.folder}
                onClick={handleAddExisting}
                disabled={addExisting.isPending}
              >
                Add existing
              </Button>
              <Button
                kind="ghost"
                size="sm"
                icon={Icon.tag}
                onClick={() => setAutoTagOpen(true)}
              >
                Auto-tag
              </Button>
              <Button
                kind="ghost"
                size="sm"
                icon={Icon.warn}
                onClick={() => setHealthOpen(true)}
              >
                Health
              </Button>
              <Button
                kind="ghost"
                size="sm"
                icon={Icon.pull}
                onClick={() => setUpdateScope([])}
                title="Check every adopted skill against its source for upstream changes"
              >
                Updates
              </Button>
              <Button
                kind="ghost"
                size="sm"
                icon={Icon.download}
                onClick={() => navigate("/adopt")}
              >
                Adopt
              </Button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {/* Search */}
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  height: 30,
                  padding: "0 10px",
                  background: "var(--surface)",
                  border: "0.5px solid var(--border-2)",
                  borderRadius: 6,
                }}
              >
                <span style={{ color: "var(--ink-3)" }}>{Icon.search}</span>
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter skills…"
                  style={{
                    flex: 1,
                    border: 0,
                    background: "transparent",
                    outline: 0,
                    fontSize: 13,
                    fontFamily: "var(--sans)",
                    color: "var(--ink)",
                  }}
                />
                <KBD>/</KBD>
              </div>

              {/* Filter pills */}
              <div
                style={{
                  display: "flex",
                  gap: 0,
                  background: "var(--surface)",
                  border: "0.5px solid var(--border-2)",
                  borderRadius: 6,
                  padding: 2,
                }}
              >
                {(
                  [
                    { id: "all", label: "All" },
                    { id: "production", label: "Production" },
                    { id: "staging", label: "Staging" },
                    { id: "stale", label: "Stale" },
                    { id: "missing", label: "Missing" },
                    { id: "vault-only", label: "Vault-only" },
                    { id: "desktop-outdated", label: "Desktop" },
                  ] as Array<{ id: Filter; label: string }>
                ).map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setFilter(f.id)}
                    style={{
                      padding: "4px 10px",
                      border: 0,
                      background: filter === f.id ? "var(--bg)" : "transparent",
                      color: filter === f.id ? "var(--ink)" : "var(--ink-3)",
                      fontSize: 12,
                      fontWeight: filter === f.id ? 500 : 400,
                      borderRadius: 4,
                      cursor: "pointer",
                      boxShadow: filter === f.id ? "0 0 0 0.5px var(--border-2)" : "none",
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Sort / layout / filter bar row */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {/* Sort dropdown */}
              <select
                value={prefs.sortBy}
                onChange={(e) => updatePrefs({ sortBy: e.target.value as SkillsPreferences["sortBy"] })}
                style={{
                  height: 26,
                  padding: "0 6px",
                  fontSize: 11,
                  fontFamily: "var(--mono)",
                  color: "var(--ink-2)",
                  background: "var(--surface)",
                  border: "0.5px solid var(--border-2)",
                  borderRadius: 5,
                  cursor: "pointer",
                }}
              >
                <option value="name">Name</option>
                <option value="modified">Modified</option>
                <option value="created">Created</option>
                <option value="file_count">File count</option>
                <option value="status">Status</option>
              </select>

              {/* Asc/Desc toggle */}
              <button
                onClick={() => updatePrefs({ sortDir: prefs.sortDir === "asc" ? "desc" : "asc" })}
                title={prefs.sortDir === "asc" ? "Ascending" : "Descending"}
                style={{
                  width: 26,
                  height: 26,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "0.5px solid var(--border-2)",
                  background: "var(--surface)",
                  borderRadius: 5,
                  cursor: "pointer",
                  color: "var(--ink-3)",
                  transform: prefs.sortDir === "desc" ? "scaleY(-1)" : undefined,
                }}
              >
                {Icon.arrowDown}
              </button>

              <span style={{ width: 1, height: 18, background: "var(--border)" }} />

              {/* Layout toggle buttons */}
              {(["list", "cards", "grouped", "matrix"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => updatePrefs({ layout: mode })}
                  title={mode}
                  style={{
                    width: 26,
                    height: 26,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "0.5px solid var(--border-2)",
                    background: prefs.layout === mode ? "var(--surface-2)" : "var(--surface)",
                    borderRadius: 5,
                    cursor: "pointer",
                    color: prefs.layout === mode ? "var(--ink)" : "var(--ink-4)",
                  }}
                >
                  {mode === "list" && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M1 3h10M1 6h10M1 9h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  )}
                  {mode === "cards" && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <rect x="1" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
                      <rect x="7" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
                      <rect x="1" y="7" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
                      <rect x="7" y="7" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
                    </svg>
                  )}
                  {mode === "grouped" && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M1 2h4M1 5h10M1 8h10M1 11h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  )}
                  {mode === "matrix" && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <rect x="1" y="1" width="10" height="10" rx="1" stroke="currentColor" strokeWidth="1.1" />
                      <path d="M4.5 1v10M1 4.5h10" stroke="currentColor" strokeWidth="1.1" />
                    </svg>
                  )}
                </button>
              ))}

              {/* GroupBy selector (only visible in grouped mode) */}
              {prefs.layout === "grouped" && (
                <select
                  value={prefs.groupBy}
                  onChange={(e) => updatePrefs({ groupBy: e.target.value as SkillsPreferences["groupBy"] })}
                  style={{
                    height: 26,
                    padding: "0 6px",
                    fontSize: 11,
                    fontFamily: "var(--mono)",
                    color: "var(--ink-2)",
                    background: "var(--surface)",
                    border: "0.5px solid var(--border-2)",
                    borderRadius: 5,
                    cursor: "pointer",
                  }}
                >
                  <option value="tag">Group by tag</option>
                  <option value="provider">Group by provider</option>
                  <option value="stage">Group by stage</option>
                  <option value="status">Group by status</option>
                </select>
              )}

              <span style={{ width: 1, height: 18, background: "var(--border)" }} />

              {/* Target filter — first-class, next to the pills */}
              <select
                value={activeFilters.target ?? ""}
                onChange={(e) =>
                  setActiveFilters({
                    ...activeFilters,
                    target: e.target.value || undefined,
                    targetState: e.target.value
                      ? activeFilters.targetState ?? "configured"
                      : undefined,
                  })
                }
                title="Filter by target provider"
                style={{
                  height: 26,
                  padding: "0 6px",
                  fontSize: 11,
                  fontFamily: "var(--mono)",
                  color: activeFilters.target ? "var(--accent)" : "var(--ink-2)",
                  background: "var(--surface)",
                  border: `0.5px solid ${activeFilters.target ? "var(--accent)" : "var(--border-2)"}`,
                  borderRadius: 5,
                  cursor: "pointer",
                }}
              >
                <option value="">Target: any</option>
                {providerIds.map((p) => (
                  <option key={p} value={p}>
                    Target: {p}
                  </option>
                ))}
              </select>
              {activeFilters.target && (
                <select
                  value={activeFilters.targetState ?? "configured"}
                  onChange={(e) =>
                    setActiveFilters({
                      ...activeFilters,
                      targetState: e.target.value as ActiveFilters["targetState"],
                    })
                  }
                  title="Sync state in the selected target"
                  style={{
                    height: 26,
                    padding: "0 6px",
                    fontSize: 11,
                    fontFamily: "var(--mono)",
                    color: "var(--ink-2)",
                    background: "var(--surface)",
                    border: "0.5px solid var(--border-2)",
                    borderRadius: 5,
                    cursor: "pointer",
                  }}
                >
                  <option value="configured">configured</option>
                  <option value="synced">✓ synced</option>
                  <option value="stale">⚠ stale</option>
                  <option value="missing">— missing</option>
                </select>
              )}

              <span style={{ flex: 1 }} />

              <ViewsMenu
                views={prefs.savedViews}
                onApply={applyView}
                onSave={saveCurrentView}
                onDelete={deleteView}
              />

              {/* Advanced FilterBar */}
              <FilterBar
                providers={providerIds}
                allTags={allTags}
                filters={activeFilters}
                onChange={setActiveFilters}
              />
            </div>
          </div>

          {/* Select-all header (when any selected) — rendered in all layouts */}
          {anySelected && (
            <SelectAllHeader
              checked={selected.size === sorted.length && sorted.length > 0}
              label={selected.size === sorted.length ? "Deselect all" : "Select all"}
              onChange={handleSelectAll}
            />
          )}

          {/* List body */}
          <div
            className="sv-scroll"
            style={{
              flex: 1,
              overflowY: "auto",
              paddingBottom: anySelected ? 60 : 0,
            }}
          >
            {isLoading ? (
              <div style={{ padding: 22, color: "var(--ink-3)", fontSize: 13 }}>
                Loading skills…
              </div>
            ) : sorted.length === 0 ? (
              <div style={{ padding: 22, color: "var(--ink-3)", fontSize: 13 }}>
                No skills match.
              </div>
            ) : prefs.layout === "matrix" ? (
              <SkillMatrixView
                skills={sorted}
                providers={providerIds}
                activeName={activeName}
                onOpen={(name) => navigate(`/skills/${encodeURIComponent(name)}`)}
                onCellPush={pushOne}
                onColumnPush={pushColumn}
              />
            ) : prefs.layout === "cards" ? (
              <SkillCardView
                skills={sorted}
                selectedName={activeName}
                selected={selected}
                onSelect={(name, e) => {
                  if (e.ctrlKey || e.metaKey) {
                    handleToggleSelect(name, e);
                    return;
                  }
                  if (selected.size > 0) {
                    handleToggleSelect(name, e);
                    return;
                  }
                  if (name === overlayName) return;
                  const dirty = overlayName ? overlayEditorDirty : panelEditorDirty;
                  if (dirty && !window.confirm("You have unsaved changes. Discard them?")) return;
                  navigate(`/skills/${encodeURIComponent(name)}`);
                }}
                onToggleSelect={(name, e) => handleToggleSelect(name, e)}
                onPreview={(name) => {
                  if (name === previewName) return;
                  if (panelEditorDirty && !window.confirm("You have unsaved changes. Discard them?")) return;
                  navigate(`/skills?preview=${encodeURIComponent(name)}`);
                }}
              />
            ) : prefs.layout === "grouped" ? (
              <SkillGroupedView
                skills={sorted}
                groupBy={prefs.groupBy}
                selectedName={activeName}
                selected={selected}
                onSelect={(name, e) => {
                  if (e.ctrlKey || e.metaKey) {
                    handleToggleSelect(name, e);
                    return;
                  }
                  if (selected.size > 0) {
                    handleToggleSelect(name, e);
                    return;
                  }
                  if (name === overlayName) return;
                  const dirty = overlayName ? overlayEditorDirty : panelEditorDirty;
                  if (dirty && !window.confirm("You have unsaved changes. Discard them?")) return;
                  navigate(`/skills/${encodeURIComponent(name)}`);
                }}
                onToggleSelect={(name, e) => handleToggleSelect(name, e)}
                onPreview={(name) => {
                  if (name === previewName) return;
                  if (panelEditorDirty && !window.confirm("You have unsaved changes. Discard them?")) return;
                  navigate(`/skills?preview=${encodeURIComponent(name)}`);
                }}
              />
            ) : (
              sorted.map((s) => (
                <SkillRow
                  key={s.name}
                  skill={s}
                  isSelected={activeName === s.name}
                  isChecked={selected.has(s.name)}
                  showCheckbox={anySelected}
                  onSelect={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      handleToggleSelect(s.name, e);
                      return;
                    }
                    if (selected.size > 0) {
                      handleToggleSelect(s.name, e);
                      return;
                    }
                    if (s.name === overlayName) return;
                    const dirty = overlayName ? overlayEditorDirty : panelEditorDirty;
                    if (dirty && !window.confirm("You have unsaved changes. Discard them?")) return;
                    navigate(`/skills/${encodeURIComponent(s.name)}`);
                  }}
                  onPreview={(e) => {
                    e.stopPropagation();
                    if (s.name === previewName) return;
                    if (panelEditorDirty && !window.confirm("You have unsaved changes. Discard them?")) return;
                    navigate(`/skills?preview=${encodeURIComponent(s.name)}`);
                  }}
                  onToggleSelect={(e) => handleToggleSelect(s.name, e)}
                />
              ))
            )}
          </div>
        </div>

        {/* Side panel (preview mode) */}
        {previewName && activeSkill && (
          <SkillSidePanel
            skillName={activeSkill.name}
            onEditorDirtyChange={setPanelEditorDirty}
          />
        )}
      </div>

      {/* Overlay (detail mode) */}
      {overlayName && (
        <SkillDetailOverlay
          skillName={overlayName}
          onClose={() => navigate("/skills")}
          onEditorDirtyChange={setOverlayEditorDirty}
        />
      )}

      {newOpen && <NewSkillDrawer onClose={() => setNewOpen(false)} />}

      {autoTagOpen && (
        <AutoTagDialog skills={skills} onClose={() => setAutoTagOpen(false)} />
      )}

      {healthOpen && (
        <HealthDialog
          skills={skills}
          onOpen={(name) => navigate(`/skills/${encodeURIComponent(name)}`)}
          onClose={() => setHealthOpen(false)}
        />
      )}

      {updateScope !== null && (
        <UpdateDialog
          skills={updateScope.length > 0 ? updateScope : undefined}
          onClose={() => setUpdateScope(null)}
        />
      )}

      {bulkPushOpen && (
        <PushDrawer
          skills={[...selected]}
          onClose={() => setBulkPushOpen(false)}
          onSuccess={() => {
            setBulkPushOpen(false);
            qc.invalidateQueries({ queryKey: ["skills"] });
          }}
        />
      )}

      {/* Bulk action bar */}
      {anySelected && (
        <BulkActionBar
          count={selected.size}
          selectedSkills={selectedSkills}
          allTags={allTags}
          providers={configData?.providers ?? []}
          onPush={handleBulkPush}
          onPull={handleBulkPull}
          onRemove={handleBulkRemove}
          onPromote={handleBulkPromote}
          onDemote={handleBulkDemote}
          onAddProvider={handleBulkAddProvider}
          onAddAllProviders={handleBulkAddAllProviders}
          onCheckUpdates={
            selectedSkills.some((s) => s.origin)
              ? () => setUpdateScope([...selected])
              : undefined
          }
          onZip={handleBulkZip}
          onExportOpenClaw={handleBulkExportOpenClaw}
          openclawAvailable={openclaw?.available}
          onApplyTags={async (add, remove) => {
            const names = [...selected];
            try {
              await api.bulkTag({ skills: names, add, remove });
              const parts: string[] = [];
              if (add.length > 0) parts.push(`added ${add.length}`);
              if (remove.length > 0) parts.push(`removed ${remove.length}`);
              toast.success(
                parts.length
                  ? `Tags updated (${parts.join(", ")}) on ${names.length} skill${names.length === 1 ? "" : "s"}`
                  : `Tags updated on ${names.length} skill${names.length === 1 ? "" : "s"}`,
              );
              qc.invalidateQueries({ queryKey: ["skills"] });
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : "Failed to update tags");
            }
          }}
          onDeselect={() => setSelected(new Set())}
        />
      )}
    </Layout>
  );
}

function SkillRow({
  skill: s,
  isSelected,
  isChecked,
  showCheckbox,
  onSelect,
  onPreview,
  onToggleSelect,
}: {
  skill: Skill;
  isSelected: boolean;
  isChecked: boolean;
  showCheckbox: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onPreview: (e: React.MouseEvent) => void;
  onToggleSelect: (e: React.MouseEvent) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const status = s.status;
  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "grid",
        gridTemplateColumns: showCheckbox || hovered
          ? "auto 1fr auto auto auto"
          : "1fr auto auto auto",
        gap: 12,
        alignItems: "center",
        padding: "11px 22px",
        borderBottom: "0.5px solid var(--border)",
        background: isChecked
          ? "var(--surface-2)"
          : isSelected
            ? "var(--surface-2)"
            : hovered
              ? "var(--surface)"
              : "transparent",
        cursor: "pointer",
        position: "relative",
      }}
    >
      {isSelected && (
        <span
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 2,
            background: "var(--accent)",
          }}
        />
      )}

      {/* Checkbox */}
      {(showCheckbox || hovered) && (
        <input
          type="checkbox"
          checked={isChecked}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(e as unknown as React.MouseEvent);
          }}
          onChange={() => {}}
          style={{
            width: 13,
            height: 13,
            cursor: "pointer",
            accentColor: "var(--accent)",
          }}
        />
      )}

      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 13.5,
              fontWeight: 500,
              color:
                status === "staging"
                  ? "var(--info)"
                  : status === "stale"
                    ? "var(--warn)"
                    : status === "vault-only"
                      ? "var(--neutral)"
                      : "var(--ink)",
            }}
          >
            {s.name}
          </span>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              color: "var(--ink-4)",
            }}
          >
            · {s.file_count} file{s.file_count === 1 ? "" : "s"}
          </span>
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--ink-3)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {s.description || (
            <span style={{ color: "var(--ink-4)", fontStyle: "italic" }}>
              no description
            </span>
          )}
        </div>
        {s.tags.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <TagChips tags={s.tags} />
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        {s.targets.length === 0 ? (
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-4)" }}>
            —
          </span>
        ) : (
          s.targets.map((t) => <ProviderChip key={t} slug={t} />)
        )}
      </div>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <StatusBadge status={status} />
        <DesktopBadge status={s.desktop_status} />
      </span>
      {/* Preview button */}
      <button
        onClick={onPreview}
        title="Preview in side panel"
        style={{
          width: 26,
          height: 26,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "0.5px solid var(--border-2)",
          background: "var(--surface)",
          borderRadius: 5,
          cursor: "pointer",
          color: "var(--ink-3)",
          opacity: hovered ? 1 : 0,
          transition: "opacity 120ms",
        }}
      >
        {Icon.eye}
      </button>
    </div>
  );
}

function ViewsMenu({
  views,
  onApply,
  onSave,
  onDelete,
}: {
  views: SavedView[];
  onApply: (v: SavedView) => void;
  onSave: () => void;
  onDelete: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          height: 26,
          padding: "0 10px",
          fontSize: 12,
          fontWeight: 500,
          fontFamily: "var(--sans)",
          color: "var(--ink-3)",
          background: "var(--surface)",
          border: "0.5px solid var(--border-2)",
          borderRadius: 5,
          cursor: "pointer",
        }}
      >
        Views{views.length ? ` (${views.length})` : ""}
        <span style={{ fontSize: 9 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 80,
            width: 220,
            background: "var(--bg)",
            border: "0.5px solid var(--border-2)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            overflow: "hidden",
          }}
        >
          <div style={{ maxHeight: 260, overflowY: "auto", padding: 4 }} className="sv-scroll">
            {views.length === 0 ? (
              <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--ink-3)" }}>
                No saved views yet.
              </div>
            ) : (
              views.map((v) => (
                <div
                  key={v.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 6px",
                    borderRadius: 5,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <button
                    onClick={() => {
                      onApply(v);
                      setOpen(false);
                    }}
                    style={{
                      flex: 1,
                      textAlign: "left",
                      border: 0,
                      background: "transparent",
                      cursor: "pointer",
                      fontSize: 12.5,
                      color: "var(--ink)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {v.name}
                  </button>
                  <button
                    onClick={() => onDelete(v.name)}
                    title="Delete view"
                    style={{
                      border: 0,
                      background: "transparent",
                      color: "var(--ink-4)",
                      cursor: "pointer",
                      fontSize: 13,
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
          <button
            onClick={() => {
              onSave();
              setOpen(false);
            }}
            style={{
              width: "100%",
              padding: "8px 10px",
              border: 0,
              borderTop: "0.5px solid var(--border)",
              background: "transparent",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 500,
              color: "var(--accent)",
              textAlign: "left",
            }}
          >
            + Save current view…
          </button>
        </div>
      )}
    </div>
  );
}

function SelectAllHeader({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 22px",
        borderBottom: "0.5px solid var(--border)",
        background: "var(--surface)",
        fontSize: 12,
        color: "var(--ink-3)",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        style={{ width: 13, height: 13, accentColor: "var(--accent)" }}
      />
      <span>{label}</span>
    </div>
  );
}
