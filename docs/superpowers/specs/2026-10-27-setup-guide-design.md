# First-Run Setup Guide — Design

**Date:** 2026-10-27 · **Status:** approved design, awaiting spec review · **Project 3 of 5** in the
app improvement roadmap (1 bug fixes ✓, 2 install & launch ✓, 3 first-run setup guide, 4 GitHub skills
flow, 5 Notion sync redesign).

## Problem

- First run shows a single text box (`client/src/pages/Setup.tsx`): type an absolute vault path, press
  Continue. There is no folder picker, no way to start from an existing vault repo, and nothing else is
  set up.
- Targets (providers) must be added one at a time in Settings by typing an id and a path. The app has no
  detection; only the Python CLI's `sv init` detects the six known tools.
- Notion and the assistant's sign-in live in long Settings sections a new user has to find on their own.
- A new user who already has skills in `~/.claude/skills` (or Cursor, Copilot…) has to discover the
  Adopt page to bring them into the vault, and the Push drawer to send vault skills back out.
- Nothing can be re-run as a guided flow later; changing the vault or targets means editing rows in
  Settings.
- Notion's sign-in always returns to `/settings`, and while the app window is on notion.com the
  installed app's idle auto-stop counts no open windows — a sign-in that takes longer than 60 s lands on
  a stopped server.

## Goals

1. A step-by-step **setup guide** opens on first run (no `vault_path`) and walks through vault, targets,
   skills, Notion and the assistant.
2. **Nothing is saved until Finish.** Answers are held in a draft; Finish applies them in one job with
   live progress.
3. **Browse…** opens the normal Windows "Select folder" dialog; a typed path always works.
4. The vault can be **new**, an **existing folder**, or **cloned from GitHub** (including vaults that
   live in a subfolder of the repo, like `agent-skills/skills/`).
5. Known tools are **detected**; found ones start selected.
6. An optional step offers to **adopt** skills found in the targets and **push** vault skills out to
   the default targets, each with a preview checklist.
7. The guide can be **run again any time** from Settings and the command bar, filled in with the current
   settings.

## Non-goals

- Linking skills to Notion pages (project 5 redesigns that flow) and GitHub skill sources/updates
  (project 4).
- Claude Desktop packaging, tags, version history and other Settings-only options.
- A folder picker on macOS / Linux or over the LAN (typed path only there).
- Undoing file moves after a partly failed Finish.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Shape | Full-screen step-by-step wizard; every step but the vault is skippable; re-runnable from Settings and the command bar, pre-filled. |
| Folder picker | The Windows folder dialog, opened by the server; hidden on non-Windows or non-local requests, where the user types a path. |
| Vault choices | New folder, existing folder, or clone a vault repo from GitHub. |
| First sync | Optional step offering adopt + push with preview checklists; skipping moves nothing. |
| When changes happen | Collect everything, commit once at Finish (approach B). The draft lives in a per-machine file. Two unavoidable exceptions, stated on screen: the Notion sign-in itself, and a temporary preview copy for clones. |

## User flow

`/setup` — full screen in the existing Setup page style, with a progress rail across the top.
Navigation: **Back / Skip / Next**. **Skip** leaves that area as it is now (on first run: empty).

1. **Welcome.** "Nothing is saved until you press Finish." If a draft exists: **Resume** or **Start
   over**. If config changed since the draft was started (e.g. `sv init` ran), Resume is replaced by a
   note and **Start over**.
2. **Vault** (required — no Skip). One of:
   - **Start a new vault** — pick a folder; created on Finish if it doesn't exist. Must be missing or
     empty.
   - **Use a folder I have** — pick a folder. The step shows what `inspect` found: `skills.json` with
     *N* skills; or *N* skill folders and no `skills.json` ("one will be created"); or empty. If the
     folder is inside a git repo, it shows the repo's origin.
   - **Clone from GitHub** — repo URL + parent folder (destination defaults to
     `<parent>\<repo-name>`, editable; must be missing or empty). **Next** runs the clone preview and
     shows "vault found at `skills/` — 278 skills". If two folders at the same depth both have a
     `skills.json`, the user picks one. With no `skills.json` in the top two levels it offers **Use it
     as a new vault anyway** (vault = repo root).
   - Under **More**: *This PC's name* (`machine_id`, pre-filled with the current value or hostname).
3. **Targets.** The six known tools — Claude Code, OpenClaw, Cursor, Codex, Copilot, Windsurf — each
   labelled **Found** (skills folder exists), **Installed, no skills folder yet** (parent folder
   exists) or **Not found**. Found and already-configured targets start ticked. A second checkbox per
   row marks it a **default target**. **Add a custom target**: name + folder (Browse…). Existing custom
   targets are listed and keep their names. Unticking an existing target removes it from config on
   Finish; no files are deleted.
4. **Skills** (optional). Built by `POST /api/setup/plan` from the draft:
   - **In your targets, not in the vault** → checklist, to adopt. A skill that exists in several
     targets with different content is listed as "differs between targets" and can't be picked.
   - **In the vault, not in your default targets** → checklist, to push to the default targets.
   - A name on both sides with different content → "differs — sort it out later on the Adopt page",
     never moved.
   - Lists use the shared checklist behaviour (`useChecklistSelection`: select all, shift/ctrl-click).
5. **Notion** (optional). If not connected: **Connect Notion** — explains that signing in saves the
   Notion sign-in on this PC right away. The sign-in returns to this step. Then pick the Skills database
   from the detected list (with the existing "add a Last edited property" option). A vault that already
   has a database in its `notion.json` shows it and keeps it unless changed. If already connected
   (re-run), shows the account state and the current database.
6. **Assistant** (optional). Shows whether the `claude` CLI is installed (version) and signed in; if
   missing, shows the install command and **Check again**. Choose **Claude login** (default) or **API
   key** (+ optional workspace ID). The key is held in page memory only and sent with Finish; it is
   never written to the draft. A reload means typing it again.
7. **Review & Finish.** A numbered list of exactly what will happen (the Finish steps below, with
   counts and paths), then **Finish**. Progress streams line by line and ends on a summary with **Open
   Skill Vault**.

**Entry points.** First run: `App.tsx` keeps redirecting to `/setup` while `vault_path` is unset; the
guide has no Close button then. Re-run: a **Run setup guide…** button at the top of Settings and a
"Setup guide" command in the command bar; the guide opens pre-filled from current config, and **Close**
asks "Discard your changes?" (deletes the draft).

## Draft

`~/.skill-vault/setup-draft.json`, per machine, never in the vault. Saved on every step change; deleted
by Finish (on success), Start over and Discard.

```ts
interface SetupDraft {
  version: 1;
  started_at: string;            // ISO
  base: string;                  // fingerprint of vault_path + agent_locations + default_targets at start
  step: "welcome" | "vault" | "targets" | "skills" | "notion" | "assistant" | "review";
  vault: {
    mode: "new" | "existing" | "clone";
    path: string;                // vault root to use (for clone: <dest>/<subdir>)
    clone?: { url: string; dest: string; subdir: string; skill_names: string[] };
    repo_url?: string;           // from clone, or the existing folder's origin; clearable on Review
  } | null;
  machine_id?: string;
  targets: { id: string; path: string; enabled: boolean; is_default: boolean; known: boolean }[];
  skills: { adopt: { name: string; from: string }[]; push: string[] };   // from = target id
  notion?: { data_source_id: string; data_source_name: string; add_last_edited: boolean } | null;
  assistant?: { auth: "login" | "api_key"; workspace_id?: string };
}
```

No secrets: no API key, no Notion tokens. A draft whose `base` no longer matches current config can't
be resumed.

## Finish

`POST /api/setup/apply` with the draft (and the API key, if any) runs one job, in this order, streaming
an event per step and per item. The API key is passed straight to the existing assistant-auth save and
never appears in events, logs or `apply/status`.

1. **Vault folder** — create the folder, or `git clone <url> <dest>`; then `initVault(path)` (writes
   `skills.json` and folders if missing).
2. **Config** — one `writeAppConfig` call: `vault_path`, providers (`agent_locations`),
   `default_targets`, `repo_url`, `machine_id`, `assistant`. Keys the app doesn't own are preserved, as
   today. Then `rebuildWatcher()`.
3. **Adopt** — each picked skill, via the existing adopt/import service code.
4. **Push** — each picked skill to each default target, via the existing push service code.
5. **Notion** — save the database choice to `<vault>/notion.json` via the existing data-source service
   code.

**Failure rules.**
- Steps 1–2 are all-or-nothing from the user's point of view: if step 1 fails, nothing else runs and
  config is untouched; the guide returns to Review with the error and the draft is kept. If step 2 fails
  after a clone succeeded, the error names the cloned folder so the user can delete or reuse it.
- Steps 3–5 run item by item: a failed item is recorded and the job continues. The summary lists
  failures with **Retry failed items** (re-runs only those items) and links to Adopt, Push and Settings.
  Moves that already happened stay — the summary says so.
- On success the draft is deleted, `["config"]` and skills queries are invalidated, and **Open Skill
  Vault** goes to `/`.

**Busy.** While the job runs, the server counts as busy: the idle auto-stop and the in-app updater wait,
like for other jobs. Only one apply runs at a time (409 otherwise). `GET /api/setup/apply/status`
returns the last job's events so a dropped stream can recover (same pattern as the update dialog).

## Server

New router `server/routes/setup.ts`, mounted at `/api/setup`, backed by single-purpose services in
`server/services/setup/`:

| Endpoint | Service | Job |
|---|---|---|
| `GET /capabilities` | — | `{ folder_dialog: boolean }` — true only on Windows and for a loopback request |
| `POST /pick-folder` `{ title, initial? }` | `folderDialog.ts` | Windows folder dialog → `{ path }` or `{ cancelled: true }`; 409 while one is open |
| `POST /inspect` `{ path }` | `inspect.ts` | missing / empty / not a folder / not writable; `skills.json` + skill count; skill folders without manifest; enclosing git repo + origin |
| `GET /targets` | `targets.ts` | known tools with found / installed / not-found, plus configured providers |
| `POST /clone-preview` `{ url }` | `clonePreview.ts` | temp preview clone → `{ subdir, skill_names }` or "no vault found" |
| `POST /plan` `{ draft }` | `plan.ts` | adopt and push candidates, with "differs" entries |
| `GET` / `PUT` / `DELETE /draft` | `draft.ts` | the draft file; GET reports `stale: true` when `base` no longer matches |
| `POST /apply`, `GET /apply/status` | `apply.ts` | Finish (event stream) and its last result |

All services take injected dependencies (home dir, spawn, fs-touching helpers, config reader/writer) so
tests run in temp folders and never touch the real `~/.skill-vault`.

**Guards.** Every POST / PUT / DELETE gets the same check as `/api/app`: refuse when `Sec-Fetch-Site` is
present and not `same-origin`, or `Origin` is present and isn't this server. `pick-folder` additionally
requires `process.platform === "win32"`, a loopback remote address, and a loopback `Host`.

**Folder dialog.** `powershell.exe -NoProfile -STA` runs a short script that uses the modern
`IFileOpenDialog` with `FOS_PICKFOLDERS` (Quick access, Desktop, OneDrive — not the old tree view),
owned by a hidden top-most form so it opens in front of the app window. The title and starting folder
are passed through environment variables, never interpolated into the script. The chosen path is
printed on stdout; cancel prints nothing. One dialog at a time; a 10-minute timeout kills it.

**Clone preview.** `git clone --depth 1 --filter=blob:none --no-checkout <url> <tmp>` into
`os.tmpdir()`, then `git ls-tree -r --name-only HEAD` to find `skills.json` at depth ≤ 2 (the shallowest
wins; if two tie, both are returned for the user to choose), then `git show HEAD:<subdir>/skills.json`
for skill names. `GIT_TERMINAL_PROMPT=0`; Git Credential Manager may still show its own sign-in window
for a private repo, which is expected. URL must be `https://…`, `ssh://…` or `git@host:…`. 2-minute
timeout; the temp folder is always removed.

**Target detection.** A TypeScript copy of the CLI's `DEFAULT_AGENT_LOCATIONS`
(`src/skill_vault/config.py`) with a comment pointing at it: `<home>/.claude/skills`, `.openclaw`,
`.cursor`, `.codex`, `.copilot`, `.windsurf`. *Found* = the skills folder exists; *installed* = its
parent exists (same rule as `detect_agent_dirs`).

**Notion return target.** `POST /api/notion/connect` accepts `return_to: "settings" | "setup"`
(default `settings`; anything else is ignored). It is saved with the pending sign-in state, and the
callback redirects to `/setup?notion=connected` (or `…=error&message=`) or `/settings?…` accordingly.

**Notion sign-in keeps the server up.** Starting a Notion sign-in records a pending timestamp; finishing,
failing or disconnecting clears it. The idle auto-stop treats a pending sign-in younger than 10 minutes
as busy. (This also fixes the Settings Connect button in the installed app.) The updater doesn't need
to wait for it: the sign-in state is on disk and the restarted server keeps the same port.

## Client

- `client/src/pages/setup/` replaces `pages/Setup.tsx`: `SetupGuide.tsx` (shell, rail, navigation,
  draft load/save), one file per step under `steps/` (`Welcome`, `Vault`, `Targets`, `Skills`, `Notion`,
  `Assistant`, `Review`), and `lib/setup.ts` for the API client and draft types (like
  `lib/appUpdate.ts`).
- Browse buttons call `pick-folder` only when `capabilities.folder_dialog` is true; otherwise only the
  text field shows.
- Settings gets **Run setup guide…** in its header; the command bar gets a "Setup guide" entry.
- Reuses existing primitives (`Button`, `Rule`, `Logo`, the checklist hook) and design tokens.

## Errors

Shown in plain words on the step they belong to:

- Folder can't be created / isn't writable / is a file / isn't empty (new vault, clone destination).
- Clone: not a git URL, needs sign-in or access denied, timed out, no `skills.json` in the top two
  levels (offers "use as a new vault anyway").
- Folder dialog unavailable or already open.
- `claude` CLI missing (install command + Check again).
- Notion sign-in denied or cancelled → back on the Notion step with the reason.
- Finish failing in steps 1–2 → back on Review with the error, nothing saved; failing items in 3–5 →
  the summary with Retry.

## Testing

- **Services** (Vitest, temp folders, injected home): draft round-trip and stale `base`; `inspect` for
  each folder shape; target detection; clone preview against a local repo built in the test (vault at
  root, vault in `skills/`, no vault, two candidates, bad URL, timeout); `plan` including "differs"
  cases; `apply` step order, all-or-nothing steps 1–2, per-item steps 3–5, retry of failed items, busy
  flag, one-at-a-time; Notion pending sign-in and its 10-minute cap; `return_to` whitelist.
- **Routes:** same-origin guard on every write; `pick-folder` refused for non-loopback / non-Windows;
  `capabilities`.
- **Folder dialog:** the built command and environment are unit-tested; the dialog itself is checked
  by hand on Windows.
- **Client:** type check; a full walk-through against a throwaway home folder on a test port (never the
  real vault), with screenshots of each step.

## Docs

`getting-started.md` (first run is the guide; re-run), `features.md`, `configuration.md`
(`setup-draft.json`; Notion `return_to`), `tech_reference.md` (setup API, Finish order, busy rules),
`troubleshooting.md` (folder dialog, clone sign-in, Notion sign-in), `faq.md`, `changelog.md`,
`app/CHANGELOG.md`, `SummaryOfChanges.md`.
