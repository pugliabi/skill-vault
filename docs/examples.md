# Examples

Copy-pasteable recipes for common workflows. Each is self-contained.

## Create a skill from scratch and push it

```bash
mkdir -p my-skill
cat > my-skill/SKILL.md <<'EOF'
---
name: my-skill
description: One-sentence description of when an agent should use this skill.
---

# My Skill

Instructions the agent follows when this skill triggers.
EOF

sv add ./my-skill          # copy into the vault, register in skills.json
sv push my-skill           # push to your default targets
sv status                  # confirm it shows synced
```

## Consolidate skills you already have across tools

You've been writing skills in Claude Code and Cursor separately and want one library:

```bash
sv discover                # finds skills in all registered agent dirs
sv adopt                   # pick which ones to import into the vault
sv push                    # push everything back out to all targets
```

From now on, edit skills in the vault (or via the app's file editor) — with symlink pushes, every agent sees changes immediately.

## Import a skill collection from GitHub

```bash
sv adopt-remote https://github.com/anthropics/skills
```

Clones the repo, discovers skills inside it, and lets you interactively pick which to import. Then `sv push` to distribute.

## Push selectively

```bash
sv push -t claude                 # everything, but only to the claude provider
sv push data-analyst -t cursor    # one skill to one provider
sv push --dry-run                 # see what would happen first
sv push --select                  # interactive picker per target
sv push --copy                    # real copies instead of symlinks
```

## Keep a skill experimental until it's ready

```bash
sv add ./rough-idea --stage staging   # or move it later:
sv demote rough-idea                  # production → staging
# iterate…
sv promote rough-idea                 # staging → production
sv push rough-idea
```

Staged skills are visible in the app under the Staging pill and are excluded from normal pushes until promoted.

## Auto-push while editing

```bash
sv watch
```

Watches the vault for changes and re-pushes modified skills automatically — useful during a heavy editing session. Ctrl+C to stop.

## Package a skill for Claude Desktop

Claude Desktop loads skills from your claude.ai account, so instead of a directory push you build an upload-ready zip:

```bash
sv package my-skill --target claude-desktop
```

Then upload the zip in Claude Desktop → Settings → Capabilities → Skills. The app's skill-detail Zip / package actions do the same.

## Sync two machines through a git vault repo

On machine A (vault is a git repo):

```bash
sv snapshot && cd <vault> && git add -A && git commit -m snapshot && git push
```

On machine B:

```bash
cd <vault> && git pull
sv devices                 # see machine A's snapshot
sv sync-from MACHINE-A     # interactively pick skills to bring local
sv sync-from MACHINE-A --dry-run    # or preview first
```

## Repair a drifted setup

Symlinks broken after moving the vault, manifest out of date, mystery state:

```bash
sv fix          # audits vault state and repairs what it can
sv status       # verify
sv push -f      # re-push everything if needed
```

## Run the whole loop guided

```bash
sv quick        # discover → adopt → push with prompts
sv sync         # two-way: computes a push/pull/adopt/promote plan, asks, runs
```

`sv sync` is the daily driver once a vault is established — the app's Sync page is the same engine with per-row diffs.
