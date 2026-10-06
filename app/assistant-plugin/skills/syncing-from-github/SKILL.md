---
name: syncing-from-github
description: The GitHub-to-vault update pipeline — adopting skills from repos with durable origins, running update checks, applying safe updates, repairing broken sources, and handling conflicts. Use for "update my skills", "sync from GitHub", "adopt from this repo", or any update-check follow-up.
---

# Syncing skills from GitHub

## Adopt a repo's skills (first time)

1. Clone into the managed location: `git clone --depth 1 <url>
   <repos_dir>/<repo-name>` (repos dir from `get_config`). A persistent clone
   beats a temp one: recorded as a `dir` origin, every future check
   auto-`git pull`s it.
2. `scan_dir_for_skills {path: <clone>}` → pick the real skills (a SKILL.md
   plus content; skip templates/examples unless asked).
3. `adopt_skills` with `origin_context: {type:"git", root:<clone>, url, ref}`
   — this records each skill's origin; skipping it orphans them from updates.

## Routine update pass

1. `check_updates` (all, or the named skills).
2. Act by status (full table in vault-format):
   - `update_available` → `apply_update`, echoing each result's
     `upstream_path`/`tmp_path` (reuses the clone the check made).
   - `upstream_missing` / `source_missing` / `error` with a dead URL →
     repair pipeline below.
   - `conflict` → list the skills and both hashes; the user picks a winner.
   - `local_changed` → note it; nothing to pull.
3. Re-check the repaired/applied skills and report final statuses.

## Repair pipeline (broken source)

1. Check the message first: "moved to <rel>" = checker already found it →
   `set_origin` with that subpath, `verify:true`, done.
2. Otherwise locate the source per `finding-skill-origins` (or delegate to
   the repo-hunter / update-fixer subagents when you're a lead agent).
3. `set_origin {name, origin, verify:true}` → expect `update_available` or
   `up_to_date` in the response.
4. `apply_update` if an update is now available.
5. Several skills, one repo: investigate once, then one `set_origin` per
   skill with its own subpath.

## Hygiene

- Keep clones under the repos dir, one per repo, named after the repo.
- Never `git push` from clones; they are read-only mirrors here.
- Temp clones (`tmp_path` on check results) are cleaned up by the app's
  dialog flow; reuse them in `apply_update` within the same pass.
