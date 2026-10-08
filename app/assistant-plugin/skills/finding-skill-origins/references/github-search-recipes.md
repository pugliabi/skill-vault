# GitHub search recipes (origin hunting)

All calls via WebFetch unless noted. Unauthenticated limits: search API =
10 requests/min; core API = 60/hour. Check `X-RateLimit-Remaining` when a
403 appears; STOP on exhaustion and say so — never retry-loop. 2-3
well-chosen calls beat ten.

## Follow a rename in one call

```
https://api.github.com/repos/<old-org>/<old-repo>
```
GitHub serves renamed/transferred repos through the old URL; compare the
response's `full_name` to what was requested — a mismatch IS the new home.
`404` = genuinely gone (try forks, below).

## Confirm a folder exists (verification step)

```
https://api.github.com/repos/<org>/<repo>/contents/<subpath>
https://api.github.com/repos/<org>/<repo>/git/trees/<default_branch>?recursive=1
```
The trees call lists every path in one response — grep it for `SKILL.md`
to inventory all skill folders at once (`truncated: true` means fall back
to /contents per directory).

## Find by name or content

```
https://api.github.com/search/repositories?q=<skill-name>+in:name&sort=stars&order=desc
https://api.github.com/search/repositories?q=<keyword>+claude+skills&sort=stars
```
Code search (`/search/code`) requires auth — fall back to the HTML search
via WebFetch or plain WebSearch:

```
https://github.com/search?q=%22<distinctive+phrase>%22&type=code
WebSearch: "<distinctive sentence>" SKILL.md github
```

## Deleted original → fork network

```
https://api.github.com/repos/<org>/<repo>/forks?sort=stargazers&per_page=5
```
The most-starred fork is usually the maintained successor; verify content
before trusting it.

## Fields worth reading in responses

`full_name` (rename detection) · `html_url` · `stargazers_count` ·
`default_branch` (needed for trees/raw URLs) · `pushed_at` (staleness) ·
search `items[].path` (where the match lives).

## Raw file fetch (compare content during verification)

```
https://raw.githubusercontent.com/<org>/<repo>/<branch>/<subpath>/SKILL.md
```
Compare its frontmatter `name:` and a distinctive line against the vault
copy before declaring a match.
