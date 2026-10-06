# Troubleshooting

## Installation

### Problem: `sv: command not found` after pip install

**Symptoms**: `pip install .` succeeds but the shell can't find `sv`.

**Cause**: pip's script directory isn't on `PATH` (common with `--user` installs and on Windows).

**Solution**: Use `pipx install .` (handles PATH for you), or run via `python -m skill_vault`, or add pip's scripts directory to PATH (`python -m site --user-base` + `/bin`, or `%APPDATA%\Python\Scripts` on Windows).

### Problem: `npm install` fails in `app/`

**Symptoms**: engine errors or native build failures.

**Cause**: Node version below 20. The app requires Node 20+ (`"engines": { "node": ">=20" }`) but has no native dependencies — anything failing to compile suggests a very old toolchain.

**Solution**: Install Node 20 LTS or newer (`nvm install 20`), delete `node_modules`, re-run `npm install`.

## Pushing and syncing

### Problem: Symlink creation fails on Windows

**Symptoms**: `sv push` errors with a privilege error, or pushed "skills" appear as broken shortcuts.

**Cause**: Windows requires Developer Mode (or elevation) to create symlinks.

**Solution**: Enable Developer Mode (Settings → System → For developers), or push with copies instead: `sv push --copy`.

**Prevention**: If you stay on copies, remember copied skills don't auto-update when the vault changes — re-push after edits (`sv watch` automates this).

### Problem: A skill shows `stale` right after pushing

**Symptoms**: `sv status` or the app reports stale immediately.

**Cause**: The target has a *copy* whose content hash no longer matches the vault (edited in place at the target, or an old copy push), or line-ending normalization changed the hash.

**Solution**: Open the diff in the app's Sync page to see which side changed. Pull if the target edit is the one you want (`sv import <skill>`), or re-push to overwrite (`sv push <skill> -f`).

### Problem: An agent edited a skill directly and the vault doesn't have the change

**Symptoms**: Skill content differs per tool; the vault copy is older.

**Cause**: With `--copy` pushes (or tools that materialize files), edits at the target don't flow back automatically.

**Solution**: `sv sync` detects target-side changes and proposes a **pull**; or `sv import <skill>` to pull one skill explicitly.

## The app

### Problem: Port already in use / app opens on an unexpected port

**Symptoms**: Startup log shows a different port than configured.

**Cause**: The launcher picks the next free port when the preferred one is busy — often a stale dev server still running.

**Solution**: Close the stale process, or pin a port: `npm run dev -- --port 5500`. Check precedence if a value "won't stick": CLI flag → env var → `.env` → config.json `app` block → defaults.

### Problem: App is unreachable from another device on the LAN

**Symptoms**: Works on `localhost`, times out from a phone/laptop.

**Cause**: Default host is `127.0.0.1` (loopback only).

**Solution**: Start with `--host 0.0.0.0` (or `HOST=0.0.0.0` in `.env`), allow `node.exe` through Windows Firewall on first bind. Only expose on networks you trust — the dashboard can modify your vault and agent directories.

### Problem: App shows an empty vault / Setup page even though the CLI works

**Symptoms**: CLI lists skills; app asks for setup.

**Cause**: The app couldn't read `~/.skill-vault/config.json` — usually a different user profile (app launched from a different account) or a `vault_path` pointing at a moved directory.

**Solution**: `sv config show` to verify `vault_path`; fix with `sv config set vault_path <path>`. Make sure the app runs as the same OS user as the CLI.

## Discovery and scanning

### Problem: `sv scan` reports "No API key found"

**Symptoms**:

```
No API key found. Set one with:
  sv config set ai_scanner.api_key YOUR_KEY
Or set the ANTHROPIC_API_KEY environment variable.
```

**Cause**: `ai_scanner.provider` is `anthropic-sdk` but no key is configured.

**Solution**: Set `ANTHROPIC_API_KEY` in your environment, or `sv config set ai_scanner.api_key <key>`, or switch back to the local CLI provider: `sv config set ai_scanner.provider claude-cli`.

### Problem: `sv discover` doesn't find a tool's skills

**Symptoms**: Skills exist on disk but discovery skips them.

**Cause**: The tool's directory isn't in `agent_locations` (non-standard install path).

**Solution**: Add it as a provider: `sv config set agent_locations.<slug> <path>` (or Settings → Add provider in the app), then re-run `sv discover`.

## State and repair

### Problem: Vault and manifest disagree (skill on disk but not listed, or vice versa)

**Symptoms**: `sv list` misses a folder that exists under `skills/`, or lists one that doesn't.

**Cause**: Manual file operations in the vault outside the tools.

**Solution**: `sv fix` audits and repairs manifest/disk drift. For a skill folder you added manually, `sv add <vault>/skills/<name>` registers it.

## The AI assistant

### Problem: The panel says "Assistant unavailable"

The reason line tells you which prerequisite failed:
- **claude.exe not found / claude --version failed** — install [Claude Code](https://claude.com/claude-code) and sign in (`claude` must work in a terminal). On Windows the real `claude.exe` must be resolvable, not just a shim; reinstalling the CLI normally fixes this.
- **vault not configured** — finish the Setup page first.
- **assistant plugin bundle missing** — the app's `assistant-plugin/` folder is gone; re-pull or reinstall the app.

Use the Retry button after fixing; status is cached for 60 seconds.

### Problem: A chat turn errors with "a turn is already running"

One turn runs per chat (two app-wide) to bound spend. Wait for the running turn (pulsing dot on the sidebar button) or press Stop in that chat.

### Problem: Suggestions say "sources not checked yet" or look stale

The background sweep first runs ~45 seconds after the app starts and every 6 hours after, skipping while a Notion job or manual update check is running. Click **refresh** in the For-you footer to run it now. Update cards also drop out automatically once you've re-adopted or updated a skill after the sweep.

### Problem: The mic button does nothing

Grant microphone permission when the browser asks (check the address-bar permission icon if you dismissed it). Dictation needs Chrome or Edge; the button hides entirely on browsers without the Web Speech API.
