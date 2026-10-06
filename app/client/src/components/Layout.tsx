import { type ReactNode, useState } from "react";
import { useLocation, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Icon, NavIcon } from "./ui/icons";
import { ActivityDrawer } from "./ActivityDrawer";
import { AssistantPanel } from "./assistant/AssistantPanel";
import { toggleAssistant, useAssistantState, useAssistantWorking } from "../lib/assistantStore";
import { THEME_LABELS, type ThemeName, useTheme } from "../lib/theme";

/**
 * App shell — left sidebar with grouped navigation, main content area.
 *
 * Pages render their own headers/toolbars; this component only owns the
 * frame. Routes are mapped to design groupings:
 *   Overview   → Dashboard, Skills
 *   Daily      → Sync
 *   Discovery  → Adopt
 *   Sharing    → Devices
 *   System     → Settings
 */
export function Layout({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const [theme, setTheme] = useTheme();
  const [activityOpen, setActivityOpen] = useState(false);
  const assistantWorking = useAssistantWorking();
  const assistantMode = useAssistantState().mode;
  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: () => api.getConfig(),
  });
  const { data: skills } = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.listSkills(),
  });

  const counts = {
    skills: skills?.skills.length ?? 0,
  };

  const groups: Array<{
    label: string;
    items: Array<{
      id: string;
      href: string;
      label: string;
      cmd: string;
      count?: number;
    }>;
  }> = [
    {
      label: "Overview",
      items: [
        { id: "dashboard", href: "/", label: "Dashboard", cmd: "sv" },
        { id: "skills", href: "/skills", label: "Skills", cmd: "sv list", count: counts.skills },
      ],
    },
    {
      label: "Daily",
      items: [
        { id: "sync", href: "/sync", label: "Sync", cmd: "sv sync" },
      ],
    },
    {
      label: "Discovery",
      items: [
        { id: "adopt", href: "/adopt", label: "Adopt", cmd: "sv adopt" },
      ],
    },
    {
      label: "Sharing",
      items: [
        { id: "devices", href: "/devices", label: "Devices", cmd: "sv devices" },
      ],
    },
    {
      label: "System",
      items: [
        { id: "settings", href: "/settings", label: "Settings", cmd: "sv init" },
      ],
    },
  ];

  const isActive = (href: string) =>
    href === "/" ? location === "/" : location === href || location.startsWith(`${href}/`);

  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--bg)", color: "var(--ink)" }}>
      <aside
        style={{
          width: 240,
          flexShrink: 0,
          background: "var(--surface)",
          borderRight: "0.5px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          padding: "14px 0",
        }}
      >
        <div style={{ padding: "0 16px 16px", display: "flex", alignItems: "center", gap: 10 }}>
          <button
            onClick={() => navigate("/")}
            style={{
              width: 30,
              height: 30,
              borderRadius: 6,
              background: "var(--ink)",
              color: "var(--bg)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "var(--mono)",
              fontWeight: 700,
              fontSize: 14,
              flexShrink: 0,
              border: 0,
            }}
            title="Skill Vault"
          >
            sv
          </button>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", lineHeight: 1.2 }}>
              Skill Vault
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-3)" }}>
              v0.2.0
            </span>
          </div>
        </div>

        <div className="sv-scroll" style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}>
          {groups.map((g) => (
            <div key={g.label} style={{ marginBottom: 14 }}>
              <div
                style={{
                  padding: "4px 8px",
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  fontWeight: 600,
                  color: "var(--ink-4)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                }}
              >
                {g.label}
              </div>
              {g.items.map((it) => {
                const active = isActive(it.href);
                return (
                  <Link key={it.id} href={it.href}>
                    <a
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        width: "100%",
                        padding: "6px 8px",
                        marginBottom: 1,
                        background: active ? "var(--surface-2)" : "transparent",
                        border: 0,
                        borderRadius: 5,
                        color: active ? "var(--ink)" : "var(--ink-2)",
                        fontSize: 13,
                        fontWeight: active ? 500 : 400,
                        textAlign: "left",
                        cursor: "pointer",
                        position: "relative",
                        textDecoration: "none",
                      }}
                      onMouseEnter={(e) => {
                        if (!active) e.currentTarget.style.background = "var(--surface-2)";
                      }}
                      onMouseLeave={(e) => {
                        if (!active) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      {active && (
                        <span
                          style={{
                            position: "absolute",
                            left: -8,
                            top: 7,
                            bottom: 7,
                            width: 2,
                            background: "var(--accent)",
                            borderRadius: 2,
                          }}
                        />
                      )}
                      <span
                        style={{
                          display: "inline-flex",
                          color: active ? "var(--accent)" : "var(--ink-3)",
                          flexShrink: 0,
                        }}
                      >
                        {NavIcon[it.id]}
                      </span>
                      <span style={{ flex: 1 }}>{it.label}</span>
                      {it.count != null && (
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: 11,
                            color: "var(--ink-3)",
                          }}
                        >
                          {it.count}
                        </span>
                      )}
                    </a>
                  </Link>
                );
              })}
            </div>
          ))}
        </div>

        <div
          style={{
            padding: "10px 16px",
            borderTop: "0.5px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <button
            onClick={toggleAssistant}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 8px",
              border: "0.5px solid var(--border-2)",
              background: assistantMode !== "closed" ? "var(--surface-2)" : "var(--bg)",
              borderRadius: 6,
              cursor: "pointer",
              color: "var(--ink-2)",
              fontSize: 12,
              position: "relative",
            }}
            title="AI assistant (Ctrl+J)"
          >
            <span style={{ display: "inline-flex", color: "var(--accent)" }}>{Icon.sparkle}</span>
            <span style={{ flex: 1, textAlign: "left" }}>Assistant</span>
            {assistantWorking && (
              <span
                className="sv-pulse"
                style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }}
              />
            )}
            <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-4)" }}>⌃J</span>
          </button>
          <button
            onClick={() => setActivityOpen(true)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 8px",
              border: "0.5px solid var(--border-2)",
              background: "var(--bg)",
              borderRadius: 6,
              cursor: "pointer",
              color: "var(--ink-2)",
              fontSize: 12,
            }}
            title="Recent activity"
          >
            <span style={{ display: "inline-flex", color: "var(--ink-3)" }}>{NavIcon.sync}</span>
            <span style={{ flex: 1, textAlign: "left" }}>Activity</span>
          </button>
          <ThemeSwitcher theme={theme} setTheme={setTheme} />
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              color: "var(--ink-3)",
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
            title={config?.vault_path ?? "(not configured)"}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span
                className="sv-pulse"
                style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ok)" }}
              />
              <span>vault</span>
            </div>
            <div
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {config?.vault_path ?? "(not configured)"}
            </div>
          </div>
        </div>
      </aside>

      <main className="sv-scroll" style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
        {children}
      </main>

      <AssistantPanel />

      <ActivityDrawer open={activityOpen} onClose={() => setActivityOpen(false)} />
    </div>
  );
}

function ThemeSwitcher({
  theme,
  setTheme,
}: {
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
}) {
  const options: ThemeName[] = ["warm", "light", "dark"];
  return (
    <div
      style={{
        display: "flex",
        gap: 0,
        background: "var(--bg)",
        border: "0.5px solid var(--border-2)",
        borderRadius: 6,
        padding: 2,
      }}
    >
      {options.map((t) => {
        const active = theme === t;
        return (
          <button
            key={t}
            onClick={() => setTheme(t)}
            title={`${THEME_LABELS[t]} theme`}
            style={{
              flex: 1,
              padding: "3px 0",
              border: 0,
              background: active ? "var(--surface-2)" : "transparent",
              color: active ? "var(--ink)" : "var(--ink-3)",
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              fontWeight: active ? 600 : 400,
              borderRadius: 4,
              cursor: "pointer",
              boxShadow: active ? "0 0 0 0.5px var(--border-2)" : "none",
              textTransform: "lowercase",
              letterSpacing: "0.04em",
            }}
          >
            {THEME_LABELS[t]}
          </button>
        );
      })}
    </div>
  );
}
