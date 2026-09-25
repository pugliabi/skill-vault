import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Layout } from "../components/Layout";
import { Icon } from "../components/ui/icons";
import { Button, ProviderChip, Rule } from "../components/ui/primitives";
import ImportVaultDialog from "../components/ImportVaultDialog";
import type { AppConfig, Provider } from "../lib/types";

/**
 * Settings — Vault config, Providers, App. Anything stored in
 * ~/.skill-vault/config.json that the app owns is editable here; the
 * rest is preserved round-trip by the server (see appConfig.ts).
 */
export default function Settings() {
  const qc = useQueryClient();
  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: () => api.getConfig(),
  });
  const [importOpen, setImportOpen] = useState(false);

  return (
    <Layout>
      <div className="sv-fade-in" style={{ padding: "18px 28px", maxWidth: 960 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 18, marginBottom: 18 }}>
          <div style={{ flex: 1 }}>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--ink)" }}>
              Settings
            </h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--ink-2)" }}>
              Stored in{" "}
              <code style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--ink-3)" }}>
                ~/.skill-vault/config.json
              </code>
              . Shared with the <code style={{ fontFamily: "var(--mono)" }}>sv</code> CLI.
            </p>
          </div>
        </div>

        <Rule label="Vault" />
        <VaultSection config={config} qc={qc} />

        <Rule
          label={`Providers (${config?.providers.length ?? 0} configured)`}
          action={<AddProviderButton qc={qc} />}
        />
        <ProvidersSection providers={config?.providers ?? []} qc={qc} />

        <ClaudeDesktopSection config={config} qc={qc} />

        <div style={{ height: 22 }} />

        <DefaultsSection config={config} qc={qc} />

        <div style={{ height: 22 }} />

        <HistorySection qc={qc} />

        <div style={{ height: 22 }} />

        <AuditSection />

        <div style={{ height: 22 }} />

        <ManageTagsSection qc={qc} />

        <div style={{ height: 22 }} />

        <Rule label="Import" />
        <div
          style={{
            background: "var(--surface)",
            border: "0.5px solid var(--border)",
            borderRadius: 8,
            padding: "14px 18px",
            marginBottom: 22,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            fontSize: 13,
            color: "var(--ink-2)",
          }}
        >
          <p style={{ margin: 0 }}>Merge skills from another vault into this one.</p>
          <div>
            <Button onClick={() => setImportOpen(true)}>Import from another vault…</Button>
          </div>
        </div>
        {importOpen && <ImportVaultDialog onClose={() => setImportOpen(false)} />}

        <Rule label="App" />
        <div
          style={{
            background: "var(--surface)",
            border: "0.5px solid var(--border)",
            borderRadius: 8,
            padding: "14px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            fontSize: 13,
            color: "var(--ink-2)",
          }}
        >
          <p style={{ margin: 0 }}>
            Runtime (port, host, auto-open) is set by:{" "}
            CLI flags → environment → <code style={{ fontFamily: "var(--mono)" }}>app/.env</code>{" "}
            → <code style={{ fontFamily: "var(--mono)" }}>app</code> block in the CLI config →
            built-in defaults (5174 / 127.0.0.1 / open).
          </p>
          <p style={{ margin: 0, color: "var(--ink-3)", fontSize: 12 }}>
            Edit those there — restart the dev server to apply.
          </p>
        </div>
      </div>
    </Layout>
  );
}

/* ── Vault section ──────────────────────────────────────────────── */

function VaultSection({
  config,
  qc,
}: {
  config?: { vault_path: string | null };
  qc: ReturnType<typeof useQueryClient>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const update = useMutation({
    mutationFn: (p: string) => api.setVaultPath(p),
    onSuccess: () => {
      toast.success("Vault path updated");
      qc.invalidateQueries({ queryKey: ["config"] });
      qc.invalidateQueries({ queryKey: ["skills"] });
      setEditing(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Update failed"),
  });

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "0.5px solid var(--border)",
        borderRadius: 8,
        padding: "14px 18px",
        marginBottom: 22,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "140px 1fr auto", gap: 14, alignItems: "center" }}>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11.5,
            color: "var(--ink-3)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontWeight: 600,
          }}
        >
          vault_path
        </span>
        {editing ? (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            style={{
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "var(--ink)",
              background: "var(--bg)",
              border: "0.5px solid var(--border-2)",
              borderRadius: 5,
              padding: "0 10px",
              height: 30,
              outline: 0,
            }}
          />
        ) : (
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "var(--ink)",
              wordBreak: "break-all",
            }}
          >
            {config?.vault_path ?? <span style={{ color: "var(--ink-3)" }}>(not set)</span>}
          </span>
        )}
        {editing ? (
          <div style={{ display: "flex", gap: 6 }}>
            <Button kind="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              kind="primary"
              size="sm"
              onClick={() => update.mutate(draft.trim())}
              disabled={!draft.trim() || update.isPending}
            >
              Save
            </Button>
          </div>
        ) : (
          <Button
            kind="ghost"
            size="sm"
            onClick={() => {
              setDraft(config?.vault_path ?? "");
              setEditing(true);
            }}
          >
            Change…
          </Button>
        )}
      </div>
    </div>
  );
}

/* ── Providers ──────────────────────────────────────────────────── */

function AddProviderButton({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Provider>({ id: "", path: "" });

  const add = useMutation({
    mutationFn: (p: Provider) => api.upsertProvider(p),
    onSuccess: () => {
      toast.success("Provider added");
      qc.invalidateQueries({ queryKey: ["config"] });
      setDraft({ id: "", path: "" });
      setOpen(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Add failed"),
  });

  if (!open) {
    return (
      <Button kind="ghost" size="sm" icon={Icon.plus} onClick={() => setOpen(true)}>
        Add provider
      </Button>
    );
  }

  return (
    <span
      style={{
        display: "inline-flex",
        gap: 6,
        alignItems: "center",
        background: "var(--surface)",
        border: "0.5px solid var(--border-2)",
        borderRadius: 6,
        padding: "3px 6px",
      }}
    >
      <input
        value={draft.id}
        onChange={(e) => setDraft({ ...draft, id: e.target.value })}
        placeholder="slug"
        style={{
          width: 80,
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          color: "var(--ink)",
          background: "var(--bg)",
          border: "0.5px solid var(--border)",
          borderRadius: 4,
          padding: "0 6px",
          height: 22,
          outline: 0,
        }}
      />
      <input
        value={draft.path}
        onChange={(e) => setDraft({ ...draft, path: e.target.value })}
        placeholder="path"
        style={{
          width: 220,
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          color: "var(--ink)",
          background: "var(--bg)",
          border: "0.5px solid var(--border)",
          borderRadius: 4,
          padding: "0 6px",
          height: 22,
          outline: 0,
        }}
      />
      <Button
        kind="primary"
        size="sm"
        onClick={() => add.mutate(draft)}
        disabled={!draft.id || !draft.path || add.isPending}
      >
        Add
      </Button>
      <Button kind="ghost" size="sm" onClick={() => setOpen(false)}>
        ×
      </Button>
    </span>
  );
}

const PROVIDER_CHECK_META: Record<string, { color: string; label: string }> = {
  ok:          { color: "var(--ok)",   label: "ready" },
  readonly:    { color: "var(--warn)", label: "read-only" },
  missing:     { color: "var(--bad)",  label: "path missing" },
  not_dir:     { color: "var(--bad)",  label: "not a folder" },
  denied:      { color: "var(--bad)",  label: "access denied" },
  unreachable: { color: "var(--bad)",  label: "unreachable" },
};

function ProvidersSection({
  providers,
  qc,
}: {
  providers: Provider[];
  qc: ReturnType<typeof useQueryClient>;
}) {
  const remove = useMutation({
    mutationFn: (id: string) => api.removeProvider(id),
    onSuccess: () => {
      toast.success("Provider removed");
      qc.invalidateQueries({ queryKey: ["config"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Remove failed"),
  });

  const upsert = useMutation({
    mutationFn: (p: Provider) => api.upsertProvider(p),
    onSuccess: () => {
      toast.success("Provider updated");
      qc.invalidateQueries({ queryKey: ["config"] });
      qc.invalidateQueries({ queryKey: ["provider-checks"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Update failed"),
  });

  const { data: checkData } = useQuery({
    queryKey: ["provider-checks"],
    queryFn: () => api.checkProviders(),
    staleTime: 15000,
  });
  const checks = checkData?.checks ?? {};

  if (providers.length === 0) {
    return (
      <div
        style={{
          background: "var(--surface)",
          border: "0.5px solid var(--border)",
          borderRadius: 8,
          padding: "14px 18px",
          fontSize: 13,
          color: "var(--ink-2)",
        }}
      >
        No providers yet. Add one above to start pushing skills.
      </div>
    );
  }

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "0.5px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
        marginBottom: 12,
      }}
    >
      {providers.map((p, i) => (
        <div
          key={p.id}
          style={{
            display: "grid",
            gridTemplateColumns: "170px 1fr auto",
            gap: 14,
            alignItems: "center",
            padding: "12px 18px",
            borderBottom: i < providers.length - 1 ? "0.5px solid var(--border)" : "none",
          }}
        >
          {(() => {
            const chk = checks[p.id];
            const meta = chk ? PROVIDER_CHECK_META[chk.status] : undefined;
            const color = meta?.color ?? "var(--ink-4)";
            const label = meta?.label ?? "checking…";
            return (
              <div
                style={{ display: "flex", alignItems: "center", gap: 10 }}
                title={
                  chk
                    ? `${label}${chk.message ? ` (${chk.message})` : ""}\n${p.path}`
                    : p.path
                }
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: color,
                    boxShadow: `0 0 0 2px color-mix(in oklab, ${color} 15%, transparent)`,
                  }}
                />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>{p.id}</div>
                  <div
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 10.5,
                      color: meta && chk?.status !== "ok" ? color : "var(--ink-3)",
                    }}
                  >
                    {label}
                  </div>
                </div>
              </div>
            );
          })()}
          <input
            defaultValue={p.path}
            onBlur={(e) => {
              if (e.target.value !== p.path) upsert.mutate({ id: p.id, path: e.target.value });
            }}
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              color: "var(--ink-2)",
              background: "var(--bg)",
              border: "0.5px solid var(--border-2)",
              borderRadius: 5,
              padding: "5px 9px",
              height: 28,
              outline: 0,
              width: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          />
          <button
            onClick={() => remove.mutate(p.id)}
            style={{
              border: 0,
              background: "transparent",
              color: "var(--ink-3)",
              cursor: "pointer",
              display: "inline-flex",
            }}
            title={`Remove ${p.id}`}
          >
            {Icon.x}
          </button>
        </div>
      ))}
    </div>
  );
}

/* ── Defaults section ──────────────────────────────────────────── */

/* ── Claude Desktop (package target) ─────────────────────── */

function ClaudeDesktopSection({
  config,
  qc,
}: {
  config?: AppConfig;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const update = useMutation({
    mutationFn: (p: string) => api.setDesktopStage(p),
    onSuccess: () => {
      toast.success("Claude Desktop stage updated");
      qc.invalidateQueries({ queryKey: ["config"] });
      setEditing(false);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Update failed"),
  });

  const reveal = useMutation({
    mutationFn: () => api.revealDesktopStage(),
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Open failed"),
  });

  // Seed desktop_package records from zips built before status tracking
  // existed. Safe to re-run — existing records are never overwritten.
  const backfill = useMutation({
    mutationFn: () => api.desktopBackfill(),
    onSuccess: (r) => {
      const outdated = r.seeded.filter(
        (s) => s.desktop_status === "outdated",
      ).length;
      toast.success(
        r.seeded.length === 0
          ? "No new zips found to backfill"
          : `Backfilled ${r.seeded.length} skill${r.seeded.length === 1 ? "" : "s"}${
              outdated ? ` (${outdated} outdated)` : ""
            }`,
      );
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Backfill failed"),
  });

  const stage = config?.claude_desktop_stage ?? "";

  return (
    <>
      <div style={{ height: 22 }} />
      <Rule label="Claude Desktop (package target)" />
      <div
        style={{
          background: "var(--surface)",
          border: "0.5px solid var(--border)",
          borderRadius: 8,
          padding: "14px 18px",
          marginBottom: 12,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
          Claude Desktop loads skills from your claude.ai account — there is no local
          skills folder to link into. Pushing to this target builds an upload-ready zip
          in the staging folder below; finish by uploading it in Claude Desktop →
          Settings → Capabilities → Skills. Each packaging is recorded, so skills show
          a desktop badge that flips to “outdated” when the vault copy changes and the
          zip needs a re-package + re-upload. Zips built before this tracking existed
          can be imported with “Scan existing zips”.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "180px 1fr auto",
            gap: 14,
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              color: "var(--ink-3)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              fontWeight: 600,
            }}
          >
            claude_desktop_stage
          </span>
          {editing ? (
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              style={{
                fontFamily: "var(--mono)",
                fontSize: 12,
                color: "var(--ink)",
                background: "var(--bg)",
                border: "0.5px solid var(--border-2)",
                borderRadius: 5,
                padding: "0 10px",
                height: 30,
                outline: 0,
              }}
            />
          ) : (
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 12,
                color: "var(--ink)",
                wordBreak: "break-all",
              }}
            >
              {stage || (
                <span style={{ color: "var(--ink-3)" }}>
                  (default: &lt;vault&gt;\..\.claude-desktop-packages)
                </span>
              )}
            </span>
          )}
          {editing ? (
            <div style={{ display: "flex", gap: 6 }}>
              <Button kind="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                kind="primary"
                size="sm"
                onClick={() => update.mutate(draft.trim())}
                disabled={!draft.trim() || update.isPending}
              >
                Save
              </Button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 6 }}>
              <Button
                kind="ghost"
                size="sm"
                onClick={() => {
                  setDraft(stage);
                  setEditing(true);
                }}
              >
                Change…
              </Button>
              <Button
                kind="ghost"
                size="sm"
                onClick={() => reveal.mutate()}
                disabled={reveal.isPending}
              >
                Open folder
              </Button>
              <Button
                kind="ghost"
                size="sm"
                onClick={() => backfill.mutate()}
                disabled={backfill.isPending}
                title="Look for <skill>.zip files in the staging folder and provider directories, and record them as packaged for Claude Desktop"
              >
                {backfill.isPending ? "Scanning…" : "Scan existing zips"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function DefaultsSection({
  config,
  qc,
}: {
  config?: AppConfig;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const [adding, setAdding] = useState(false);
  const defaults = config?.default_targets ?? [];
  const providers = config?.providers ?? [];
  const available = providers.filter((p) => !defaults.includes(p.id));

  const update = useMutation({
    mutationFn: (newTargets: string[]) =>
      api.updateConfig({ default_targets: newTargets } as Partial<AppConfig>),
    onSuccess: () => {
      toast.success("Defaults updated");
      qc.invalidateQueries({ queryKey: ["config"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Update failed"),
  });

  const removeTarget = (id: string) => {
    update.mutate(defaults.filter((t) => t !== id));
  };

  const addTarget = (id: string) => {
    update.mutate([...defaults, id]);
    setAdding(false);
  };

  return (
    <>
      <Rule label="Defaults" />
      <div
        style={{
          background: "var(--surface)",
          border: "0.5px solid var(--border)",
          borderRadius: 8,
          padding: "14px 18px",
          marginBottom: 12,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          Default push targets for new skills.
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {defaults.length === 0 && (
            <span style={{ fontSize: 12, color: "var(--ink-4)" }}>No defaults set</span>
          )}
          {defaults.map((id) => (
            <ProviderChip key={id} slug={id} removable onRemove={() => removeTarget(id)} />
          ))}
          {adding ? (
            <select
              autoFocus
              onChange={(e) => {
                if (e.target.value) addTarget(e.target.value);
                else setAdding(false);
              }}
              onBlur={() => setAdding(false)}
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--ink)",
                background: "var(--surface)",
                border: "0.5px solid var(--border-2)",
                borderRadius: 4,
                padding: "2px 6px",
                height: 24,
              }}
            >
              <option value="">select…</option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>{p.id}</option>
              ))}
            </select>
          ) : available.length > 0 ? (
            <Button kind="ghost" size="sm" onClick={() => setAdding(true)}>
              + Add
            </Button>
          ) : null}
        </div>
      </div>
    </>
  );
}

/* ── Version history section ────────────────────────────────── */

function HistorySection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { data } = useQuery({ queryKey: ["history-config"], queryFn: () => api.getHistoryConfig() });
  const [value, setValue] = useState<string>("");

  useEffect(() => {
    if (data) setValue(String(data.max_versions));
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.setHistoryConfig(Number(value)),
    onSuccess: () => {
      toast.success("History limit saved");
      qc.invalidateQueries({ queryKey: ["history-config"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Save failed"),
  });

  return (
    <>
      <Rule label="Version history" />
      <div
        style={{
          background: "var(--surface)",
          border: "0.5px solid var(--border)",
          borderRadius: 8,
          padding: "14px 18px",
          marginBottom: 12,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          Versions kept per skill in the vault&apos;s{" "}
          <code style={{ fontFamily: "var(--mono)" }}>.history/</code> folder. Older versions
          are dropped first.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="number"
            min={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Versions kept per skill"
            style={{
              width: 80,
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "var(--ink)",
              background: "var(--bg)",
              border: "0.5px solid var(--border-2)",
              borderRadius: 5,
              padding: "0 10px",
              height: 30,
              outline: 0,
            }}
          />
          <Button
            kind="primary"
            size="sm"
            onClick={() => save.mutate()}
            disabled={save.isPending || !(Number.isInteger(Number(value)) && Number(value) >= 1)}
          >
            Save
          </Button>
        </div>
      </div>
    </>
  );
}

/* ── Audit & Repair section ──────────────────────────────────── */

interface AuditIssue {
  id: string;
  kind: string;
  target: string;
  description: string;
  fixes: Array<{ label: string; action: string }>;
}

function AuditSection() {
  const [issues, setIssues] = useState<AuditIssue[] | null>(null);
  const [ran, setRan] = useState(false);

  const audit = useMutation({
    mutationFn: () => api.runAudit(),
    onSuccess: (data) => {
      setIssues(data.issues);
      setRan(true);
      if (data.issues.length === 0) toast.success("No issues found");
    },
    onError: (err) => toast.error(String(err)),
  });

  const repair = useMutation({
    mutationFn: (body: { kind: string; target: string; action: string }) =>
      api.repairIssue(body),
    onSuccess: (_data, vars) => {
      toast.success("Fixed");
      setIssues((prev) =>
        prev ? prev.filter((i) => !(i.kind === vars.kind && i.target === vars.target)) : null,
      );
    },
    onError: (err) => toast.error(String(err)),
  });

  const kindColors: Record<string, string> = {
    orphan_folder: "var(--warn)",
    dangling_entry: "var(--bad)",
    broken_link: "var(--info)",
  };

  return (
    <>
      <Rule label="Audit & Repair" />
      <div
        style={{
          background: "var(--surface)",
          border: "0.5px solid var(--border)",
          borderRadius: 8,
          padding: "14px 18px",
          marginBottom: 12,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Button
            kind="default"
            size="sm"
            onClick={() => audit.mutate()}
            disabled={audit.isPending}
          >
            {audit.isPending ? "Scanning…" : "Run audit"}
          </Button>
          {ran && issues && issues.length === 0 && (
            <span style={{ fontSize: 12, color: "var(--ok)", fontWeight: 500 }}>
              No issues found
            </span>
          )}
        </div>

        {issues && issues.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {issues.map((issue) => (
              <div
                key={issue.id}
                style={{
                  padding: "10px 14px",
                  background: "var(--bg)",
                  border: "0.5px solid var(--border)",
                  borderRadius: 6,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 10,
                      fontWeight: 600,
                      color: kindColors[issue.kind] ?? "var(--ink-3)",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    {issue.kind.replace(/_/g, " ")}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.4 }}>
                  {issue.description}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                  {issue.fixes.map((fix) => (
                    <Button
                      key={fix.action}
                      kind="ghost"
                      size="sm"
                      onClick={() => repair.mutate({ kind: issue.kind, target: issue.target, action: fix.action })}
                      disabled={repair.isPending}
                    >
                      {fix.label}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ── Manage tags section ────────────────────────────────────── */

/**
 * Settings → Manage tags. Lists every tag in the vault with its skill
 * count and per-tag actions: Rename (atomic via POST /api/tags/rename),
 * Delete (bulk-remove via POST /api/tags/bulk), Merge into another tag
 * (bulk add target + remove source via POST /api/tags/bulk).
 *
 * Affected-skill computation runs client-side off the standard
 * ["skills"] cache so we share data with the rest of the UI. After any
 * mutation we invalidate ["tags", "withCounts"], ["tags"], and
 * ["skills"] so other pages see fresh data immediately.
 */
function ManageTagsSection({
  qc,
}: {
  qc: ReturnType<typeof useQueryClient>;
}) {
  const tagsQuery = useQuery({
    queryKey: ["tags", "withCounts"],
    queryFn: () => api.listTagsWithCounts(),
  });
  const skillsQuery = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.listSkills(),
  });

  const tags = tagsQuery.data?.tags ?? [];
  const allSkills = skillsQuery.data?.skills ?? [];
  const [newTag, setNewTag] = useState("");

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["tags", "withCounts"] });
    qc.invalidateQueries({ queryKey: ["tags"] });
    qc.invalidateQueries({ queryKey: ["skills"] });
  };

  const create = useMutation({
    mutationFn: (tag: string) => api.createTag(tag),
    onSuccess: (data) => {
      toast.success(`Created tag "${data.tag}"`);
      setNewTag("");
      qc.invalidateQueries({ queryKey: ["tags", "withCounts"] });
      qc.invalidateQueries({ queryKey: ["tags"] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Create failed"),
  });

  const handleCreate = () => {
    const trimmed = newTag.trim();
    if (!trimmed) return;
    if (trimmed !== trimmed.toLowerCase() || /\s/.test(trimmed)) {
      toast.error("Tag must be lowercase and contain no whitespace");
      return;
    }
    create.mutate(trimmed);
  };

  const skillsWithTag = (tag: string): string[] =>
    allSkills.filter((s) => Array.isArray(s.tags) && s.tags.includes(tag)).map((s) => s.name);

  const rename = useMutation({
    mutationFn: (body: { from: string; to: string }) => api.renameTag(body),
    onSuccess: (data, vars) => {
      if (data.updated === 0) {
        toast.message(`No skills used "${vars.from}"`);
      } else {
        toast.success(
          `Renamed "${vars.from}" → "${vars.to}" on ${data.updated} skill${data.updated === 1 ? "" : "s"}`,
        );
      }
      invalidateAll();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Rename failed"),
  });

  const remove = useMutation({
    mutationFn: (tag: string) => {
      const skills = skillsWithTag(tag);
      return api.bulkTag({ skills, remove: [tag] });
    },
    onSuccess: (data, tag) => {
      toast.success(
        `Deleted "${tag}" from ${data.updated} skill${data.updated === 1 ? "" : "s"}`,
      );
      invalidateAll();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Delete failed"),
  });

  const merge = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) => {
      const skills = skillsWithTag(from);
      return api.bulkTag({ skills, add: [to], remove: [from] });
    },
    onSuccess: (data, vars) => {
      toast.success(
        `Merged "${vars.from}" → "${vars.to}" on ${data.updated} skill${data.updated === 1 ? "" : "s"}`,
      );
      invalidateAll();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Merge failed"),
  });

  const handleRename = (tag: string) => {
    const next = window.prompt(`Rename tag "${tag}" to:`, tag);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    if (trimmed === tag) return;
    if (trimmed !== trimmed.toLowerCase() || /\s/.test(trimmed)) {
      toast.error("Tag must be lowercase and contain no whitespace");
      return;
    }
    rename.mutate({ from: tag, to: trimmed });
  };

  const handleDelete = (tag: string, count: number) => {
    if (
      !window.confirm(
        `Remove tag "${tag}" from ${count} skill${count === 1 ? "" : "s"}? This cannot be undone.`,
      )
    )
      return;
    remove.mutate(tag);
  };

  const handleMerge = (tag: string, target: string) => {
    if (!target || target === tag) return;
    const count = skillsWithTag(tag).length;
    if (
      !window.confirm(
        `Merge "${tag}" into "${target}" on ${count} skill${count === 1 ? "" : "s"}?`,
      )
    )
      return;
    merge.mutate({ from: tag, to: target });
  };

  const busy = rename.isPending || remove.isPending || merge.isPending;

  return (
    <>
      <Rule label={`Manage tags (${tags.length})`} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <input
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleCreate();
            }
          }}
          placeholder="new-tag"
          disabled={create.isPending}
          style={{
            flex: "0 0 220px",
            fontFamily: "var(--mono)",
            fontSize: 11.5,
            color: "var(--ink)",
            background: "var(--bg)",
            border: "0.5px solid var(--border)",
            borderRadius: 4,
            padding: "0 6px",
            height: 24,
            outline: 0,
          }}
        />
        <Button
          kind="primary"
          size="sm"
          onClick={handleCreate}
          disabled={!newTag.trim() || create.isPending}
        >
          Create tag
        </Button>
      </div>
      <div
        style={{
          background: "var(--surface)",
          border: "0.5px solid var(--border)",
          borderRadius: 8,
          padding: tags.length === 0 ? "14px 18px" : 0,
          marginBottom: 12,
          fontSize: 13,
          color: "var(--ink-2)",
          overflow: "hidden",
        }}
      >
        {tagsQuery.isLoading ? (
          <span style={{ padding: "14px 18px", color: "var(--ink-3)" }}>
            Loading tags…
          </span>
        ) : tags.length === 0 ? (
          <span>No tags in this vault yet.</span>
        ) : (
          tags.map((t, i) => (
            <TagRow
              key={t.tag}
              tag={t.tag}
              count={t.count}
              otherTags={tags.filter((x) => x.tag !== t.tag).map((x) => x.tag)}
              isLast={i === tags.length - 1}
              busy={busy}
              onRename={() => handleRename(t.tag)}
              onDelete={() => handleDelete(t.tag, t.count)}
              onMerge={(target) => handleMerge(t.tag, target)}
            />
          ))
        )}
      </div>
    </>
  );
}

function TagRow({
  tag,
  count,
  otherTags,
  isLast,
  busy,
  onRename,
  onDelete,
  onMerge,
}: {
  tag: string;
  count: number;
  otherTags: string[];
  isLast: boolean;
  busy: boolean;
  onRename: () => void;
  onDelete: () => void;
  onMerge: (target: string) => void;
}) {
  const [merging, setMerging] = useState(false);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto auto",
        gap: 12,
        alignItems: "center",
        padding: "10px 18px",
        borderBottom: isLast ? "none" : "0.5px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "var(--ink)",
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {tag}
        </span>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10.5,
            color: "var(--ink-3)",
          }}
        >
          {count} skill{count === 1 ? "" : "s"}
        </span>
      </div>

      {merging ? (
        <select
          autoFocus
          onChange={(e) => {
            const v = e.target.value;
            setMerging(false);
            if (v) onMerge(v);
          }}
          onBlur={() => setMerging(false)}
          disabled={busy}
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--ink)",
            background: "var(--bg)",
            border: "0.5px solid var(--border-2)",
            borderRadius: 4,
            padding: "2px 6px",
            height: 24,
          }}
        >
          <option value="">merge into…</option>
          {otherTags.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <Button
          kind="ghost"
          size="sm"
          onClick={() => setMerging(true)}
          disabled={busy || otherTags.length === 0}
          title={otherTags.length === 0 ? "No other tags to merge into" : "Merge into another tag"}
        >
          Merge…
        </Button>
      )}

      <div style={{ display: "flex", gap: 6 }}>
        <Button kind="ghost" size="sm" onClick={onRename} disabled={busy}>
          Rename…
        </Button>
        <Button kind="ghost" size="sm" onClick={onDelete} disabled={busy}>
          Delete
        </Button>
      </div>
    </div>
  );
}
