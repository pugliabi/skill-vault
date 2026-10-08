---
name: navigating-app-features
description: Use this skill when answering how to do something in the Skill Vault app or pointing the user to the right place — the catalog of pages (Dashboard, Skills, Sync, Adopt, Devices, Graph, Notion, Settings), their features and buttons, deep-link paths, sv CLI equivalents, keyboard shortcuts, and which actions only the UI can perform. Triggers: "how do I", "where can I", "what can the app do", "which page", "is there a button for", "can I do this from the CLI", "take me to", "what does this page do".
---

# Navigating the app's features

Answer "how do I…" with: the answer → the page + path → the steps. When the
task is reachable through the vault tools, OFFER to just do it. When it's
UI-only, name the exact page and control — never improvise around a missing
tool.

See ./references/feature-catalog.md for the full page-by-page map (every
page's actions, buttons, related tools, and sv commands).

## Page map

| Route | What it's for |
|---|---|
| `/` | Dashboard — status counts, provider health, one-click actionable list |
| `/skills` | The library: search/filter/status pills, list·card·grouped·matrix views, multi-select bulk bar, per-skill side panel |
| `/skills/<name>` | Deep link to a skill's detail (tabs: overview, targets, files, history) |
| `/sync` | The daily two-way plan: push/pull/adopt/promote rows with diffs, run-selected |
| `/adopt` | Bring skills IN: scan a path, a provider, all providers, or a git URL |
| `/devices` | Multi-device snapshots + sync-from |
| `/graph` | Visual map of skills ↔ providers |
| `/notion/push` · `/notion/pull` | Reviewed Notion plans |
| `/notion/conflicts` | Both-sides-changed resolution incl. Claude-assisted merge |
| `/notion/legacy` | Upgrade old summary pages to full skills |
| `/skill-names` | Fix SKILL.md-name vs folder-name disagreements |
| `/settings` | Vault path, providers, defaults, history, Notion connection, audit, tags, assistant install |

## UI-only actions (your toolset deliberately lacks these)

Notion OAuth connect/disconnect · skill deletion · Notion force overwrite ·
conflict merges · legacy upgrades · provider add/remove · Claude Desktop
packaging · choosing the Notion data source · overriding the git guard.

## sv CLI quick map (for "can I script this?")

`sv init` (setup wizard) · `sv status` · `sv sync` · `sv push [skill] -t
<provider>` (`--force`, `--copy`, `--dry-run`, `--select`) · `sv adopt` /
`sv adopt-remote <git-url>` / `sv discover` / `sv scan <path>` ·
`sv package <skill>` (Claude Desktop zip) · `sv snapshot` / `sv devices` /
`sv sync-from <device>` · `sv config show|get|set`.

## Keyboard shortcuts

`Ctrl/⌘+K` command palette · `Ctrl/⌘+J` this assistant · `/` focus skill
search · `j`/`k` next/previous skill · `?` shortcut cheatsheet · `Esc`
close/collapse.

## The assistant's own surface (for explaining yourself)

Entry points: sidebar button, Ctrl/⌘+J, and ✦ Ask AI buttons on failures,
skill views, Notion pages, selections, and filters. The panel's "For you"
cards and ✦ AI briefing (analyzing-suggestions), the 🎤 mic for dictation
(Chrome/Edge), session history + per-turn cost, and Settings → AI assistant
→ Install assistant skills (puts this bundle's skills into the user's own
vault).
