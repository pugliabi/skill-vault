# Features & Use Cases

Skill Vault is two tools over one vault: the `sv` CLI for terminal workflows and automation, and the Skill Vault App for visual management. This page covers both, grouped by what you're trying to do.

## Dashboard — see the state of everything

![Dashboard](images/dashboard.jpg)

The app's Dashboard summarizes the vault: skill and provider counts, status cards (synced / stale / missing / staging / vault-only), per-provider health bars, and an **actions available** list — each row is a one-click fix ("1 skill drifted — re-push to update", "87 skills missing from a target — push to restore") with the equivalent CLI command shown alongside.

CLI equivalent: `sv status` for the same numbers, `sv fix` to audit and repair vault state (broken symlinks, manifest drift, orphaned entries).

## Skills browser — find, inspect, and act on skills

![Skills list](images/skills-list.jpg)

The Skills page lists every skill with its description, tags, file count, configured providers, and sync state. It offers:

- **Four layouts** — list, cards, grouped, and coverage matrix.
- **Search** — matches names, descriptions, and the full SKILL.md body.
- **Status pills** — filter to Production / Staging / Stale / Missing / Vault-only.
- **Target filter** — combine a provider with a state, e.g. "everything missing from Cursor".
- **Multi-select** with a bulk action bar for pushing, tagging, or removing many skills at once.
- **Command palette** (Ctrl/⌘-K) — jump to any skill or run a command from anywhere.

CLI equivalents: `sv list`, `sv status`.

## Coverage matrix — the "what's not synced where" view

![Coverage matrix](images/coverage-matrix.png)

The matrix layout is a skills × providers grid. A filled dot means synced; an empty circle means not present. Click a column header to push everything missing or stale to that provider, or a single cell to push one skill to one provider. Combined with search, it answers "which of my Power BI skills are on which agent?" in one glance.

## Skill detail — inspect and edit in place

![Skill detail](images/skill-detail.jpg)

Clicking a skill opens the detail overlay with three tabs: **overview** (stage, source, path, tags, metadata), **targets** (per-provider sync state with push/pull per row), and **files** (the skill's file tree with a rendered SKILL.md preview and an in-place editor). Actions along the top: Push, Pull, Zip, export to OpenClaw, Rename (cascades everywhere), and Remove.

## Sync — two-way, with a plan you approve first

![Sync plan](images/sync-plan.jpg)

`sv sync` (CLI) and the Sync page (app) compute a smart two-way plan: **push** skills that drifted or are missing at a target, **pull** changes made in a provider directory back into the vault, **adopt** new skills found in provider directories, and **promote** staged skills. Nothing runs until you approve; in the app every row offers a **diff-before-run** so you can see exactly what changes. Deselect anything you don't want, then run the rest.

Related CLI: `sv push`, `sv import` (pull one skill from an agent dir), `sv watch` (auto-push on file change).

## Discovery and adoption — grow the vault

- `sv discover` scans registered agent directories (optionally including Claude plugins) for skills that aren't in the vault.
- `sv adopt` interactively imports discovered skills.
- `sv adopt-remote <git-url>` clones a repo or plugin URL, discovers its skills, and lets you pick which to import.
- `sv scan <path>` analyzes a local repo for skills, hooks, and commands; with the AI scanner configured it can use Claude to identify skill-like content (see [Configuration](./configuration.md#ai_scanner)).

The app's **Adopt** page covers the same flow, and **Add existing** imports a skill folder from disk.

## Curation — keep the library healthy

- **Auto-tagging** — heuristic tagger proposes tags per skill; review and apply in bulk.
- **Health board** — flags *trigger collisions* (skills whose descriptions are so similar an agent may pick the wrong one) and low-quality SKILL.md files (structure/quality score).
- **Staging → production** — keep experimental skills in `staging/`; `sv promote` moves them to production, `sv demote` moves them back. Status pills and the manifest track the stage.

## Packaging and sharing

- `sv package <skill> --target <format>` builds a target-specific artifact for tools that can't consume a plain skills directory — e.g. a Claude Desktop upload-ready zip (the app's Claude Desktop packaging does the same, staging zips in a folder you pick).
- `sv share <skill>` cross-publishes a skill to additional providers.
- **Export to OpenClaw** — installs a skill into the isolated OpenClaw WSL gateway via its own CLI.
- The Zip action on any skill produces a portable archive.

## Multi-device sync

Keep the vault directory in a git repo, then:

```bash
sv snapshot          # record this machine's state to snapshots/<machine-id>.json
sv devices           # list device snapshots
sv sync-from LAPTOP  # compare another device's snapshot and pick what to sync
```

The app's **Devices** page shows the same snapshots with a visual compare. See [vault-format.md](./vault-format.md) for the snapshot schema.

## Providers — manage where skills go

Providers are named directories skills can be pushed to — one per agent tool, plus any custom location (a project repo's skills folder, for example). Manage them in the app's Settings page (add/rename/remove with live path validation, "★ All providers" bulk add) or via `sv config`. Both tools read the same `agent_locations` map, so changes made in either are visible to both.
