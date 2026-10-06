/**
 * Proactive suggestions ("For you") — deterministic, zero-AI.
 *
 * `gatherSuggestionInputs` snapshots signals the app already computes
 * (skill/provider/Notion/desktop statuses from listSkills, audit findings,
 * name mismatches, the activity ring, manifest facts) plus the persisted
 * background update sweep. `composeSuggestions` is PURE — fixture data in,
 * ranked cards out — so the catalog, ranking, thresholds, and dismissal
 * semantics are all unit-testable without a vault.
 *
 * Cards never mutate anything; each carries actions the UI (or an agent via
 * mcp__vault__get_suggestions) can take: "ask-ai" pre-seeds the chat with a
 * prompt + context chips, "link" deep-links into the app. The reserved
 * `operation` action type is the hook for a future auto-fix mode — the
 * composer's output shape won't change if that ever ships.
 */

import crypto from "node:crypto";
import type { ActivityEntry, Provider, Skill } from "../../types/vault.ts";
import type { NameMismatch } from "../skillNames.ts";
import { auditVault, type AuditIssue } from "../audit.ts";
import { listActivity } from "../activity.ts";
import { listSkills } from "../vault.ts";
import { listNameMismatches } from "../skillNames.ts";
import { readDismissals, readSweepCache, type Dismissal, type UpdateSweepCache } from "./suggestionStore.ts";
import type { ChatContextChip } from "./session.ts";

export type SuggestionSeverity = "action" | "warn" | "info";

export type SuggestionKind =
  | "update_conflicts"
  | "upstream_gone"
  | "vault_behind"
  | "failed_ops"
  | "notion_conflicts"
  | "updates_available"
  | "audit_issues"
  | "stale_skills"
  | "missing_targets"
  | "notion_changed"
  | "notion_missing_page"
  | "name_mismatches"
  | "desktop_outdated"
  | "no_origin"
  | "staging_lingering"
  | "notion_legacy"
  | "untagged"
  | "new_upstream_skills"; // reserved for the v2 clone-scan sweep step

export type SuggestionAction =
  | { type: "ask-ai"; label: string; prompt: string; chips?: ChatContextChip[] }
  | { type: "link"; label: string; href: string };

export interface SuggestionCard {
  id: string; // = kind; every kind is a singleton card
  kind: SuggestionKind;
  severity: SuggestionSeverity;
  title: string;
  detail?: string;
  count: number; // full count even when skills[] is capped
  skills?: string[];
  actions: SuggestionAction[]; // first = primary
  /** ISO of the sweep that produced this card — sweep-sourced cards only. */
  freshness?: string;
  /** Changes when the card's content meaningfully changes — revives dismissals. */
  fingerprint: string;
}

export interface SuggestionInputs {
  skills: Skill[];
  audit: AuditIssue[];
  nameMismatches: NameMismatch[];
  activity: ActivityEntry[];
  sweep: UpdateSweepCache | null;
  dismissals: Dismissal[];
  now: Date;
}

const SKILLS_CAP = 20;
const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const STAGING_LINGER_MS = 7 * 24 * 60 * 60 * 1000;
const DISMISSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UNTAGGED_THRESHOLD = 3;

/** Fixed order inside a severity tier (catalog order = triage priority). */
const KIND_PRIORITY: SuggestionKind[] = [
  "update_conflicts",
  "upstream_gone",
  "vault_behind",
  "failed_ops",
  "notion_conflicts",
  "updates_available",
  "audit_issues",
  "stale_skills",
  "missing_targets",
  "notion_changed",
  "notion_missing_page",
  "name_mismatches",
  "desktop_outdated",
  "no_origin",
  "staging_lingering",
  "notion_legacy",
  "untagged",
  "new_upstream_skills",
];

const SEVERITY_RANK: Record<SuggestionSeverity, number> = { action: 0, warn: 1, info: 2 };

function fingerprintOf(kind: string, names: string[], count: number): string {
  const h = crypto.createHash("sha1");
  h.update(`${kind}\0${count}\0${[...names].sort().join(",")}`);
  return h.digest("hex").slice(0, 16);
}

function namesList(names: string[]): string {
  return names.slice(0, SKILLS_CAP).join(", ") + (names.length > SKILLS_CAP ? ", …" : "");
}

function skillsChip(label: string, names: string[]): ChatContextChip {
  return { kind: "skills", id: "suggestion-skills", label, data: { skills: names.slice(0, SKILLS_CAP) } };
}

/** IO half: snapshot everything the pure composer needs. Never throws. */
export function gatherSuggestionInputs(cfg: { vault_path: string; providers: Provider[] }): SuggestionInputs {
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  return {
    skills: safe(() => listSkills(cfg.vault_path, cfg.providers), []),
    audit: safe(() => auditVault(cfg.vault_path, cfg.providers), []),
    nameMismatches: safe(() => listNameMismatches(cfg.vault_path), []),
    activity: safe(() => listActivity(), []),
    sweep: safe(() => readSweepCache(cfg.vault_path), null),
    dismissals: safe(() => readDismissals(), []),
    now: new Date(),
  };
}

interface CardSpec {
  kind: SuggestionKind;
  severity: SuggestionSeverity;
  title: string;
  detail?: string;
  count: number;
  skills?: string[];
  actions: SuggestionAction[];
  freshness?: string;
}

function card(spec: CardSpec): SuggestionCard {
  return {
    id: spec.kind,
    ...spec,
    skills: spec.skills?.slice(0, SKILLS_CAP),
    fingerprint: fingerprintOf(spec.kind, spec.skills ?? [], spec.count),
  };
}

export function composeSuggestions(inputs: SuggestionInputs): SuggestionCard[] {
  const cards: SuggestionCard[] = [];
  const { skills, sweep, now } = inputs;
  const byName = new Map(skills.map((s) => [s.name, s]));

  // ── Sweep-sourced (update checks + git guard) ──────────────────────────
  if (sweep) {
    // Drop rows the user already acted on since the sweep ran.
    const fresh = sweep.results.filter((r) => {
      const origin = byName.get(r.name)?.origin;
      return !(origin?.adopted_at && origin.adopted_at > sweep.checked_at);
    });
    const ofStatus = (...statuses: string[]): string[] =>
      fresh.filter((r) => statuses.includes(r.status)).map((r) => r.name);

    const conflicted = ofStatus("conflict");
    if (conflicted.length > 0) {
      cards.push(
        card({
          kind: "update_conflicts",
          severity: "action",
          title: `${conflicted.length} skill${conflicted.length === 1 ? "" : "s"} have update conflicts`,
          detail: "Edited locally AND changed upstream — needs a decision per skill.",
          count: conflicted.length,
          skills: conflicted,
          freshness: sweep.checked_at,
          actions: [
            {
              type: "ask-ai",
              label: "Resolve with AI",
              prompt: `These skills changed both locally and upstream: ${namesList(conflicted)}. Diff each one and help me merge or pick a side — never overwrite without telling me what would be lost.`,
              chips: [skillsChip(`${conflicted.length} conflicted`, conflicted)],
            },
            { type: "link", label: "Open updates", href: "/skills" },
          ],
        }),
      );
    }

    const gone = ofStatus("upstream_missing", "source_missing", "error");
    if (gone.length > 0) {
      cards.push(
        card({
          kind: "upstream_gone",
          severity: "action",
          title: `${gone.length} skill${gone.length === 1 ? "" : "s"} lost their source`,
          detail: "The recorded origin is missing or moved — updates can't run until it's repaired.",
          count: gone.length,
          skills: gone,
          freshness: sweep.checked_at,
          actions: [
            {
              type: "ask-ai",
              label: "Fix with AI",
              prompt: `These skills' recorded sources are missing or moved: ${namesList(gone)}. Find where each one lives now (check the local clones first, then git history, then the web), repair each origin with set_origin verify:true, and apply any update that becomes available.`,
              chips: [skillsChip(`${gone.length} broken sources`, gone)],
            },
          ],
        }),
      );
    }

    if (sweep.guard && sweep.guard.behind > 0) {
      cards.push(
        card({
          kind: "vault_behind",
          severity: "action",
          title: `Vault repo is ${sweep.guard.behind} commit${sweep.guard.behind === 1 ? "" : "s"} behind its remote`,
          detail: "Pull before bulk operations so nothing gets clobbered mid-session.",
          count: sweep.guard.behind,
          freshness: sweep.checked_at,
          actions: [
            {
              type: "ask-ai",
              label: "Explain",
              prompt: `My vault's git repo is ${sweep.guard.behind} commits behind its remote${sweep.guard.ahead ? ` (and ${sweep.guard.ahead} ahead)` : ""}. Explain what I should do — you must NOT run git push/pull on the vault repo yourself.`,
            },
          ],
        }),
      );
    }

    const updatable = ofStatus("update_available");
    if (updatable.length > 0) {
      cards.push(
        card({
          kind: "updates_available",
          severity: "warn",
          title: `Updates available for ${updatable.length} skill${updatable.length === 1 ? "" : "s"}`,
          detail: "Vault copies untouched since adoption — safe to apply.",
          count: updatable.length,
          skills: updatable,
          freshness: sweep.checked_at,
          actions: [
            {
              type: "ask-ai",
              label: "Apply with AI",
              prompt: `Check these skills for updates and apply the safe ones; flag anything that looks risky before touching it: ${namesList(updatable)}.`,
              chips: [skillsChip(`${updatable.length} updatable`, updatable)],
            },
            { type: "link", label: "Open updates", href: "/skills" },
          ],
        }),
      );
    }
  }

  // ── Live: activity failures (last 24h, newest per kind+skill) ──────────
  const cutoff = now.getTime() - ACTIVITY_WINDOW_MS;
  const failures = new Map<string, ActivityEntry>();
  for (const e of inputs.activity) {
    if (e.ok || Date.parse(e.at) < cutoff) continue;
    failures.set(`${e.kind}\0${e.skill}`, e); // newest wins (append order)
  }
  if (failures.size > 0) {
    const entries = [...failures.values()].slice(-12);
    const names = [...new Set(entries.map((e) => e.skill).filter((s) => s !== "*"))];
    cards.push(
      card({
        kind: "failed_ops",
        severity: "action",
        title: `${failures.size} recent operation${failures.size === 1 ? "" : "s"} failed`,
        detail: entries
          .slice(-3)
          .map((e) => `${e.kind}: ${e.skill}`)
          .join(" · "),
        count: failures.size,
        skills: names,
        actions: [
          {
            type: "ask-ai",
            label: "Diagnose with AI",
            prompt: "Diagnose the failed operations in my recent activity (see context), find the root causes, and fix what you safely can.",
            chips: [
              {
                kind: "failure",
                id: "suggestion-failed-ops",
                label: `${failures.size} failed operations`,
                data: { entries: entries.map((e) => ({ at: e.at, kind: e.kind, skill: e.skill, message: e.message })) },
              },
            ],
          },
        ],
      }),
    );
  }

  // ── Live: Notion (derived from listSkills' notion_status) ─────────────
  const notionOf = (status: string): string[] => skills.filter((s) => s.notion_status === status).map((s) => s.name);

  const notionConflicts = notionOf("conflict");
  if (notionConflicts.length > 0) {
    cards.push(
      card({
        kind: "notion_conflicts",
        severity: "action",
        title: `${notionConflicts.length} Notion conflict${notionConflicts.length === 1 ? "" : "s"}`,
        detail: "Edited in both the vault and Notion since the last sync.",
        count: notionConflicts.length,
        skills: notionConflicts,
        actions: [
          {
            type: "ask-ai",
            label: "Walk me through it",
            prompt: `These skills conflict between the vault and Notion: ${namesList(notionConflicts)}. Explain what diverged on each side and the safest way to resolve each one.`,
            chips: [{ kind: "notion", id: "suggestion-notion-conflicts", label: "notion: conflicts" }],
          },
          { type: "link", label: "Open conflicts", href: "/notion/conflicts" },
        ],
      }),
    );
  }

  const changedVault = notionOf("changed-vault");
  const changedNotion = notionOf("changed-notion");
  const changed = [...changedVault, ...changedNotion];
  if (changed.length > 0) {
    cards.push(
      card({
        kind: "notion_changed",
        severity: "warn",
        title: `${changed.length} skill${changed.length === 1 ? "" : "s"} drifted from Notion`,
        detail: [
          changedVault.length ? `${changedVault.length} ahead in the vault (push)` : "",
          changedNotion.length ? `${changedNotion.length} ahead in Notion (pull)` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        count: changed.length,
        skills: changed,
        actions: [
          {
            type: "ask-ai",
            label: "Sync with AI",
            prompt: `Some skills drifted from their Notion pages — ${changedVault.length} changed in the vault, ${changedNotion.length} changed in Notion. Review the plan and push/pull the right ones.`,
            chips: [{ kind: "notion", id: "suggestion-notion-drift", label: "notion: drift" }],
          },
          { type: "link", label: changedNotion.length > changedVault.length ? "Review pull" : "Review push", href: changedNotion.length > changedVault.length ? "/notion/pull" : "/notion/push" },
        ],
      }),
    );
  }

  const missingPages = notionOf("missing-in-notion");
  if (missingPages.length > 0) {
    cards.push(
      card({
        kind: "notion_missing_page",
        severity: "warn",
        title: `${missingPages.length} linked Notion page${missingPages.length === 1 ? "" : "s"} vanished`,
        count: missingPages.length,
        skills: missingPages,
        actions: [
          {
            type: "ask-ai",
            label: "Investigate",
            prompt: `These skills are linked to Notion pages that are no longer in the Skills data source: ${namesList(missingPages)}. Check notion_status and tell me whether to relink, re-push, or unlink each.`,
            chips: [{ kind: "notion", id: "suggestion-notion-missing", label: "notion: missing pages" }],
          },
        ],
      }),
    );
  }

  const legacy = notionOf("legacy");
  if (legacy.length > 0) {
    cards.push(
      card({
        kind: "notion_legacy",
        severity: "info",
        title: `${legacy.length} legacy Notion page${legacy.length === 1 ? "" : "s"}`,
        detail: "Old summary conversions — upgrade them to full skills from the Legacy page.",
        count: legacy.length,
        skills: legacy,
        actions: [{ type: "link", label: "Open legacy", href: "/notion/legacy" }],
      }),
    );
  }

  // ── Live: provider drift ───────────────────────────────────────────────
  const stale = skills.filter((s) => s.status === "stale").map((s) => s.name);
  if (stale.length > 0) {
    cards.push(
      card({
        kind: "stale_skills",
        severity: "warn",
        title: `${stale.length} skill${stale.length === 1 ? "" : "s"} out of sync with providers`,
        detail: "A provider copy differs from the vault — one side has newer edits.",
        count: stale.length,
        skills: stale,
        actions: [
          {
            type: "ask-ai",
            label: "Push or pull?",
            prompt: `For each of these stale skills, figure out which side changed (vault vs provider copy) and push or pull accordingly: ${namesList(stale)}.`,
            chips: [skillsChip(`${stale.length} stale`, stale)],
          },
          { type: "link", label: "Open Sync", href: "/sync" },
        ],
      }),
    );
  }

  const missing = skills.filter((s) => s.status === "missing").map((s) => s.name);
  if (missing.length > 0) {
    cards.push(
      card({
        kind: "missing_targets",
        severity: "warn",
        title: `${missing.length} skill${missing.length === 1 ? "" : "s"} missing from a provider`,
        detail: "A target copy is absent or its link is broken.",
        count: missing.length,
        skills: missing,
        actions: [
          {
            type: "ask-ai",
            label: "Re-push with AI",
            prompt: `These skills are missing (or broken) in at least one of their target providers: ${namesList(missing)}. Check each target status and re-push where needed.`,
            chips: [skillsChip(`${missing.length} missing`, missing)],
          },
          { type: "link", label: "Open Sync", href: "/sync" },
        ],
      }),
    );
  }

  // ── Live: hygiene ──────────────────────────────────────────────────────
  if (inputs.audit.length > 0) {
    const byKind = new Map<string, number>();
    for (const i of inputs.audit) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
    cards.push(
      card({
        kind: "audit_issues",
        severity: "warn",
        title: `${inputs.audit.length} vault integrity issue${inputs.audit.length === 1 ? "" : "s"}`,
        detail: [...byKind.entries()].map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`).join(" · "),
        count: inputs.audit.length,
        actions: [
          {
            type: "ask-ai",
            label: "Fix with AI",
            prompt: `The vault audit found: ${[...byKind.entries()].map(([k, n]) => `${n} ${k}`).join(", ")}. Run audit_vault yourself, review each finding, and apply the right fix — prefer non-destructive options (add_to_manifest over remove_folder).`,
          },
        ],
      }),
    );
  }

  if (inputs.nameMismatches.length > 0) {
    const folders = inputs.nameMismatches.map((m) => m.folder);
    cards.push(
      card({
        kind: "name_mismatches",
        severity: "warn",
        title: `${folders.length} skill${folders.length === 1 ? "" : "s"} where SKILL.md name ≠ folder`,
        detail: "Notion pushes and renames will refuse these until the names agree.",
        count: folders.length,
        skills: folders,
        actions: [{ type: "link", label: "Fix names", href: "/skill-names" }],
      }),
    );
  }

  const desktopOutdated = skills.filter((s) => s.desktop_status === "outdated").map((s) => s.name);
  if (desktopOutdated.length > 0) {
    cards.push(
      card({
        kind: "desktop_outdated",
        severity: "info",
        title: `${desktopOutdated.length} Claude Desktop package${desktopOutdated.length === 1 ? "" : "s"} outdated`,
        detail: "Vault changed since the last packaged zip — re-package and re-upload.",
        count: desktopOutdated.length,
        skills: desktopOutdated,
        actions: [{ type: "link", label: "Open Skills", href: "/skills" }],
      }),
    );
  }

  const noOrigin = skills.filter((s) => !s.origin).map((s) => s.name);
  if (noOrigin.length > 0) {
    cards.push(
      card({
        kind: "no_origin",
        severity: "info",
        title: `${noOrigin.length} skill${noOrigin.length === 1 ? "" : "s"} can't be update-checked`,
        detail: "No source recorded — they work fine, but updates can't find them upstream.",
        count: noOrigin.length,
        skills: noOrigin,
        actions: [
          {
            type: "ask-ai",
            label: "Find sources",
            prompt: `These skills have no recorded source: ${namesList(noOrigin)}. For any that plausibly came from a public repo, find the upstream and record it with set_origin so update checks work. Skip ones that look locally authored — just tell me which.`,
            chips: [skillsChip(`${noOrigin.length} origin-less`, noOrigin)],
          },
        ],
      }),
    );
  }

  const lingerCutoff = now.getTime() - STAGING_LINGER_MS;
  const lingering = skills.filter((s) => s.stage === "staging" && Date.parse(s.modified_at) < lingerCutoff).map((s) => s.name);
  if (lingering.length > 0) {
    cards.push(
      card({
        kind: "staging_lingering",
        severity: "info",
        title: `${lingering.length} skill${lingering.length === 1 ? "" : "s"} parked in staging for over a week`,
        count: lingering.length,
        skills: lingering,
        actions: [
          {
            type: "ask-ai",
            label: "Review",
            prompt: `These skills have sat in staging for over a week: ${namesList(lingering)}. Summarize what each does and recommend promote vs keep-staging vs drop.`,
            chips: [skillsChip(`${lingering.length} staging`, lingering)],
          },
        ],
      }),
    );
  }

  const untagged = skills.filter((s) => s.tags.length === 0).map((s) => s.name);
  if (untagged.length >= UNTAGGED_THRESHOLD) {
    cards.push(
      card({
        kind: "untagged",
        severity: "info",
        title: `${untagged.length} skills have no tags`,
        actions: [{ type: "link", label: "Auto-tag", href: "/skills" }],
        count: untagged.length,
        skills: untagged,
      }),
    );
  }

  // ── Dismissals: suppress for 7 days, revive when the content changes ───
  const dismissalCutoff = now.getTime() - DISMISSAL_TTL_MS;
  const active = cards.filter((c) => {
    const d = inputs.dismissals.find((x) => x.id === c.id);
    if (!d) return true;
    if (d.fingerprint !== c.fingerprint) return true; // content changed → revive
    return Date.parse(d.at) < dismissalCutoff; // expired → show again
  });

  // ── Rank ───────────────────────────────────────────────────────────────
  active.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    const pri = KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind);
    if (pri !== 0) return pri;
    return b.count - a.count;
  });
  return active;
}
