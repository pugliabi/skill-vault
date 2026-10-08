---
name: syncing-from-github
description: Use this skill when syncing vault skills with their GitHub or local-repo sources — adopting a repo's skills with durable origins, running a bulk or single update check, applying safe updates, repairing broken sources, and handling conflicts or local edits. Triggers: "update my skills", "check for updates", "update everything", "sync from GitHub", "adopt this repo", "apply the updates", "bulk update pass", "re-check", and any follow-up to a check_updates result.
---

# Syncing skills with their sources

## Adopt a repo's skills (first time)

1. Clone into the managed location: `git clone --depth 1 <url>
   <repos_dir>/<repo-name>` (repos dir from `get_config`). A persistent
   clone beats a temp one: recorded as a `dir` origin, every future check
   auto-`git pull`s it.
2. `scan_dir_for_skills {path: <clone>}` → show the user what's there; pick
   real skills (a SKILL.md plus substance; skip templates/examples unless
   asked).
3. `adopt_skills` with `origin_context: {type:"git", root:<clone>, url, ref}`
   — this records each skill's origin; skipping it orphans them from every
   future update check.

## Single / few-skill update pass

`check_updates {skills:[…]}` → act by status (decision table: vault-format)
→ re-check what you touched → report.

## Bulk pass choreography

1. ONE unfiltered `check_updates` (one pull/clone per distinct source, no
   matter how many skills share it).
2. Bucket results by status.
3. `update_available` → ONE `apply_update` call with every item, echoing
   each result's `upstream_path`/`tmp_path` (reuses the clones the check
   just made).
4. `upstream_missing` / `source_missing` / `error`: group by SOURCE, not by
   skill — one investigation per source, then one `set_origin` per skill
   with its own subpath. **Two or more broken sources → the lead delegates
   one update-fixer Task per source, in parallel.** One source → fix
   in-thread.
5. `conflict` / `local_changed`: list the skills with both hashes and what
   changed where; the USER picks a winner — never overwrite.
6. Re-check everything touched; report grouped by outcome.

## Repair pipeline (broken source)

1. Shortcut: check message `moved to <rel>` → `set_origin` that subpath,
   `verify:true`, done.
2. Otherwise locate the source (finding-skill-origins — or the lead
   delegates repo-hunter when the hunt is heavy).
3. `set_origin {name, origin, verify:true}` → the recheck in the response
   is the proof: expect `update_available` or `up_to_date`.
4. `apply_update` if an update is now available.
5. Several skills, one repo: investigate once; repeat set_origin per skill.

## Conflict etiquette

A `conflict` means the user (or an agent on their behalf) edited the vault
copy AND upstream moved. Present: what changed locally (version history has
it), what changed upstream, both hashes. Offer: keep local / take upstream /
inspect diffs first. Execute only what they choose.

## Clone hygiene

Clones live under the repos dir, one per repo, named after the repo. They
are read-only mirrors: never commit or push from them. Temp clones from a
check (`tmp_path`) get reused by apply within the same pass; the app cleans
them up afterwards.

## Report format for a pass

Applied (count + names) · repaired (one-line origin diff each) · blocked
(conflicts/local edits, with why) · untouched (up to date). End with the
single recommended next action.
