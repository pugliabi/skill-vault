---
name: connecting-notion
description: Notion Skills sync semantics and playbooks — connection checks, per-skill link states (linked/legacy/unlinked/vault-only), push/pull plans, drift and conflicts, and what must be handed back to the user (OAuth, force, merges). Use for any Notion question or operation.
---

# Notion sync for the Skill Vault

The vault syncs FULL skill folders (SKILL.md + every file) with pages in a
Notion "Skills" database through the Notion Skills API. The app tracks both
sides' versions; you drive it with the `notion_*` vault tools.

## Always start with state

`notion_status {}` → `status` (connected? which data source?) + `summary`
(counts: in-sync, vault-changed, notion-changed, conflicts, unlinked).

Not connected → STOP. OAuth needs a browser: send the user to the app's
Notion page → Connect. You cannot connect for them (and `401` mid-flight
means the connection lapsed — same answer).

## Link states (per skill, from get_skill / the summary)

- **linked** — normal two-way link; drift tracked on both sides.
- **legacy** — the Notion page is an old converted summary, not the real
  skill; excluded from drift. Upgrading it to a full page is a UI flow.
- **unlinked** — user disconnected it; leave alone unless asked.
- **vault-only** — deliberately not in Notion; leave alone.

## Operations

- Preview: `notion_plan {direction: "push"|"pull"}` — per-skill rows with the
  action each would take. Explain the plan before executing when the user
  asked a question; execute directly when they asked for the action.
- Execute reviewed rows: `notion_run {direction, rows:[{id, action?}]}`.
- Plain push of named skills: `notion_push {skills:[...]}`.
- Both wait for completion and return per-row results — report failures
  per skill, successes as a count.

## Rules of the road

- ONE Notion job at a time, app-wide. A busy (409) error = report and stop.
- A guard error ("vault behind remote") means the vault's git checkout needs
  a pull first — tell the user; overriding the guard is a UI decision.
- **Conflicts** (both sides changed since last sync): you have no force and
  no merge by design. Explain what diverged; the app's Conflicts page offers
  a Claude-assisted merge and manual resolution.
- Notion may reformat content on write; the app re-downloads after a push to
  record what Notion actually stored. Cosmetic reflows are normal, not drift.
