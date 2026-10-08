# GitHub discovery recipes

WebFetch calls, the JSON fields to read, and the etiquette that keeps the
unauthenticated limits (search: 10/min · core: 60/hr) from biting.

## Repository search (the workhorse)

```
https://api.github.com/search/repositories?q=<terms>+claude+skills&sort=stars&order=desc&per_page=10
https://api.github.com/search/repositories?q=topic:claude-skills+<terms>&sort=stars
https://api.github.com/search/repositories?q=<terms>+agent+skills+in:name,description&sort=stars
```

Read per item: `full_name`, `description`, `stargazers_count`, `html_url`,
`pushed_at` (staleness flag), `default_branch` (needed for verification),
`topics`.

## Code search (finding SKILL.md matches)

The JSON code-search endpoint requires auth. Fall back to:

```
WebFetch: https://github.com/search?q=<terms>+path:SKILL.md&type=code
WebSearch: "<terms>" SKILL.md github
WebSearch: awesome claude skills <topic>
```

## Verification calls (per candidate — cheap, core-rate)

```
https://api.github.com/repos/<org>/<repo>/git/trees/<default_branch>?recursive=1
```
One response lists every path — count entries ending in `/SKILL.md` and
collect their parent folder names (= the skills inside). If `truncated:
true`, fall back to `/contents/<dir>` for the likely skill roots
(`skills/`, root, `plugins/`).

Spot-check relevance by reading one skill's description:
```
https://raw.githubusercontent.com/<org>/<repo>/<branch>/<path>/SKILL.md
```

## Rate-limit etiquette

- Budget per ask: ≤3 search calls + ≤1 verification call per presented row.
- On 403: read `X-RateLimit-Remaining`; if 0, STOP, present what you have,
  and say the limit was hit — never loop.
- Prefer one `per_page=10` call over paging.

## Ranking & flags

Primary sort: `stargazers_count`. Flags: `pushed_at` older than ~1 year →
"stale"; monorepos with many skills → note the count (a 50-skill monorepo
at 1k★ may matter more than a single-skill repo at 2k★ — say so rather
than letting raw stars mislead).
