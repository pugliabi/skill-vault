---
name: connecting-notion
description: Use this skill when working with Notion sync for the vault — checking the connection, interpreting per-skill link states (linked, legacy, unlinked, vault-only) and drift statuses, previewing or executing push and pull plans, diagnosing conflicts, busy jobs, guard errors, 401s, or vanished pages, and knowing what must be handed back to the user. Triggers: "push to Notion", "pull from Notion", "Notion status", "Notion conflict", "page out of date", "sync with Notion", "reconnect Notion", "legacy page", "unlink", "changed in Notion".
---

# Notion sync for the vault

The vault syncs FULL skill folders (SKILL.md + every file) with pages in a
Notion "Skills" database through the Notion Skills API. The app tracks both
sides' versions; you drive it with the `notion_*` vault tools.

See ./references/notion-states.md for the complete link-state machine and
the drift statuses you'll meet in `notion_status` and per-skill
`notion_status` fields.

## Rule zero: state first

`notion_status {}` before anything else. Not connected → STOP: OAuth needs
a browser — Settings page → Notion → Connect. A 401 mid-flight means the
connection lapsed — same answer. The session context block's `Notion:` line
already tells you connected/not — don't re-confirm what it states.

## Link states (summary — full machine in the reference)

- **linked** — normal two-way link; drift tracked on both sides.
- **legacy** — an old summary-conversion page, not the real skill; excluded
  from drift; upgrading to a full page is a UI flow (`/notion/legacy`).
- **unlinked** — the user disconnected it; leave alone unless asked.
- **vault-only** — deliberately not in Notion; leave alone.

Per-skill drift verdicts (from list_skills/get_skill `notion_status`):
`synced` · `changed-vault` (push it) · `changed-notion` (pull it) ·
`conflict` (user decision) · `missing-in-notion` (page vanished from the
data source) · `unchecked` (no fresh cache yet).

## Operations

- **Preview**: `notion_plan {direction}` — per-skill rows with the action
  each would take. Explain the plan when the user asked a QUESTION; execute
  directly when they asked for the ACTION.
- **Execute reviewed rows**: `notion_run {direction, rows:[{id, action?}]}`.
- **Plain push of named skills**: `notion_push {skills:[…]}` (non-force —
  a Notion-side edit is never overwritten by it).
- Both wait for completion and return per-row results: report failures per
  skill, successes as a count.

## Failure modes

| Signal | Meaning | Response |
|---|---|---|
| 409 "a Notion job is already running" | One job app-wide | Report; wait for it; never spin |
| 409 guard "vault behind remote" | The vault's git checkout is stale | User pulls first; overriding the guard is UI-only |
| 401 | Connection lapsed | Settings → Connect |
| `missing-in-notion` | Linked page left the data source | Options: relink, re-push (recreates), or unlink — ask |
| Post-push "drift" that is cosmetic | Notion reformats on write; the app re-downloads what Notion stored | Normal — not drift; say so |

## UI-only (by design — your toolset lacks them)

Conflict resolution (the `/notion/conflicts` page has Claude-assisted
merge) · force push/pull · OAuth connect/disconnect · legacy upgrades ·
choosing the Skills data source. Name the page; don't improvise around it.
