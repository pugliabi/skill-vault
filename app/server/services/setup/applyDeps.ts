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
const NO_APP_ROOT_DESKTOP = "The app folder isn't known, so Claude Desktop can't be connected.";

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
      if (!appRoot) throw new Error(NO_APP_ROOT_DESKTOP);
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
