/** The real dependencies of the Finish job (tests use fakes; see apply.test.ts). */
import fs from "node:fs";
import path from "node:path";
import { defaultRun } from "../appUpdate.ts";
import { readAppConfig, writeSetupConfig } from "../appConfig.ts";
import { importSkills } from "../adoption.ts";
import { pushSkillToProvider } from "../pushSkill.ts";
import { getServerPort } from "../runtime.ts";
import { initVault } from "../vault.ts";
import { rebuildWatcher } from "../watcher.ts";
import { chooseDataSource, openNotionApiAt } from "../notion/dataSource.ts";
import { deleteDraft } from "./draft.ts";
import type { SetupApplyDeps } from "./apply.ts";

export function defaultApplyDeps(home?: () => string): SetupApplyDeps {
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
    deleteDraft: () => deleteDraft(home?.()),
  };
}
