# Setup Guide: the Agents step (Claude Desktop and the skill-vault skill) — Design

**Date:** 2026-11-05 · **Status:** approved design, awaiting spec review · Builds on `main` at `bcf44cd`
(0.2.0 plus the agent access follow-ups). Branch `feat/setup-agents-step`.

## Problem

- Agent access (0.2.0, beta) lives only on the Settings card. A new user finishes the setup guide
  without ever hearing that Claude Desktop can reach their vault.
- Connecting Desktop has an order that's easy to get wrong. Desktop reads its MCP servers only when it
  starts, so it has to be quit from the tray icon and reopened; closing the window isn't enough. The
  install prompt only works once Desktop has the vault tools, so connecting comes first.
- The `skill-vault` skill has to be added to the vault before Claude Code, Cursor and the other tools
  get it. That's another click on the Settings card.
- Once the skill is installed, Desktop should treat the vault folder set in Skill Vault's Settings as
  the place all the user's skills live, and the targets set there as where they get pushed. Claude
  Desktop has no skills folder on this computer, and the skill doesn't say so outright today.
- Desktop's own way of making a skill ends with a zip or `.skill` file to download and upload. The
  user doesn't want that. A skill made or changed in a Desktop chat should be saved into the vault (and
  pushed to the user's tools from there). Today the skill does that only when the user asks for it in
  so many words.

## Goals

1. An optional **Agents** step in the setup guide, between Assistant and Finish. It offers:
   - **Add the skill-vault skill to my vault** (and push it to the default tools), shown whenever the
     skill isn't in the chosen vault, whether or not Desktop is installed;
   - **Connect Claude Desktop**, shown when Desktop is installed and not connected yet.
2. Both run at **Finish** as items in the existing job, with the same progress lines, the same
   carry-on-after-a-failure rule and **Retry failed items**. Nothing is saved before Finish.
3. After Finish, a **Finish in Claude Desktop** panel: quit Desktop from the tray icon and reopen it,
   then paste the install prompt into a new chat (**Copy install prompt**), with **Download skill zip**
   as the alternative.
4. The `skill-vault` skill says plainly that:
   - the vault is the folder set in Skill Vault's Settings, with the targets set there, and Desktop has
     no skills folder of its own to look for;
   - any skill made or changed in a chat is saved to the vault with `save_skill` and then offered for
     push, never handed back as a zip or `.skill` file. A zip is only for installing a vault skill in
     Claude Desktop or claude.ai when the user asks for that.
5. The Settings card keeps working exactly as it does now. The guide and the card share one copy of
   the connect and add-skill code.

## Non-goals

- Claude Code connect in the guide. It stays on the Settings card; a possible follow-up.
- Updating an outdated bundled skill from the guide. The card's **Update** and the Updates page do that.
- Installing the skill into Desktop for the user. Desktop keeps skills in the user's Claude account,
  and nothing on this PC can put them there.
- A new install mechanism. The prompt still embeds SKILL.md and asks for `skill-vault.zip`. That's the
  one zip that has to exist, because a file is the only way a skill gets into Desktop. The prompt gains
  one sentence saying so (below).
- Testing on macOS. `desktopConfigPath` already knows the macOS location, so the step should work
  there, but only Windows is checked.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Where the Desktop part goes | Its own optional step before Finish, labelled **Agents** on the rail (7 steps). |
| Desktop not installed | The step says so and still offers the skill, which helps the other tools too. |
| How Finish runs the work | New item types in the existing Finish job, not calls after Finish and not a second job. |
| What "the folder in Settings" means | The vault folder (and the targets) set in Skill Vault's Settings, not a Claude Desktop folder: Desktop has none on this computer. |
| A skill made or changed in a Desktop chat | Saved to the vault with `save_skill`, then offered for push. Never a zip or `.skill` file, even when another skill (such as skill-creator) says to package it. |
| Defaults | Like the Skills step: ticked on the first visit, saved picks on return. |

## The Agents step

Rail: Vault · Tools · Skills · Notion · Assistant · **Agents** · Finish. The Assistant step's Next and
Skip go to `agents`; Finish's Back goes to `agents`. The Welcome text becomes "where your skills live,
the tools you use, Notion, the assistant and Claude Desktop".

Title: **Claude Desktop and other agents (optional)**. Intro: "Let Claude Desktop and your other AI
tools work with your vault: find and load skills, save new ones, push them to your tools and run Notion
syncs."

The step loads `POST /api/setup/agents { draft }` (below), so every state is about the vault and the
tools chosen in this draft, not the saved settings.

**Row 1: the skill-vault skill**

| `skill.state` | Shows |
|---|---|
| `not_in_vault` | Tick **Add it to my vault**. Hint: "It tells agents how to use your vault. It's also pushed to your default tools: claude-code, cursor." With no default tools: "You can push it to your tools later." |
| `in_vault` | "Already in your vault." No tick. |
| `adopting` | "You're adopting skill-vault from <tool> on the Skills step." No tick. |

**Row 2: Claude Desktop**

| `desktop.state` | Shows |
|---|---|
| `not_connected` | Tick **Connect Claude Desktop**. Hint: "Adds a skill-vault server to Claude Desktop's settings. Your other servers stay as they are, and the file is backed up first. You'll restart Claude Desktop after Finish." |
| `broken` | Tick **Reconnect Claude Desktop**. Hint: "The connection points at a file that's gone." |
| `connected` | "Already connected." No tick. |
| `not_installed` | "Claude Desktop isn't installed for this user." No tick. |
| `name_taken` | 'Claude Desktop already has another MCP server named "skill-vault". Rename it to connect this one.' No tick. |
| `unreadable` | "Can't read the Claude Desktop config: <error>. Fix the file, then come back to this step." No tick. |

When `bridge_built` is false, the Desktop tick is disabled with "Build the app first" (only a dev
checkout can hit this).

**Ticks.** When `draft.agents` is null (first visit, or after Skip), each tick that's offered starts
on. Otherwise the ticks show the saved choice. A tick that isn't offered saves as `false`.

**Buttons.** Back → `assistant`. **Skip** → `agents: null`, go to `review`. **Next** → save
`{ add_skill, desktop_connect }`, go to `review`. Next is disabled only while the status loads: a step
with nothing to tick saves two `false`s. That still counts as visiting, so the panel after Finish can offer the install
prompt when Desktop is already connected.

**Finish's list** gains, in Finish order:

- `add_skill`: "Add the skill-vault skill to the vault and push it to your default tools". When the
  draft's own tool list has no default: "Add the skill-vault skill to the vault".
- `desktop_connect`: "Connect Claude Desktop to the vault tools".

## Draft

`services/setup/types.ts` and `client/src/lib/setup.ts`:

```ts
export type SetupStep = "welcome" | "vault" | "targets" | "skills" | "notion" | "assistant" | "agents" | "review";

export interface AgentsChoice {
  add_skill: boolean;
  desktop_connect: boolean;
}

export interface SetupDraft {
  // ...existing fields...
  /** null = Skip (or not visited): Finish touches neither. */
  agents: AgentsChoice | null;
}
```

`normalizeDraft`: `agents` missing or null → null; an object → both fields `=== true`; anything else →
`DraftError("agents must be an object")`. `STEPS` gains `"agents"` before `"review"`. `startDraft` sets
`agents: null`. The draft version stays 1, since an older draft simply reads as `agents: null`.
`configFingerprint` doesn't change: the Desktop config and the vault's skills aren't settings the guide
starts from.

## `POST /api/setup/agents`

Body `{ draft }`. It's 400 when the draft is malformed or has no vault (same as `/plan`). The
response:

```ts
interface AgentsStatus {
  bridge_built: boolean;            // <appRoot>/dist/assistant-mcp.js exists
  skill: { state: "not_in_vault" | "in_vault" | "adopting"; adopting_from?: string };
  desktop: { state: DesktopState; config_path: string | null; error?: string };
  default_targets: string[];        // ids of effectiveTargets(draft, config) with is_default
  vault_path: string;               // draft.vault.path
}
type DesktopState = "not_installed" | "not_connected" | "connected" | "broken" | "name_taken" | "unreadable";
```

`skill.state` against the draft's vault (`services/setup/agents.ts`):

1. `draft.skills.adopt` holds `skill-vault` → `adopting`, `adopting_from` = its `from`.
2. `new` vault → `not_in_vault`.
3. `existing` vault → `in_vault` when its manifest has a `skill-vault` entry or `skills/skill-vault`
   exists (a folder without a readable manifest counts by the folder alone); else `not_in_vault`.
4. `clone` vault → `in_vault` when `clone.skill_names` has `skill-vault`; else `not_in_vault`.

`in_vault` covers any `skill-vault`, ours or not. Whether it's ours, outdated or someone else's is the
Settings card's business.

`desktop` is the card's Desktop row, from the shared `desktopStatus()` (below). The route takes
`pathEnv?: () => PathEnv` as a test seam. Without `appRoot`, `bridge_built` is false.

## Finish

The fixed order, with the new parts in bold:

1. vault — 2. config — 3. adopt (**then `skill-vault (from Skill Vault)`**) — 4. push (**then
`skill-vault → <tool>`** for each default tool) — 5. Notion — 6. **Desktop**

Steps 1–2 are unchanged and still stop the job. Items in 3–6 record a failure and carry on, and
**Retry failed items** re-runs only the failed ones, in this order.

**`skill-vault (from Skill Vault)`**: present when `draft.agents.add_skill`. A new work-item kind
`vault_skill`, logged under the **Adopt** step. It runs the shared `addBundledSkill(appRoot, vaultPath)`:

| Vault state at Finish | Result |
|---|---|
| no `skill-vault` | import it from the app's `bundled-skills` with a `dir` origin, exactly as the card does → done |
| our copy (`in_vault` / `update_available`) | skip, "already in the vault" (the guide never overwrites) |
| someone else's `skill-vault` | error: 'Your vault already has a skill named "skill-vault" from somewhere else. Rename it to add this one.' |
| the app's bundled folder is missing | error: "The app's bundled skill-vault skill folder is missing. Reinstall or rebuild the app." |

**`skill-vault → <tool>`**: present when `draft.agents.add_skill`, one per default tool in the
effective targets, after the user's own push items. Each runs the shared
`pushBundledSkill(vaultPath, provider)`:

| At the tool | Result |
|---|---|
| `skill-vault` isn't in the vault (its add failed) | error: "skill-vault isn't in the vault yet" |
| nothing named `skill-vault` | push (`pushSkillToProvider`) → done |
| a link to the vault copy | push again (re-links it, as the card does) → done |
| anything else named `skill-vault` | error: "a skill-vault folder that isn't from your vault is already there (<path>) — rename or remove it first" |

A failed add leaves its pushes failing too. Retry runs the add first, then the pushes. A foreign folder
is never overwritten; once the user moves it, Retry pushes.

**Desktop**: present when `draft.agents.desktop_connect`. A new work-item kind and log step `desktop`
(label "Desktop"). It runs the shared `connectDesktop()`, which reads the Desktop config again at
Finish (not the step's copy), backs it up to `<file>.skill-vault.bak`, writes only
`mcpServers["skill-vault"]` and keeps every other key as parsed. Connecting again just rewrites our
own entry. It fails, and Retry can try again, with:

- "Claude Desktop isn't installed for this user."
- "Build the app first: the bridge (dist/assistant-mcp.js) isn't built yet."
- 'Claude Desktop already has an MCP server named "skill-vault" that isn't from Skill Vault'
- "<file> isn't valid JSON (…). Fix it, then try again." and the other `readDesktopConfig` errors

The done line reads "Claude Desktop — connected".

Types: `ApplyStep` and `SetupEvent.step` gain `"desktop"`; `FailedItem.step` gains `"desktop"`
(`vault_skill` failures use `"adopt"`). `SetupApplyDeps` gains
`addVaultSkill(vaultPath) → "added" | "already"`, `pushVaultSkill(vaultPath, provider) → void`
and `connectDesktop() → void`, each throwing with the message above. `defaultApplyDeps({ home?, appRoot })`
wires them to the shared services, and `server/index.ts` passes `APP_ROOT`. The add and its pushes
record the same activity entries the card records. The Desktop connect logs to the server log like the
card's ("connect/disconnect are settings changes").

## After Finish: Finish in Claude Desktop

The result screen (both "You're all set" and "Almost done") calls `POST /api/setup/agents` again once
the job has ended, when `draft.agents` isn't null. It shows the panel when Desktop is now `connected`,
or when `draft.agents.desktop_connect` was set.

**Connected:**

1. "Quit Claude Desktop from its tray icon (closing the window isn't enough), then open it again. It
   loads the vault tools only when it starts." Shown only when this job's events include a `desktop`
   done line; a Desktop connected earlier has had its restart.
2. "In a new chat, paste the install prompt and save the skill Claude gives you." **Copy install
   prompt** (`GET /api/agent-access/skill/prompt` → clipboard). Then: "Or **Download skill zip** and
   upload it in Claude Desktop → Settings → Capabilities → Skills." (`POST /api/agent-access/skill/zip`,
   which opens the folder.)
3. "Claude Desktop then reads and saves skills in your vault, <vault_path>, the folder set in Settings."

The toasts match the card's: "Install prompt copied: paste it into a new Claude Desktop chat", and
"skill-vault.zip is ready: upload it in Claude Desktop".

**Ticked but not connected** (the Desktop item failed): "Claude Desktop isn't connected yet. Press
**Retry failed items**, or connect it later in Settings → Agent access." It shows no prompt button,
since the prompt only works once Desktop has the tools. After a successful Retry the panel checks
again and switches to the connected form.

## The skill-vault skill: the vault is where skills go

What the user wants from Desktop once it's set up: every skill lives in the vault folder set in Skill
Vault's Settings, and is pushed to the targets set there. A skill made or changed in a Desktop chat is
saved into the vault, not handed back as a zip to upload.

Changes to `bundled-skills/skill-vault/SKILL.md`:

1. **Description** (frontmatter) gains a trigger, so the skill loads whenever a skill is being made, not
   only when the vault is named: "Also use it whenever you create, edit or improve a skill in a chat, so
   the skill is saved to the vault instead of handed back as a zip or .skill file." It stays well under
   1,024 characters.
2. **A new section before Step 1, "Where skills live":**

   > The user's skills live in their vault: the folder set in the Skill Vault app's Settings. `get_config`
   > shows it, along with the user's tools (targets) and which of them get new skills by default. Claude
   > Desktop and claude.ai have no skills folder on this computer, so don't look for one. Find, read and
   > save skills only through the vault tools or the shared command, which always use the folder from
   > Settings.
   >
   > When you create a skill or change one in this chat, including with another skill such as
   > skill-creator, save it to the vault with `save_skill` (next sections), then offer to push it to the
   > user's tools. Don't hand it back as a zip or `.skill` file to download, even if another skill's steps
   > say to package it. Build a zip only when the user asks to install a vault skill in Claude Desktop or
   > claude.ai.

3. **"Save a skill from this chat to the vault"** opens with "This is what to do with any skill made or
   changed in a chat." The steps stay as they are (create → staging, offer to push; update → show the
   diff, `expected_sha256`).
4. **"Install a vault skill in Claude Desktop or claude.ai"** opens with "Only when the user asks to use a
   vault skill in Claude Desktop or claude.ai itself." The `package_for_desktop` steps stay.

No path is written into the skill. The tools look up the folder from Settings when they run, so a changed
vault folder works without reinstalling the skill. `get_config` returns only the vault path, the tools,
the default targets and the Desktop staging folder, with no keys or tokens, so pointing agents at it is
safe.

**The install prompt** (`installPrompt` in `services/agentAccess/bundledSkill.ts`) still starts "Please
install this as a Claude skill for me" and still embeds SKILL.md in a four-backtick fence. It gains one
sentence before the fence, so the new rule inside SKILL.md doesn't read as a reason to refuse: "This zip
is how the skill gets into Claude Desktop, so it's the one skill to package. Once it's installed, it
saves every other skill to my vault instead."

**Existing copies.** Vaults holding an untouched copy (including the user's own) see **Update
available** on the card after updating the app; one click refreshes it and the linked tools follow. A
copy already installed in Desktop keeps the old text until it's installed again from the new prompt or
zip, and the after-Finish panel's buttons always give the new text.

## Shared services (moved out of `routes/agentAccess.ts`)

- `services/agentAccess/vaultSkill.ts`
  - `bundledSkillState(appRoot, vaultPath)` → `not_in_vault | in_vault | update_available | name_taken`,
    plus `targets`. This is the card's `skillRow`, taking the vault path as an argument.
  - `addBundledSkill(appRoot, vaultPath, { overwrite })` → the `importSkills` call with the `dir`
    origin context.
  - `pushBundledSkill(vaultPath, provider)` → the foreign-folder check (`linksTo`) plus
    `pushSkillToProvider`.
- `services/agentAccess/desktopConnect.ts`
  - `desktopStatus(env)` → the card's `desktopRow`.
  - `connectDesktop({ env, nodePath, bridgePath })`, which throws `DesktopConnectError` with the
    messages above.

`routes/agentAccess.ts` keeps its routes, status codes, messages and the card's rule (push only when the
skill is new to the vault), but calls these. `agentAccess.test.ts` passing unchanged shows the card
didn't move.

## Errors

| Where | What the user sees |
|---|---|
| Agents step, status call fails | Hint (warn) with the error. Skip still works; Next saves the ticks as shown (none). |
| Finish, any new item | An error line naming the item and why, "Almost done", **Retry failed items**. |
| Panel, Copy or Download fails | A toast with the server's message (as the card does). |
| Panel, status call fails | No panel; the result screen is otherwise unchanged. |

## Testing

Node test runner, in the style of the existing files (fakes for deps, temp homes, real HTTP for routes):

- `draft.test.ts`: `agents` round-trips; junk fields are dropped; missing → null; a non-object → 400
  from `PUT /draft`; step `agents` is kept.
- `agents.test.ts` (new, `services/setup`): skill state for new, existing (manifest entry, folder only,
  none), clone (listed, not listed) and adopting.
- `apply.test.ts`:
  - the order adopt → `vault_skill` → push → skill-vault pushes → Notion → desktop;
  - `agents: null` adds no items;
  - a failed connect is the only item that retries;
  - a failed add fails its pushes, and Retry runs the add then the pushes;
  - a foreign folder fails with its message;
  - an "already" add logs as a skip line.
- `vaultSkill.test.ts` and `desktopConnect.test.ts` (new) for the moved logic, including that
  `connectDesktop` keeps other servers and writes the backup, and refuses invalid JSON.
- `setup.test.ts`: `POST /agents` with a fake `pathEnv` (Desktop missing, not connected, connected,
  invalid JSON), skill states, `default_targets`, 400 on a bad draft or no vault.
- `bundledSkill.test.ts`: the existing checks (every backticked identifier is a tool, nothing
  personal) cover the new text. New checks: the description mentions creating or editing a skill and
  stays under 1,024 characters; SKILL.md has the "Where skills live" section and its save-to-vault
  rule; the install prompt still starts the same, still embeds SKILL.md and has its new sentence.
- `agentAccess.test.ts`: unchanged, and passing.

The client has no test runner: it's covered by `npm run typecheck`, `npm run build` and the real run.
Run `npm test -- --test-concurrency=1` if parallel runs hit the Windows EPERM flake in `history.ts`.

**Real run** (never against the real home):

- **Sandbox.** The built app runs from the worktree with `NODE_ENV=production`, on a free port, with
  USERPROFILE, HOME, APPDATA and LOCALAPPDATA pointed at a throwaway folder. Its
  `APPDATA\Claude\claude_desktop_config.json` is a copy of the real one, and its contents are never
  printed. The sandbox home has a `.claude\skills` folder, so Claude Code is detected as a tool.
- **Main path.** In the browser pane, starting from `/` (deep links 404 under a dot-folder path): new
  vault, Claude Code as a default tool, Agents with both ticks, Finish. Then check that:
  - the config's only change is `mcpServers["skill-vault"]` (a deep compare with the copy);
  - `.skill-vault.bak` equals the copy;
  - skill-vault is in the vault with a `dir` origin and linked into the sandbox `.claude\skills`;
  - the panel shows all three lines, and both buttons work (clipboard holds the prompt; the zip exists
    in the stage folder).
- **Failure and retry.** Make the config invalid JSON, re-run the guide, and Finish ends with Desktop
  failed and the "isn't connected yet" panel. Fix the file, press **Retry failed items**, and it ends
  connected with the full panel.
- **No Desktop.** Remove `APPDATA\Claude`: the step says Desktop isn't installed and still offers the
  skill.

## Docs

- `docs/getting-started.md` → **First run: the setup guide**: the list gains **6. Agents** (optional),
  Finish becomes 7, and an "After Finish" paragraph covers the tray-icon restart, the install prompt
  and the zip.
- `docs/features.md`: the setup guide paragraph changes from six steps to seven; the Agent access
  section notes the guide can do the Desktop connect and add the skill.
- `docs/faq.md`: "Can Claude Desktop save skills to my vault?" mentions the guide. A new entry, "Where
  does Claude Desktop keep my skills?", says the vault folder from Settings; that Desktop has no skills
  folder on this computer; and that a skill made or changed in a Desktop chat is saved to the vault,
  not handed back as a zip.
- `docs/features.md` → Agent access: the same save-to-vault rule, in a line.
- `docs/troubleshooting.md` → **Setup finished with "items need attention"**: the Desktop and
  skill-vault messages and what to do about each.
- `docs/changelog.md` and `app/CHANGELOG.md` → `[Unreleased]` → **Added**.

## Files

| File | Change |
|---|---|
| `app/server/services/agentAccess/vaultSkill.ts` (+ test) | new: moved skill state, add, push |
| `app/server/services/agentAccess/desktopConnect.ts` (+ test) | new: moved Desktop status and connect |
| `app/server/routes/agentAccess.ts` | calls the shared services; behaviour unchanged |
| `app/server/services/setup/types.ts`, `draft.ts` (+ test) | `agents` field and step |
| `app/server/services/setup/agents.ts` (+ test) | new: the step's status |
| `app/server/services/setup/apply.ts`, `applyDeps.ts` (+ test) | new item kinds and deps |
| `app/server/routes/setup.ts` (+ test) | `POST /agents`, `pathEnv` seam |
| `app/server/index.ts` | `defaultApplyDeps({ appRoot: APP_ROOT })` |
| `app/bundled-skills/skill-vault/SKILL.md` | description trigger, "Where skills live", two section openers |
| `app/server/services/agentAccess/bundledSkill.ts` (+ test) | the install prompt's extra sentence |
| `app/client/src/lib/setup.ts` | types, `setupApi.agents` |
| `app/client/src/pages/setup/steps/AgentsStep.tsx` | new |
| `app/client/src/pages/setup/steps/DesktopFinishPanel.tsx` | new |
| `app/client/src/pages/setup/SetupGuide.tsx`, `steps/AssistantStep.tsx`, `steps/ReviewStep.tsx` | rail, Welcome text, navigation, list lines, log label, panel |
| `docs/…`, both changelogs | as above |
