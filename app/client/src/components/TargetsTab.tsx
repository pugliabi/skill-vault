import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Icon } from "./ui/icons";
import { Button, ProviderChip } from "./ui/primitives";
import { DiffDrawer } from "./DiffDrawer";
import type { Skill } from "../lib/types";

export function TargetsTab({ skill }: { skill: Skill }) {
  const qc = useQueryClient();
  const [diffProvider, setDiffProvider] = useState<string | null>(null);
  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: () => api.getConfig(),
  });
  const providers = config?.providers ?? [];

  const update = useMutation({
    mutationFn: (targets: string[]) => api.updateSkill(skill.name, { targets }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skill", skill.name] });
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Update failed"),
  });

  const pull = useMutation({
    mutationFn: (provider_id: string) =>
      api.pull({ skill: skill.name, provider_id }),
    onSuccess: (r) => {
      toast.success(r.action === "no-op" ? "Already linked" : `Pulled from ${r.source_path}`);
      qc.invalidateQueries({ queryKey: ["skill", skill.name] });
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Pull failed"),
  });

  const push = useMutation({
    mutationFn: (provider_id: string) =>
      api.push({ skill: skill.name, provider_id, method: "auto" }),
    onSuccess: (r) => {
      toast.success(`Pushed via ${r.method}`);
      qc.invalidateQueries({ queryKey: ["skill", skill.name] });
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Push failed"),
  });

  // Claude Desktop is a package target, not a link target: no local
  // skills dir exists, so "push" = build an upload-ready zip in the
  // staging folder. Upload happens manually in Claude Desktop →
  // Settings → Capabilities → Skills.
  const packageDesktop = useMutation({
    mutationFn: () => api.packageForDesktop(skill.name),
    onSuccess: (r) => toast.success(`Packaged → ${r.zip_path}`),
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Package failed"),
  });

  const revealStage = useMutation({
    mutationFn: () => api.revealDesktopStage(),
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Open failed"),
  });

  if (providers.length === 0) {
    return (
      <div
        style={{
          fontSize: 12.5,
          color: "var(--ink-3)",
          padding: "8px 10px",
          background: "var(--surface)",
          border: "0.5px solid var(--border)",
          borderRadius: 6,
        }}
      >
        No providers configured. Add one in Settings.
      </div>
    );
  }

  const toggle = (id: string) => {
    const next = skill.targets.includes(id)
      ? skill.targets.filter((t) => t !== id)
      : [...skill.targets, id];
    update.mutate(next);
  };

  const stateLabel: Record<string, { label: string; color: string }> = {
    synced:  { label: "synced",  color: "var(--ok)" },
    stale:   { label: "stale",   color: "var(--warn)" },
    missing: { label: "missing", color: "var(--bad)" },
    error:   { label: "error",   color: "var(--bad)" },
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          fontSize: 11.5,
          color: "var(--ink-3)",
          marginBottom: 4,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 600,
        }}
      >
        Sync targets
      </div>
      {diffProvider && (
        <DiffDrawer
          skillName={skill.name}
          providerId={diffProvider}
          onClose={() => setDiffProvider(null)}
          onResolved={() => setDiffProvider(null)}
        />
      )}
      {providers.map((p) => {
        const enabled = skill.targets.includes(p.id);
        const state = enabled ? skill.target_status[p.id] : undefined;
        const meta = state ? stateLabel[state] : undefined;
        const showFix = enabled && (state === "stale" || state === "missing");
        return (
          <div
            key={p.id}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "8px 10px",
              background: enabled ? "var(--surface)" : "transparent",
              border: `0.5px solid ${enabled ? "var(--border-2)" : "var(--border)"}`,
              borderRadius: 6,
              opacity: update.isPending ? 0.6 : 1,
            }}
          >
            <div
              onClick={() => toggle(p.id)}
              style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
            >
              <input
                type="checkbox"
                checked={enabled}
                readOnly
                style={{ accentColor: "var(--accent)" }}
              />
              <span style={{ fontSize: 13, color: "var(--ink)", flex: 1 }}>{p.id}</span>
              {meta && (
                <span
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                    fontWeight: 500,
                    color: meta.color,
                    textTransform: "lowercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  ·{meta.label}
                </span>
              )}
              <ProviderChip slug={p.id} active={enabled} />
            </div>
            {showFix && (
              <div style={{ display: "flex", gap: 6, paddingLeft: 22 }}>
                {state === "stale" && (
                  <Button
                    kind="ghost"
                    size="sm"
                    onClick={() => setDiffProvider(p.id)}
                    title="Preview the difference before resolving"
                  >
                    View diff
                  </Button>
                )}
                <Button
                  kind="ghost"
                  size="sm"
                  icon={Icon.push}
                  onClick={() => push.mutate(p.id)}
                  disabled={push.isPending}
                  title="Push vault → provider (vault wins)"
                >
                  Push
                </Button>
                {state === "stale" && (
                  <Button
                    kind="ghost"
                    size="sm"
                    icon={Icon.pull}
                    onClick={() => pull.mutate(p.id)}
                    disabled={pull.isPending}
                    title="Pull provider → vault (provider wins)"
                  >
                    Pull
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {/* Claude Desktop — package target. Rendered after link providers;
          intentionally not part of skill.targets (the Python sv CLI
          doesn't know package-targets yet — see routes/desktop.ts). */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: "8px 10px",
          background: "var(--surface)",
          border: "0.5px solid var(--border)",
          borderRadius: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 13, color: "var(--ink)", flex: 1 }}>
            claude-desktop
          </span>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              fontWeight: 500,
              color: "var(--ink-3)",
              textTransform: "lowercase",
              letterSpacing: "0.04em",
            }}
            title="No local skills folder — builds an upload-ready zip instead of a link"
          >
            ·package
          </span>
          <ProviderChip slug="claude-desktop" />
        </div>
        <div style={{ display: "flex", gap: 6, paddingLeft: 22 }}>
          <Button
            kind="ghost"
            size="sm"
            icon={Icon.push}
            onClick={() => packageDesktop.mutate()}
            disabled={packageDesktop.isPending}
            title="Build an upload-ready zip in the staging folder, then upload it in Claude Desktop → Settings → Capabilities → Skills"
          >
            {packageDesktop.isPending ? "Packaging…" : "Package zip"}
          </Button>
          <Button
            kind="ghost"
            size="sm"
            onClick={() => revealStage.mutate()}
            disabled={revealStage.isPending}
            title="Open the staging folder in Explorer"
          >
            Open folder
          </Button>
        </div>
      </div>
    </div>
  );
}
