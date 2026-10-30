import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyAssistantSetupPatch,
  applyEngineAuthPatch,
  engineAuth,
  isEngineId,
  selectedEngine,
  withSelectedEngine,
} from "./config.ts";

test("selectedEngine: missing or unknown → claude", () => {
  assert.equal(selectedEngine({}), "claude");
  assert.equal(selectedEngine({ engine: "codex" }), "codex");
  assert.equal(selectedEngine({ engine: "bard" as never }), "claude");
  assert.ok(isEngineId("grok") && !isEngineId("bard"));
});

test("engineAuth: Claude reads the top-level fields; others read engines.<id>, default login", () => {
  const block = { auth: "api_key" as const, api_key: "sk-ant", workspace_id: "wrk", engines: { copilot: { auth: "api_key" as const, api_key: "github_pat_x" } } };
  assert.deepEqual(engineAuth(block, "claude"), { auth: "api_key", api_key: "sk-ant", workspace_id: "wrk" });
  assert.deepEqual(engineAuth(block, "copilot"), { auth: "api_key", api_key: "github_pat_x" });
  assert.deepEqual(engineAuth(block, "grok"), { auth: "login" });
});

test("applyEngineAuthPatch: omitted keeps, empty clears, other keys untouched", () => {
  const start = { auth: "login" as const, api_key: "sk-ant", engine: "codex" as const, engines: { codex: { auth: "login" as const } } };
  const withKey = applyEngineAuthPatch(start, "codex", { auth: "api_key", api_key: "  sk-openai  " });
  assert.deepEqual(withKey.engines?.codex, { auth: "api_key", api_key: "sk-openai" });
  assert.equal(withKey.api_key, "sk-ant");
  assert.equal(withKey.engine, "codex");
  assert.deepEqual(applyEngineAuthPatch(withKey, "codex", { api_key: "" }).engines?.codex, { auth: "api_key" });
  assert.throws(() => applyEngineAuthPatch(start, "codex", { auth: "token" as never }), /auth must be/);
});

test("withSelectedEngine and applyAssistantSetupPatch keep Claude's fields intact", () => {
  assert.deepEqual(withSelectedEngine({ auth: "login" }, "grok"), { auth: "login", engine: "grok" });
  const claudeSetup = applyAssistantSetupPatch({}, { engine: "claude", auth: "api_key", api_key: "sk-ant", workspace_id: "" });
  assert.deepEqual(claudeSetup, { engine: "claude", auth: "api_key", api_key: "sk-ant" });
  const codexSetup = applyAssistantSetupPatch({ auth: "login" }, { engine: "codex", engine_auth: { auth: "api_key", api_key: "sk-o" } });
  assert.deepEqual(codexSetup, { auth: "login", engine: "codex", engines: { codex: { auth: "api_key", api_key: "sk-o" } } });
});
