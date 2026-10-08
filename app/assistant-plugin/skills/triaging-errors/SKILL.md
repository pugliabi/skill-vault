---
name: triaging-errors
description: Use this skill when diagnosing failed vault operations — classifying recent errors from adopt, push, pull, update, or Notion jobs, clustering repeated failures into root causes, and prescribing the exact tool call that fixes each one. Triggers: "what failed", "why did this fail", "fix my errors", "recent errors", "diagnose", "triage", a red failure toast, a failure chip in the session context, or a "Recent failed operations" list in the system context.
---

# Triaging failed operations

Every claim must trace to something read from a tool or the context block.
Diagnose completely before fixing anything.

## 1. Start from what's already paid for

The session context's failure chip and "Recent failed operations" list ARE
evidence — never re-fetch them. Then:

1. `get_suggestions {}` — the app has already ranked what's broken; add
   depth to its cards, don't re-discover.
2. `recent_activity {only_errors:true}` — the raw failure stream.

## 2. Cluster

Group failures by skill AND by message shape. Five identical "symlink
creation failed" entries are ONE problem with five instances; count them as
such. Note the time pattern — a burst at one timestamp usually shares one
cause.

## 3. Probe per kind

| Failure kind | Probe with | Looking for |
|---|---|---|
| update | `check_updates {skills:[…]}` | Current status + message (dead URL? moved? conflict?) |
| push / pull | `get_skill` (per-target status) + `audit_vault` | Broken links, missing target dirs, permission hints in messages |
| adopt | `get_config` + Read the source path | Source path/provider still exists? scan root right? |
| notion-* | `notion_status` | Lapsed connection (401)? busy? guard? missing page? |
| rename / remove | `audit_vault` | Dangling entries, orphan folders left behind |

## 4. Classify each cluster

- **One-off** (transient lock, network blip): safe to re-run once; if it
  recurs, reclassify.
- **Structural** (gone upstream, broken link, dangling entry, dead source
  path, disconnected Notion): needs a specific repair tool.
- **User-decision** (conflicts, local edits, which side wins): present the
  evidence; never pick for them.

## 5. Prescribe — exact fixes

| Root cause | Fix |
|---|---|
| Upstream gone / source missing | finding-skill-origins → `set_origin {verify:true}` |
| Broken provider link | `fix_repair {kind:"broken_link", action:"recreate_link"}` |
| Dangling manifest entry | `fix_repair {kind:"dangling_entry", action:"remove_from_manifest"}` |
| Orphan folder | `fix_repair {action:"add_to_manifest"}` (or remove_folder if junk) |
| Stale provider copy | Determine edited side → `push_to_provider` or `pull_from_provider` |
| Notion busy | Wait for the running job; report |
| Notion 401 | Settings → Connect (UI) |
| Dead local source path | Re-clone to repos dir → `set_origin` at the clone |

## 6. Close the loop

Apply what's safe, re-run the operation that originally failed, and confirm
the new activity entry is `ok:true`. A fix without a green re-run isn't done.

## Report format

Per root cause, ordered by impact: **cause** (one line) → **evidence**
(entries + probe results) → **affected** (skill names) → **fix** (exact tool
+ arguments, or the UI page) → safe-to-auto-apply vs needs-user.
