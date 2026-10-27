import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyClaudeAuthPatch,
  claudeAuthStatus,
  claudeChildEnv,
  withAuthHint,
} from "./auth.ts";

const BASE = { PATH: "/bin", ANTHROPIC_API_KEY: "env-key", ANTHROPIC_AUTH_TOKEN: "tok" };

test("login mode (the default) strips API credentials so the CLI uses its own login", () => {
  for (const cfg of [{}, { auth: "login" as const, api_key: "saved", workspace_id: "w" }]) {
    const env = claudeChildEnv(cfg, BASE);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
    assert.equal(env.PATH, "/bin");
  }
  assert.equal(BASE.ANTHROPIC_API_KEY, "env-key", "the base env is never mutated");
});

test("api_key mode prefers the saved key, else the environment's", () => {
  assert.equal(claudeChildEnv({ auth: "api_key", api_key: "saved" }, BASE).ANTHROPIC_API_KEY, "saved");
  assert.equal(claudeChildEnv({ auth: "api_key" }, BASE).ANTHROPIC_API_KEY, "env-key");
});

test("api_key mode sends the workspace id as a custom header, after any existing ones", () => {
  const env = claudeChildEnv({ auth: "api_key", workspace_id: "wrkspc_1" }, BASE);
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "anthropic-workspace-id: wrkspc_1");
  const withExisting = claudeChildEnv(
    { auth: "api_key", workspace_id: "wrkspc_1" },
    { ...BASE, ANTHROPIC_CUSTOM_HEADERS: "x-a: 1" },
  );
  assert.equal(withExisting.ANTHROPIC_CUSTOM_HEADERS, "x-a: 1\nanthropic-workspace-id: wrkspc_1");
});

test("status never includes the saved key itself", () => {
  const s = claudeAuthStatus({ auth: "api_key", api_key: "secret", workspace_id: "w" }, BASE);
  assert.deepEqual(s, { auth: "api_key", has_saved_key: true, env_key_present: true, workspace_id: "w" });
  assert.ok(!JSON.stringify(s).includes("secret"));
  assert.deepEqual(claudeAuthStatus({}, { PATH: "/bin" }), {
    auth: "login",
    has_saved_key: false,
    env_key_present: false,
    workspace_id: null,
  });
});

test("patch: an omitted key keeps the saved one, an empty string clears it", () => {
  const saved = { auth: "api_key" as const, api_key: "k", workspace_id: "w" };
  assert.deepEqual(applyClaudeAuthPatch(saved, { auth: "login" }), { auth: "login", api_key: "k", workspace_id: "w" });
  assert.deepEqual(applyClaudeAuthPatch(saved, { api_key: " k2 " }), { auth: "api_key", api_key: "k2", workspace_id: "w" });
  assert.deepEqual(applyClaudeAuthPatch(saved, { api_key: "", workspace_id: "" }), { auth: "api_key" });
  assert.throws(() => applyClaudeAuthPatch(saved, { auth: "bogus" as never }), /auth must be/);
});

test("the workspace-scope API error gets a pointer to the fix", () => {
  const msg = "API Error: 400 This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header";
  assert.match(withAuthHint(msg), /Settings → AI assistant/);
  assert.equal(withAuthHint("some other failure"), "some other failure");
});
