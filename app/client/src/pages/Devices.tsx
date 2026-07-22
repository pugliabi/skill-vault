import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { api } from "../lib/api";
import { Layout } from "../components/Layout";
import { Button } from "../components/ui/primitives";
import { timeAgo } from "../lib/status";

export default function Devices() {
  const params = useParams<{ name?: string }>();
  if (params.name) return <DeviceCompare deviceName={params.name} />;
  return <DeviceList />;
}

function DeviceList() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["devices"],
    queryFn: () => api.listDevices(),
  });

  const saveMut = useMutation({
    mutationFn: () => api.saveSnapshot(),
    onSuccess: () => {
      toast.success("Snapshot saved");
      qc.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (err) => toast.error(String(err)),
  });

  const deleteMut = useMutation({
    mutationFn: (name: string) => api.deleteDevice(name),
    onSuccess: () => {
      toast.success("Device snapshot deleted");
      qc.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (err) => toast.error(String(err)),
  });

  const devices = data?.devices ?? [];
  const current = devices.find((d) => d.is_current);
  const others = devices.filter((d) => !d.is_current);

  return (
    <Layout>
      <div className="sv-fade-in" style={{ maxWidth: 900, margin: "0 auto", padding: "32px 28px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--ink)", letterSpacing: "-0.01em" }}>
            Devices
          </h1>
          <code style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-4)" }}>
            $ sv devices
          </code>
        </div>

        {isLoading ? (
          <div style={{ color: "var(--ink-3)", fontSize: 13 }}>Loading…</div>
        ) : devices.length === 0 ? (
          <EmptyState onSave={() => saveMut.mutate()} saving={saveMut.isPending} />
        ) : (
          <>
            {/* Current device card */}
            {current && (
              <div
                style={{
                  padding: "16px 20px",
                  background: "var(--surface)",
                  border: "0.5px solid var(--border-2)",
                  borderRadius: 8,
                  marginBottom: 24,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
                    {current.machine_id}
                  </span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ok)", background: "color-mix(in oklab, var(--ok) 12%, transparent)", padding: "1px 6px", borderRadius: 3 }}>
                    this device
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 12 }}>
                  {current.skill_count} skills · saved {timeAgo(current.timestamp)}
                </div>
                <Button
                  kind="primary"
                  size="sm"
                  onClick={() => saveMut.mutate()}
                  disabled={saveMut.isPending}
                >
                  {saveMut.isPending ? "Saving…" : "Save snapshot"}
                </Button>
              </div>
            )}

            {/* Other devices */}
            {others.length > 0 && (
              <div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, marginBottom: 10 }}>
                  Other devices
                </div>
                {others.map((d) => (
                  <div
                    key={d.machine_id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "12px 16px",
                      background: "var(--surface)",
                      border: "0.5px solid var(--border)",
                      borderRadius: 6,
                      marginBottom: 6,
                    }}
                  >
                    <a
                      href={`/devices/${encodeURIComponent(d.machine_id)}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        flex: 1,
                        textDecoration: "none",
                        color: "var(--ink)",
                      }}
                    >
                      <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 500, flex: 1 }}>
                        {d.machine_id}
                      </span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)" }}>
                        {d.skill_count} skills
                      </span>
                      <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        {timeAgo(d.timestamp)}
                      </span>
                      <span style={{ color: "var(--accent)", fontSize: 12 }}>Sync from →</span>
                    </a>
                    <button
                      onClick={() => {
                        if (window.confirm(`Delete snapshot for "${d.machine_id}"?`)) {
                          deleteMut.mutate(d.machine_id);
                        }
                      }}
                      disabled={deleteMut.isPending}
                      style={{
                        border: 0,
                        background: "transparent",
                        color: "var(--ink-3)",
                        cursor: "pointer",
                        padding: 4,
                        fontSize: 14,
                        lineHeight: 1,
                      }}
                      title="Delete snapshot"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!current && (
              <div style={{ marginTop: 16 }}>
                <Button kind="primary" size="sm" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
                  Save snapshot for this device
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}

type SyncDecision = "pull" | "keep" | "skip";

function defaultDecision(status: string): SyncDecision {
  if (status === "remote_only" || status === "diverged") return "pull";
  if (status === "local_only") return "keep";
  return "skip";
}

function DeviceCompare({ deviceName }: { deviceName: string }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["devices", deviceName, "compare"],
    queryFn: () => api.compareDevice(deviceName),
  });

  const comparisons = data?.comparisons ?? [];

  const [decisions, setDecisions] = useState<Record<string, SyncDecision>>({});

  const effectiveDecision = (skill: string, status: string): SyncDecision =>
    decisions[skill] ?? defaultDecision(status);

  const setDecision = (skill: string, d: SyncDecision) =>
    setDecisions((prev) => ({ ...prev, [skill]: d }));

  const actionable = comparisons.filter(
    (c) => effectiveDecision(c.skill, c.status) !== "skip",
  );

  const syncMut = useMutation({
    mutationFn: () =>
      api.syncFromDevice(
        deviceName,
        comparisons.map((c) => ({
          skill: c.skill,
          action: effectiveDecision(c.skill, c.status),
        })),
      ),
    onSuccess: (res) => {
      toast.success(`Applied ${res.applied.length} changes`);
      qc.invalidateQueries({ queryKey: ["devices"] });
      qc.invalidateQueries({ queryKey: ["skills"] });
      navigate("/devices");
    },
    onError: (err) => toast.error(String(err)),
  });

  const decisionColors: Record<SyncDecision, string> = {
    pull: "var(--info)",
    keep: "var(--ok)",
    skip: "var(--ink-4)",
  };

  return (
    <Layout>
      <div className="sv-fade-in" style={{ maxWidth: 1000, margin: "0 auto", padding: "32px 28px" }}>
        <div style={{ marginBottom: 20 }}>
          <a href="/devices" style={{ fontSize: 12, color: "var(--ink-3)", textDecoration: "none" }}>
            ← Devices
          </a>
          <h1 style={{ margin: "8px 0 0", fontSize: 18, fontWeight: 600, color: "var(--ink)" }}>
            Sync from {deviceName}
          </h1>
        </div>

        {isLoading ? (
          <div style={{ color: "var(--ink-3)", fontSize: 13 }}>Comparing…</div>
        ) : comparisons.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--ink-3)", fontSize: 13 }}>
            Both devices are in sync. No differences found.
          </div>
        ) : (
          <>
            <div style={{ border: "0.5px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 90px 90px 100px 110px",
                  gap: 8,
                  padding: "10px 16px",
                  background: "var(--surface)",
                  borderBottom: "0.5px solid var(--border)",
                  fontFamily: "var(--mono)",
                  fontSize: 10.5,
                  color: "var(--ink-3)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  fontWeight: 600,
                }}
              >
                <span>Skill</span>
                <span>Local</span>
                <span>Remote</span>
                <span>Status</span>
                <span>Action</span>
              </div>
              {comparisons.map((c) => {
                const dec = effectiveDecision(c.skill, c.status);
                return (
                  <div
                    key={c.skill}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 90px 90px 100px 110px",
                      gap: 8,
                      padding: "10px 16px",
                      borderBottom: "0.5px solid var(--border)",
                      fontSize: 13,
                      opacity: dec === "skip" ? 0.5 : 1,
                    }}
                  >
                    <span style={{ fontFamily: "var(--mono)", color: "var(--ink)" }}>{c.skill}</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)" }}>
                      {c.local_stage ?? "—"}
                    </span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)" }}>
                      {c.remote_stage ?? "—"}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 11,
                        fontWeight: 500,
                        color: c.status === "same" ? "var(--ok)"
                          : c.status === "remote_only" ? "var(--info)"
                          : c.status === "local_only" ? "var(--neutral)"
                          : "var(--warn)",
                      }}
                    >
                      {c.status === "same" ? "synced"
                        : c.status === "remote_only" ? "← pull"
                        : c.status === "local_only" ? "local only"
                        : "diverged"}
                    </span>
                    <select
                      value={dec}
                      onChange={(e) => setDecision(c.skill, e.target.value as SyncDecision)}
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 11,
                        color: decisionColors[dec],
                        background: "var(--surface)",
                        border: "0.5px solid var(--border-2)",
                        borderRadius: 4,
                        padding: "2px 4px",
                        height: 24,
                        cursor: "pointer",
                      }}
                    >
                      <option value="pull">pull</option>
                      <option value="keep">keep</option>
                      <option value="skip">skip</option>
                    </select>
                  </div>
                );
              })}
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
              <Button
                kind="primary"
                size="md"
                onClick={() => syncMut.mutate()}
                disabled={actionable.length === 0 || syncMut.isPending}
              >
                {syncMut.isPending ? "Applying…" : `Apply ${actionable.length} change${actionable.length !== 1 ? "s" : ""}`}
              </Button>
              <Button kind="ghost" size="md" onClick={() => navigate("/devices")}>
                Cancel
              </Button>
              <span style={{ fontSize: 12, color: "var(--ink-3)", marginLeft: 8 }}>
                {actionable.length} actionable · {comparisons.length - actionable.length} skipped
              </span>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

function EmptyState({ onSave, saving }: { onSave: () => void; saving: boolean }) {
  return (
    <div
      style={{
        marginTop: 48,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 16,
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 12,
          background: "var(--surface)",
          border: "0.5px solid var(--border-2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 24,
          color: "var(--ink-3)",
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 500, color: "var(--ink)", marginBottom: 6 }}>
          No device snapshots yet
        </div>
        <div style={{ fontSize: 13, color: "var(--ink-3)", maxWidth: 360, lineHeight: 1.5 }}>
          Snapshots capture your vault's state so other machines can sync from it.
          Save one to get started.
        </div>
      </div>
      <Button kind="primary" size="md" onClick={onSave} disabled={saving}>
        {saving ? "Saving…" : "Save first snapshot"}
      </Button>
    </div>
  );
}
