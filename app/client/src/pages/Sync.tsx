import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Layout } from "../components/Layout";
import { Icon } from "../components/ui/icons";
import { Button, ProviderChip, Rule, StatusBadge } from "../components/ui/primitives";
import {
  type ModifierClick,
  SelectAllControl,
  useChecklistSelection,
} from "../components/Checklist";
import { DiffDrawer } from "../components/DiffDrawer";
import { AskAIButton } from "../components/assistant/AskAIButton";
import { openAssistant } from "../lib/assistantStore";
import type { SyncPlan } from "../lib/types";

type RowStatus = "idle" | "running" | "ok" | "error";
interface RowState {
  status: RowStatus;
  error?: string;
}

export default function Sync() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const {
    data: plan,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["sync-plan"],
    queryFn: () => api.syncPlan(),
  });

  const [pushPicked, setPushPicked] = useState<Set<string>>(new Set());
  const [pullPicked, setPullPicked] = useState<Set<string>>(new Set());
  const [adoptPicked, setAdoptPicked] = useState<Set<string>>(new Set());
  const [promotePicked, setPromotePicked] = useState<Set<string>>(new Set());
  const [packagePicked, setPackagePicked] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [diffFor, setDiffFor] = useState<{ skill: string; provider: string } | null>(null);

  // Ordered keys per section drive range (Shift-click) selection.
  const pushKeys = (plan?.push ?? []).map(pushKey);
  const pullKeys = (plan?.pull ?? []).map(pullKey);
  const adoptKeys = (plan?.adopt ?? []).map(adoptKey);
  const promoteKeys = (plan?.promote ?? []).map((p) => p.name);
  const packageKeys = (plan?.package ?? []).map((p) => p.skill);
  const pushSel = useChecklistSelection(pushKeys, pushPicked, setPushPicked);
  const pullSel = useChecklistSelection(pullKeys, pullPicked, setPullPicked);
  const adoptSel = useChecklistSelection(adoptKeys, adoptPicked, setAdoptPicked);
  const promoteSel = useChecklistSelection(promoteKeys, promotePicked, setPromotePicked);
  const packageSel = useChecklistSelection(packageKeys, packagePicked, setPackagePicked);

  const autoSelected = useRef(false);
  useEffect(() => {
    if (!plan || autoSelected.current) return;
    autoSelected.current = true;
    if (plan.push.length) setPushPicked(new Set(plan.push.map(pushKey)));
    if (plan.pull.length) setPullPicked(new Set(plan.pull.map(pullKey)));
    if (plan.adopt.length) setAdoptPicked(new Set(plan.adopt.map(adoptKey)));
    if (plan.promote.length) setPromotePicked(new Set(plan.promote.map((p) => p.name)));
    if (plan.package.length) setPackagePicked(new Set(plan.package.map((p) => p.skill)));
  }, [plan]);

  const total =
    (plan?.push.length ?? 0) +
    (plan?.pull.length ?? 0) +
    (plan?.adopt.length ?? 0) +
    (plan?.promote.length ?? 0) +
    (plan?.package.length ?? 0);
  const selected =
    pushPicked.size +
    pullPicked.size +
    adoptPicked.size +
    promotePicked.size +
    packagePicked.size;

  const refetchAll = () => {
    qc.invalidateQueries({ queryKey: ["sync-plan"] });
    qc.invalidateQueries({ queryKey: ["skills"] });
  };

  const deselectAll = () => {
    setPushPicked(new Set());
    setPullPicked(new Set());
    setAdoptPicked(new Set());
    setPromotePicked(new Set());
    setPackagePicked(new Set());
  };

  const setRow = (key: string, state: RowState) =>
    setRowStates((prev) => ({ ...prev, [key]: state }));

  const onRun = async () => {
    if (!plan || selected === 0) return;
    setRunning(true);
    setRowStates({});

    let ok = 0;
    let fail = 0;

    // ── Push ──────────────────────────────────────────────────────
    for (const item of plan.push) {
      const k = pushKey(item);
      if (!pushPicked.has(k)) continue;
      setRow(k, { status: "running" });
      try {
        await api.push({
          skill: item.skill,
          provider_id: item.provider_id,
          method: "auto",
        });
        setRow(k, { status: "ok" });
        ok++;
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : "Push failed";
        setRow(k, { status: "error", error: msg });
        fail++;
      }
    }

    // ── Package (Claude Desktop) ──────────────────────────────────
    for (const item of plan.package) {
      const k = packageKey(item);
      if (!packagePicked.has(k)) continue;
      setRow(k, { status: "running" });
      try {
        await api.packageForDesktop(item.skill);
        setRow(k, { status: "ok" });
        ok++;
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : "Package failed";
        setRow(k, { status: "error", error: msg });
        fail++;
      }
    }

    // ── Pull ──────────────────────────────────────────────────────
    for (const item of plan.pull) {
      const k = pullKey(item);
      if (!pullPicked.has(k)) continue;
      setRow(k, { status: "running" });
      try {
        await api.pull({ skill: item.skill, provider_id: item.provider_id });
        setRow(k, { status: "ok" });
        ok++;
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : "Pull failed";
        setRow(k, { status: "error", error: msg });
        fail++;
      }
    }

    // ── Adopt ─────────────────────────────────────────────────────
    const config = await api.getConfig();
    const byId = new Map(config.providers.map((p) => [p.id, p]));

    const adoptByProvider = new Map<string, SyncPlan["adopt"]>();
    for (const a of plan.adopt) {
      if (!adoptPicked.has(adoptKey(a))) continue;
      const list = adoptByProvider.get(a.provider_id) ?? [];
      list.push(a);
      adoptByProvider.set(a.provider_id, list);
    }

    for (const [providerId, items] of adoptByProvider) {
      const provider = byId.get(providerId);
      if (!provider) {
        for (const a of items) {
          setRow(adoptKey(a), {
            status: "error",
            error: `unknown provider ${providerId}`,
          });
        }
        fail += items.length;
        continue;
      }
      for (const a of items) setRow(adoptKey(a), { status: "running" });
      try {
        const r = await api.importAdopt({
          source_path: provider.path,
          skills: items.map((a) => a.name),
          provider_id: providerId,
        });
        const imported = new Set(r.imported);
        for (const a of items) {
          if (imported.has(a.name)) {
            setRow(adoptKey(a), { status: "ok" });
            ok++;
          } else {
            setRow(adoptKey(a), { status: "error", error: "skipped" });
            fail++;
          }
        }
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : "Adopt failed";
        for (const a of items) setRow(adoptKey(a), { status: "error", error: msg });
        fail += items.length;
      }
    }

    // ── Promote ───────────────────────────────────────────────────
    for (const item of plan.promote) {
      if (!promotePicked.has(item.name)) continue;
      setRow(item.name, { status: "running" });
      try {
        await api.updateSkill(item.name, { stage: "production" });
        setRow(item.name, { status: "ok" });
        ok++;
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : "Promote failed";
        setRow(item.name, { status: "error", error: msg });
        fail++;
      }
    }

    setRunning(false);
    const askAiAction = {
      label: "Ask AI",
      onClick: () =>
        openAssistant({
          chips: [
            {
              kind: "failure" as const,
              id: "sync:summary",
              label: `failure: sync (${fail} failed)`,
              data: { operation: "sync", failed: fail, ok },
            },
          ],
          prompt: `${fail} action(s) in my sync run just failed. Look at the recent errors, explain what went wrong, and fix what you safely can.`,
        }),
    };
    if (ok && !fail) toast.success(`Sync complete — ${ok} actions`);
    else if (ok && fail) toast.warning(`${ok} ok, ${fail} failed`, { action: askAiAction });
    else if (fail) toast.error("Sync failed", { action: askAiAction });

    refetchAll();
  };

  return (
    <Layout>
      <div
        className="sv-fade-in"
        style={{ padding: "18px 28px", paddingBottom: selected > 0 ? 72 : 18, maxWidth: 1100 }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 18,
            marginBottom: 18,
          }}
        >
          <div style={{ flex: 1 }}>
            <h1
              style={{
                margin: 0,
                fontSize: 18,
                fontWeight: 600,
                color: "var(--ink)",
              }}
            >
              Sync
            </h1>
            <p
              style={{
                margin: "4px 0 0",
                fontSize: 13,
                color: "var(--ink-2)",
              }}
            >
              Smart two-way sync — pushes drifted skills, pulls provider
              changes, adopts new ones, and promotes staging.
            </p>
          </div>
          <code
            style={{
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "var(--ink-3)",
              background: "var(--surface)",
              padding: "6px 10px",
              borderRadius: 6,
              border: "0.5px solid var(--border)",
            }}
          >
            $ sv sync
          </code>
        </div>

        {isLoading && (
          <div style={{ color: "var(--ink-3)", fontSize: 13, padding: 18 }}>
            Computing plan…
          </div>
        )}

        {plan && total === 0 && (
          <div
            style={{
              background: "var(--surface)",
              border: "0.5px solid var(--border)",
              borderRadius: 8,
              padding: "22px 18px",
              fontSize: 13,
              color: "var(--ink-2)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span style={{ color: "var(--ok)" }}>{Icon.check}</span>
            Everything is in sync.
            <span style={{ flex: 1 }} />
            <Button
              kind="ghost"
              size="sm"
              icon={Icon.refresh}
              onClick={() => refetch()}
            >
              Recheck
            </Button>
          </div>
        )}

        {plan && total > 0 && (
          <>
            <Rule
              label={`Plan — ${total} action${total === 1 ? "" : "s"}`}
              action={
                <span
                  style={{
                    display: "inline-flex",
                    gap: 6,
                    alignItems: "center",
                  }}
                >
                  <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                    {selected} selected
                  </span>
                  <Button
                    kind="ghost"
                    size="sm"
                    icon={Icon.refresh}
                    onClick={() => refetch()}
                    disabled={running}
                  >
                    Refresh
                  </Button>
                </span>
              }
            />

            {/* ── Push ──────────────────────────────────────────── */}
            {plan.push.length > 0 && (
              <Section
                heading={`Push — vault → providers (${plan.push.length})`}
                hint="Skills that drifted or are missing from a target."
                action={<SelectAllControl selection={pushSel} />}
              >
                {plan.push.map((p) => {
                  const k = pushKey(p);
                  return (
                    <PlanRow
                      key={k}
                      checked={pushPicked.has(k)}
                      onSelect={(e) => pushSel.onItemClick(k, e)}
                      onClick={() =>
                        navigate(
                          `/skills/${encodeURIComponent(p.skill)}`,
                        )
                      }
                      kind="push"
                      title={p.skill}
                      sub={
                        <span
                          style={{
                            display: "inline-flex",
                            gap: 6,
                            alignItems: "center",
                          }}
                        >
                          → <ProviderChip slug={p.provider_id} />
                        </span>
                      }
                      badge={
                        <StatusBadge
                          status={
                            p.reason === "missing" ? "missing" : "stale"
                          }
                        />
                      }
                      rowState={rowStates[k]}
                      running={running}
                      onRunOne={async () => {
                        setRow(k, { status: "running" });
                        try {
                          await api.push({
                            skill: p.skill,
                            provider_id: p.provider_id,
                            method: "auto",
                          });
                          setRow(k, { status: "ok" });
                          toast.success(`Pushed ${p.skill}`);
                        } catch (err) {
                          const msg =
                            err instanceof ApiError
                              ? err.message
                              : "Push failed";
                          setRow(k, { status: "error", error: msg });
                          toast.error(msg);
                        }
                        refetchAll();
                      }}
                      onDiff={
                        p.reason === "missing"
                          ? undefined
                          : () => setDiffFor({ skill: p.skill, provider: p.provider_id })
                      }
                      actionLabel="Push"
                    />
                  );
                })}
              </Section>
            )}

            {/* ── Package (Claude Desktop) ──────────────────────── */}
            {plan.package.length > 0 && (
              <Section
                heading={`Package — vault → Claude Desktop (${plan.package.length})`}
                hint="Previously-packaged skills whose upload-ready zip went stale."
                action={<SelectAllControl selection={packageSel} />}
              >
                {plan.package.map((p) => {
                  const k = packageKey(p);
                  return (
                    <PlanRow
                      key={k}
                      checked={packagePicked.has(k)}
                      onSelect={(e) => packageSel.onItemClick(k, e)}
                      onClick={() =>
                        navigate(`/skills/${encodeURIComponent(p.skill)}`)
                      }
                      kind="package"
                      title={p.skill}
                      sub={
                        <span
                          style={{
                            display: "inline-flex",
                            gap: 6,
                            alignItems: "center",
                          }}
                        >
                          → <ProviderChip slug="claude-desktop" /> · re-zip
                        </span>
                      }
                      badge={<StatusBadge status="stale" />}
                      rowState={rowStates[k]}
                      running={running}
                      onRunOne={async () => {
                        setRow(k, { status: "running" });
                        try {
                          await api.packageForDesktop(p.skill);
                          setRow(k, { status: "ok" });
                          toast.success(`Packaged ${p.skill}`);
                        } catch (err) {
                          const msg =
                            err instanceof ApiError
                              ? err.message
                              : "Package failed";
                          setRow(k, { status: "error", error: msg });
                          toast.error(msg);
                        }
                        refetchAll();
                      }}
                      actionLabel="Package"
                    />
                  );
                })}
              </Section>
            )}

            {/* ── Pull ──────────────────────────────────────────── */}
            {plan.pull.length > 0 && (
              <Section
                heading={`Pull — providers → vault (${plan.pull.length})`}
                hint="Provider copies that differ from the vault."
                action={<SelectAllControl selection={pullSel} />}
              >
                {plan.pull.map((p) => {
                  const k = pullKey(p);
                  return (
                    <PlanRow
                      key={k}
                      checked={pullPicked.has(k)}
                      onSelect={(e) => pullSel.onItemClick(k, e)}
                      onClick={() =>
                        navigate(
                          `/skills/${encodeURIComponent(p.skill)}`,
                        )
                      }
                      kind="pull"
                      title={p.skill}
                      sub={
                        <span
                          style={{
                            display: "inline-flex",
                            gap: 6,
                            alignItems: "center",
                          }}
                        >
                          ← <ProviderChip slug={p.provider_id} />
                        </span>
                      }
                      badge={<StatusBadge status="stale" />}
                      rowState={rowStates[k]}
                      running={running}
                      onRunOne={async () => {
                        setRow(k, { status: "running" });
                        try {
                          await api.pull({
                            skill: p.skill,
                            provider_id: p.provider_id,
                          });
                          setRow(k, { status: "ok" });
                          toast.success(`Pulled ${p.skill}`);
                        } catch (err) {
                          const msg =
                            err instanceof ApiError
                              ? err.message
                              : "Pull failed";
                          setRow(k, { status: "error", error: msg });
                          toast.error(msg);
                        }
                        refetchAll();
                      }}
                      onDiff={() => setDiffFor({ skill: p.skill, provider: p.provider_id })}
                      actionLabel="Pull"
                    />
                  );
                })}
              </Section>
            )}

            {/* ── Adopt ─────────────────────────────────────────── */}
            {plan.adopt.length > 0 && (
              <Section
                heading={`Adopt — providers → vault (${plan.adopt.length})`}
                hint="Skills found in your agent dirs that aren't in the vault."
                action={<SelectAllControl selection={adoptSel} />}
              >
                {plan.adopt.map((a) => {
                  const k = adoptKey(a);
                  return (
                    <PlanRow
                      key={k}
                      checked={adoptPicked.has(k)}
                      onSelect={(e) => adoptSel.onItemClick(k, e)}
                      kind="adopt"
                      title={a.name}
                      sub={
                        <span
                          style={{
                            display: "inline-flex",
                            gap: 6,
                            alignItems: "center",
                          }}
                        >
                          from <ProviderChip slug={a.provider_id} /> ·{" "}
                          {a.file_count} files
                        </span>
                      }
                      badge={<StatusBadge status="new" />}
                      rowState={rowStates[k]}
                      running={running}
                      onRunOne={async () => {
                        setRow(k, { status: "running" });
                        const config = await api.getConfig();
                        const provider = config.providers.find(
                          (pr) => pr.id === a.provider_id,
                        );
                        if (!provider) {
                          setRow(k, {
                            status: "error",
                            error: `unknown provider ${a.provider_id}`,
                          });
                          return;
                        }
                        try {
                          await api.importAdopt({
                            source_path: provider.path,
                            skills: [a.name],
                            provider_id: a.provider_id,
                          });
                          setRow(k, { status: "ok" });
                          toast.success(`Adopted ${a.name}`);
                        } catch (err) {
                          const msg =
                            err instanceof ApiError
                              ? err.message
                              : "Adopt failed";
                          setRow(k, { status: "error", error: msg });
                          toast.error(msg);
                        }
                        refetchAll();
                      }}
                      actionLabel="Adopt"
                    />
                  );
                })}
              </Section>
            )}

            {/* ── Promote ───────────────────────────────────────── */}
            {plan.promote.length > 0 && (
              <Section
                heading={`Promote — staging → production (${plan.promote.length})`}
                hint="Staging skills you might want to flip to production."
                action={<SelectAllControl selection={promoteSel} />}
              >
                {plan.promote.map((p) => (
                  <PlanRow
                    key={p.name}
                    checked={promotePicked.has(p.name)}
                    onSelect={(e) => promoteSel.onItemClick(p.name, e)}
                    onClick={() =>
                      navigate(
                        `/skills/${encodeURIComponent(p.name)}`,
                      )
                    }
                    kind="promote"
                    title={p.name}
                    sub="staging → production"
                    badge={<StatusBadge status="staging" />}
                    rowState={rowStates[p.name]}
                    running={running}
                    onRunOne={async () => {
                      setRow(p.name, { status: "running" });
                      try {
                        await api.updateSkill(p.name, {
                          stage: "production",
                        });
                        setRow(p.name, { status: "ok" });
                        toast.success(`Promoted ${p.name}`);
                      } catch (err) {
                        const msg =
                          err instanceof ApiError
                            ? err.message
                            : "Promote failed";
                        setRow(p.name, { status: "error", error: msg });
                        toast.error(msg);
                      }
                      refetchAll();
                    }}
                    actionLabel="Promote"
                  />
                ))}
              </Section>
            )}
          </>
        )}
      </div>

      {/* ── Sticky bottom bulk bar ──────────────────────────────── */}
      {selected > 0 && (
        <div
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 50,
            background: "var(--surface)",
            borderTop: "1px solid var(--border)",
            padding: "10px 28px",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 13,
              fontWeight: 500,
              color: "var(--ink)",
            }}
          >
            {selected} selected
          </span>
          <span style={{ color: "var(--ink-3)", fontSize: 13 }}>·</span>
          <Button
            kind="primary"
            size="sm"
            icon={Icon.arrow}
            onClick={onRun}
            disabled={running}
          >
            {running ? "Running…" : `Run selected`}
          </Button>
          <Button
            kind="ghost"
            size="sm"
            onClick={deselectAll}
            disabled={running}
          >
            Deselect all
          </Button>
        </div>
      )}

      {diffFor && (
        <DiffDrawer
          skillName={diffFor.skill}
          providerId={diffFor.provider}
          onClose={() => setDiffFor(null)}
          onResolved={() => {
            setDiffFor(null);
            refetchAll();
          }}
        />
      )}
    </Layout>
  );
}

// ── helpers ────────────────────────────────────────────────────────

function pushKey(p: SyncPlan["push"][number]): string {
  return `push\0${p.skill}\0${p.provider_id}`;
}
function pullKey(p: SyncPlan["pull"][number]): string {
  return `pull\0${p.skill}\0${p.provider_id}`;
}
function adoptKey(a: SyncPlan["adopt"][number]): string {
  return `adopt\0${a.name}\0${a.provider_id}`;
}
function packageKey(p: SyncPlan["package"][number]): string {
  return `package\0${p.skill}`;
}

// ── section + row components ──────────────────────────────────────

function Section({
  heading,
  hint,
  action,
  children,
}: {
  heading: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 22 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          marginBottom: 8,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 13,
            fontWeight: 600,
            color: "var(--ink)",
          }}
        >
          {heading}
        </h2>
        {hint && (
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{hint}</span>
        )}
        {action && (
          <>
            <span style={{ flex: 1 }} />
            {action}
          </>
        )}
      </div>
      <div
        style={{
          background: "var(--surface)",
          border: "0.5px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </section>
  );
}

function PlanRow({
  checked,
  onSelect,
  onClick,
  kind,
  title,
  sub,
  badge,
  rowState,
  running,
  onRunOne,
  onDiff,
  actionLabel,
}: {
  checked: boolean;
  onSelect: (e: ModifierClick) => void;
  onClick?: () => void;
  kind: "push" | "pull" | "adopt" | "promote" | "package";
  title: string;
  sub: React.ReactNode;
  badge: React.ReactNode;
  rowState?: RowState;
  running: boolean;
  onRunOne: () => void;
  /** When set, renders a "diff" button that previews the change before running. */
  onDiff?: () => void;
  actionLabel: string;
}) {
  const arrow =
    kind === "push"
      ? "↑"
      : kind === "pull"
        ? "↓"
        : kind === "adopt"
          ? "↓"
          : kind === "package"
            ? "▣"
            : "→";
  const arrowColor =
    kind === "push"
      ? "var(--warn)"
      : kind === "pull"
        ? "var(--accent)"
        : kind === "adopt"
          ? "var(--info)"
          : kind === "package"
            ? "var(--warn)"
            : "var(--accent)";

  const st = rowState?.status ?? "idle";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "20px 16px 1fr auto auto",
        gap: 12,
        alignItems: "center",
        padding: "10px 14px",
        borderBottom: "0.5px solid var(--border)",
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        readOnly
        onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
        onClick={(e) => { e.stopPropagation(); onSelect(e); }}
        style={{ accentColor: "var(--accent)" }}
      />
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 14,
          fontWeight: 600,
          color: arrowColor,
        }}
      >
        {arrow}
      </span>
      <div onClick={onClick} style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 13,
            fontWeight: 500,
            color: "var(--ink)",
            marginBottom: 2,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {title}
          {st === "running" && (
            <span
              className="sv-spin"
              style={{ display: "inline-block", fontSize: 12, color: "var(--accent)" }}
            >
              ⟳
            </span>
          )}
          {st === "ok" && (
            <span style={{ color: "var(--ok)", fontSize: 13 }}>{Icon.check}</span>
          )}
          {st === "error" && (
            <>
              <span
                style={{
                  color: "var(--danger)",
                  fontSize: 12,
                  fontFamily: "var(--sans)",
                  fontWeight: 400,
                }}
              >
                ✗ {rowState?.error}
              </span>
              <AskAIButton
                options={{
                  skill: title,
                  chips: [
                    {
                      kind: "failure",
                      id: `sync:${kind}:${title}`,
                      label: `failure: ${kind} failed`,
                      data: { operation: kind, skill: title, error: rowState?.error },
                    },
                  ],
                  prompt: `The ${kind} of "${title}" failed with: ${rowState?.error ?? "unknown error"}. Diagnose and fix it.`,
                }}
              />
            </>
          )}
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{sub}</div>
      </div>
      {badge}
      <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
        {onDiff && (
          <Button kind="ghost" size="sm" onClick={onDiff} disabled={running}>
            diff
          </Button>
        )}
        <Button
          kind="ghost"
          size="sm"
          onClick={() => onRunOne()}
          disabled={running || st === "running" || st === "ok"}
        >
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}
