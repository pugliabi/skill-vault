import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-nconn-"));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
});

async function fakeNotion(tools: Record<string, (args: any) => any>) {
  const server = new McpServer({ name: "fake", version: "1" });
  for (const [name, fn] of Object.entries(tools)) {
    server.tool(name, async (args: any) => fn(args));
  }
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(ct);
  return client;
}

test("callToolJson parses JSON text content and surfaces isError", async () => {
  const { callToolJson } = await import("./connection.ts");
  const client = await fakeNotion({
    ok: () => ({ content: [{ type: "text", text: JSON.stringify({ a: 1 }) }] }),
    plain: () => ({ content: [{ type: "text", text: "hello" }] }),
    bad: () => ({ isError: true, content: [{ type: "text", text: "nope" }] }),
  });
  assert.deepEqual(await callToolJson(client, "ok", {}), { a: 1 });
  assert.deepEqual(await callToolJson(client, "plain", {}), { text: "hello" });
  await assert.rejects(callToolJson(client, "bad", {}), /nope/);
});

test("missingTools reports required tools the server lacks", async () => {
  const { missingTools, REQUIRED_TOOLS } = await import("./connection.ts");
  const client = await fakeNotion({ "notion-fetch": () => ({ content: [] }) });
  const missing = await missingTools(client);
  assert.deepEqual(missing, REQUIRED_TOOLS.filter((t) => t !== "notion-fetch"));
});

test("auth provider persists client info, verifier, tokens and pending URL", async () => {
  const { createNotionAuthProvider } = await import("./oauth.ts");
  const { readNotionAuth } = await import("./store.ts");
  const p = createNotionAuthProvider("http://localhost:5174/api/notion/callback");
  assert.equal(await p.clientInformation(), undefined);
  await p.saveClientInformation!({ client_id: "c1" } as any);
  await p.saveCodeVerifier("ver");
  await p.saveTokens({ access_token: "a", token_type: "bearer", refresh_token: "r" } as any);
  await p.redirectToAuthorization(new URL("https://example.test/auth?x=1"));
  const again = createNotionAuthProvider("http://localhost:5174/api/notion/callback");
  assert.equal((await again.clientInformation())?.client_id, "c1");
  assert.equal(await again.codeVerifier(), "ver");
  assert.equal((await again.tokens())?.access_token, "a");
  assert.equal(p.pendingAuthUrl(), "https://example.test/auth?x=1");
  assert.equal(readNotionAuth().redirect_url, "http://localhost:5174/api/notion/callback");
  assert.deepEqual(p.clientMetadata.redirect_uris, ["http://localhost:5174/api/notion/callback"]);
  assert.equal(p.clientMetadata.token_endpoint_auth_method, "none");
});

test("a redirect URL mismatch keeps tokens and client info (refresh needs the client_id)", async () => {
  const { createNotionAuthProvider } = await import("./oauth.ts");
  const p = createNotionAuthProvider("http://localhost:5174/api/notion/callback");
  await p.saveClientInformation!({ client_id: "c1" } as any);
  await p.saveTokens({ access_token: "a", token_type: "bearer", refresh_token: "r" } as any);
  const q = createNotionAuthProvider("http://localhost:5199/api/notion/callback");
  assert.equal((await q.clientInformation())?.client_id, "c1");
  assert.equal((await q.tokens())?.refresh_token, "r");
  // Saving refreshed tokens under the new port does not rewrite the registration's redirect.
  await q.saveTokens({ access_token: "b", token_type: "bearer", refresh_token: "r2" } as any);
  const { readNotionAuth } = await import("./store.ts");
  assert.equal(readNotionAuth().redirect_url, "http://localhost:5174/api/notion/callback");
});

test("registrationNeedsReset only for a registration made for another redirect", async () => {
  const { registrationNeedsReset } = await import("./oauth.ts");
  const url = "http://localhost:5174/api/notion/callback";
  assert.equal(registrationNeedsReset({}, url), false);
  assert.equal(registrationNeedsReset({ tokens: { access_token: "a" } }, url), false);
  assert.equal(registrationNeedsReset({ client_information: { client_id: "c" }, redirect_url: url }, url), false);
  assert.equal(
    registrationNeedsReset({ client_information: { client_id: "c" }, redirect_url: "http://localhost:5199/api/notion/callback" }, url),
    true,
  );
  assert.equal(registrationNeedsReset({ client_information: { client_id: "c" } }, url), true);
});

test("startNotionAuth clears a mismatched registration (keeps tokens) before connecting", async () => {
  const { startNotionAuth } = await import("./connection.ts");
  const { readNotionAuth, writeNotionAuth } = await import("./store.ts");
  writeNotionAuth({
    redirect_url: "http://localhost:5199/api/notion/callback",
    client_information: { client_id: "old" },
    code_verifier: "v",
    state: "s",
    tokens: { access_token: "a" },
  });
  let seen: unknown = "not called";
  const r = await startNotionAuth("http://localhost:5174/api/notion/callback", async (_client, provider) => {
    seen = await provider.clientInformation();
  });
  assert.deepEqual(r, { status: "connected" });
  assert.equal(seen, undefined);
  const a = readNotionAuth();
  assert.equal(a.client_information, undefined);
  assert.equal(a.code_verifier, undefined);
  assert.equal(a.state, undefined);
  assert.deepEqual(a.tokens, { access_token: "a" });
  assert.equal(a.redirect_url, "http://localhost:5174/api/notion/callback");
});

test("startNotionAuth keeps a registration made for the same redirect", async () => {
  const { startNotionAuth } = await import("./connection.ts");
  const { readNotionAuth, writeNotionAuth } = await import("./store.ts");
  const url = "http://localhost:5174/api/notion/callback";
  writeNotionAuth({ redirect_url: url, client_information: { client_id: "keep" } });
  await startNotionAuth(url, async () => {});
  assert.deepEqual(readNotionAuth().client_information, { client_id: "keep" });
});

test("finishNotionAuth clears state on success and on failure", async () => {
  const { finishNotionAuth } = await import("./connection.ts");
  const { readNotionAuth, writeNotionAuth } = await import("./store.ts");
  const url = "http://localhost:5174/api/notion/callback";

  writeNotionAuth({ state: "s1", client_information: { client_id: "c" } });
  let code = "";
  await finishNotionAuth(url, "the-code", "s1", async (_p, c) => {
    code = c;
  });
  assert.equal(code, "the-code");
  assert.equal(readNotionAuth().state, undefined);

  writeNotionAuth({ state: "s2" });
  await assert.rejects(finishNotionAuth(url, "c", "wrong", async () => {}), /state mismatch/);
  assert.equal(readNotionAuth().state, undefined);

  writeNotionAuth({ state: "s3" });
  await assert.rejects(
    finishNotionAuth(url, "c", "s3", async () => {
      throw new Error("exchange failed");
    }),
    /exchange failed/,
  );
  assert.equal(readNotionAuth().state, undefined);
});

test("getNotionClient drops tokens (keeps client info) when refresh is impossible", async () => {
  const { getNotionClient, NotionNotConnectedError } = await import("./connection.ts");
  const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");
  const { readNotionAuth, writeNotionAuth } = await import("./store.ts");
  writeNotionAuth({ client_information: { client_id: "c" }, tokens: { access_token: "a", refresh_token: "r" } });
  await assert.rejects(
    getNotionClient("http://localhost:5174/api/notion/callback", async () => {
      throw new UnauthorizedError("expired");
    }),
    (err) => err instanceof NotionNotConnectedError,
  );
  const a = readNotionAuth();
  assert.equal(a.tokens, undefined);
  assert.deepEqual(a.client_information, { client_id: "c" });
});

test("getNotionClient keeps tokens on non-auth errors", async () => {
  const { getNotionClient } = await import("./connection.ts");
  const { readNotionAuth, writeNotionAuth } = await import("./store.ts");
  writeNotionAuth({ tokens: { access_token: "a" } });
  await assert.rejects(
    getNotionClient("http://localhost:5174/api/notion/callback", async () => {
      throw new Error("network down");
    }),
    /network down/,
  );
  assert.deepEqual(readNotionAuth().tokens, { access_token: "a" });
});

test("state is generated, persisted and returned", async () => {
  const { createNotionAuthProvider } = await import("./oauth.ts");
  const { readNotionAuth } = await import("./store.ts");
  const p = createNotionAuthProvider("http://localhost:5174/api/notion/callback");
  const s = await p.state!();
  assert.match(s, /^[a-f0-9]{32}$/);
  assert.equal(readNotionAuth().state, s);
});
