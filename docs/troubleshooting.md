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

### Problem: Clicking the Skill Vault shortcut doesn't open a window

**Symptoms**: nothing happens, or a "Skill Vault" message box appears.

**Cause**: the launcher couldn't find Node, couldn't rebuild, or the server didn't answer within 20 seconds.

**Solution**: read `~/.skill-vault/logs/launch.log` (launcher steps and build output) and `~/.skill-vault/logs/server.log` (the server's own output). Re-running `setup.cmd` repairs packages, the build and the shortcuts. If it keeps failing, delete `~/.skill-vault/app.lock` and try again.

### Problem: "Update & restart" is greyed out

**Symptoms**: the update dialog says "Can't update right now: …".

**Cause**: in-app updates only fast-forward a clean `main` checkout. The reason names what's in the way: another branch, uncommitted changes, local commits not on GitHub, GitHub's main branch (origin/main) wasn't found, the `app` folder isn't directly inside its git checkout, running from source with `npm run dev`, or a job (Notion sync, assistant reply, update check) still running.

**Solution**: commit, stash or push your changes, or switch to `main`. When running from source, `git pull` and restart yourself. If the `app` folder was moved into another git repository, run Skill Vault from its own clone. The dialog checks again each time you open it, so close and reopen it after fixing the cause.

### Problem: An update says "waiting for running jobs to finish"

**Symptoms**: the update dialog shows the Restart step waiting, and the window doesn't reload.

**Cause**: the new version is built, but a Notion sync, an assistant reply or a skill update check is still running; restarting now would cut it off.

**Solution**: let it finish (or stop the assistant reply); the restart then happens by itself and the window reloads.

### Problem: An update failed with "couldn't move the current build aside"

**Symptoms**: the dialog shows `✗ Build: couldn't move the current build aside …`.

**Cause**: Windows wouldn't rename the `app\dist` folder because something had a file in it open (an antivirus scan, an Explorer preview pane, an editor).

**Solution**: nothing was changed — the checkout was put back and your current version is still running. Close anything showing that folder and try **Update & restart** again. Full details are in `~/.skill-vault/logs/server.log`.

### Problem: Port already in use / app opens on an unexpected port

**Symptoms**: Startup log shows a different port than configured.

**Cause**: The launcher picks the next free port when the preferred one is busy — often a stale dev server still running. A port another program listens on for all addresses (`0.0.0.0` or `::`) counts as busy too, so the app never hides that program from `localhost`.

**Solution**: Close the stale process, or pin a port: `npm run dev -- --port 5500`. Check precedence if a value "won't stick": CLI flag → env var → `.env` → config.json `app` block → defaults.

### Problem: App is unreachable from another device on the LAN

**Symptoms**: Works on `localhost`, times out from a phone/laptop.

**Cause**: Default host is `127.0.0.1` (loopback only).

**Solution**: Start with `--host 0.0.0.0` (or `HOST=0.0.0.0` in `.env`), allow `node.exe` through Windows Firewall on first bind. Only expose on networks you trust — the dashboard can modify your vault and agent directories.

### Problem: App shows an empty vault / Setup page even though the CLI works

**Symptoms**: CLI lists skills; app asks for setup.

**Cause**: The app couldn't read `~/.skill-vault/config.json` — usually a different user profile (app launched from a different account) or a `vault_path` pointing at a moved directory.

**Solution**: `sv config show` to verify `vault_path`; fix with `sv config set vault_path <path>`. Make sure the app runs as the same OS user as the CLI.

## Setup guide

### Browse… does nothing, or the folder dialog is behind the window

The dialog opens on top of the app; if another program took focus, look for it in the taskbar. Browse only appears when the app runs on this PC (not over the LAN or on a Mac); you can always paste a path instead.

### "Skill Vault can't open this folder"

The folder exists but Windows won't let the app read it. Check the folder's permissions or pick another one.

### "The repo wasn't found, or it needs a sign-in this PC doesn't have"

Check the URL. For a private repo, sign in to GitHub with Git on this PC first (for example, clone any private repo once in a terminal so Git Credential Manager saves your sign-in), then try again. The same applies if the preview fails part-way with a plain message: the connection dropped or the sign-in expired, so try again.

### "Use a full folder path"

Folders must be typed in full, like `C:\Users\you\skill-vault`. A name such as `my-vault` or a path starting with `~` isn't accepted, because Skill Vault wouldn't know where to put it. Use Browse… or paste the full path.

### "Git isn't installed on this PC"

Cloning from GitHub needs Git. Install Git for Windows, restart Skill Vault, then check the repo again.

### Retry says "There's nothing to retry"

Nothing failed in the last Finish, or the app was restarted since. Check Settings to see what was saved; press **Finish** again if something is missing.

### Notion sign-in came back with an error

The guide returns to the Notion step with Notion's reason. Press **Connect Notion** again, or skip the step and connect later in Settings → Notion.

### Setup finished with "items need attention"

Your vault and settings are saved. Press **Retry failed items**, or finish those skills on the Adopt page. Skills that were already moved stay where they are.

### Finish says "Lost contact with setup"

The app stopped answering while Finish was running. Check Settings to see what was saved before pressing Finish again. A new-vault folder left with only an empty `skills/` folder and an empty `skills.json` counts as empty, so pressing Finish again is safe.

### Finish says "Settings saved. Restart Skill Vault to watch the new folders."

Your settings were written, but the app couldn't restart its file watcher. Close and reopen Skill Vault; nothing else is needed.

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

## Notion

### Problem: "Connect Notion" fails with "Couldn't reach Notion" (older versions: "fetch failed")

**Symptoms**: clicking **Connect Notion** shows an error right away and never opens notion.com, even though Notion opens fine in the browser.

**Cause**: the app's server (Node.js), not the browser, talks to `mcp.notion.com`, and it can't get through. The error names the reason: a certificate code (`SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`) means a proxy or antivirus is inspecting HTTPS with a certificate the browser trusts but Node.js doesn't; `ENOTFOUND` means the name couldn't be looked up; a timeout means a firewall or proxy is blocking Node.js. The full error is in `~/.skill-vault/logs/server.log` (lines starting `[notion]`).

**Solution**: for certificate errors, allow `mcp.notion.com` through the HTTPS inspection, or start the server with Node's `--use-system-ca` flag (Node 22.15+) so it trusts the Windows certificate store. For lookups and timeouts, check the connection or proxy settings, then try **Connect Notion** again.

### Problem: Pushing to Notion fails with "returned no archive"

**Symptoms**: pushing (or pulling) a skill that is only a `SKILL.md` fails with `download-skill returned no archive for <page id>`; such skills may also sit in "changed in vault" forever.

**Cause**: Notion returns single-file skills as inline text rather than an archive link, which older versions of the app rejected. A first push could then leave the new page linked but never marked synced.

**Solution**: update the app (the current version handles both forms), then run **Link skills** once from the Notion menu: it re-checks those links and marks the ones whose content matches as in sync. See [notion-sync.md](./notion-sync.md#known-notion-limitations).

## The AI assistant

### Problem: The panel says "Assistant unavailable"

The reason line tells you which prerequisite failed:
- **claude.exe not found / claude --version failed** — install [Claude Code](https://claude.com/claude-code) and sign in (`claude` must work in a terminal). On Windows the real `claude.exe` must be resolvable, not just a shim; reinstalling the CLI normally fixes this.
- **vault not configured** — finish the setup guide first.
- **assistant plugin bundle missing** — the app's `assistant-plugin/` folder is gone; re-pull or reinstall the app.

Use the Retry button after fixing; status is cached for 60 seconds.

### Problem: Chats fail with "This API key is not scoped to a workspace"

**Symptoms**: every assistant reply fails at once with that API error, at $0.

**Cause**: an `ANTHROPIC_API_KEY` set in your environment (often user-wide, for another tool) was used instead of your Claude login, and that key needs a workspace ID.

**Solution**: in **Settings → AI assistant → Sign in with**, choose **Claude login** (the app then ignores the environment key), or choose **API key** and enter the key's workspace ID.

### Problem: A chat turn errors with "a turn is already running"

One turn runs per chat (two app-wide) to bound spend. Wait for the running turn (pulsing dot on the sidebar button) or press Stop in that chat.

### Problem: Suggestions say "sources not checked yet" or look stale

The background sweep first runs ~45 seconds after the app starts and every 6 hours after, skipping while a Notion job or manual update check is running. Click **refresh** in the For-you footer to run it now. Update cards also drop out automatically once you've re-adopted or updated a skill after the sweep.

### Problem: The mic button does nothing

Grant microphone permission when the browser asks (check the address-bar permission icon if you dismissed it). Dictation needs Chrome or Edge; the button hides entirely on browsers without the Web Speech API.
