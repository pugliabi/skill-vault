import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

// The Notion store resolves ~/.skill-vault at call time: a temp HOME keeps this sandboxed.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sv-signin-"));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

let conn: typeof import("./connection.ts");
before(async () => {
  conn = await import("./connection.ts");
});
after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

const REDIRECT = "http://localhost:9994/api/notion/callback";
const needsSignIn = async (_client: unknown, provider: { redirectToAuthorization(u: URL): void }) => {
  provider.redirectToAuthorization(new URL("https://notion.example/authorize"));
  throw new UnauthorizedError("sign in");
};

test("a started sign-in is pending for at most 10 minutes", async () => {
  assert.equal(conn.notionSignInPending(), false);
  const r = await conn.startNotionAuth(REDIRECT, needsSignIn as never);
  assert.equal(r.status, "redirect");
  assert.equal(conn.notionSignInPending(), true);
  assert.equal(conn.notionSignInPending(Date.now() + 11 * 60_000), false);
  await conn.disconnectNotion();
  assert.equal(conn.notionSignInPending(), false);
});

test("finishing (even with a bad state) clears the pending flag", async () => {
  await conn.startNotionAuth(REDIRECT, needsSignIn as never);
  assert.equal(conn.notionSignInPending(), true);
  await assert.rejects(conn.finishNotionAuth(REDIRECT, "code", "wrong-state", async () => {}));
  assert.equal(conn.notionSignInPending(), false);
});
