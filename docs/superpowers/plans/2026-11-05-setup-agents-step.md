# Setup Guide Agents Step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional **Agents** step to the setup guide. At Finish it adds the bundled `skill-vault` skill to the vault (and pushes it to the default tools) and connects Claude Desktop, then guides the user through the Desktop restart and the skill install. The skill itself learns that the vault from Settings is where every skill goes.

**Architecture:** The Desktop connect logic and the bundled-skill logic move out of `routes/agentAccess.ts` into two services, which the Settings card and the guide's Finish job both call. The guide gets a draft field (`agents`), a draft-aware status route (`POST /api/setup/agents`), and three new Finish work-item kinds that run inside the existing job, so they get progress lines and retry. On the client there's a new step component and a result-screen panel.

**Tech Stack:** Node 20 + Express + TypeScript (`tsx`), node:test, React 18 + @tanstack/react-query + wouter + sonner, Vite build.

**Spec:** `docs/superpowers/specs/2026-11-05-setup-agents-step-design.md`

## Global Constraints

- Public repo: no personal paths, emails or machine names in code, tests or docs. Example paths look like `C:\Users\you\...`.
- Nothing is saved before **Finish**: the step only writes the draft (`~/.skill-vault/setup-draft.json`).
- The Settings card (`routes/agentAccess.ts`) keeps its routes, status codes and messages: `agentAccess.test.ts` must pass **unchanged**.
- Desktop connect writes only `mcpServers["skill-vault"]`, backs the file up to `<file>.skill-vault.bak` first, and refuses a config that isn't valid JSON.
- Commands run from `app/`: tests `npm test` (use `npm test -- --test-concurrency=1` if Windows EPERM flakes hit `history.ts`), types `npm run typecheck`, build `npm run build`. A single file runs with `node --import tsx --test server/path/file.test.ts`.
- Never run `launch.ps1` or a dev server against the real home folder. Real runs use a throwaway USERPROFILE/HOME/APPDATA/LOCALAPPDATA with `NODE_ENV=production`, and start from `/` (deep links 404 under `.claude/worktrees/...`).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Writing style for UI and docs copy: short plain sentences, no em dashes in new UI strings unless an existing string already uses one (the Finish log uses ` — ` between item and message).

## File Structure

| File | Responsibility |
|---|---|
| `app/server/services/agentAccess/desktopConnect.ts` (new) | Desktop status row and connect, shared by the card and Finish |
| `app/server/services/agentAccess/vaultSkill.ts` (new) | Is the bundled skill in a vault (and ours), add it, push it to one tool |
| `app/server/routes/agentAccess.ts` | Calls the two services; behaviour unchanged |
| `app/bundled-skills/skill-vault/SKILL.md` | "Where skills live" + save-to-vault rule |
| `app/server/services/agentAccess/bundledSkill.ts` | Install prompt gains one sentence |
| `app/server/services/setup/types.ts`, `draft.ts` | `agents` draft field and `"agents"` step |
| `app/server/services/setup/agents.ts` (new) | The step's status for the draft's vault and tools |
| `app/server/routes/setup.ts` | `POST /api/setup/agents`, `pathEnv` seam, `defaultApplyDeps` options |
| `app/server/services/setup/apply.ts`, `applyDeps.ts`, `app/server/index.ts` | New Finish items and their real deps |
| `app/client/src/lib/setup.ts` | Client types and `setupApi.agents` |
| `app/client/src/pages/setup/steps/AgentsStep.tsx` (new) | The step UI |
| `app/client/src/pages/setup/steps/DesktopFinishPanel.tsx` (new) | The after-Finish panel |
| `app/client/src/pages/setup/SetupGuide.tsx`, `steps/AssistantStep.tsx`, `steps/ReviewStep.tsx` | Rail, Welcome text, navigation, list lines, log label, panel |
| `docs/getting-started.md`, `docs/features.md`, `docs/faq.md`, `docs/troubleshooting.md`, `docs/changelog.md`, `app/CHANGELOG.md` | Docs and changelogs |

---

### Task 1: Shared Desktop status and connect

**Files:**
- Create: `app/server/services/agentAccess/desktopConnect.ts`
- Create: `app/server/services/agentAccess/desktopConnect.test.ts`
- Modify: `app/server/routes/agentAccess.ts` (the `desktopRow` function, the `/desktop/connect` handler, imports)

**Interfaces:**
- Consumes: `desktopConfig.ts` exports `bridgeEntry`, `desktopConfigPath`, `entryState`, `getEntry`, `readDesktopConfig`, `withEntry`, `writeDesktopConfig`, `DesktopConfigError`, `type EntryState`, `type PathEnv`.
- Produces:
  - `type DesktopState = EntryState | "not_installed" | "unreadable"`
  - `interface DesktopStatus { state: DesktopState; config_path: string | null; error?: string }`
  - `desktopStatus(env: PathEnv): DesktopStatus`
  - `class DesktopConnectError extends Error`
  - `const DESKTOP_NOT_INSTALLED = "Claude Desktop isn't installed for this user."`
  - `const BRIDGE_NOT_BUILT = "Build the app first: the bridge (dist/assistant-mcp.js) isn't built yet."`
  - `connectDesktop(opts: { env: PathEnv; nodePath: string; bridgePath: string }): string` returns the config file it wrote. It throws `DesktopConnectError` (bridge missing or Desktop not installed), `DesktopConfigError` (bad JSON, name taken) or a raw fs error.

- [ ] **Step 1: Write the failing test**

`app/server/services/agentAccess/desktopConnect.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopConfigError, type PathEnv } from "./desktopConfig.ts";
import { BRIDGE_NOT_BUILT, DESKTOP_NOT_INSTALLED, DesktopConnectError, connectDesktop, desktopStatus } from "./desktopConnect.ts";

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-desktop-"));
  const appData = path.join(root, "appdata");
  const claudeDir = path.join(appData, "Claude");
  const bridgePath = path.join(root, "app", "dist", "assistant-mcp.js");
  fs.mkdirSync(path.dirname(bridgePath), { recursive: true });
  fs.writeFileSync(bridgePath, "// bridge");
  const env: PathEnv = { platform: "win32", appData, home: root, exists: (p) => fs.existsSync(p), list: () => [] };
  const file = path.join(claudeDir, "claude_desktop_config.json");
  return { root, claudeDir, bridgePath, env, file, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("status: not installed until Claude's folder exists, then not connected", () => {
  const s = sandbox();
  try {
    assert.deepEqual(desktopStatus(s.env), { state: "not_installed", config_path: null });
    fs.mkdirSync(s.claudeDir, { recursive: true });
    assert.deepEqual(desktopStatus(s.env), { state: "not_connected", config_path: s.file });
  } finally {
    s.done();
  }
});

test("connect keeps every other key, backs the file up and reads as connected", () => {
  const s = sandbox();
  try {
    fs.mkdirSync(s.claudeDir, { recursive: true });
    const original = JSON.stringify({ mcpServers: { other: { command: "x", args: ["y"] } }, preferences: { a: 1 } }, null, 2);
    fs.writeFileSync(s.file, original);
    assert.equal(connectDesktop({ env: s.env, nodePath: process.execPath, bridgePath: s.bridgePath }), s.file);
    const cfg = JSON.parse(fs.readFileSync(s.file, "utf-8"));
    assert.deepEqual(cfg.mcpServers.other, { command: "x", args: ["y"] });
    assert.deepEqual(cfg.preferences, { a: 1 });
    assert.deepEqual(cfg.mcpServers["skill-vault"], { command: process.execPath, args: [s.bridgePath, "--client", "claude-desktop"] });
    assert.equal(fs.readFileSync(`${s.file}.skill-vault.bak`, "utf-8"), original);
    assert.equal(desktopStatus(s.env).state, "connected");
    // Connecting again just rewrites our own entry.
    connectDesktop({ env: s.env, nodePath: process.execPath, bridgePath: s.bridgePath });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(s.file, "utf-8")).mcpServers), ["other", "skill-vault"]);
  } finally {
    s.done();
  }
});

test("connect refuses invalid JSON and leaves the file alone; status says unreadable", () => {
  const s = sandbox();
  try {
    fs.mkdirSync(s.claudeDir, { recursive: true });
    fs.writeFileSync(s.file, "{ broken");
    assert.throws(() => connectDesktop({ env: s.env, nodePath: process.execPath, bridgePath: s.bridgePath }), DesktopConfigError);
    assert.equal(fs.readFileSync(s.file, "utf-8"), "{ broken");
    const st = desktopStatus(s.env);
    assert.equal(st.state, "unreadable");
    assert.match(st.error ?? "", /isn't valid JSON/);
  } finally {
    s.done();
  }
});

test("connect refuses a server of someone else's named skill-vault", () => {
  const s = sandbox();
  try {
    fs.mkdirSync(s.claudeDir, { recursive: true });
    fs.writeFileSync(s.file, JSON.stringify({ mcpServers: { "skill-vault": { command: "other", args: ["x"] } } }));
    assert.equal(desktopStatus(s.env).state, "name_taken");
    assert.throws(() => connectDesktop({ env: s.env, nodePath: process.execPath, bridgePath: s.bridgePath }), /isn't from Skill Vault/);
  } finally {
    s.done();
  }
});

test("connect needs the bridge and an installed Claude Desktop", () => {
  const s = sandbox();
  try {
    assert.throws(() => connectDesktop({ env: s.env, nodePath: process.execPath, bridgePath: s.bridgePath }), (e: unknown) => e instanceof DesktopConnectError && e.message === DESKTOP_NOT_INSTALLED);
    fs.mkdirSync(s.claudeDir, { recursive: true });
    const missing = path.join(s.root, "nope", "assistant-mcp.js");
    assert.throws(() => connectDesktop({ env: s.env, nodePath: process.execPath, bridgePath: missing }), (e: unknown) => e instanceof DesktopConnectError && e.message === BRIDGE_NOT_BUILT);
    assert.equal(fs.existsSync(s.file), false);
  } finally {
    s.done();
  }
});
```

- [ ] **Step 2: Run the test to see it fail**

Run (from `app/`): `node --import tsx --test server/services/agentAccess/desktopConnect.test.ts`
Expected: FAIL, `Cannot find module './desktopConnect.ts'`.

- [ ] **Step 3: Write the service**

`app/server/services/agentAccess/desktopConnect.ts`:

```ts
/**
 * Claude Desktop's side of agent access: the status row and the connect.
 * Shared by Settings → Agent access (routes/agentAccess.ts) and the setup
 * guide's Finish (services/setup/applyDeps.ts).
 */
import fs from "node:fs";
import {
  bridgeEntry, desktopConfigPath, entryState, getEntry, readDesktopConfig, withEntry, writeDesktopConfig,
  type EntryState, type PathEnv,
} from "./desktopConfig.ts";

export type DesktopState = EntryState | "not_installed" | "unreadable";

export interface DesktopStatus {
  state: DesktopState;
  config_path: string | null;
  error?: string;
}

export const DESKTOP_NOT_INSTALLED = "Claude Desktop isn't installed for this user.";
export const BRIDGE_NOT_BUILT = "Build the app first: the bridge (dist/assistant-mcp.js) isn't built yet.";

export class DesktopConnectError extends Error {}

export function desktopStatus(env: PathEnv): DesktopStatus {
  const file = desktopConfigPath(env);
  if (!file) return { state: "not_installed", config_path: null };
  try {
    return { state: entryState(getEntry(readDesktopConfig(file)), (p) => fs.existsSync(p)), config_path: file };
  } catch (err) {
    return { state: "unreadable", config_path: file, error: (err as Error).message };
  }
}

/**
 * Add (or rewrite) the skill-vault MCP entry and return the file written.
 * Reads the config fresh, so a file changed since the last status still
 * gets checked (bad JSON and someone else's "skill-vault" are refused by
 * readDesktopConfig / withEntry). Other errors (disk) come through raw.
 */
export function connectDesktop(opts: { env: PathEnv; nodePath: string; bridgePath: string }): string {
  if (!fs.existsSync(opts.bridgePath)) throw new DesktopConnectError(BRIDGE_NOT_BUILT);
  const file = desktopConfigPath(opts.env);
  if (!file) throw new DesktopConnectError(DESKTOP_NOT_INSTALLED);
  writeDesktopConfig(file, withEntry(readDesktopConfig(file), bridgeEntry(opts.nodePath, opts.bridgePath, "claude-desktop")));
  return file;
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `node --import tsx --test server/services/agentAccess/desktopConnect.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Point the route at the service**

In `app/server/routes/agentAccess.ts`:

1. Add the import:
   ```ts
   import { BRIDGE_NOT_BUILT, DESKTOP_NOT_INSTALLED, connectDesktop, desktopStatus } from "../services/agentAccess/desktopConnect.ts";
   ```
2. Delete the whole `function desktopRow(): AgentAccessStatus["claude_desktop"] { ... }` and replace every `desktopRow()` call (in `GET /`, `/desktop/connect` and `/desktop/disconnect`) with `desktopStatus(pathEnv())`.
3. In `bridgeMissing`, replace the message literal with `BRIDGE_NOT_BUILT`:
   ```ts
   res.status(409).json({ error: BRIDGE_NOT_BUILT });
   ```
4. In `desktopFile`, replace the message literal with `DESKTOP_NOT_INSTALLED`:
   ```ts
   if (!file) res.status(404).json({ error: DESKTOP_NOT_INSTALLED });
   ```
5. Replace the body of `attempt(...)` in `/desktop/connect` so it calls the service:
   ```ts
   const ok = await attempt(res, file, () => {
     connectDesktop({ env: pathEnv(), nodePath, bridgePath });
   });
   ```
6. Remove imports that are now unused (`bridgeEntry`, `entryState` stay if `claudeCodeRow` still uses `entryState`; `getEntry` and `withEntry` go if unused). Let `npm run typecheck` and the linter-free build tell you: TypeScript flags none of these, so check with `rg "bridgeEntry|getEntry|withEntry|entryState" server/routes/agentAccess.ts` and drop the names that no longer appear outside the import line.

- [ ] **Step 6: Run the card's tests unchanged**

Run: `node --import tsx --test server/routes/agentAccess.test.ts server/services/agentAccess/desktopConnect.test.ts`
Expected: PASS. `agentAccess.test.ts` has no edits.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck` → no errors.

```bash
git add app/server/services/agentAccess/desktopConnect.ts app/server/services/agentAccess/desktopConnect.test.ts app/server/routes/agentAccess.ts
git commit -m "agent access: Desktop status and connect as a shared service

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared bundled-skill state, add and push

**Files:**
- Create: `app/server/services/agentAccess/vaultSkill.ts`
- Create: `app/server/services/agentAccess/vaultSkill.test.ts`
- Modify: `app/server/routes/agentAccess.ts` (`samePath`, `realOr`, `linksTo`, `skillRow`, the `/skill/add` handler)

**Interfaces:**
- Consumes: `bundledSkill.ts` (`BUNDLED_SKILL_NAME`, `bundledSkillDir`, `bundledSkillsRoot`), `importSkills` (`../adoption.ts`), `isLink`/`resolveLink` (`../linking.ts`), `pushSkillToProvider` (`../pushSkill.ts`), `hashSkillDirNormalized` (`../skillHash.ts`), `readManifest`/`skillDir` (`../vault.ts`), `Provider` (`../../types/vault.ts`).
- Produces:
  - `type BundledSkillState = "not_in_vault" | "in_vault" | "update_available" | "name_taken"`
  - `bundledSkillState(appRoot: string, vaultPath: string): { state: BundledSkillState; targets: string[] }`
  - `importBundledSkill(appRoot: string, vaultPath: string, opts: { overwrite: boolean }): { imported: string[]; updated: string[]; skipped: string[] }`
  - `addBundledSkillIfMissing(appRoot: string, vaultPath: string): "added" | "already"` (throws with `NAME_TAKEN`, `BUNDLED_MISSING` or `Couldn't add skill-vault to the vault.`)
  - `pushBundledSkill(vaultPath: string, provider: Provider): void` (throws `NOT_IN_VAULT_YET` or the foreign-folder message)
  - `const NAME_TAKEN = 'Your vault already has a skill named "skill-vault" from somewhere else. Rename it to add this one.'`
  - `const BUNDLED_MISSING = "The app's bundled skill-vault skill folder is missing. Reinstall or rebuild the app."`
  - `const NOT_IN_VAULT_YET = "skill-vault isn't in the vault yet"`
  - `foreignFolderMessage(dest: string): string` → `a skill-vault folder that isn't from your vault is already there (<dest>) — rename or remove it first`

- [ ] **Step 1: Write the failing test**

`app/server/services/agentAccess/vaultSkill.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The vault and adoption modules read the CLI config path at import time:
// point HOME at a temp folder before the first import.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-vskill-"));
process.env.USERPROFILE = path.join(root, "home");
process.env.HOME = path.join(root, "home");

type Mod = typeof import("./vaultSkill.ts");
let m: Mod;
let initVault: (p: string) => void;
const SKILL_MD = "---\nname: skill-vault\ndescription: test copy of the bundled skill for the shared service\n---\n\nBody\n";
let n = 0;

before(async () => {
  m = await import("./vaultSkill.ts");
  ({ initVault } = await import("../vault.ts"));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

function fresh() {
  const dir = path.join(root, `case-${++n}`);
  const appRoot = path.join(dir, "app");
  const vault = path.join(dir, "vault");
  const tool = path.join(dir, "tool");
  fs.mkdirSync(path.join(appRoot, "bundled-skills", "skill-vault"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "bundled-skills", "skill-vault", "SKILL.md"), SKILL_MD);
  fs.mkdirSync(tool, { recursive: true });
  initVault(vault);
  return { appRoot, vault, tool, provider: { id: "claude", path: tool } };
}
const manifest = (vault: string) => JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf-8")).skills as Record<string, any>;

test("add when missing: imports with a dir origin, then reports already", () => {
  const c = fresh();
  assert.equal(m.bundledSkillState(c.appRoot, c.vault).state, "not_in_vault");
  assert.equal(m.addBundledSkillIfMissing(c.appRoot, c.vault), "added");
  assert.equal(manifest(c.vault)["skill-vault"].origin.type, "dir");
  assert.equal(m.bundledSkillState(c.appRoot, c.vault).state, "in_vault");
  assert.equal(m.addBundledSkillIfMissing(c.appRoot, c.vault), "already");
});

test("an outdated copy of ours is left alone (the guide never overwrites)", () => {
  const c = fresh();
  m.addBundledSkillIfMissing(c.appRoot, c.vault);
  fs.writeFileSync(path.join(c.appRoot, "bundled-skills", "skill-vault", "SKILL.md"), SKILL_MD + "\nNewer\n");
  assert.equal(m.bundledSkillState(c.appRoot, c.vault).state, "update_available");
  assert.equal(m.addBundledSkillIfMissing(c.appRoot, c.vault), "already");
  assert.ok(!fs.readFileSync(path.join(c.vault, "skills", "skill-vault", "SKILL.md"), "utf-8").includes("Newer"));
});

test("someone else's skill-vault is refused with a rename hint", () => {
  const c = fresh();
  fs.mkdirSync(path.join(c.vault, "skills", "skill-vault"), { recursive: true });
  fs.writeFileSync(path.join(c.vault, "skills", "skill-vault", "SKILL.md"), "mine");
  assert.equal(m.bundledSkillState(c.appRoot, c.vault).state, "name_taken");
  assert.throws(() => m.addBundledSkillIfMissing(c.appRoot, c.vault), { message: m.NAME_TAKEN });
});

test("a missing bundled folder is refused", () => {
  const c = fresh();
  fs.rmSync(path.join(c.appRoot, "bundled-skills"), { recursive: true, force: true });
  assert.throws(() => m.addBundledSkillIfMissing(c.appRoot, c.vault), { message: m.BUNDLED_MISSING });
});

test("push: needs the vault copy, pushes into an empty spot, re-pushes through our own link", () => {
  const c = fresh();
  assert.throws(() => m.pushBundledSkill(c.vault, c.provider), { message: m.NOT_IN_VAULT_YET });
  m.addBundledSkillIfMissing(c.appRoot, c.vault);
  m.pushBundledSkill(c.vault, c.provider);
  assert.ok(fs.existsSync(path.join(c.tool, "skill-vault", "SKILL.md")));
  m.pushBundledSkill(c.vault, c.provider);
  assert.ok(fs.existsSync(path.join(c.tool, "skill-vault", "SKILL.md")));
});

test("push: a tool's own skill-vault folder is never overwritten", () => {
  const c = fresh();
  m.addBundledSkillIfMissing(c.appRoot, c.vault);
  const theirs = path.join(c.tool, "skill-vault");
  fs.mkdirSync(theirs);
  fs.writeFileSync(path.join(theirs, "SKILL.md"), "mine");
  assert.throws(() => m.pushBundledSkill(c.vault, c.provider), { message: m.foreignFolderMessage(theirs) });
  assert.match(m.foreignFolderMessage(theirs), /isn't from your vault.*rename or remove it first/);
  assert.equal(fs.readFileSync(path.join(theirs, "SKILL.md"), "utf-8"), "mine");
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `node --import tsx --test server/services/agentAccess/vaultSkill.test.ts`
Expected: FAIL, `Cannot find module './vaultSkill.ts'`.

- [ ] **Step 3: Write the service** (moves `samePath`, `realOr`, `linksTo` and the `skillRow` body out of the route)

`app/server/services/agentAccess/vaultSkill.ts`:

```ts
/**
 * The bundled skill-vault skill in a vault: is it there and ours, add it,
 * push it to one tool. Shared by Settings → Agent access
 * (routes/agentAccess.ts) and the setup guide's Finish
 * (services/setup/applyDeps.ts). Callers record activity; this doesn't.
 */
import fs from "node:fs";
import path from "node:path";
import { importSkills } from "../adoption.ts";
import { isLink, resolveLink } from "../linking.ts";
import { pushSkillToProvider } from "../pushSkill.ts";
import { hashSkillDirNormalized } from "../skillHash.ts";
import { readManifest, skillDir } from "../vault.ts";
import type { Provider } from "../../types/vault.ts";
import { BUNDLED_SKILL_NAME, bundledSkillDir, bundledSkillsRoot } from "./bundledSkill.ts";

export type BundledSkillState = "not_in_vault" | "in_vault" | "update_available" | "name_taken";

export const NAME_TAKEN = `Your vault already has a skill named "${BUNDLED_SKILL_NAME}" from somewhere else. Rename it to add this one.`;
export const BUNDLED_MISSING = `The app's bundled ${BUNDLED_SKILL_NAME} skill folder is missing. Reinstall or rebuild the app.`;
export const NOT_IN_VAULT_YET = `${BUNDLED_SKILL_NAME} isn't in the vault yet`;

export function foreignFolderMessage(dest: string): string {
  return `a ${BUNDLED_SKILL_NAME} folder that isn't from your vault is already there (${dest}) — rename or remove it first`;
}

const samePath = (a: string | undefined, b: string): boolean =>
  !!a && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

const realOr = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** True when `p` is a symlink or junction to `vaultCopy` (an earlier push of ours). */
function linksTo(p: string, vaultCopy: string): boolean {
  const target = isLink(p) ? resolveLink(p) : null;
  return !!target && (samePath(target, vaultCopy) || samePath(realOr(target), realOr(vaultCopy)));
}

export function bundledSkillState(appRoot: string, vaultPath: string): { state: BundledSkillState; targets: string[] } {
  const entry = readManifest(vaultPath).skills[BUNDLED_SKILL_NAME];
  const vaultCopy = skillDir(vaultPath, BUNDLED_SKILL_NAME);
  if (!entry && !fs.existsSync(vaultCopy)) return { state: "not_in_vault", targets: [] };
  const origin = entry?.origin;
  // Any app checkout's bundled-skills folder, not only this one: a moved or
  // re-cloned app must still know its own copy. win32 basename splits on
  // both separators, so a vault shared with another OS reads the same.
  const ours =
    origin?.type === "dir" &&
    origin.subpath === BUNDLED_SKILL_NAME &&
    !!origin.path &&
    path.win32.basename(origin.path).toLowerCase() === path.basename(bundledSkillsRoot(appRoot)).toLowerCase();
  if (!entry || !origin || !ours) return { state: "name_taken", targets: entry?.targets ?? [] };
  const vaultHash = hashSkillDirNormalized(vaultCopy);
  // One-click refresh only while the vault copy is untouched since import;
  // a locally edited copy goes through the normal Updates flow instead.
  const untouched = vaultHash === origin.content_hash;
  const differs = vaultHash !== hashSkillDirNormalized(bundledSkillDir(appRoot));
  return { state: untouched && differs ? "update_available" : "in_vault", targets: entry.targets };
}

/** importSkills from the app's bundled-skills folder, recorded with a dir origin. */
export function importBundledSkill(appRoot: string, vaultPath: string, opts: { overwrite: boolean }) {
  const sourceRoot = bundledSkillsRoot(appRoot);
  return importSkills(
    vaultPath,
    sourceRoot,
    [],
    undefined,
    undefined,
    [{ name: BUNDLED_SKILL_NAME, path: bundledSkillDir(appRoot) }],
    { overwrite: opts.overwrite, originContext: { type: "dir", root: sourceRoot } },
  );
}

/** The guide's add: import only when the vault has no skill-vault; never overwrite. */
export function addBundledSkillIfMissing(appRoot: string, vaultPath: string): "added" | "already" {
  const { state } = bundledSkillState(appRoot, vaultPath);
  if (state === "name_taken") throw new Error(NAME_TAKEN);
  if (state !== "not_in_vault") return "already";
  if (!fs.existsSync(bundledSkillDir(appRoot))) throw new Error(BUNDLED_MISSING);
  const r = importBundledSkill(appRoot, vaultPath, { overwrite: false });
  if (!r.imported.includes(BUNDLED_SKILL_NAME)) throw new Error(`Couldn't add ${BUNDLED_SKILL_NAME} to the vault.`);
  return "added";
}

/**
 * Push the vault copy to one tool. A push replaces whatever is at the
 * target, so only nothing at all, or a link to the vault copy, is ours.
 */
export function pushBundledSkill(vaultPath: string, provider: Provider): void {
  const vaultCopy = skillDir(vaultPath, BUNDLED_SKILL_NAME);
  if (!fs.existsSync(vaultCopy)) throw new Error(NOT_IN_VAULT_YET);
  const dest = path.join(provider.path, BUNDLED_SKILL_NAME);
  if ((fs.existsSync(dest) || isLink(dest)) && !linksTo(dest, vaultCopy)) throw new Error(foreignFolderMessage(dest));
  pushSkillToProvider(vaultPath, BUNDLED_SKILL_NAME, provider);
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `node --import tsx --test server/services/agentAccess/vaultSkill.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Point the route at the service**

In `app/server/routes/agentAccess.ts`:

1. Add the import:
   ```ts
   import {
     BUNDLED_MISSING, NAME_TAKEN, bundledSkillState, importBundledSkill, pushBundledSkill,
   } from "../services/agentAccess/vaultSkill.ts";
   ```
2. Delete `samePath`, `realOr` and `linksTo` from the route.
3. Replace `skillRow()` with:
   ```ts
   function skillRow(): AgentAccessStatus["skill"] {
     const cfg = readAppConfig();
     if (!cfg.vault_path) return { state: "no_vault", targets: [] };
     return bundledSkillState(opts.appRoot, cfg.vault_path);
   }
   ```
4. In `POST /skill/add`:
   - the `name_taken` reply becomes `res.status(409).json({ error: NAME_TAKEN });`
   - the import becomes `const result = importBundledSkill(opts.appRoot, vaultPath, { overwrite: row.state === "update_available" });`
   - the missing-folder reply becomes `res.status(409).json({ error: BUNDLED_MISSING });`
   - the push loop becomes:
     ```ts
     if (row.state === "not_in_vault") {
       for (const id of cfg.default_targets ?? []) {
         const provider = cfg.providers.find((p) => p.id === id);
         if (!provider) {
           failed.push({ provider_id: id, error: "not configured" });
           continue;
         }
         try {
           pushBundledSkill(vaultPath, provider);
           pushed.push(id);
           recordActivity({ kind: "push", skill: BUNDLED_SKILL_NAME, provider_id: id, ok: true, message: "pushed" });
         } catch (err) {
           failed.push({ provider_id: id, error: (err as Error).message });
           recordActivity({ kind: "push", skill: BUNDLED_SKILL_NAME, provider_id: id, ok: false, message: (err as Error).message });
         }
       }
     }
     ```
5. Drop imports the route no longer uses: `importSkills`, `isLink`, `resolveLink`, `pushSkillToProvider`, `bundledSkillsRoot`, `readManifest` (`skillDir`, `hashSkillDirNormalized`, `bundledSkillDir` are still used by `/skill/add` and `/skill/zip`). Check with `rg "importSkills|isLink|resolveLink|pushSkillToProvider|bundledSkillsRoot|readManifest" server/routes/agentAccess.ts`.

- [ ] **Step 6: Run the card's tests unchanged**

Run: `node --import tsx --test server/routes/agentAccess.test.ts server/services/agentAccess/vaultSkill.test.ts`
Expected: PASS, including "add leaves a default target's own skill-vault folder alone and reports it" (same message) and "the vault copy is recognised from another checkout's bundled-skills folder".

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck` → no errors.

```bash
git add app/server/services/agentAccess/vaultSkill.ts app/server/services/agentAccess/vaultSkill.test.ts app/server/routes/agentAccess.ts
git commit -m "agent access: bundled skill state, add and push as a shared service

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The skill-vault skill saves to the vault, never a zip

**Files:**
- Modify: `app/bundled-skills/skill-vault/SKILL.md` (frontmatter line 3; new section after the intro; openers of "Save a skill from this chat to the vault" and "Install a vault skill in Claude Desktop or claude.ai")
- Modify: `app/server/services/agentAccess/bundledSkill.ts` (`installPrompt`)
- Test: `app/server/services/agentAccess/bundledSkill.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `installPrompt(skillMd)` still starts `Please install this as a Claude skill for me` and embeds SKILL.md in a ```` fence; it now also contains `it's the one skill to package`.

- [ ] **Step 1: Write the failing tests** (append to `bundledSkill.test.ts`)

```ts
test("the skill loads whenever a skill is being made, and its description still fits", () => {
  const description = frontmatterValueOf(md, "description") ?? "";
  assert.match(description, /create, edit or improve a skill/);
  assert.ok(description.length <= 1024, `description is ${description.length} characters`);
});

test("the skill says the vault from Settings is where skills live, and never to hand back a zip", () => {
  assert.ok(md.includes("## Where skills live"));
  assert.match(md, /the folder set in the Skill Vault app's Settings/);
  assert.match(md, /no skills folder on this computer/);
  assert.match(md, /save it to the vault with `save_skill`/);
  assert.match(md, /Don't hand it back as a zip or `\.skill` file/);
  assert.ok(md.indexOf("## Where skills live") < md.indexOf("## Step 1: reach the vault"));
});

test("the install prompt explains why this one skill is a zip", () => {
  const prompt = installPrompt(md);
  assert.match(prompt, /^Please install this as a Claude skill for me/);
  assert.match(prompt, /it's the one skill to package/);
  assert.ok(prompt.indexOf("it's the one skill to package") < prompt.indexOf("````markdown"));
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --import tsx --test server/services/agentAccess/bundledSkill.test.ts`
Expected: the three new tests FAIL; the four existing ones pass.

- [ ] **Step 3: Edit SKILL.md**

1. Line 3 (frontmatter, one line): append this sentence to the end of the existing `description:` value. It must stay one line with no `": "` in the added text.
   ```
    Also use it whenever you create, edit or improve a skill in a chat, so the skill is saved to the vault instead of handed back as a zip or .skill file.
   ```
2. After the intro paragraph (the one ending "This skill lets you do that work from a chat.") and before `## Step 1: reach the vault`, insert:
   ```markdown
   ## Where skills live

   The user's skills live in their vault: the folder set in the Skill Vault app's Settings. `get_config`
   shows it, along with the user's tools (targets) and which of them get new skills by default. Claude
   Desktop and claude.ai have no skills folder on this computer, so don't look for one. Find, read and
   save skills only through the vault tools or the shared command, which always use the folder from
   Settings.

   When you create a skill or change one in this chat, including with another skill such as
   skill-creator, save it to the vault with `save_skill` (see below), then offer to push it to the
   user's tools. Don't hand it back as a zip or `.skill` file to download, even if another skill's steps
   say to package it. Build a zip only when the user asks to install a vault skill in Claude Desktop or
   claude.ai.

   ```
3. Directly under `## Save a skill from this chat to the vault`, before `**A new skill:**`, insert:
   ```markdown
   This is what to do with any skill made or changed in a chat.

   ```
4. Directly under `## Install a vault skill in Claude Desktop or claude.ai`, before the existing first paragraph, insert:
   ```markdown
   Only when the user asks to use a vault skill in Claude Desktop or claude.ai itself.

   ```

- [ ] **Step 4: Edit the install prompt**

In `app/server/services/agentAccess/bundledSkill.ts`, `installPrompt` becomes:

```ts
export function installPrompt(skillMd: string): string {
  return [
    "Please install this as a Claude skill for me. Create a zip named skill-vault.zip that contains one",
    "folder, skill-vault/, with this exact file as skill-vault/SKILL.md (don't change any of it), and give",
    "me the zip so I can save it to my skills.",
    "",
    "This zip is how the skill gets into Claude Desktop, so it's the one skill to package. Once it's",
    "installed, it saves every other skill to my vault instead.",
    "",
    "````markdown",
    skillMd.trimEnd(),
    "````",
    "",
  ].join("\n");
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `node --import tsx --test server/services/agentAccess/bundledSkill.test.ts server/routes/agentAccess.test.ts`
Expected: PASS. "every tool the skill names exists in the bridge" still passes: the only new backticked snake_case names are `get_config` and `save_skill`.

- [ ] **Step 6: Commit**

```bash
git add app/bundled-skills/skill-vault/SKILL.md app/server/services/agentAccess/bundledSkill.ts app/server/services/agentAccess/bundledSkill.test.ts
git commit -m "skill-vault skill: the vault from Settings is where skills go, never a zip

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The draft's `agents` field and step

**Files:**
- Modify: `app/server/services/setup/types.ts`
- Modify: `app/server/services/setup/draft.ts`
- Test: `app/server/services/setup/draft.test.ts`

**Interfaces:**
- Produces (server `types.ts`):
  ```ts
  export type SetupStep = "welcome" | "vault" | "targets" | "skills" | "notion" | "assistant" | "agents" | "review";
  export interface AgentsChoice { add_skill: boolean; desktop_connect: boolean }
  // SetupDraft gains: agents: AgentsChoice | null;
  ```
- `normalizeDraft` keeps `agents` (both fields `=== true`); missing/null → null; a non-object → `DraftError("agents must be an object")`. `startDraft` sets `agents: null`.

- [ ] **Step 1: Write the failing tests** (append to `draft.test.ts`)

```ts
test("agents: start null, round-trip, junk dropped, a non-object refused", () => {
  const d = startDraft(base);
  assert.equal(d.agents, null);
  assert.deepEqual(normalizeDraft({ ...d, agents: { add_skill: true, desktop_connect: "yes", extra: 1 } }).agents, { add_skill: true, desktop_connect: false });
  const older: Record<string, unknown> = { ...d };
  delete older.agents;
  assert.equal(normalizeDraft(older).agents, null);
  assert.throws(() => normalizeDraft({ ...d, agents: "yes" }), DraftError);
  assert.throws(() => normalizeDraft({ ...d, agents: [true] }), DraftError);
  assert.equal(normalizeDraft({ ...d, step: "agents" }).step, "agents");
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `node --import tsx --test server/services/setup/draft.test.ts`
Expected: FAIL (`d.agents` is `undefined`, and the step falls back to `"welcome"`).

- [ ] **Step 3: Implement**

`types.ts`: change `SetupStep` as above, add `AgentsChoice` after `AssistantChoice`, and add to `SetupDraft` after `assistant`:

```ts
  /** The Agents step. null = Skip (or not visited): Finish touches neither. */
  agents: AgentsChoice | null;
```

`draft.ts`:

```ts
// imports: add AgentsChoice to the type import list from "./types.ts"
const STEPS: SetupStep[] = ["welcome", "vault", "targets", "skills", "notion", "assistant", "agents", "review"];
```

In `startDraft`'s returned object, after `assistant: null,` add `agents: null,`.

Add next to `normalizeAssistant`:

```ts
function normalizeAgents(v: unknown): AgentsChoice | null {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new DraftError("agents must be an object");
  const o = v as Record<string, unknown>;
  return { add_skill: o.add_skill === true, desktop_connect: o.desktop_connect === true };
}
```

In `normalizeDraft`'s returned object, after `assistant: normalizeAssistant(o.assistant),` add `agents: normalizeAgents(o.agents),`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --test server/services/setup/draft.test.ts server/services/setup/apply.test.ts server/routes/setup.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`. The client has its own `SetupDraft` (Task 7), so the server change alone typechecks.

```bash
git add app/server/services/setup/types.ts app/server/services/setup/draft.ts app/server/services/setup/draft.test.ts
git commit -m "setup: agents field and step in the draft

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The Agents step's status (`POST /api/setup/agents`)

**Files:**
- Create: `app/server/services/setup/agents.ts`
- Create: `app/server/services/setup/agents.test.ts`
- Modify: `app/server/routes/setup.ts` (imports, `SetupRouterDeps`, new route, header comment)
- Test: `app/server/routes/setup.test.ts`

**Interfaces:**
- Consumes: `desktopStatus`, `DesktopStatus` (Task 1); `BUNDLED_SKILL_NAME`; `effectiveTargets` (`./plan.ts`); `readManifest` (`../vault.ts`); `PathEnv`, `realPathEnv` (`../agentAccess/desktopConfig.ts`); `SetupDraft` with `agents` (Task 4).
- Produces:
  ```ts
  export interface AgentsStatus {
    bridge_built: boolean;
    skill: { state: "not_in_vault" | "in_vault" | "adopting"; adopting_from?: string };
    desktop: DesktopStatus;
    default_targets: string[];
    vault_path: string;
  }
  export function skillInDraftVault(draft: SetupDraft): AgentsStatus["skill"];
  export function agentsStatus(draft: SetupDraft, deps: { config: Pick<AppConfig, "providers" | "default_targets">; env: PathEnv; bridgePath: string | null }): AgentsStatus;
  ```
  - Route: `POST /api/setup/agents { draft }` → `AgentsStatus`. 400 for a malformed draft, or `{ error: "Choose a vault first." }` when there's no vault. `SetupRouterDeps` gains `pathEnv?: () => PathEnv`.

- [ ] **Step 1: Write the failing service test**

`app/server/services/setup/agents.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDraft } from "./draft.ts";
import { agentsStatus, skillInDraftVault } from "./agents.ts";
import type { SetupDraft } from "./types.ts";

const emptyBase = { vault_path: null, agent_locations: {}, default_targets: [], machine_id: "PC", repo_url: null };
const draftWith = (patch: Partial<SetupDraft>): SetupDraft => ({ ...startDraft(emptyBase), ...patch });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-agents-"));

test("skill state: new, clone listed or not, adopting", () => {
  assert.deepEqual(skillInDraftVault(draftWith({ vault: { mode: "new", path: "C:\\v" } })), { state: "not_in_vault" });
  const clone = (names: string[]) =>
    draftWith({ vault: { mode: "clone", path: "C:\\c", clone: { url: "https://github.com/me/v.git", dest: "C:\\c", subdir: "", skill_names: names, notion: null } } });
  assert.deepEqual(skillInDraftVault(clone(["skill-vault", "x"])), { state: "in_vault" });
  assert.deepEqual(skillInDraftVault(clone(["x"])), { state: "not_in_vault" });
  const adopting = draftWith({ vault: { mode: "new", path: "C:\\v" }, skills: { adopt: [{ name: "skill-vault", from: "cursor" }], push: [] } });
  assert.deepEqual(skillInDraftVault(adopting), { state: "adopting", adopting_from: "cursor" });
});

test("skill state for an existing vault: manifest entry, folder alone, neither", () => {
  const root = tmp();
  try {
    const v = (p: string) => draftWith({ vault: { mode: "existing", path: p } });
    const byManifest = path.join(root, "a");
    fs.mkdirSync(byManifest);
    fs.writeFileSync(path.join(byManifest, "skills.json"), JSON.stringify({ skills: { "skill-vault": { targets: [] } } }));
    assert.equal(skillInDraftVault(v(byManifest)).state, "in_vault");

    const byFolder = path.join(root, "b");
    fs.mkdirSync(path.join(byFolder, "skills", "skill-vault"), { recursive: true });
    fs.writeFileSync(path.join(byFolder, "skills.json"), "{not json");
    assert.equal(skillInDraftVault(v(byFolder)).state, "in_vault");

    const none = path.join(root, "c");
    fs.mkdirSync(none);
    fs.writeFileSync(path.join(none, "skills.json"), JSON.stringify({ skills: { other: { targets: [] } } }));
    assert.equal(skillInDraftVault(v(none)).state, "not_in_vault");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("status: bridge, Desktop and the draft's default tools", () => {
  const root = tmp();
  try {
    const bridge = path.join(root, "dist", "assistant-mcp.js");
    fs.mkdirSync(path.dirname(bridge), { recursive: true });
    fs.writeFileSync(bridge, "//");
    const env = { platform: "win32" as const, appData: path.join(root, "appdata"), home: root, exists: (p: string) => fs.existsSync(p), list: () => [] };
    const draft = draftWith({
      vault: { mode: "new", path: path.join(root, "vault") },
      targets: [
        { id: "claude", path: path.join(root, "c"), enabled: true, is_default: true, known: true },
        { id: "cursor", path: path.join(root, "u"), enabled: true, is_default: false, known: true },
      ],
    });
    const config = { providers: [], default_targets: [] };
    const st = agentsStatus(draft, { config, env, bridgePath: bridge });
    assert.equal(st.bridge_built, true);
    assert.deepEqual(st.desktop, { state: "not_installed", config_path: null });
    assert.deepEqual(st.default_targets, ["claude"]);
    assert.equal(st.vault_path, path.join(root, "vault"));
    assert.equal(agentsStatus(draft, { config, env, bridgePath: null }).bridge_built, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --import tsx --test server/services/setup/agents.test.ts`
Expected: FAIL, `Cannot find module './agents.ts'`.

- [ ] **Step 3: Write the service**

`app/server/services/setup/agents.ts`:

```ts
/**
 * The setup guide's Agents step: what it can offer for the vault and tools
 * chosen in the draft, not the saved settings
 * (docs/superpowers/specs/2026-11-05-setup-agents-step-design.md).
 */
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../../types/vault.ts";
import { BUNDLED_SKILL_NAME } from "../agentAccess/bundledSkill.ts";
import type { PathEnv } from "../agentAccess/desktopConfig.ts";
import { desktopStatus, type DesktopStatus } from "../agentAccess/desktopConnect.ts";
import { readManifest } from "../vault.ts";
import { effectiveTargets } from "./plan.ts";
import type { SetupDraft } from "./types.ts";

export interface AgentsStatus {
  bridge_built: boolean;
  skill: { state: "not_in_vault" | "in_vault" | "adopting"; adopting_from?: string };
  desktop: DesktopStatus;
  default_targets: string[];
  vault_path: string;
}

/** Whether the draft's vault already has a skill-vault (ours or not: the Settings card sorts that out). */
export function skillInDraftVault(draft: SetupDraft): AgentsStatus["skill"] {
  const adopting = draft.skills.adopt.find((a) => a.name === BUNDLED_SKILL_NAME);
  if (adopting) return { state: "adopting", adopting_from: adopting.from };
  const v = draft.vault;
  if (!v || v.mode === "new") return { state: "not_in_vault" };
  if (v.mode === "clone") return { state: v.clone?.skill_names.includes(BUNDLED_SKILL_NAME) ? "in_vault" : "not_in_vault" };
  if (fs.existsSync(path.join(v.path, "skills", BUNDLED_SKILL_NAME))) return { state: "in_vault" };
  try {
    if (Object.hasOwn(readManifest(v.path).skills, BUNDLED_SKILL_NAME)) return { state: "in_vault" };
  } catch {
    /* no readable manifest: the folder alone decides */
  }
  return { state: "not_in_vault" };
}

export function agentsStatus(
  draft: SetupDraft,
  deps: { config: Pick<AppConfig, "providers" | "default_targets">; env: PathEnv; bridgePath: string | null },
): AgentsStatus {
  return {
    bridge_built: !!deps.bridgePath && fs.existsSync(deps.bridgePath),
    skill: skillInDraftVault(draft),
    desktop: desktopStatus(deps.env),
    default_targets: effectiveTargets(draft, deps.config).filter((t) => t.is_default).map((t) => t.id),
    vault_path: draft.vault?.path ?? "",
  };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --import tsx --test server/services/setup/agents.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing route test** (append to `app/server/routes/setup.test.ts`)

```ts
test("agents: draft-aware status; 400 without a vault or for a bad draft", async () => {
  const { startDraft } = await import("../services/setup/draft.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-setup-a-"));
  const appRoot = path.join(root, "app");
  fs.mkdirSync(path.join(appRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "dist", "assistant-mcp.js"), "//");
  const claudeDir = path.join(root, "appdata", "Claude");
  const pathEnv = () => ({ platform: "win32" as const, appData: path.join(root, "appdata"), home: root, exists: (p: string) => fs.existsSync(p), list: () => [] });
  const url = await serve(
    setup.setupRouter({ appRoot, pathEnv, readConfig: () => ({ vault_path: null, providers: [{ id: "claude", path: path.join(root, "c") }], default_targets: ["claude"] }) }),
  );
  const draft = startDraft({ vault_path: null, agent_locations: {}, default_targets: [], machine_id: null, repo_url: null });
  assert.equal((await fetch(`${url}/agents`, json({ draft }))).status, 400);
  assert.equal((await fetch(`${url}/agents`, json({ draft: { version: 3 } }))).status, 400);

  const withVault = { ...draft, vault: { mode: "new", path: path.join(root, "vault") } };
  const gone = await (await fetch(`${url}/agents`, json({ draft: withVault }))).json();
  assert.deepEqual(gone, {
    bridge_built: true,
    skill: { state: "not_in_vault" },
    desktop: { state: "not_installed", config_path: null },
    default_targets: ["claude"],
    vault_path: path.join(root, "vault"),
  });

  fs.mkdirSync(claudeDir, { recursive: true });
  const file = path.join(claudeDir, "claude_desktop_config.json");
  assert.equal((await (await fetch(`${url}/agents`, json({ draft: withVault }))).json()).desktop.state, "not_connected");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { "skill-vault": { command: process.execPath, args: [path.join(appRoot, "dist", "assistant-mcp.js")] } } }));
  assert.equal((await (await fetch(`${url}/agents`, json({ draft: withVault }))).json()).desktop.state, "connected");
  fs.writeFileSync(file, "{ broken");
  const bad = (await (await fetch(`${url}/agents`, json({ draft: withVault }))).json()).desktop;
  assert.equal(bad.state, "unreadable");
  assert.match(bad.error, /isn't valid JSON/);
  fs.rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `node --import tsx --test server/routes/setup.test.ts`
Expected: FAIL, 404 from `/agents`. (`pathEnv` isn't a known option yet, but `tsx` doesn't typecheck.)

- [ ] **Step 7: Add the route**

In `app/server/routes/setup.ts`:

1. Header comment: add a line after the `/plan` line:
   ```
    *   POST   /agents         { draft } → AgentsStatus — what the Agents step can offer (skill-vault, Claude Desktop)
   ```
2. Imports:
   ```ts
   import path from "node:path";
   import { agentsStatus } from "../services/setup/agents.ts";
   import { realPathEnv, type PathEnv } from "../services/agentAccess/desktopConfig.ts";
   ```
3. `SetupRouterDeps` gains:
   ```ts
   /** Where Claude Desktop's config is looked for (tests pass a temp folder). */
   pathEnv?: () => PathEnv;
   ```
4. In `setupRouter`, next to the other defaults: `const pathEnv = deps.pathEnv ?? realPathEnv;`
5. After the `/plan` route:
   ```ts
   router.post("/agents", (req, res) => {
     let draft;
     try {
       draft = normalizeDraft((req.body as { draft?: unknown } | undefined)?.draft);
     } catch (err) {
       res.status(400).json({ error: (err as Error).message });
       return;
     }
     if (!draft.vault) {
       res.status(400).json({ error: "Choose a vault first." });
       return;
     }
     res.json(
       agentsStatus(draft, {
         config: readConfig(),
         env: pathEnv(),
         bridgePath: deps.appRoot ? path.join(deps.appRoot, "dist", "assistant-mcp.js") : null,
       }),
     );
   });
   ```

- [ ] **Step 8: Run the tests to see them pass**

Run: `node --import tsx --test server/routes/setup.test.ts server/services/setup/agents.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

Run: `npm run typecheck` → no errors.

```bash
git add app/server/services/setup/agents.ts app/server/services/setup/agents.test.ts app/server/routes/setup.ts app/server/routes/setup.test.ts
git commit -m "setup: POST /api/setup/agents, the Agents step's status for the draft

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Finish adds skill-vault, pushes it and connects Desktop

**Files:**
- Modify: `app/server/services/setup/apply.ts`
- Modify: `app/server/services/setup/applyDeps.ts`
- Modify: `app/server/routes/setup.ts` (the default applier line)
- Modify: `app/server/index.ts:177`
- Test: `app/server/services/setup/apply.test.ts`

**Interfaces:**
- Consumes: `addBundledSkillIfMissing`, `pushBundledSkill`, `BUNDLED_SKILL_NAME` (Task 2/3 files); `connectDesktop`, `DesktopConnectError` (Task 1); `DesktopConfigError`, `realPathEnv`; `recordActivity` (`../activity.ts`); `draft.agents` (Task 4).
- Produces:
  - `ApplyStep` = `"vault" | "config" | "adopt" | "push" | "notion" | "desktop"`; `FailedItem.step` = `"adopt" | "push" | "notion" | "desktop"`.
  - `SetupApplyDeps` gains `addVaultSkill(vaultPath: string): "added" | "already"`, `pushVaultSkill(vaultPath: string, provider: Provider): void`, `connectDesktop(): void`.
  - `defaultApplyDeps(opts?: { home?: () => string; appRoot?: string }): SetupApplyDeps`. **Breaking:** it used to take `home?: () => string` directly.
  - Log labels: `skill-vault (from Skill Vault)` (adopt step), `skill-vault → <id>` (push step), `Claude Desktop` (desktop step, done message `connected`).

- [ ] **Step 1: Write the failing tests**

In `apply.test.ts`, extend `harness`. Add to `calls`: `vaultSkill: 0, vaultSkillPush: [] as string[], desktop: 0, order: [] as string[]`. Add to `deps` (before `...over`):

```ts
    addVaultSkill: () => {
      calls.vaultSkill++;
      calls.order.push("vault_skill");
      return "added";
    },
    pushVaultSkill: (_v, provider) => {
      calls.vaultSkillPush.push(provider.id);
      calls.order.push(`vault_skill_push:${provider.id}`);
    },
    connectDesktop: () => {
      calls.desktop++;
      calls.order.push("desktop");
    },
```

Then append these tests:

```ts
const NOTION = { data_source_id: "11111111-2222-3333-4444-555555555555", data_source_name: "Skills", add_last_edited: false };

test("agents: skill-vault after the adopts, its pushes after the pushes, Desktop last", async () => {
  const root = tmp();
  try {
    const t1 = path.join(root, "t1");
    const t2 = path.join(root, "t2");
    fs.mkdirSync(t1);
    fs.mkdirSync(t2);
    const { applier, calls } = harness();
    const events: SetupEvent[] = [];
    const draft = draftWith({
      vault: { mode: "new", path: path.join(root, "vault") },
      targets: [
        { id: "t1", path: t1, enabled: true, is_default: true, known: false },
        { id: "t2", path: t2, enabled: true, is_default: false, known: false },
      ],
      skills: { adopt: [{ name: "found", from: "t1" }], push: ["mine"] },
      notion: NOTION,
      agents: { add_skill: true, desktop_connect: true },
    });
    const state = await applier.apply({ draft }, (e) => events.push(e));
    assert.equal(state.ok, true);
    assert.deepEqual(calls.vaultSkillPush, ["t1"]);
    assert.deepEqual(calls.order, ["vault_skill", "vault_skill_push:t1", "desktop"]);
    assert.deepEqual(events.map((e) => `${e.step}:${e.state}${e.item ? `:${e.item}` : ""}`), [
      "vault:start", "vault:done", "config:start", "config:done",
      "adopt:start", "adopt:done:found (from t1)", "adopt:done:skill-vault (from Skill Vault)",
      "push:start", "push:done:mine → t1", "push:done:skill-vault → t1",
      "notion:start", "notion:done:Skills",
      "desktop:start", "desktop:done:Claude Desktop",
      "done:done",
    ]);
    assert.equal(events.find((e) => e.step === "desktop" && e.state === "done")?.message, "connected");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("agents: null (Skip) adds no items; false ticks add none either", async () => {
  const root = tmp();
  try {
    for (const agents of [null, { add_skill: false, desktop_connect: false }]) {
      const { applier, calls } = harness();
      const state = await applier.apply({ draft: draftWith({ vault: { mode: "new", path: path.join(root, `v${agents ? 1 : 0}`) }, agents }) }, () => {});
      assert.equal(state.ok, true);
      assert.deepEqual(calls.order, []);
      assert.ok(!state.events.some((e) => e.step === "desktop"));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed Desktop connect is the only item that retries", async () => {
  const root = tmp();
  try {
    let broken = true;
    const { applier, calls } = harness({
      connectDesktop: () => {
        calls.desktop++;
        if (broken) throw new Error("C:\\x\\claude_desktop_config.json isn't valid JSON (Unexpected token). Fix it, then try again.");
      },
    });
    const draft = draftWith({ vault: { mode: "new", path: path.join(root, "vault") }, agents: { add_skill: true, desktop_connect: true } });
    const first = await applier.apply({ draft }, () => {});
    assert.equal(first.ok, false);
    assert.deepEqual(first.failed.map((f) => `${f.step}:${f.item}`), ["desktop:Claude Desktop"]);
    assert.match(first.failed[0].message, /isn't valid JSON/);

    broken = false;
    const second = await applier.retry(() => {});
    assert.equal(second.ok, true);
    assert.equal(calls.desktop, 2);
    assert.equal(calls.vaultSkill, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed skill-vault add fails its pushes; retry runs the add first", async () => {
  const root = tmp();
  try {
    const t1 = path.join(root, "t1");
    fs.mkdirSync(t1);
    let inVault = false;
    let addFails = true;
    const order: string[] = [];
    const { applier } = harness({
      addVaultSkill: () => {
        order.push("add");
        if (addFails) throw new Error('Your vault already has a skill named "skill-vault" from somewhere else. Rename it to add this one.');
        inVault = true;
        return "added";
      },
      pushVaultSkill: (_v, p) => {
        order.push(`push:${p.id}`);
        if (!inVault) throw new Error("skill-vault isn't in the vault yet");
      },
    });
    const draft = draftWith({
      vault: { mode: "new", path: path.join(root, "vault") },
      targets: [{ id: "t1", path: t1, enabled: true, is_default: true, known: false }],
      agents: { add_skill: true, desktop_connect: false },
    });
    const first = await applier.apply({ draft }, () => {});
    assert.deepEqual(first.failed.map((f) => `${f.step}:${f.item}`), ["adopt:skill-vault (from Skill Vault)", "push:skill-vault → t1"]);
    assert.equal(first.failed[1].message, "skill-vault isn't in the vault yet");

    addFails = false;
    order.length = 0;
    const second = await applier.retry(() => {});
    assert.equal(second.ok, true);
    assert.deepEqual(order, ["add", "push:t1"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skill-vault already in the vault is a skip line, not a failure", async () => {
  const root = tmp();
  try {
    const { applier } = harness({ addVaultSkill: () => "already" });
    const state = await applier.apply({ draft: draftWith({ vault: { mode: "new", path: path.join(root, "vault") }, agents: { add_skill: true, desktop_connect: false } }) }, () => {});
    assert.equal(state.ok, true);
    const line = state.events.find((e) => e.item === "skill-vault (from Skill Vault)");
    assert.deepEqual(line, { step: "adopt", state: "skip", item: "skill-vault (from Skill Vault)", message: "already in the vault" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --import tsx --test server/services/setup/apply.test.ts`
Expected: the five new tests FAIL (no new items are produced). The existing tests still pass.

- [ ] **Step 3: Implement in `apply.ts`**

1. Header comment, the order lines become:
   ```
    *   3 adopt (+ skill-vault from the app), 4 push (+ skill-vault to the default tools),
    *   5 Notion database, 6 Claude Desktop — item by item
   ```
2. Types:
   ```ts
   export type ApplyStep = "vault" | "config" | "adopt" | "push" | "notion" | "desktop";

   export interface FailedItem {
     step: "adopt" | "push" | "notion" | "desktop";
     item: string;
     message: string;
   }
   ```
3. `SetupApplyDeps` gains, after `saveNotion`:
   ```ts
   /** Add the bundled skill-vault skill unless the vault has one (throws why it can't). */
   addVaultSkill: (vaultPath: string) => "added" | "already";
   /** Push the vault's skill-vault to one tool (throws for a folder that isn't ours). */
   pushVaultSkill: (vaultPath: string, provider: Provider) => void;
   /** Add the skill-vault MCP server to Claude Desktop's config (throws why it can't). */
   connectDesktop: () => void;
   ```
4. `WorkItem` and the step map:
   ```ts
   type WorkItem =
     | { kind: "adopt"; label: string; name: string; path: string; providerId: string }
     | { kind: "vault_skill"; label: string }
     | { kind: "push"; label: string; name: string; provider: Provider }
     | { kind: "vault_skill_push"; label: string; provider: Provider }
     | { kind: "notion"; label: string; choice: NotionChoice }
     | { kind: "desktop"; label: string };

   /** The log step each kind shows under (skill-vault's items sit with Adopt and Push). */
   const STEP_OF: Record<WorkItem["kind"], FailedItem["step"]> = {
     adopt: "adopt",
     vault_skill: "adopt",
     push: "push",
     vault_skill_push: "push",
     notion: "notion",
     desktop: "desktop",
   };
   const VAULT_SKILL_LABEL = "skill-vault (from Skill Vault)";
   ```
5. In `workItems`, after the `for (const a of draft.skills.adopt)` loop:
   ```ts
   const agents = draft.agents;
   if (agents?.add_skill) items.push({ kind: "vault_skill", label: VAULT_SKILL_LABEL });
   ```
   after the `for (const name of draft.skills.push)` loop:
   ```ts
   if (agents?.add_skill) {
     for (const t of targets.filter((x) => x.is_default)) {
       items.push({ kind: "vault_skill_push", label: `skill-vault → ${t.id}`, provider: { id: t.id, path: t.path } });
     }
   }
   ```
   and after the `if (draft.notion)` block:
   ```ts
   if (agents?.desktop_connect) items.push({ kind: "desktop", label: "Claude Desktop" });
   ```
6. `runItems` becomes:
   ```ts
   async function runItems(items: WorkItem[], vaultPath: string, emit: (e: SetupEvent) => void): Promise<WorkItem[]> {
     const failed: WorkItem[] = [];
     let current: ApplyStep | null = null;
     for (const it of items) {
       const step = STEP_OF[it.kind];
       if (step !== current) {
         current = step;
         emit({ step, state: "start" });
       }
       try {
         if (it.kind === "adopt") {
           const r = deps.adopt(vaultPath, { name: it.name, path: it.path, providerId: it.providerId });
           emit(r === "imported" ? { step, state: "done", item: it.label } : { step, state: "skip", item: it.label, message: "already in the vault" });
         } else if (it.kind === "vault_skill") {
           const r = deps.addVaultSkill(vaultPath);
           emit(r === "added" ? { step, state: "done", item: it.label } : { step, state: "skip", item: it.label, message: "already in the vault" });
         } else if (it.kind === "push") {
           deps.push(vaultPath, it.name, it.provider);
           emit({ step, state: "done", item: it.label });
         } else if (it.kind === "vault_skill_push") {
           deps.pushVaultSkill(vaultPath, it.provider);
           emit({ step, state: "done", item: it.label });
         } else if (it.kind === "notion") {
           const r = await deps.saveNotion(vaultPath, it.choice, redirectUrl);
           emit({ step, state: "done", item: it.label, ...(r.warning ? { message: r.warning } : {}) });
         } else {
           deps.connectDesktop();
           emit({ step, state: "done", item: it.label, message: "connected" });
         }
       } catch (err) {
         const message = (err as Error).message;
         failed.push(it);
         state.failed.push({ step, item: it.label, message });
         emit({ step, state: "error", item: it.label, message });
       }
     }
     return failed;
   }
   ```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --test server/services/setup/apply.test.ts`
Expected: PASS, all tests (the old ones too).

- [ ] **Step 5: Wire the real deps**

`app/server/services/setup/applyDeps.ts` becomes:

```ts
/** The real dependencies of the Finish job (tests use fakes; see apply.test.ts). */
import fs from "node:fs";
import path from "node:path";
import { defaultRun } from "../appUpdate.ts";
import { readAppConfig, writeSetupConfig } from "../appConfig.ts";
import { recordActivity } from "../activity.ts";
import { importSkills } from "../adoption.ts";
import { pushSkillToProvider } from "../pushSkill.ts";
import { getServerPort } from "../runtime.ts";
import { initVault } from "../vault.ts";
import { rebuildWatcher } from "../watcher.ts";
import { chooseDataSource, openNotionApiAt } from "../notion/dataSource.ts";
import { BUNDLED_SKILL_NAME } from "../agentAccess/bundledSkill.ts";
import { DesktopConfigError, realPathEnv } from "../agentAccess/desktopConfig.ts";
import { DesktopConnectError, connectDesktop } from "../agentAccess/desktopConnect.ts";
import { addBundledSkillIfMissing, pushBundledSkill } from "../agentAccess/vaultSkill.ts";
import { deleteDraft } from "./draft.ts";
import type { SetupApplyDeps } from "./apply.ts";

const NO_APP_ROOT = "The app folder isn't known, so the skill-vault items can't run.";

export function defaultApplyDeps(opts: { home?: () => string; appRoot?: string } = {}): SetupApplyDeps {
  const { home, appRoot } = opts;
  return {
    run: defaultRun,
    readConfig: readAppConfig,
    initVault,
    writeConfig: (patch) => {
      writeSetupConfig(patch);
    },
    rebuildWatcher,
    adopt: (vaultPath, item) => {
      const r = importSkills(vaultPath, path.dirname(item.path), [], item.providerId, undefined, [{ name: item.name, path: item.path }]);
      return r.imported.length + r.updated.length > 0 ? "imported" : "skipped";
    },
    push: (vaultPath, skill, provider) => {
      fs.mkdirSync(provider.path, { recursive: true });
      pushSkillToProvider(vaultPath, skill, provider);
    },
    saveNotion: async (vaultPath, choice, redirectUrl) => {
      const conn = await openNotionApiAt(redirectUrl ?? `http://localhost:${getServerPort()}/api/notion/callback`);
      try {
        return await chooseDataSource(conn.api, vaultPath, {
          id: choice.data_source_id,
          name: choice.data_source_name,
          add_last_edited: choice.add_last_edited,
        });
      } finally {
        await conn.close().catch(() => {});
      }
    },
    addVaultSkill: (vaultPath) => {
      if (!appRoot) throw new Error(NO_APP_ROOT);
      const r = addBundledSkillIfMissing(appRoot, vaultPath);
      if (r === "added") recordActivity({ kind: "adopt", skill: BUNDLED_SKILL_NAME, ok: true, message: "added from the app" });
      return r;
    },
    pushVaultSkill: (vaultPath, provider) => {
      try {
        fs.mkdirSync(provider.path, { recursive: true });
        pushBundledSkill(vaultPath, provider);
        recordActivity({ kind: "push", skill: BUNDLED_SKILL_NAME, provider_id: provider.id, ok: true, message: "pushed" });
      } catch (err) {
        recordActivity({ kind: "push", skill: BUNDLED_SKILL_NAME, provider_id: provider.id, ok: false, message: (err as Error).message });
        throw err;
      }
    },
    connectDesktop: () => {
      if (!appRoot) throw new Error(NO_APP_ROOT);
      try {
        const file = connectDesktop({ env: realPathEnv(), nodePath: process.execPath, bridgePath: path.join(appRoot, "dist", "assistant-mcp.js") });
        console.log(`[setup] connected Claude Desktop (${file})`);
      } catch (err) {
        if (err instanceof DesktopConnectError || err instanceof DesktopConfigError) throw err;
        throw new Error(`Couldn't update the Claude Desktop config: ${(err as Error).message}`);
      }
    },
    deleteDraft: () => deleteDraft(home?.()),
  };
}
```

`app/server/routes/setup.ts`, the default applier:

```ts
const applier = deps.applier ?? createSetupApplier(defaultApplyDeps({ home: deps.home, appRoot: deps.appRoot }));
```

`app/server/index.ts:177`:

```ts
const setupApplier = createSetupApplier(defaultApplyDeps({ appRoot: APP_ROOT }));
```

- [ ] **Step 6: Full server tests and typecheck**

Run: `npm test` (or `npm test -- --test-concurrency=1` on an EPERM flake), then `npm run typecheck`.
Expected: all pass; no type errors.

- [ ] **Step 7: Commit**

```bash
git add app/server/services/setup/apply.ts app/server/services/setup/apply.test.ts app/server/services/setup/applyDeps.ts app/server/routes/setup.ts app/server/index.ts
git commit -m "setup: Finish adds skill-vault, pushes it and connects Claude Desktop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The Agents step in the guide

**Files:**
- Modify: `app/client/src/lib/setup.ts`
- Create: `app/client/src/pages/setup/steps/AgentsStep.tsx`
- Modify: `app/client/src/pages/setup/SetupGuide.tsx`
- Modify: `app/client/src/pages/setup/steps/AssistantStep.tsx`
- Modify: `app/client/src/pages/setup/steps/ReviewStep.tsx` (Back, list lines, log label)

**Interfaces:**
- Consumes: `POST /api/setup/agents` (Task 5); the `agents` draft field (Task 4); the `"desktop"` log step (Task 6).
- Produces (client `lib/setup.ts`):
  ```ts
  export type SetupStep = "welcome" | "vault" | "targets" | "skills" | "notion" | "assistant" | "agents" | "review";
  export interface AgentsChoice { add_skill: boolean; desktop_connect: boolean }
  export type DesktopState = "not_installed" | "not_connected" | "connected" | "broken" | "name_taken" | "unreadable";
  export interface AgentsStatus {
    bridge_built: boolean;
    skill: { state: "not_in_vault" | "in_vault" | "adopting"; adopting_from?: string };
    desktop: { state: DesktopState; config_path: string | null; error?: string };
    default_targets: string[];
    vault_path: string;
  }
  // SetupDraft gains agents: AgentsChoice | null
  // SetupEvent.step and SetupJobState.failed[].step gain "desktop"
  // setupApi.agents(draft: SetupDraft): Promise<AgentsStatus>
  ```

- [ ] **Step 1: Client types and API**

In `app/client/src/lib/setup.ts`:

1. Replace the `SetupStep` line with the one above.
2. Add `AgentsChoice`, `DesktopState` and `AgentsStatus` (as above) after `SetupTarget`.
3. In `SetupDraft`, after `assistant`, add:
   ```ts
     /** The Agents step. null = Skip (or not visited). */
     agents: AgentsChoice | null;
   ```
4. `SetupEvent.step` becomes `"vault" | "config" | "adopt" | "push" | "notion" | "desktop" | "done"`.
5. `SetupJobState.failed` becomes `{ step: "adopt" | "push" | "notion" | "desktop"; item: string; message: string }[]`.
6. In `setupApi`, after `plan`:
   ```ts
     agents: (draft: SetupDraft) => call<AgentsStatus>("POST", "/api/setup/agents", { draft }),
   ```

- [ ] **Step 2: The step component**

`app/client/src/pages/setup/steps/AgentsStep.tsx`:

```tsx
/**
 * The Agents step: add the skill-vault skill to the vault and connect
 * Claude Desktop, both applied at Finish
 * (docs/superpowers/specs/2026-11-05-setup-agents-step-design.md).
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { setupApi, type DesktopState } from "../../../lib/setup";
import type { StepProps } from "../types";
import { Hint, StepHeader, StepNav, listBox } from "../ui";

const DESKTOP_TEXT: Record<DesktopState, string> = {
  not_connected: "Not connected.",
  broken: "The connection points at a file that's gone.",
  connected: "Already connected.",
  not_installed: "Claude Desktop isn't installed for this user.",
  name_taken: 'Claude Desktop already has another MCP server named "skill-vault". Rename it to connect this one.',
  unreadable: "Can't read the Claude Desktop config.",
};

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ padding: "10px 14px", borderTop: "0.5px solid var(--border)", fontSize: 13, color: "var(--ink)" }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

function Tick({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: disabled ? "default" : "pointer", color: disabled ? "var(--ink-3)" : "var(--ink)" }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

export function AgentsStep({ draft, commit, goTo }: StepProps) {
  const { data: status, error, isLoading } = useQuery({
    queryKey: ["setup-agents", draft.vault, draft.targets, draft.skills.adopt],
    queryFn: () => setupApi.agents(draft),
  });
  // First visit (or after Skip): what's offered starts ticked. Otherwise the saved choice.
  const [addSkill, setAddSkill] = useState(draft.agents ? draft.agents.add_skill : true);
  const [connect, setConnect] = useState(draft.agents ? draft.agents.desktop_connect : true);

  const skillOffered = status?.skill.state === "not_in_vault";
  const desktop = status?.desktop;
  const desktopOffered = desktop?.state === "not_connected" || desktop?.state === "broken";
  const desktopUsable = desktopOffered && status?.bridge_built === true;

  const next = () =>
    commit({ agents: { add_skill: Boolean(skillOffered && addSkill), desktop_connect: Boolean(desktopUsable && connect) } }, "review");

  const defaults = status?.default_targets ?? [];

  return (
    <div>
      <StepHeader title="Claude Desktop and other agents (optional)">
        Let Claude Desktop and your other AI tools work with your vault: find and load skills, save new ones, push them to your tools and run Notion syncs.
      </StepHeader>

      {error && <Hint tone="warn">{error instanceof Error ? error.message : "Couldn't check Claude Desktop and the vault."}</Hint>}
      {isLoading && <Hint>Checking…</Hint>}

      {status && (
        <div style={{ ...listBox, maxHeight: "none", padding: 0 }}>
          <Row title="The skill-vault skill">
            {skillOffered ? (
              <>
                <Tick checked={addSkill} onChange={setAddSkill}>Add it to my vault</Tick>
                <Hint>
                  It tells agents how to use your vault.{" "}
                  {defaults.length ? `It's also pushed to your default tools: ${defaults.join(", ")}.` : "You can push it to your tools later."}
                </Hint>
              </>
            ) : status.skill.state === "adopting" ? (
              <Hint>You're adopting skill-vault from {status.skill.adopting_from} on the Skills step.</Hint>
            ) : (
              <Hint tone="good">Already in your vault.</Hint>
            )}
          </Row>

          <Row title="Claude Desktop">
            {desktop && desktopOffered ? (
              <>
                <Tick checked={connect && desktopUsable} disabled={!status.bridge_built} onChange={setConnect}>
                  {desktop.state === "broken" ? "Reconnect Claude Desktop" : "Connect Claude Desktop"}
                </Tick>
                {!status.bridge_built && <Hint tone="warn">Build the app first.</Hint>}
                {desktop.state === "broken" && <Hint tone="warn">{DESKTOP_TEXT.broken}</Hint>}
                <Hint>
                  Adds a skill-vault server to Claude Desktop's settings. Your other servers stay as they are, and the file is backed up first. You'll
                  restart Claude Desktop after Finish.
                </Hint>
              </>
            ) : desktop ? (
              <Hint tone={desktop.state === "connected" ? "good" : desktop.state === "not_installed" ? "info" : "warn"}>
                {desktop.state === "unreadable"
                  ? `Can't read the Claude Desktop config: ${desktop.error ?? "unknown error"}. Fix the file, then come back to this step.`
                  : DESKTOP_TEXT[desktop.state]}
              </Hint>
            ) : null}
          </Row>
        </div>
      )}

      <StepNav onBack={() => goTo("assistant")} onSkip={() => commit({ agents: null }, "review")} onNext={next} nextDisabled={isLoading} />
    </div>
  );
}
```

- [ ] **Step 3: Wire it into the guide**

`app/client/src/pages/setup/SetupGuide.tsx`:

1. `import { AgentsStep } from "./steps/AgentsStep";` next to the other step imports.
2. In `RAIL`, between `assistant` and `review`: `{ id: "agents", label: "Agents" },`
3. Welcome text becomes: `A few short steps: where your skills live, the tools you use, Notion, the assistant and Claude Desktop. Nothing is saved until you press Finish.`
4. After `{step === "assistant" && <AssistantStep {...props} />}` add `{step === "agents" && <AgentsStep {...props} />}`.

`app/client/src/pages/setup/steps/AssistantStep.tsx`: the two `"review"` targets (in `next`'s `commit(..., "review")` and in `onSkip={() => commit({ assistant: null }, "review")}`) become `"agents"`.

`app/client/src/pages/setup/steps/ReviewStep.tsx`:

1. `STEP_NAME` gains `desktop: "Desktop",` (before `done`).
2. In `plannedActions`, after the `push` line and before the Notion line:
   ```ts
   if (d.agents?.add_skill) {
     const noDefault = d.targets !== null && !d.targets.some((t) => t.enabled && t.is_default);
     out.push(noDefault ? "Add the skill-vault skill to the vault" : "Add the skill-vault skill to the vault and push it to your default tools");
   }
   ```
   and after the Notion line (last):
   ```ts
   if (d.agents?.desktop_connect) out.push("Connect Claude Desktop to the vault tools");
   ```
3. The review's `StepNav` Back becomes `onBack={() => goTo("agents")}`.

- [ ] **Step 4: Typecheck and build**

Run (from `app/`): `npm run typecheck` then `npm run build`.
Expected: no errors; the build writes `dist/`.

- [ ] **Step 5: Commit**

```bash
git add app/client/src/lib/setup.ts app/client/src/pages/setup/steps/AgentsStep.tsx app/client/src/pages/setup/SetupGuide.tsx app/client/src/pages/setup/steps/AssistantStep.tsx app/client/src/pages/setup/steps/ReviewStep.tsx
git commit -m "setup guide: the Agents step (skill-vault skill, Claude Desktop)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Finish in Claude Desktop panel

**Files:**
- Create: `app/client/src/pages/setup/steps/DesktopFinishPanel.tsx`
- Modify: `app/client/src/pages/setup/steps/ReviewStep.tsx` (result phase)

**Interfaces:**
- Consumes: `setupApi.agents` (Task 7), `api.vaultSkillPrompt()` → `{ prompt }`, `api.vaultSkillZip()` → `{ zip_path, stage_dir }` (existing, `lib/api.ts`), `SetupEvent` with `"desktop"`.
- Produces: `DesktopFinishPanel({ draft, events }: { draft: SetupDraft; events: SetupEvent[] })`, which renders nothing when the panel doesn't apply.

- [ ] **Step 1: The panel**

`app/client/src/pages/setup/steps/DesktopFinishPanel.tsx`:

```tsx
/**
 * After Finish: what's left in Claude Desktop. Restart it (when this job
 * connected it), then install the skill-vault skill from the prompt or the
 * zip. Shown when the Agents step wasn't skipped and Desktop is connected,
 * or Connect was ticked and didn't go through.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../../../lib/api";
import { setupApi, type SetupDraft, type SetupEvent } from "../../../lib/setup";
import { Button } from "../../../components/ui/primitives";
import { Hint } from "../ui";

const errText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

const box = {
  marginTop: 16,
  background: "var(--surface)",
  border: "0.5px solid var(--border)",
  borderRadius: 8,
  padding: "14px 18px",
  fontSize: 13,
  color: "var(--ink)",
  lineHeight: 1.6,
} as const;

export function DesktopFinishPanel({ draft, events }: { draft: SetupDraft; events: SetupEvent[] }) {
  const agents = draft.agents;
  // Ask again after every job (a Retry adds events), so a fixed connect shows up.
  const { data } = useQuery({
    queryKey: ["setup-agents-after", events.length],
    queryFn: () => setupApi.agents(draft),
    enabled: agents !== null,
  });
  const copy = useMutation({
    mutationFn: async () => navigator.clipboard.writeText((await api.vaultSkillPrompt()).prompt),
    onSuccess: () => toast.success("Install prompt copied: paste it into a new Claude Desktop chat"),
    onError: (err) => toast.error(errText(err, "Couldn't copy the prompt")),
  });
  const zip = useMutation({
    mutationFn: () => api.vaultSkillZip(),
    onSuccess: () => toast.success("skill-vault.zip is ready: upload it in Claude Desktop"),
    onError: (err) => toast.error(errText(err, "Couldn't build the zip")),
  });

  if (!agents || !data) return null;
  const connected = data.desktop.state === "connected";
  if (!connected && !agents.desktop_connect) return null;

  if (!connected) {
    return (
      <div style={box}>
        <div style={{ fontWeight: 600 }}>Finish in Claude Desktop</div>
        <Hint tone="warn">Claude Desktop isn't connected yet. Press Retry failed items, or connect it later in Settings → Agent access.</Hint>
      </div>
    );
  }

  const connectedNow = events.some((e) => e.step === "desktop" && e.state === "done");
  return (
    <div style={box}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Finish in Claude Desktop</div>
      <ol style={{ margin: 0, paddingLeft: 20 }}>
        {connectedNow && (
          <li>
            Quit Claude Desktop from its tray icon (closing the window isn't enough), then open it again. It loads the vault tools only when it starts.
          </li>
        )}
        <li>
          In a new chat, paste the install prompt and save the skill Claude gives you.
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "8px 0 4px" }}>
            <Button size="sm" kind="primary" onClick={() => copy.mutate()} disabled={copy.isPending}>
              Copy install prompt
            </Button>
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>or</span>
            <Button size="sm" onClick={() => zip.mutate()} disabled={zip.isPending}>
              Download skill zip
            </Button>
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>and upload it in Claude Desktop → Settings → Capabilities → Skills.</span>
          </div>
        </li>
      </ol>
      <Hint>Claude Desktop then reads and saves skills in your vault, {data.vault_path}, the folder set in Settings.</Hint>
    </div>
  );
}
```

- [ ] **Step 2: Show it on the result screen**

In `ReviewStep.tsx`:

1. `import { DesktopFinishPanel } from "./DesktopFinishPanel";`
2. In the `phase === "result" && result` branch, directly after `{log}`, add `<DesktopFinishPanel draft={draft} events={events} />`.

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck` then `npm run build`.
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/client/src/pages/setup/steps/DesktopFinishPanel.tsx app/client/src/pages/setup/steps/ReviewStep.tsx
git commit -m "setup guide: Finish in Claude Desktop panel (restart, install prompt, zip)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs and changelogs

**Files:**
- Modify: `docs/getting-started.md` (section "First run: the setup guide")
- Modify: `docs/features.md` ("Agent access" section and "Setup guide — first run and re-run")
- Modify: `docs/faq.md` (the "Can Claude Desktop save skills to my vault?" entry, plus a new entry after it)
- Modify: `docs/troubleshooting.md` ("Setup finished with "items need attention"")
- Modify: `docs/changelog.md`, `app/CHANGELOG.md` (`[Unreleased]`)

- [ ] **Step 1: getting-started.md**

Replace list items 5–6 with:

```markdown
5. **Assistant** (optional): pick the tool the assistant runs on (Claude Code, OpenAI Codex, GitHub Copilot CLI or Grok Build). Skill Vault can install it; then sign in with your account or use an API key.
6. **Agents** (optional): add the `skill-vault` skill to your vault (it's pushed to your default tools too) and connect Claude Desktop to the vault tools. If Claude Desktop isn't installed, the step says so and still offers the skill.
7. **Finish**: a list of exactly what will happen, then live progress.
```

After the paragraph that starts "Nothing is saved until you press **Finish**.", add:

```markdown
**After Finish, in Claude Desktop.** If you connected Claude Desktop, quit it from its tray icon (closing the window isn't enough) and open it again: it reads the vault tools only when it starts. Then press **Copy install prompt** on the Finish screen and paste it into a new Desktop chat, and save the skill Claude gives you. Or press **Download skill zip** and upload it in Claude Desktop → Settings → Capabilities → Skills. From then on, Desktop reads and saves skills in your vault, the folder set in Settings.
```

- [ ] **Step 2: features.md**

In "Setup guide — first run and re-run", replace `A six-step guide` … `**Assistant** (pick a provider, install it and sign in, or use an API key), and **Finish**` with `A seven-step guide` … `**Assistant** (pick a provider, install it and sign in, or use an API key), **Agents** (add the `skill-vault` skill and connect Claude Desktop), and **Finish**`. Keep the rest of the paragraph.

In "Agent access", add after the **Claude Desktop** bullet:

```markdown
- **The setup guide** can do the same at Finish: its **Agents** step adds the skill to the vault and connects Claude Desktop, and the Finish screen then walks you through the restart and the skill install.
- **Skills made in a chat go to the vault.** Once the skill is installed, a skill that Claude Desktop (or any agent with the skill) creates or changes in a chat is saved to your vault with `save_skill`, then offered for push to your tools. It isn't handed back as a zip to upload. A zip is only for putting a vault skill into Claude Desktop itself.
```

- [ ] **Step 3: faq.md**

Replace the "Can Claude Desktop save skills to my vault?" answer's first sentence with:

```markdown
Yes. Connect Claude Desktop and install the `skill-vault` skill, either in the setup guide's **Agents** step or in Settings → Agent access (zip or copy-paste prompt).
```

Add after that entry:

```markdown
**Where does Claude Desktop keep my skills?**
In your vault: the folder set in Skill Vault's Settings. Claude Desktop has no skills folder on your computer, so the `skill-vault` skill tells it to find, read and save skills only through the vault tools. When you make or change a skill in a Desktop chat, Claude saves it to the vault instead of giving you a zip, then offers to push it to your tools. The one zip you install by hand is the `skill-vault` skill itself.
```

- [ ] **Step 4: troubleshooting.md**

Under `### Setup finished with "items need attention"`, after the existing paragraph, add:

```markdown
- **Desktop — "… isn't valid JSON"**: Claude Desktop's `claude_desktop_config.json` has a typo. Fix it (or restore `claude_desktop_config.json.skill-vault.bak` from an earlier connect), then press **Retry failed items**.
- **Desktop — "already has an MCP server named "skill-vault""**: another server uses that name. Rename it in Claude Desktop's config, then retry.
- **Adopt — skill-vault "from somewhere else"**: your vault already has a different `skill-vault` skill. Rename it if you want this one.
- **Push — "a skill-vault folder that isn't from your vault is already there"**: that tool has its own `skill-vault` folder, which is never overwritten. Move or rename it, then retry.
```

- [ ] **Step 5: Changelogs**

`docs/changelog.md`, under `## [Unreleased]`, add before `### Fixed`:

```markdown
### Added
- **The setup guide can connect Claude Desktop.** A new optional **Agents** step adds the `skill-vault`
  skill to your vault (and pushes it to your default tools) and connects Claude Desktop to the vault
  tools, both at Finish with progress and retry. The Finish screen then says to quit Desktop from the
  tray icon and reopen it, and gives you **Copy install prompt** and **Download skill zip** for the
  skill.
- **Skills made in a Claude Desktop chat are saved to your vault.** The `skill-vault` skill now says the
  vault folder from Settings is where every skill lives. A skill created or changed in a chat goes into
  the vault, then out to your tools, instead of coming back as a zip to upload.
```

`app/CHANGELOG.md`, under `## [Unreleased]`, add before `### Fixed`:

```markdown
### Added
- Setup guide **Agents** step (`steps/AgentsStep.tsx`), between Assistant and Finish. The draft gains
  `agents: { add_skill, desktop_connect } | null`, and `POST /api/setup/agents { draft }` reports
  skill-vault against the draft's vault, the Claude Desktop state, the bridge and the default tools.
  Finish gains three item kinds: `vault_skill` (Adopt), `vault_skill_push` (Push, one per default tool)
  and `desktop` (new log step). They retry like the others. The result screen's
  `DesktopFinishPanel` gives the tray-icon restart, the install prompt and the zip.
- Desktop connect and the bundled-skill state, add and push moved to
  `services/agentAccess/desktopConnect.ts` and `vaultSkill.ts`. Settings → Agent access calls them,
  and its behaviour is unchanged.
- `bundled-skills/skill-vault/SKILL.md`: a "Where skills live" section (the vault from Settings, no
  Desktop skills folder). A skill made or changed in a chat is saved with `save_skill`, never handed
  back as a zip or `.skill` file, and the description triggers on creating or editing a skill. The
  install prompt says why this one skill is a zip.
```

- [ ] **Step 6: Check for personal data and commit**

Run (from the repo root): `git diff | rg -n -i "<your-user-name>|<your-name>"` → no matches. Example paths in the new text use `C:\Users\you\…` only.

```bash
git add docs/getting-started.md docs/features.md docs/faq.md docs/troubleshooting.md docs/changelog.md app/CHANGELOG.md
git commit -m "docs: the setup guide's Agents step and skills saved from Claude Desktop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Real run in a sandbox (lead only)

This spends no paid turns: it drives the built app in a sandbox home, with no assistant calls.

**Files:** none committed. Scratch files go in the session scratchpad.

- [ ] **Step 1: Build and prepare the sandbox**

From `app/`: `npm run build`. Make a sandbox folder in the scratchpad with `home\`, `appdata\Claude\`, `localappdata\`, and `home\.claude\skills\`. Copy the real `%APPDATA%\Claude\claude_desktop_config.json` to `appdata\Claude\claude_desktop_config.json`, and a second copy to `original.json` for the comparison. **Never print either file.**

- [ ] **Step 2: Start the built app on a free port**

Run in the background from `app/`, with `NODE_ENV=production`, `USERPROFILE`/`HOME` = sandbox `home`, `APPDATA` = sandbox `appdata` and `LOCALAPPDATA` = sandbox `localappdata`: `node dist/launcher.js --port 9871 --strict-port --no-open`. Open `http://127.0.0.1:9871/` in the browser pane, never a deep link.

- [ ] **Step 3: Main path**

Go through the guide: Get started → new vault in the sandbox → Tools (Claude Code found, default) → Skills → Notion Skip → Assistant Skip → **Agents**: both rows offered and ticked, the hint names `claude` → Next → Finish's list shows both new lines → Finish.

Then check, with a script that prints only booleans and key names:

- The deep compare of `appdata\Claude\claude_desktop_config.json` minus `mcpServers["skill-vault"]` against `original.json` is true.
- `claude_desktop_config.json.skill-vault.bak` is byte-equal to `original.json`.
- `mcpServers["skill-vault"].args` ends with `--client claude-desktop`.
- The sandbox vault's `skills.json` has `skill-vault` with `origin.type === "dir"`, and `home\.claude\skills\skill-vault\SKILL.md` exists.
- The log shows `skill-vault (from Skill Vault)`, `skill-vault → claude` and `Claude Desktop — connected`. The panel shows the restart line, both buttons and the vault path. **Copy install prompt**: read the clipboard in the page with `navigator.clipboard.readText()` and check it includes `it's the one skill to package`. **Download skill zip**: `skill-vault.zip` exists in the stage folder.

- [ ] **Step 4: Failure and retry**

Settings → Agent access → Disconnect Claude Desktop. Write `{ broken` into the sandbox config. Run the guide again (Settings → Run setup guide…, existing vault), with Agents → Connect ticked → Finish. Expect "Almost done", an error line under Desktop with "isn't valid JSON", and the "isn't connected yet" panel. Restore the sandbox config from `original.json`, press **Retry failed items**, and expect it done with the full panel. Repeat the compare checks from Step 3.

- [ ] **Step 5: No Desktop**

Stop the app, rename the sandbox `appdata\Claude`, start again, and run the guide to the Agents step: it shows "Claude Desktop isn't installed for this user." and still offers the skill (with a fresh new vault) or "Already in your vault." Then stop the app and delete the sandbox.

- [ ] **Step 6: Full checks**

From `app/`: `npm test` (serial if EPERM), `npm run typecheck`, `npm run build`. Record the test count for the hand-over.
