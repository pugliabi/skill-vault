import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// appConfig.ts fixes the config path at import time: point HOME at a temp folder first.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sv-cfg-"));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
const file = path.join(fakeHome, ".skill-vault", "config.json");

let cfg: typeof import("./appConfig.ts");
before(async () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      vault_path: "C:\\old",
      perplexity_stage: "C:\\stage",
      machine_id: "OLD",
      repo_url: "",
      agent_locations: { claude: "C:\\c" },
      default_targets: ["claude"],
      assistant: { auth: "login", api_key: "sk-old" },
    }),
  );
  cfg = await import("./appConfig.ts");
});
after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

test("readSetupBase reads the guide's fields", () => {
  assert.deepEqual(cfg.readSetupBase(), {
    vault_path: "C:\\old",
    agent_locations: { claude: "C:\\c" },
    default_targets: ["claude"],
    machine_id: "OLD",
    repo_url: null,
  });
});

test("writeSetupConfig writes everything in one go and keeps other keys", () => {
  cfg.writeSetupConfig({
    vault_path: "C:\\new",
    providers: [{ id: "cursor", path: "C:\\u" }],
    default_targets: ["cursor"],
    repo_url: "https://github.com/me/v.git",
    machine_id: "PC2",
    assistant: { auth: "api_key", workspace_id: "wrk" },
  });
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.vault_path, "C:\\new");
  assert.deepEqual(raw.agent_locations, { cursor: "C:\\u" });
  assert.deepEqual(raw.default_targets, ["cursor"]);
  assert.equal(raw.repo_url, "https://github.com/me/v.git");
  assert.equal(raw.machine_id, "PC2");
  assert.equal(raw.perplexity_stage, "C:\\stage");
  assert.deepEqual(raw.assistant, { auth: "api_key", api_key: "sk-old", workspace_id: "wrk" });
});

test("writeSetupConfig leaves targets and assistant alone when not given", () => {
  cfg.writeSetupConfig({ vault_path: "C:\\third" });
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.vault_path, "C:\\third");
  assert.deepEqual(raw.agent_locations, { cursor: "C:\\u" });
  assert.equal(raw.assistant.auth, "api_key");
});
