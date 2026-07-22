import { useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSseReady } from "../lib/sse";
import { timeAgo } from "../lib/status";
import type { ActivityEntry } from "../lib/types";
import { Layout } from "../components/Layout";
import { Icon } from "../components/ui/icons";
import {
  Button,
  Rule,
  SkillCount,
  STATUS_META,
} from "../components/ui/primitives";

/**
 * Dashboard — mirrors `sv` with no args: a glanceable banner, "what's
 * actionable right now", and provider/status overviews.
 *
 * Data comes from the same /api/skills + /api/config the rest of the
 * app uses; nothing is mocked. Fields the design exposes that we can't
 * compute yet (drift "stale" count, recent activity feed) are simply
 * omitted rather than faked.
 */
export default function Dashboard() {
  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: () => api.getConfig(),
  });
  const { data: skillsResp } = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.listSkills(),
  });
  const { data: activityResp } = useQuery({
    queryKey: ["activity"],
    queryFn: () => api.getActivity(),
  });
  const sseReady = useSseReady();

  const skills = skillsResp?.skills ?? [];
  const activity: ActivityEntry[] = activityResp?.entries ?? [];
  // Newest first, max 12 — server appends in chronological order.
  const recentActivity = activity.slice(-12).reverse();
  const counts = useMemo(() => {
    let synced = 0;
    let staging = 0;
    let stale = 0;
    let vaultOnly = 0;
    let missing = 0;
    for (const s of skills) {
      switch (s.status) {
        case "synced":     synced++;     break;
        case "staging":    staging++;    break;
        case "stale":      stale++;      break;
        case "vault-only": vaultOnly++;  break;
        case "missing":    missing++;    break;
      }
    }
    return {
      total: skills.length,
      synced,
      staging,
      stale,
      vaultOnly,
      missing,
      providers: config?.providers.length ?? 0,
    };
  }, [skills, config]);

  type Priority = "warn" | "info" | "bad" | "normal";
  const actions: Array<{
    id: string;
    label: string;
    sub: string;
    href: string;
    priority: Priority;
    show: boolean;
  }> = (
    [
      {
        id: "stale",
        label: `${counts.stale} skill${counts.stale === 1 ? "" : "s"} drifted — re-push to update`,
        sub: "sv push",
        href: "/skills?filter=stale",
        priority: "warn",
        show: counts.stale > 0,
      },
      {
        id: "missing",
        label: `${counts.missing} skill${counts.missing === 1 ? "" : "s"} missing from a target — push to restore`,
        sub: "sv push",
        href: "/skills",
        priority: "bad",
        show: counts.missing > 0,
      },
      {
        id: "vault-only",
        label: `${counts.vaultOnly} skill${counts.vaultOnly === 1 ? "" : "s"} not pushed anywhere`,
        sub: "sv push",
        href: "/skills",
        priority: "info",
        show: counts.vaultOnly > 0,
      },
      {
        id: "promote",
        label: `${counts.staging} staging skill${counts.staging === 1 ? "" : "s"} ready to review`,
        sub: "sv promote",
        href: "/skills",
        priority: "info",
        show: counts.staging > 0,
      },
      {
        id: "providers",
        label: "Add a provider to start pushing skills",
        sub: "sv config set agent_locations.<id> <path>",
        href: "/settings",
        priority: "warn",
        show: counts.providers === 0,
      },
      {
        id: "vault",
        label: "Configure your vault",
        sub: "sv init",
        href: "/setup",
        priority: "bad",
        show: !config?.vault_path,
      },
    ] satisfies Array<{
      id: string;
      label: string;
      sub: string;
      href: string;
      priority: Priority;
      show: boolean;
    }>
  ).filter((a) => a.show);

  return (
    <Layout>
      <div className="sv-fade-in" style={{ padding: "20px 28px", maxWidth: 1100 }}>
        {/* Banner */}
        <div
          style={{
            background: "var(--surface)",
            border: "0.5px solid var(--border)",
            borderRadius: 10,
            padding: "18px 22px",
            display: "flex",
            alignItems: "center",
            gap: 24,
            marginBottom: 22,
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)", marginBottom: 4 }}>
              ╭─ Skill Vault ─╮
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 18, fontSize: 13, color: "var(--ink-2)" }}>
              <SkillCount n={counts.total} label="skills" />
              <span style={{ color: "var(--border-2)" }}>·</span>
              <SkillCount n={counts.providers} label="providers" />
              <span style={{ color: "var(--border-2)" }}>·</span>
              <SkillCount n={counts.synced} label="pushed" />
            </div>
          </div>
          <Link href="/adopt">
            <a style={{ textDecoration: "none" }}>
              <Button kind="primary" size="md" icon={Icon.refresh}>
                Discover
              </Button>
            </a>
          </Link>
        </div>

        {/* Quick actions */}
        {actions.length > 0 && (
          <section style={{ marginBottom: 28 }}>
            <Rule label={`${actions.length} action${actions.length === 1 ? "" : "s"} available`} />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {actions.map((a) => (
                <Link key={a.id} href={a.href}>
                  <a
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "12px 16px",
                      textAlign: "left",
                      background: "var(--surface)",
                      border: "0.5px solid var(--border)",
                      borderRadius: 8,
                      cursor: "pointer",
                      transition: "all 120ms",
                      textDecoration: "none",
                      color: "inherit",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--surface-2)";
                      e.currentTarget.style.borderColor = "var(--border-2)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "var(--surface)";
                      e.currentTarget.style.borderColor = "var(--border)";
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 14,
                        fontWeight: 600,
                        color:
                          a.priority === "warn"
                            ? "var(--warn)"
                            : a.priority === "bad"
                              ? "var(--bad)"
                              : a.priority === "info"
                                ? "var(--info)"
                                : "var(--accent)",
                      }}
                    >
                      ❯
                    </span>
                    <span style={{ flex: 1, fontSize: 13.5, color: "var(--ink)" }}>{a.label}</span>
                    <code
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 11.5,
                        color: "var(--ink-3)",
                        background: "var(--surface-2)",
                        padding: "2px 7px",
                        borderRadius: 4,
                        border: "0.5px solid var(--border)",
                      }}
                    >
                      {a.sub}
                    </code>
                    <span style={{ color: "var(--ink-3)", display: "inline-flex" }}>{Icon.chevron}</span>
                  </a>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Status grid */}
        <section style={{ marginBottom: 28 }}>
          <Rule label="Status" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
            {[
              { label: "synced",     n: counts.synced,    status: "synced" as const,     href: "/skills" },
              { label: "stale",      n: counts.stale,     status: "stale" as const,      href: "/skills?filter=stale" },
              { label: "missing",    n: counts.missing,   status: "missing" as const,    href: "/skills?filter=missing" },
              { label: "staging",    n: counts.staging,   status: "staging" as const,    href: "/skills?filter=staging" },
              { label: "vault-only", n: counts.vaultOnly, status: "vault-only" as const, href: "/skills?filter=vault-only" },
            ].map((c) => (
              <Link key={c.label} href={c.href}>
                <a
                  style={{
                    background: "var(--surface)",
                    border: "0.5px solid var(--border)",
                    borderRadius: 8,
                    padding: "14px 16px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    textDecoration: "none",
                    color: "inherit",
                    transition: "border-color 120ms",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--border-2)")}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span
                      style={{
                        fontSize: 11.5,
                        color: "var(--ink-3)",
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                        fontWeight: 600,
                        fontFamily: "var(--mono)",
                      }}
                    >
                      {c.label}
                    </span>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: STATUS_META[c.status].dot,
                      }}
                    />
                  </div>
                  <div
                    style={{
                      fontSize: 28,
                      fontWeight: 600,
                      color: "var(--ink)",
                      fontVariantNumeric: "tabular-nums",
                      letterSpacing: "-0.02em",
                      fontFamily: "var(--sans)",
                    }}
                  >
                    {c.n}
                  </div>
                </a>
              </Link>
            ))}
          </div>
        </section>

        {/* Providers */}
        <section>
          <Rule label="Providers" />
          {!config?.providers.length ? (
            <div
              style={{
                background: "var(--surface)",
                border: "0.5px solid var(--border)",
                borderRadius: 8,
                padding: "14px 16px",
                fontSize: 13,
                color: "var(--ink-2)",
              }}
            >
              No providers configured. Add one in{" "}
              <Link href="/settings">
                <a style={{ color: "var(--accent)", textDecoration: "none" }}>Settings</a>
              </Link>{" "}
              to start pushing skills.
            </div>
          ) : (
            <div
              style={{
                background: "var(--surface)",
                border: "0.5px solid var(--border)",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              {config.providers.map((p, i, arr) => {
                const targeting = skills.filter((s) => s.targets.includes(p.id));
                const total = targeting.length;
                const synced = targeting.filter((s) => s.target_status[p.id] === "synced").length;
                const pct = total > 0 ? synced / total : 0;
                const behind = total - synced;
                const barColor = behind === 0 ? "var(--ok)" : pct >= 0.5 ? "var(--warn)" : "var(--bad)";
                // Click → Skills filtered to what's missing/stale in this provider.
                const href =
                  behind > 0
                    ? `/skills?target=${encodeURIComponent(p.id)}&targetState=missing`
                    : `/skills?target=${encodeURIComponent(p.id)}&targetState=configured`;
                return (
                  <Link key={p.id} href={href}>
                    <a
                      title={`${p.path}\n${behind} not yet pushed to ${p.id}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "9px 14px",
                        borderBottom: i < arr.length - 1 ? "0.5px solid var(--border)" : "none",
                        textDecoration: "none",
                        color: "inherit",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <span style={{ fontSize: 13, color: "var(--ink)", width: 120, flexShrink: 0 }}>
                        {p.id}
                      </span>
                      {/* Health bar */}
                      <span
                        style={{
                          flex: 1,
                          height: 6,
                          borderRadius: 3,
                          background: "var(--surface-2)",
                          overflow: "hidden",
                        }}
                      >
                        <span
                          style={{
                            display: "block",
                            height: "100%",
                            width: `${Math.round(pct * 100)}%`,
                            background: barColor,
                            transition: "width 200ms",
                          }}
                        />
                      </span>
                      <span
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 11,
                          color: "var(--ink-3)",
                          width: 68,
                          textAlign: "right",
                          flexShrink: 0,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {synced}/{total} synced
                      </span>
                    </a>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        {/* Activity */}
        <section style={{ marginTop: 28 }}>
          <Rule label="Activity" />
          {!sseReady ? (
            // SSE not yet open — render a quiet placeholder, NOT the empty state.
            // This avoids the "No recent activity" string flashing during the
            // initial connect race (per 01-CONTEXT.md decisions).
            <div
              style={{
                background: "var(--surface)",
                border: "0.5px solid var(--border)",
                borderRadius: 8,
                padding: "14px 16px",
                fontSize: 13,
                color: "var(--ink-3)",
                fontFamily: "var(--mono)",
              }}
              aria-busy="true"
            >
              Connecting…
            </div>
          ) : recentActivity.length === 0 ? (
            <div
              style={{
                background: "var(--surface)",
                border: "0.5px solid var(--border)",
                borderRadius: 8,
                padding: "14px 16px",
                fontSize: 13,
                color: "var(--ink-3)",
                fontFamily: "var(--mono)",
              }}
            >
              No recent activity
            </div>
          ) : (
            <div
              style={{
                background: "var(--surface)",
                border: "0.5px solid var(--border)",
                borderRadius: 8,
                overflow: "hidden",
                fontFamily: "var(--mono)",
                fontSize: 12,
              }}
            >
              {recentActivity.map((e, i, arr) => (
                <div
                  key={`${e.at}-${i}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 16px 80px 1fr",
                    alignItems: "baseline",
                    gap: 10,
                    padding: "8px 14px",
                    borderBottom:
                      i < arr.length - 1 ? "0.5px solid var(--border)" : "none",
                  }}
                >
                  <span
                    style={{ color: "var(--ink-3)", whiteSpace: "nowrap" }}
                    title={e.at}
                  >
                    {timeAgo(e.at)}
                  </span>
                  <span
                    style={{
                      color: e.ok ? "var(--ok)" : "var(--bad)",
                      fontWeight: 600,
                      textAlign: "center",
                    }}
                  >
                    {e.ok ? "✓" : "✗"}
                  </span>
                  <span style={{ color: "var(--ink-2)" }}>{e.kind}</span>
                  <span
                    style={{
                      color: "var(--ink)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {e.skill}
                    {e.provider_id ? ` → ${e.provider_id}` : ""}
                    {e.message ? (
                      <span
                        style={{ color: "var(--ink-3)" }}
                      >{` · ${e.message}`}</span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Layout>
  );
}
