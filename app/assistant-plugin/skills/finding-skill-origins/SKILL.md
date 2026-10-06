---
name: finding-skill-origins
description: Strategy for locating where a vault skill's upstream source lives now — tracking renames inside a repo with git log --follow and -S, finding moved/renamed repos via web search on distinctive content, and verifying a candidate before repairing the origin. Use for upstream_missing, source_missing, dead clone URLs, or unknown provenance.
---

# Finding where a skill lives (or moved to)

Goal: a verified `{type, url|path, subpath, ref?}` for `set_origin`. Wrong
guesses poison future updates — verify before you repair.

## 1. Mine what's recorded

`get_skill` → the old origin (url/path/subpath/ref) and `source` string
("adopted from X", "scanned from <repo>"). Read the vault copy's SKILL.md and
pick 2–3 distinctive search keys: the frontmatter name, an unusual sentence,
a function or file name unique to the skill.

## 2. Moved INSIDE the same repo (the common case — upstream_missing)

Repos restructure far more often than they vanish. Get a full clone (the
repos dir from `get_config`; `git fetch --unshallow` if it's shallow), then:

```
git log --all --oneline --follow -- "<old subpath>/SKILL.md"   # rename chain
git log --all -S"<distinctive line>" --name-only --oneline     # content moves
git grep -l "<distinctive key>" $(git rev-parse HEAD)          # where is it NOW
```

`scan_dir_for_skills` on the clone root lists every skill folder the repo
holds today — often the fastest confirmation of the new subpath. Also check
the repo's releases/CHANGELOG for "moved/renamed/consolidated" notes.

## 3. Repo gone, renamed, or unknown (source_missing, dead URLs)

- WebSearch, most-specific first: `"<distinctive sentence>" github`, then
  `<skill-name> SKILL.md github`, then `<old org>/<old repo>` (GitHub redirects
  renames — WebFetch the old URL and see where it lands).
- Org/product renames are common (e.g. a vendor consolidating `*-skills`
  repos into one monorepo). Check the old org's profile and pinned repos.
- GitHub code search via WebFetch:
  `https://github.com/search?q=%22<quoted+phrase>%22&type=code`.

## 4. Verify the candidate (non-negotiable)

A candidate is confirmed only when ALL hold:
1. The folder exists at the proposed subpath (WebFetch the file listing, or
   clone and look).
2. Its SKILL.md is recognizably the same skill — same `name:`, clearly shared
   content with the vault copy (not a same-named stranger).
3. It is plausibly the *successor*: equal or newer content, or an explicit
   rename trail leading there.

Then prefer recording a `dir` origin pointing at a clone in the repos dir
(auto-pulls on every check) when the user keeps clones; otherwise a pure
`git` origin with the URL. Always pass `verify:true` to `set_origin` and read
the recheck status — `update_available`/`up_to_date` proves the fix.

## Dead ends

Report honestly: what you searched, the best near-miss, and the options —
keep the skill origin-less (it still works, just no update checks), or let
the user name the source. Never record a low-confidence origin.
