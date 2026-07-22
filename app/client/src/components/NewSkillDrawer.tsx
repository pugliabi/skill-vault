import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Icon } from "./ui/icons";
import { Button } from "./ui/primitives";

/**
 * Client-side mirror of services/skillName.ts:SLUG_RE.
 * Server is authoritative — this is for instant inline feedback.
 *
 * MUST stay in lockstep with the server regex. Pattern:
 *   ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$
 *   - lowercase letters, digits, hyphens
 *   - 2 to 64 chars total
 *   - cannot start or end with a hyphen
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const SLUG_HINT =
  "lowercase letters, digits, hyphens; 2–64 chars; cannot start or end with -";

/**
 * "+ New skill" right-side drawer.
 *
 * Mirrors the DiffDrawer overlay pattern: fixed-position backdrop +
 * panel sliding in from the right, Esc/backdrop/Cancel all dismiss.
 * The form is intentionally minimal — name + description — to match
 * the lightness of the Adopt flow's first step. Initial stage is
 * always "staging" (server-side default; not a user choice in v1).
 */
export function NewSkillDrawer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  // Esc to close — scoped to the drawer's lifecycle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trimmedName = name.trim();
  const localValid = trimmedName === "" || SLUG_RE.test(trimmedName);
  const canSubmit = SLUG_RE.test(trimmedName);

  const create = useMutation({
    mutationFn: () =>
      api.createSkill({
        name: trimmedName,
        description: description.trim() || undefined,
      }),
    onSuccess: (skill) => {
      toast.success(`Created ${skill.name}`);
      qc.invalidateQueries({ queryKey: ["skills"] });
      onClose();
      navigate(`/skills/${encodeURIComponent(skill.name)}`);
    },
    onError: (err) => {
      // Surface server's 409 reason inline; do NOT close the drawer.
      const msg = err instanceof ApiError ? err.message : "Create failed";
      setServerError(msg);
    },
  });

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
            New skill
          </span>
          <Button kind="ghost" size="sm" icon={Icon.x} onClick={onClose}>
            Close
          </Button>
        </header>

        <div
          className="sv-scroll"
          style={{ flex: 1, overflowY: "auto", padding: 22 }}
        >
          <div style={{ marginBottom: 18 }}>
            <label
              style={{
                display: "block",
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--ink-3)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontWeight: 600,
                marginBottom: 6,
              }}
            >
              Name
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setServerError(null);
              }}
              placeholder="my-new-skill"
              style={{
                width: "100%",
                height: 32,
                padding: "0 10px",
                background: "var(--surface)",
                border: `0.5px solid ${
                  serverError || (!localValid && trimmedName)
                    ? "var(--bad)"
                    : "var(--border-2)"
                }`,
                borderRadius: 6,
                outline: 0,
                fontFamily: "var(--mono)",
                fontSize: 13,
                color: "var(--ink)",
              }}
            />
            <div
              style={{
                marginTop: 6,
                fontSize: 11.5,
                color:
                  serverError
                    ? "var(--bad)"
                    : !localValid && trimmedName
                      ? "var(--bad)"
                      : "var(--ink-3)",
                lineHeight: 1.4,
              }}
            >
              {serverError ?? SLUG_HINT}
            </div>
          </div>

          <div>
            <label
              style={{
                display: "block",
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--ink-3)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontWeight: 600,
                marginBottom: 6,
              }}
            >
              Description{" "}
              <span style={{ color: "var(--ink-4)", fontWeight: 400 }}>
                (optional)
              </span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="One-liner about what this skill does."
              style={{
                width: "100%",
                padding: "8px 10px",
                background: "var(--surface)",
                border: "0.5px solid var(--border-2)",
                borderRadius: 6,
                outline: 0,
                fontFamily: "var(--sans)",
                fontSize: 13,
                color: "var(--ink)",
                resize: "vertical",
              }}
            />
            <div
              style={{
                marginTop: 6,
                fontSize: 11.5,
                color: "var(--ink-3)",
                lineHeight: 1.4,
              }}
            >
              Becomes the <code style={{ fontFamily: "var(--mono)" }}>description:</code>{" "}
              field in <code style={{ fontFamily: "var(--mono)" }}>SKILL.md</code>{" "}
              frontmatter.
            </div>
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
            onClick={() => create.mutate()}
            disabled={!canSubmit || create.isPending}
          >
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
