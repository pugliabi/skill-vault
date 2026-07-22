import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSseReady } from "../lib/sse";
import { timeAgo } from "../lib/status";
import type { ActivityEntry } from "../lib/types";

/**
 * Global slide-in activity feed. Reuses the same `/api/activity` ring
 * buffer + SSE stream the Dashboard consumes, so pushes/pulls/adopts are
 * visible from any page — not just the Dashboard. Read-only.
 */
export function ActivityDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { data } = useQuery({
    queryKey: ["activity"],
    queryFn: () => api.getActivity(),
    enabled: open,
  });
  const sseReady = useSseReady();

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;

  const entries: ActivityEntry[] = data?.entries ?? [];
  const recent = entries.slice(-60).reverse();

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 95,
        background: "oklch(0.15 0.005 60 / 0.4)",
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        style={{
          width: 380,
          maxWidth: "90vw",
          height: "100%",
          background: "var(--bg)",
          borderLeft: "0.5px solid var(--border-2)",
          display: "flex",
          flexDirection: "column",
          boxShadow: "-8px 0 30px oklch(0.1 0.01 60 / 0.2)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 18px",
            borderBottom: "0.5px solid var(--border)",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
            Activity
          </h3>
          <span style={{ flex: 1 }} />
          <button
            onClick={onClose}
            style={{
              border: "0.5px solid var(--border-2)",
              background: "var(--surface)",
              borderRadius: 6,
              width: 26,
              height: 26,
              cursor: "pointer",
              color: "var(--ink-2)",
            }}
          >
            ×
          </button>
        </div>

        <div
          className="sv-scroll"
          style={{ flex: 1, overflowY: "auto", fontFamily: "var(--mono)", fontSize: 12 }}
        >
          {!sseReady ? (
            <div style={{ padding: 18, color: "var(--ink-3)" }} aria-busy="true">
              Connecting…
            </div>
          ) : recent.length === 0 ? (
            <div style={{ padding: 18, color: "var(--ink-3)" }}>No recent activity.</div>
          ) : (
            recent.map((e, i) => (
              <div
                key={`${e.at}-${i}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 16px 1fr",
                  gap: 8,
                  alignItems: "baseline",
                  padding: "8px 18px",
                  borderBottom: "0.5px solid var(--border)",
                }}
              >
                <span style={{ color: "var(--ink-3)", whiteSpace: "nowrap" }} title={e.at}>
                  {timeAgo(e.at)}
                </span>
                <span style={{ color: e.ok ? "var(--ok)" : "var(--bad)", fontWeight: 600, textAlign: "center" }}>
                  {e.ok ? "✓" : "✗"}
                </span>
                <span style={{ color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis" }}>
                  <span style={{ color: "var(--ink-2)" }}>{e.kind}</span> {e.skill}
                  {e.provider_id ? ` → ${e.provider_id}` : ""}
                  {e.message ? <span style={{ color: "var(--ink-3)" }}>{` · ${e.message}`}</span> : null}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
