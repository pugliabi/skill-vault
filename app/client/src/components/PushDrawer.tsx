import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Icon } from "./ui/icons";
import { Button } from "./ui/primitives";
import { useChecklistSelection } from "./Checklist";
import type { LinkMethod, SkillDetail } from "../lib/types";

/**
 * Drawer for pushing one or more skills to selected providers.
 *
 * - Single-skill mode (skills.length === 1): seeds picked targets from
 *   the skill's existing targets list, shows per-target sync status badge.
 * - Bulk mode (skills.length > 1): seeds picked = all providers, no
 *   per-target sync badge (would be ambiguous across N skills).
 *
 * On push, runs `Promise.allSettled` over `skills × pickedTargets`
 * pairs, then toast-summarizes successes/failures per skill.
 */
export function PushDrawer({
  skills,
  onClose,
  onSuccess,
}: {
  skills: string[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const isBulk = skills.length > 1;
  const singleName = skills[0];

  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: () => api.getConfig(),
  });
  const { data: skill } = useQuery<SkillDetail>({
    queryKey: ["skill", singleName],
    queryFn: () => api.getSkill(singleName),
    enabled: !isBulk && !!singleName,
  });
  const providers = config?.providers ?? [];
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [method, setMethod] = useState<LinkMethod>("auto");
  const [pushing, setPushing] = useState(false);

  useEffect(() => {
    if (providers.length === 0 || picked.size > 0) return;
    if (isBulk) {
      setPicked(new Set(providers.map((p) => p.id)));
      return;
    }
    if (!skill) return;
    const seed = skill.targets.length > 0 ? skill.targets : providers.map((p) => p.id);
    setPicked(new Set(seed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill, providers.length, isBulk]);

  const sel = useChecklistSelection(providers.map((p) => p.id), picked, setPicked);

  const onPush = async () => {
    if (picked.size === 0) return;
    setPushing(true);

    type R = { skill: string; provider: string; ok: boolean; msg: string };
    const tasks: Array<Promise<R>> = [];
    for (const skillName of skills) {
      for (const id of picked) {
        tasks.push(
          api
            .push({ skill: skillName, provider_id: id, method })
            .then<R>((r) => ({ skill: skillName, provider: id, ok: true, msg: r.method }))
            .catch<R>((err) => ({
              skill: skillName,
              provider: id,
              ok: false,
              msg: err instanceof ApiError ? err.message : String(err),
            })),
        );
      }
    }

    const results = await Promise.all(tasks);
    setPushing(false);

    const ok = results.filter((r) => r.ok);
    const fail = results.filter((r) => !r.ok);

    if (isBulk) {
      if (ok.length) toast.success(`Pushed ${ok.length} link${ok.length === 1 ? "" : "s"} across ${skills.length} skills`);
      if (fail.length) toast.error(`${fail.length} push${fail.length === 1 ? "" : "es"} failed`);
    } else {
      if (ok.length) toast.success(`Pushed to ${ok.map((r) => r.provider).join(", ")}`);
      for (const f of fail) toast.error(`${f.provider}: ${f.msg}`);
    }

    // Single-skill mode: merge any newly-pushed targets back into the
    // skill's targets list so the UI reflects the wired-up providers.
    // Bulk mode skips this — the server's push route already updates
    // each manifest entry's targets on success.
    if (!isBulk && skill && ok.length) {
      const existing = new Set(skill.targets);
      const merged = Array.from(new Set([...skill.targets, ...ok.map((r) => r.provider)]));
      if (merged.length !== existing.size) {
        try {
          await api.updateSkill(singleName, { targets: merged });
        } catch {
          /* non-fatal */
        }
      }
    }

    onSuccess();
  };

  const headerLabel = isBulk
    ? `Push ${skills.length} skills`
    : (
      <>
        Push <code style={{ fontFamily: "var(--mono)" }}>{singleName}</code>
      </>
    );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "oklch(0.2 0.01 60 / 0.4)",
          backdropFilter: "blur(2px)",
        }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal
        style={{
          position: "relative",
          marginLeft: "auto",
          width: 460,
          maxWidth: "100%",
          height: "100%",
          background: "var(--bg)",
          borderLeft: "0.5px solid var(--border-2)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            height: 56,
            flexShrink: 0,
            borderBottom: "0.5px solid var(--border)",
            padding: "0 22px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
            {headerLabel}
          </span>
          <Button kind="ghost" size="sm" icon={Icon.x} onClick={onClose}>
            Close
          </Button>
        </header>

        <div className="sv-scroll" style={{ flex: 1, overflowY: "auto", padding: 22 }}>
          {isBulk && (
            <div
              style={{
                fontSize: 12,
                color: "var(--ink-3)",
                fontFamily: "var(--mono)",
                background: "var(--surface)",
                border: "0.5px solid var(--border-2)",
                borderRadius: 6,
                padding: "8px 10px",
                marginBottom: 16,
                lineHeight: 1.5,
              }}
            >
              Pushing: {skills.slice(0, 4).join(", ")}
              {skills.length > 4 && ` … (+${skills.length - 4} more)`}
            </div>
          )}
          <div style={{ marginBottom: 18 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: "var(--ink-3)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  fontWeight: 600,
                  flex: 1,
                }}
              >
                Targets
              </span>
              <button
                onClick={() => setPicked(new Set(providers.map((p) => p.id)))}
                style={{
                  border: 0,
                  background: "transparent",
                  color: "var(--ink-3)",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                all
              </button>
              <span style={{ color: "var(--border-2)", margin: "0 4px" }}>·</span>
              <button
                onClick={() => setPicked(new Set())}
                style={{
                  border: 0,
                  background: "transparent",
                  color: "var(--ink-3)",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                none
              </button>
            </div>
            {providers.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--ink-2)" }}>
                No providers yet. Add one in Settings.
              </div>
            ) : (
              providers.map((p) => {
                const active = picked.has(p.id);
                const state = !isBulk ? skill?.target_status[p.id] : undefined;
                return (
                  <label
                    key={p.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "10px 12px",
                      marginBottom: 6,
                      border: `0.5px solid ${active ? "var(--accent)" : "var(--border-2)"}`,
                      background: active
                        ? "color-mix(in oklab, var(--accent) 6%, transparent)"
                        : "var(--surface)",
                      borderRadius: 6,
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={active}
                      readOnly
                      onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
                      onClick={(e) => sel.onItemClick(p.id, e)}
                      style={{ accentColor: "var(--accent)", marginTop: 3 }}
                    />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          color: "var(--ink)",
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <span>{p.id}</span>
                        {state && (
                          <span
                            style={{
                              fontFamily: "var(--mono)",
                              fontSize: 10.5,
                              color:
                                state === "synced"
                                  ? "var(--ok)"
                                  : state === "stale"
                                    ? "var(--warn)"
                                    : "var(--ink-3)",
                            }}
                          >
                            ·{state}
                          </span>
                        )}
                      </div>
                      <div
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 11,
                          color: "var(--ink-3)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {p.path}
                      </div>
                    </div>
                  </label>
                );
              })
            )}
          </div>

          <div>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--ink-3)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontWeight: 600,
                marginBottom: 8,
              }}
            >
              Method
            </div>
            <div
              style={{
                display: "flex",
                gap: 0,
                background: "var(--surface)",
                border: "0.5px solid var(--border-2)",
                borderRadius: 6,
                padding: 2,
                width: "fit-content",
              }}
            >
              {(["auto", "copy"] as LinkMethod[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMethod(m)}
                  style={{
                    padding: "4px 12px",
                    border: 0,
                    background: method === m ? "var(--ink)" : "transparent",
                    color: method === m ? "var(--bg)" : "var(--ink-2)",
                    fontFamily: "var(--mono)",
                    fontSize: 11.5,
                    fontWeight: 500,
                    borderRadius: 4,
                    cursor: "pointer",
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
            <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 8, lineHeight: 1.5 }}>
              <code style={{ fontFamily: "var(--mono)" }}>auto</code> tries symlink, then a Windows
              junction, then a full copy. <code style={{ fontFamily: "var(--mono)" }}>copy</code>{" "}
              always works but loses the live link.
            </p>
          </div>
        </div>

        <footer
          style={{
            height: 64,
            flexShrink: 0,
            borderTop: "0.5px solid var(--border)",
            padding: "0 22px",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <Button kind="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            kind="primary"
            size="md"
            icon={Icon.push}
            onClick={onPush}
            disabled={picked.size === 0 || pushing}
          >
            {pushing
              ? "Pushing…"
              : isBulk
                ? `Push ${skills.length} → ${picked.size}`
                : `Push to ${picked.size}`}
          </Button>
        </footer>
      </div>
    </div>
  );
}
