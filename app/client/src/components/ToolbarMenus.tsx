import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Icon } from "./ui/icons";
import { GuardBanner } from "./GuardBanner";
import { useNotionRunJob } from "../lib/useNotionRunJob";
import type { NotionDirection } from "../lib/types";

/** behind-commit count from a 409 `{error:"vault_behind", behind}` response, else null. */
function vaultBehindCount(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.message !== "vault_behind") return null;
  const raw = err.raw as { behind?: number } | null;
  return typeof raw?.behind === "number" ? raw.behind : 0;
}

/** Fixed-position guard banner shown when a force/bulk-push 409'd on `vault_behind`. */
function FloatingGuardBanner({ behind, onRunAnyway, onDismiss }: { behind: number; onRunAnyway: () => void; onDismiss: () => void }) {
  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 200 }}>
      <GuardBanner guard={{ is_repo: true, behind, ahead: 0 }} onRunAnyway={onRunAnyway} onDismiss={onDismiss} />
    </div>
  );
}

/* ── Generic accessible dropdown menu ────────────────────────────── */

export interface MenuAction {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}
export type MenuEntry = MenuAction | { id: string; separator: true };

function isSeparator(e: MenuEntry): e is { id: string; separator: true } {
  return "separator" in e && e.separator === true;
}

type ButtonKind = "primary" | "default" | "ghost";

const KIND_STYLES: Record<ButtonKind, { bg: string; fg: string; bd: string; hover: string }> = {
  primary: { bg: "var(--ink)", fg: "var(--bg)", bd: "var(--ink)", hover: "oklch(0.32 0.012 60)" },
  default: { bg: "var(--surface)", fg: "var(--ink)", bd: "var(--border-2)", hover: "var(--surface-2)" },
  ghost: { bg: "transparent", fg: "var(--ink-2)", bd: "transparent", hover: "var(--surface-2)" },
};

/**
 * A button that opens a `role="menu"` popover. Fully keyboard-driven:
 * ArrowDown/Up open it and move focus, Escape closes and returns focus to
 * the trigger, and clicking outside closes it too. One instance backs every
 * `▾` toolbar menu (New, Import, Notion) so the a11y wiring lives once.
 */
export function Menu({
  label,
  icon,
  kind = "default",
  items,
  disabled,
  title,
}: {
  label: string;
  icon?: React.ReactElement;
  kind?: ButtonKind;
  items: MenuEntry[];
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectableIdx = items
    .map((e, i) => (isSeparator(e) ? -1 : i))
    .filter((i) => i >= 0 && !(items[i] as MenuAction).disabled);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    setActiveIdx(-1);
    if (returnFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open && activeIdx >= 0) itemRefs.current[activeIdx]?.focus();
  }, [open, activeIdx]);

  const moveTo = (dir: 1 | -1) => {
    if (selectableIdx.length === 0) return;
    const pos = selectableIdx.indexOf(activeIdx);
    const next =
      pos === -1
        ? dir === 1
          ? selectableIdx[0]
          : selectableIdx[selectableIdx.length - 1]
        : selectableIdx[(pos + dir + selectableIdx.length) % selectableIdx.length];
    setActiveIdx(next);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
      setActiveIdx(selectableIdx[0] ?? -1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActiveIdx(selectableIdx[selectableIdx.length - 1] ?? -1);
    } else if (e.key === "Escape" && open) {
      // Closes the menu from the trigger itself without letting Escape
      // bubble up to page-level handlers (e.g. a Skills multi-select
      // clearing itself on Escape).
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // Never let Escape bubble past the menu — a page-level Escape handler
      // (e.g. Skills' multi-select) would otherwise also react to it.
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveTo(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveTo(-1);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  const k = KIND_STYLES[kind];
  const [hover, setHover] = useState(false);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        disabled={disabled}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => (open ? close(false) : (setOpen(true), setActiveIdx(-1)))}
        onKeyDown={onTriggerKeyDown}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 26,
          padding: "0 10px",
          background: hover && !disabled ? k.hover : k.bg,
          color: k.fg,
          border: `0.5px solid ${k.bd}`,
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 500,
          fontFamily: "var(--sans)",
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? "not-allowed" : "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {icon && <span style={{ display: "inline-flex" }}>{icon}</span>}
        {label}
        <span style={{ display: "inline-flex", opacity: 0.7 }}>{Icon.chevron}</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 90,
            minWidth: 200,
            background: "var(--bg)",
            border: "0.5px solid var(--border-2)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
            padding: 4,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {items.map((entry, i) =>
            isSeparator(entry) ? (
              <div
                key={entry.id}
                role="separator"
                style={{ height: 1, background: "var(--border)", margin: "4px 2px" }}
              />
            ) : (
              <button
                key={entry.id}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                role="menuitem"
                tabIndex={-1}
                disabled={entry.disabled}
                onClick={() => {
                  close(true);
                  entry.onSelect();
                }}
                style={{
                  display: "block",
                  textAlign: "left",
                  width: "100%",
                  border: 0,
                  background: "transparent",
                  color: entry.danger ? "var(--bad)" : "var(--ink)",
                  padding: "7px 10px",
                  borderRadius: 5,
                  fontSize: 13,
                  fontFamily: "var(--sans)",
                  cursor: entry.disabled ? "not-allowed" : "pointer",
                  opacity: entry.disabled ? 0.5 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!entry.disabled) e.currentTarget.style.background = "var(--surface-2)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                {entry.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/* ── Notion ▾ toolbar menu ────────────────────────────────────────── */

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Notion is not connected — connect it in Settings.";
    return err.message || fallback;
  }
  return fallback;
}

function invalidateAfterForce(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["skills"] });
  qc.invalidateQueries({ queryKey: ["notion-conflicts"] });
  qc.invalidateQueries({ queryKey: ["notion-status"] });
  qc.invalidateQueries({ queryKey: ["notion-plan"] });
}

/**
 * `Notion ▾` — hidden unless `/api/notion/status` reports connected with a
 * data source configured. Force push/pull confirm with the plan's
 * `force_eligible` count (linked, non-legacy skills) before firing
 * `POST /api/notion/force`, and progress is reported via `useNotionRunJob`
 * (the same polling the review pages use).
 */
export function NotionMenu({ navigate }: { navigate: (to: string) => void }) {
  const qc = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["notion-status"],
    queryFn: () => api.notionStatus(),
    staleTime: 15000,
  });
  const configured = !!status?.connected && !!status.data_source;

  const { data: conflicts } = useQuery({
    queryKey: ["notion-conflicts"],
    queryFn: () => api.notionConflicts(),
    enabled: configured,
    retry: false,
  });
  const conflictCount = conflicts?.skills.length ?? 0;

  const toastIdRef = useRef<string | number | null>(null);
  const { start, job } = useNotionRunJob((finished, lost) => {
    const id = toastIdRef.current;
    toastIdRef.current = null;
    const ran = finished?.results ?? [];
    const failed = ran.filter((r) => !r.ok).length;
    const verb = finished?.direction === "pull" ? "Force pull" : "Force push";
    if (lost) {
      toast.error(`Lost track of the ${verb.toLowerCase()} — reload to see where things stand`, { id: id ?? undefined });
    } else if (finished?.error) {
      toast.error(`${verb} failed: ${finished.error}`, { id: id ?? undefined });
    } else if (failed > 0) {
      toast.error(`${verb}: ${ran.length - failed} done, ${failed} failed`, { id: id ?? undefined });
    } else {
      toast.success(`${verb}: ${ran.length} done`, { id: id ?? undefined });
    }
    invalidateAfterForce(qc);
  });

  useEffect(() => {
    if (!job || toastIdRef.current == null) return;
    const verb = job.direction === "pull" ? "Force pulling" : "Force pushing";
    toast.loading(`${verb}… ${job.done}/${job.total}`, { id: toastIdRef.current });
  }, [job]);

  const check = useMutation({
    mutationFn: () => api.notionCheck(),
    onSuccess: (r) => {
      toast.success(`Checked Notion — ${r.rows} skill${r.rows === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["notion-status"] });
      qc.invalidateQueries({ queryKey: ["notion-conflicts"] });
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => toast.error(errorText(err, "Check failed")),
  });

  const [guardBlock, setGuardBlock] = useState<{ direction: NotionDirection; behind: number } | null>(null);

  const force = useMutation({
    mutationFn: (body: { direction: NotionDirection; override_guard?: boolean }) => api.notionForce(body),
    onSuccess: (r, vars) => {
      setGuardBlock(null);
      toastIdRef.current = toast.loading(
        `${vars.direction === "pull" ? "Force pulling" : "Force pushing"}… 0/?`,
      );
      start(r.job_id);
    },
    onError: (err, vars) => {
      const behind = vaultBehindCount(err);
      if (behind !== null) {
        setGuardBlock({ direction: vars.direction, behind });
        return;
      }
      toast.error(errorText(err, "Force failed"));
    },
  });

  const confirmForce = async (direction: NotionDirection) => {
    let count: number | null = null;
    try {
      const plan = await api.notionPlan(direction);
      count = plan.stats.force_eligible;
    } catch {
      // Fall back to an un-counted warning rather than blocking the action.
    }
    const other = direction === "push" ? "Notion" : "the vault";
    const n = count == null ? "every linked" : String(count);
    const ok = window.confirm(
      `Force ${direction} ${count == null ? "" : `${count} `}linked skill${count === 1 ? "" : "s"}?\n\n` +
        `Overwrites ${other} for ${n} skill${count === 1 ? "" : "s"}; nothing is deleted; every overwritten copy is saved to history.`,
    );
    if (!ok) return;
    force.mutate({ direction });
  };

  const guardBanner: ReactNode = guardBlock && (
    <FloatingGuardBanner
      behind={guardBlock.behind}
      onRunAnyway={() => force.mutate({ direction: guardBlock.direction, override_guard: true })}
      onDismiss={() => setGuardBlock(null)}
    />
  );

  if (!configured) return guardBanner ?? null;

  const items: MenuEntry[] = [
    { id: "push", label: "Push to Notion…", onSelect: () => navigate("/notion/push") },
    { id: "pull", label: "Pull from Notion…", onSelect: () => navigate("/notion/pull") },
    {
      id: "conflicts",
      label: `Conflicts (${conflictCount})`,
      onSelect: () => navigate("/notion/conflicts"),
    },
    { id: "sep1", separator: true },
    { id: "force-push", label: "Force push…", onSelect: () => void confirmForce("push") },
    { id: "force-pull", label: "Force pull…", onSelect: () => void confirmForce("pull") },
    { id: "sep2", separator: true },
    { id: "check", label: "Check Notion now", onSelect: () => check.mutate(), disabled: check.isPending },
    { id: "settings", label: "Notion settings", onSelect: () => navigate("/settings#notion") },
  ];

  return (
    <>
      <Menu label="Notion" icon={Icon.sync} kind="ghost" items={items} />
      {guardBanner}
    </>
  );
}

/**
 * Confirm + POST `/api/notion/push-selected {skills}` for the BulkActionBar
 * "Push to Notion" action: a normal (non-force) push per selected skill —
 * a skill changed in Notion (or never synced) is reported as a per-skill
 * error pointing to Conflicts, never overwritten (overwriting stays in
 * Notion ▾ → Force push). Lists the affected skill names (max 10 + "and N
 * more") before running, with the same job-progress toast as `NotionMenu`.
 * Returns `run` (wire up to the button's onClick) and `banner` (render it
 * somewhere in the caller's tree so a 409 `vault_behind` can offer "Run
 * anyway").
 */
export function useBulkPushToNotion(names: string[]): { run: () => void; banner: ReactNode } {
  const qc = useQueryClient();
  const toastIdRef = useRef<string | number | null>(null);
  const [guardBehind, setGuardBehind] = useState<number | null>(null);
  const { start, job } = useNotionRunJob((finished, lost) => {
    const id = toastIdRef.current;
    toastIdRef.current = null;
    const ran = finished?.results ?? [];
    const failed = ran.filter((r) => !r.ok).length;
    if (lost) {
      toast.error("Lost track of the Notion push — reload to see where things stand", { id: id ?? undefined });
    } else if (finished?.error) {
      toast.error(`Push to Notion failed: ${finished.error}`, { id: id ?? undefined });
    } else if (failed > 0) {
      const bad = ran.filter((r) => !r.ok);
      const lines = bad
        .slice(0, 5)
        .map((r) => `${r.id.replace(/^push-selected:/, "")}: ${r.error ?? "failed"}`)
        .concat(bad.length > 5 ? [`and ${bad.length - 5} more`] : []);
      toast.error(`Push to Notion: ${ran.length - failed} done, ${failed} failed`, {
        id: id ?? undefined,
        description: lines.join(" · "),
        duration: 12000,
      });
    } else {
      toast.success(`Push to Notion: ${ran.length} done`, { id: id ?? undefined });
    }
    invalidateAfterForce(qc);
  });

  useEffect(() => {
    if (!job || toastIdRef.current == null) return;
    toast.loading(`Pushing to Notion… ${job.done}/${job.total}`, { id: toastIdRef.current });
  }, [job]);

  const push = useMutation({
    mutationFn: (body: { skills: string[]; override_guard?: boolean }) => api.notionPushSelected(body),
    onSuccess: (r) => {
      setGuardBehind(null);
      toastIdRef.current = toast.loading(`Pushing to Notion… 0/${names.length}`);
      start(r.job_id);
    },
    onError: (err) => {
      const behind = vaultBehindCount(err);
      if (behind !== null) {
        setGuardBehind(behind);
        return;
      }
      toast.error(errorText(err, "Push to Notion failed"));
    },
  });

  const run = () => {
    if (names.length === 0) return;
    const shown = names.slice(0, 10);
    const list = shown.join(", ") + (names.length > 10 ? `, and ${names.length - 10} more` : "");
    const ok = window.confirm(
      `Push ${names.length} skill${names.length === 1 ? "" : "s"} to Notion?\n\n${list}\n\n` +
        `Pushes vault changes; creates a Notion page for any selected skill that has none. ` +
        `Skills changed in Notion (or never synced) are skipped — resolve them in Conflicts. Nothing is deleted.`,
    );
    if (!ok) return;
    push.mutate({ skills: names });
  };

  const banner: ReactNode = guardBehind != null && (
    <FloatingGuardBanner
      behind={guardBehind}
      onRunAnyway={() => push.mutate({ skills: names, override_guard: true })}
      onDismiss={() => setGuardBehind(null)}
    />
  );

  return { run, banner };
}
