import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Icon } from "./ui/icons";
import { KBD } from "./ui/primitives";

/**
 * Cmd/Ctrl+K command palette. Lists routes plus the CLI command they
 * approximate, so a user fluent in `sv` can jump by command name.
 *
 * Mounted once at the App level; opens on ⌘K and closes on Esc / click
 * outside / selection.
 */
const COMMANDS = [
  { cmd: "sv",         label: "Open dashboard",                href: "/",         cat: "navigate" },
  { cmd: "sv list",    label: "List all skills",               href: "/skills",   cat: "navigate" },
  { cmd: "sv sync",    label: "Plan and run two-way sync",     href: "/sync",     cat: "daily" },
  { cmd: "sv adopt",   label: "Discover skills in agent dirs", href: "/adopt",    cat: "discovery" },
  { cmd: "sv scan",    label: "Recursive repo scan",           href: "/adopt",    cat: "discovery" },
  { cmd: "sv init",    label: "Setup wizard",                  href: "/setup",    cat: "system" },
  { cmd: "sv config",  label: "Settings",                      href: "/settings", cat: "system" },
];

export function CommandBar({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (b: boolean) => void;
}) {
  const [, navigate] = useLocation();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Skills for jump-to-skill. Shares the cached ["skills"] query; only
  // fetched once the palette opens.
  const { data: skillsResp } = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.listSkills(),
    enabled: open,
    staleTime: 30000,
  });
  const skills = skillsResp?.skills ?? [];

  useEffect(() => {
    if (open) {
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQ("");
    }
  }, [open]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!open);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, setOpen]);

  const ql = q.trim().toLowerCase();
  type Item = {
    key: string;
    primary: string;
    label: string;
    cat: string;
    onSelect: () => void;
  };
  const cmdItems: Item[] = COMMANDS.filter(
    (c) => !ql || c.cmd.toLowerCase().includes(ql) || c.label.toLowerCase().includes(ql),
  ).map((c) => ({
    key: `cmd:${c.cmd}`,
    primary: c.cmd,
    label: c.label,
    cat: c.cat,
    onSelect: () => navigate(c.href),
  }));
  // Jump-to-skill: only when the user has typed something.
  const skillItems: Item[] = ql
    ? skills
        .filter((s) => s.name.toLowerCase().includes(ql))
        .slice(0, 8)
        .map((s) => ({
          key: `skill:${s.name}`,
          primary: s.name,
          label: s.description || "skill",
          cat: "skill",
          onSelect: () => navigate(`/skills/${encodeURIComponent(s.name)}`),
        }))
    : [];
  const items: Item[] = [...cmdItems, ...skillItems];

  if (!open) return null;
  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "oklch(0.2 0.01 60 / 0.4)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "18vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 580,
          background: "var(--bg)",
          border: "0.5px solid var(--border-2)",
          borderRadius: 10,
          boxShadow: "0 20px 60px oklch(0.2 0.01 60 / 0.3)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "14px 16px",
            borderBottom: "0.5px solid var(--border)",
          }}
        >
          <span style={{ color: "var(--ink-3)" }}>{Icon.search}</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(items.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter" && items[active]) {
                items[active].onSelect();
                setOpen(false);
              }
            }}
            placeholder="Run a command…"
            style={{
              flex: 1,
              border: 0,
              outline: 0,
              fontSize: 14,
              fontFamily: "var(--sans)",
              color: "var(--ink)",
              background: "transparent",
            }}
          />
          <KBD>esc</KBD>
        </div>
        <div className="sv-scroll" style={{ maxHeight: 360, overflowY: "auto", padding: 6 }}>
          {items.length === 0 && (
            <div
              style={{
                padding: "20px 12px",
                textAlign: "center",
                fontSize: 13,
                color: "var(--ink-3)",
              }}
            >
              No matches.
            </div>
          )}
          {items.map((c, i) => (
            <button
              key={c.key}
              onClick={() => {
                c.onSelect();
                setOpen(false);
              }}
              onMouseEnter={() => setActive(i)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                width: "100%",
                padding: "8px 10px",
                background: i === active ? "var(--surface-2)" : "transparent",
                border: 0,
                borderRadius: 6,
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <code
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: c.cat === "skill" ? "var(--ink)" : "var(--accent)",
                  minWidth: 110,
                  maxWidth: 160,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {c.primary}
              </code>
              <span
                style={{
                  flex: 1,
                  fontSize: 13,
                  color: "var(--ink)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {c.label}
              </span>
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  color: "var(--ink-3)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                {c.cat}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
