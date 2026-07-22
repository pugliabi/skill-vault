import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { api } from "../lib/api";
import { Layout } from "../components/Layout";
import type { Skill } from "../lib/types";

/**
 * Graph page — SVG visualization of vault-to-provider topology.
 * Center "vault" node with provider ring nodes; edge thickness
 * proportional to skill count targeting that provider; edge color
 * reflects aggregate sync status.
 */
export default function Graph() {
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: () => api.getConfig() });
  const { data: skillsResp } = useQuery({ queryKey: ["skills"], queryFn: () => api.listSkills() });
  const [, navigate] = useLocation();

  const providers = config?.providers ?? [];
  const skills = skillsResp?.skills ?? [];

  const graphData = useMemo(() => {
    return providers.map((p) => {
      const targeting = skills.filter((s) => s.targets.includes(p.id));
      let synced = 0, stale = 0, missing = 0;
      for (const s of targeting) {
        const st = s.target_status[p.id];
        if (st === "synced") synced++;
        else if (st === "stale") stale++;
        else if (st === "missing") missing++;
      }
      const total = targeting.length;
      const status: "ok" | "warn" | "neutral" =
        total === 0 ? "neutral"
        : stale > 0 || missing > 0 ? "warn"
        : "ok";
      return { id: p.id, count: total, synced, stale, missing, status };
    });
  }, [providers, skills]);

  const cx = 400, cy = 300;
  const radius = 200;
  const nodeR = 40;

  return (
    <Layout>
      <div className="sv-fade-in" style={{ padding: "32px 28px", height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--ink)", letterSpacing: "-0.01em" }}>
            Topology
          </h1>
          <code style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-4)" }}>
            {skills.length} skills → {providers.length} providers
          </code>
        </div>

        {providers.length === 0 ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-3)", fontSize: 13 }}>
            No providers configured. Add one in Settings to see the topology.
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg
              viewBox="0 0 800 600"
              style={{ width: "100%", maxWidth: 800, maxHeight: 500 }}
            >
              {/* Edges */}
              {graphData.map((node, i) => {
                const angle = (2 * Math.PI * i) / graphData.length - Math.PI / 2;
                const nx = cx + radius * Math.cos(angle);
                const ny = cy + radius * Math.sin(angle);
                const thickness = Math.max(1.5, Math.min(8, node.count * 1.5));
                const color = node.status === "ok" ? "var(--ok)"
                  : node.status === "warn" ? "var(--warn)"
                  : "var(--border-2)";
                return (
                  <line
                    key={`edge-${node.id}`}
                    x1={cx}
                    y1={cy}
                    x2={nx}
                    y2={ny}
                    stroke={color}
                    strokeWidth={thickness}
                    strokeLinecap="round"
                    opacity={0.6}
                    style={{ cursor: "pointer" }}
                    onClick={() =>
                      navigate(
                        `/skills?target=${encodeURIComponent(node.id)}&targetState=${node.status === "warn" ? "missing" : "configured"}`,
                      )
                    }
                  >
                    <title>{node.count} skills → {node.id}</title>
                  </line>
                );
              })}

              {/* Center vault node */}
              <circle cx={cx} cy={cy} r={nodeR + 10} fill="var(--surface)" stroke="var(--border-2)" strokeWidth="1" />
              <circle cx={cx} cy={cy} r={nodeR} fill="var(--ink)" />
              <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fill="var(--bg)" fontSize="14" fontWeight="700" fontFamily="var(--mono)">
                vault
              </text>
              <text x={cx} y={cy + 20} textAnchor="middle" dominantBaseline="middle" fill="var(--bg)" fontSize="10" fontFamily="var(--mono)" opacity="0.7">
                {skills.length}
              </text>

              {/* Provider nodes */}
              {graphData.map((node, i) => {
                const angle = (2 * Math.PI * i) / graphData.length - Math.PI / 2;
                const nx = cx + radius * Math.cos(angle);
                const ny = cy + radius * Math.sin(angle);
                const fill = node.status === "ok" ? "var(--ok)"
                  : node.status === "warn" ? "var(--warn)"
                  : "var(--neutral)";
                return (
                  <g
                    key={`node-${node.id}`}
                    style={{ cursor: "pointer" }}
                    onClick={() =>
                      navigate(
                        `/skills?target=${encodeURIComponent(node.id)}&targetState=${node.status === "warn" ? "missing" : "configured"}`,
                      )
                    }
                  >
                    <circle cx={nx} cy={ny} r={30} fill="var(--surface)" stroke={fill} strokeWidth="2" />
                    <text x={nx} y={ny - 4} textAnchor="middle" dominantBaseline="middle" fill="var(--ink)" fontSize="11" fontWeight="500" fontFamily="var(--mono)">
                      {node.id}
                    </text>
                    <text x={nx} y={ny + 12} textAnchor="middle" dominantBaseline="middle" fill="var(--ink-3)" fontSize="10" fontFamily="var(--mono)">
                      {node.count}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        )}

        {/* Legend */}
        <div style={{ display: "flex", gap: 16, justifyContent: "center", padding: "12px 0", borderTop: "0.5px solid var(--border)" }}>
          {[
            { color: "var(--ok)", label: "synced" },
            { color: "var(--warn)", label: "stale/missing" },
            { color: "var(--neutral)", label: "no skills" },
          ].map((l) => (
            <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--ink-3)" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: l.color }} />
              {l.label}
            </div>
          ))}
          <div style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "var(--mono)" }}>
            edge thickness = skill count
          </div>
        </div>
      </div>
    </Layout>
  );
}
