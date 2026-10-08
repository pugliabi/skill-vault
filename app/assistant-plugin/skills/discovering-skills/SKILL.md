---
name: discovering-skills
description: Use this skill when finding skills on GitHub or the web that the user wants to add to their vault — requests like "find top skills for X", "best Claude skills for Power BI", "search GitHub for agent skills", "discover new skills", "trending skills", "any good skills for this workflow". Covers GitHub repository and code search via WebFetch, star-ranked result tables, verifying candidates actually contain SKILL.md folders, deduplicating against the vault, and handing off to the clone, scan, and adopt pipeline.
---

# Discovering skills on GitHub and the web

Produce a verified, star-ranked shortlist the user can choose from — then
adopt what they pick through the standard pipeline. NEVER adopt without
showing the list first.

See ./references/github-search.md for the exact API calls, JSON fields, and
rate-limit rules.

## 1. Shape the query

Turn the ask into 2-3 search angles, e.g. "top skills for creating agents" →
`agent creation claude skills` (repo search) · `topic:claude-skills agent`
(topic search) · `"subagent" filename:SKILL.md` (code/web search). Three
good queries beat ten sprayed ones — the unauthenticated search API allows
10/minute.

## 2. Search

Run the angles via WebFetch against the GitHub search API (recipes file);
supplement with one WebSearch for awesome-lists (`awesome claude skills
<topic>`) when the topic is broad.

## 3. Verify before presenting — non-negotiable

A starred repo is not a skill repo until proven: fetch its tree/contents
and confirm real `SKILL.md` folders exist; count them; note roughly which
are relevant. Drop anything unverifiable from the table (or mark it
explicitly unverified).

## 4. Present — one table

Ranked by stars, max ~10 rows:

| name | what it does (one line) | ★ | skills inside | link |

Flag: **in vault** (dedupe below) · **stale** (last push > ~1 year) ·
anything rate limits cut short. Follow with a two-line recommendation:
which 1-2 repos best fit the ask and why.

## 5. Dedupe against the vault

`list_skills` once; match candidates by skill NAME and by origin URL
(the user may have the same repo under a different clone). "You already
have X from this repo" beats re-adopting it.

## 6. Adopt what the user picks

Standard pipeline (detail: syncing-from-github):
`git clone --depth 1 <url> <repos_dir>/<repo>` → `scan_dir_for_skills` →
show the scan (duplicates flagged) → `adopt_skills` with
`origin_context {type:"git", root, url, ref}` so every adopted skill stays
update-checkable forever.

## Scope guard

Discovery reads the web and the vault — nothing else. Cloning happens only
after the user picks; adoption only for the skills they chose.
