import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeLoginStatus, parseAuthStatus, type ClaudeRunner } from "./cli.ts";

test("parseAuthStatus reads claude auth status JSON", () => {
  assert.deepEqual(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","email":"me@example.com","orgId":"x"}'), {
    logged_in: true,
    auth_method: "claude.ai",
    email: "me@example.com",
  });
  assert.deepEqual(parseAuthStatus('{"loggedIn":false}'), { logged_in: false, auth_method: null, email: null });
  assert.equal(parseAuthStatus("Usage: claude [options]"), null);
  assert.equal(parseAuthStatus('{"something":1}'), null);
});

test("claudeLoginStatus runs `claude auth status` and tolerates failures", async () => {
  const seen: string[][] = [];
  const ok: ClaudeRunner = async (args) => {
    seen.push(args);
    return { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: "", code: 0 };
  };
  assert.deepEqual(await claudeLoginStatus(ok), { logged_in: true, auth_method: "claude.ai", email: null });
  assert.deepEqual(seen[0], ["auth", "status"]);
  const notLoggedIn: ClaudeRunner = async () => ({ stdout: '{"loggedIn":false}', stderr: "", code: 1 });
  assert.deepEqual(await claudeLoginStatus(notLoggedIn), { logged_in: false, auth_method: null, email: null });
  const broken: ClaudeRunner = async () => {
    throw new Error("spawn failed");
  };
  assert.equal(await claudeLoginStatus(broken), null);
});
