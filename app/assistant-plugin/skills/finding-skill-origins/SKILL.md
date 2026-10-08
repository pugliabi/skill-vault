---
name: finding-skill-origins
description: Use this skill when locating where a vault skill's upstream source lives now — a broken or unknown origin, upstream_missing or source_missing status, a dead or 404 clone URL, or a repo that moved, was renamed, or restructured. Covers git forensics (log --follow, -S, --diff-filter), GitHub and web search on distinctive content, candidate verification, and recording the repaired origin. Triggers: "where did this skill come from", "the source is gone", "repo moved", "fix the origin", "upstream missing", "source missing", "dead URL", "find the new home", "provenance".
---

# Finding where a skill lives now

Goal: a VERIFIED `{type, url|path, subpath, ref?}` for `set_origin`. A wrong
origin silently poisons every future update check — verify before repairing,
and never record low confidence.

See ./references/github-search-recipes.md for exact GitHub API calls, URL
templates, rename-redirect detection, and rate-limit etiquette.

## 0. The shortcut

Read the check result's `message` first. `moved to <rel>` means the checker
already found the skill inside the same source — `set_origin` with that
subpath (`verify:true`), done. No hunting.

## 1. Mine what's recorded

`get_skill` → the old origin (url/path/subpath/ref) and the free-form
`source` string ("scanned from <repo>" often names the home). Read the vault
copy's SKILL.md and pick 2-3 distinctive search keys: the frontmatter name,
one unusual sentence, a unique file or function name.

## 2. Moved INSIDE the same repo (the common case)

Repos restructure far more often than they vanish. Get a full clone under
the repos dir (`git fetch --unshallow` if shallow), then in order:

```
git log --all --oneline --follow -- "<old subpath>/SKILL.md"   # rename chain
git log --all --diff-filter=R --summary | grep -i <name>       # explicit renames
git log --all -S"<distinctive line>" --name-only --oneline     # content moves
git grep -l "<distinctive key>" HEAD                           # where is it NOW
```

`scan_dir_for_skills` on the clone root lists every skill folder the repo
holds today — often the fastest confirmation of the new subpath. Also check
releases/CHANGELOG for "moved/renamed/consolidated" notes, and watch for the
monorepo pattern (`skills/<x>` → `plugins/<x>/skills/<x>` or a merge of
several skills into one successor folder — note it for the user if so).

## 3. Repo gone, renamed, or unknown

- WebFetch the OLD URL first: GitHub redirects renamed repos — the API
  response's `full_name` reveals the new home in one call.
- WebSearch, most-specific first: `"<distinctive sentence>" github` →
  `<skill-name> SKILL.md github` → `<old org>/<old repo>`.
- Check the old org's profile/pinned repos (vendors consolidate `*-skills`
  repos into monorepos regularly).
- Deleted originals: the fork network — the most-starred fork is the usual
  successor (recipes file has the call).

## 4. Verify — non-negotiable, all three

1. The folder EXISTS at the proposed subpath (fetch the contents listing, or
   clone and look).
2. It is recognizably the SAME skill — same `name:`, clearly shared content
   with the vault copy; not a same-named stranger.
3. It is plausibly the SUCCESSOR — equal or newer content, or an explicit
   rename/move trail leading there.

## 5. Record

Prefer a `dir` origin pointing at a clone under the repos dir (it auto-pulls
on every future check); otherwise pure `git` with the URL. Always
`verify:true` on set_origin and read the recheck — `update_available` or
`up_to_date` proves the repair; `upstream_missing` again means it's wrong.

## Dead ends

Report honestly: what was searched, the best near-miss, and the options —
leave the skill origin-less (it still works; it just can't update-check) or
let the user name the source. A guessed origin is worse than none.
