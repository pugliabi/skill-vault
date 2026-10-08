---
name: analyzing-suggestions
description: Use this skill when interpreting the app's proactive suggestion cards — from the get_suggestions tool, an AI-briefing message with embedded cards, or a suggestion chip in the session context — understanding card kinds, severity tiers, counts, fingerprints and dismissals, and turning the cards into a prioritized briefing or an action plan. Triggers: "give me a briefing", "what needs attention", "prioritize", "what matters most", "For you", "suggestions", "what should I do first", "make a plan for my vault".
---

# Reading and acting on suggestion cards

Cards are deterministic and zero-AI-cost: the app composes them from its own
signals (statuses, activity, audit, Notion state) plus a background source
sweep that re-checks every origin ~6-hourly. `freshness` on a card is that
sweep's timestamp. Cards never mutate anything.

## Card anatomy

`id` == `kind` (one card per kind) · `severity` — `action` (act now) /
`warn` (worth a look) / `info` (housekeeping, UI shows collapsed) ·
`count` is the FULL count even when `skills[]` is capped at 20 ·
`fingerprint` changes when the card's content meaningfully changes (that
revives dismissals) · `actions` carry the UI's own Fix-with-AI prompts and
deep links.

## Kind catalog (priority order = triage order)

| Kind | Means | Resolve with |
|---|---|---|
| update_conflicts | Edited locally AND upstream | USER decision — present both sides (syncing-from-github) |
| upstream_gone | Sources missing/moved | finding-skill-origins → set_origin → apply |
| vault_behind | Vault repo behind its git remote | User pulls — never do it for them |
| failed_ops | Recent operation failures | triaging-errors |
| notion_conflicts | Both sides changed | `/notion/conflicts` page (UI merge) |
| updates_available | Safe updates waiting | apply_update (echo paths) |
| audit_issues | Orphans/dangling/broken links | audit_vault → fix_repair |
| stale_skills | Provider copy differs | Determine edited side → push/pull |
| missing_targets | Target copy absent/broken | Re-push |
| notion_changed | One side drifted | notion_plan → push or pull |
| notion_missing_page | Linked page vanished | Relink / re-push / unlink — ask |
| name_mismatches | SKILL.md name ≠ folder | `/skill-names` page (UI) |
| desktop_outdated | Stale Claude Desktop zips | Packaging UI |
| no_origin | Can't update-check | finding-skill-origins to record sources |
| staging_lingering | Parked in staging >7d | Review: promote / keep / drop |
| notion_legacy | Old summary pages | `/notion/legacy` page (UI) |
| untagged | No tags (≥3 skills) | Auto-tag UI, or tag suggestions |
| new_upstream_skills | (reserved) unadopted skills in clones | Adopt pipeline |

## Dismissals

Server-side; last 7 days OR until the fingerprint changes. A dismissed card
is a choice the user made — mention it at most once, never nag.

## The briefing (what the ✦ AI-briefing button runs)

The cards arrive EMBEDDED in the message — do not re-call `get_suggestions`
unless asked or the data is clearly stale. Fix nothing. Output exactly:

1. **What matters most and why** — the action tier, with cross-card
   dependencies called out (fix `upstream_gone` BEFORE `updates_available`
   when they share skills; `vault_behind` before any bulk mutation).
2. **What can wait** — warn tier in a sentence or two; info tier in one line.
3. **The order to tackle it** — a numbered sequence with effort notes
   (seconds / a minute / needs-your-decision) and, per step, the exact
   action (tool, card button, or app page).

## The action plan (when asked to actually fix things)

Work the action tier in catalog order, loading the mapped skill per card.
Honor every USER-decision row (conflicts) as a stop-and-present. Finish by
re-calling `get_suggestions` once and reporting the delta (cards cleared,
counts dropped, anything new).
