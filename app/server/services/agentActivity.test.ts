import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { AGENT_CLIENT_HEADER, agentIdleMs, clientLabel, createAgentActivity } from "./agentActivity.ts";

function call(activity: ReturnType<typeof createAgentActivity>, client?: string): void {
  const req = { get: (h: string) => (h.toLowerCase() === AGENT_CLIENT_HEADER ? client : undefined) } as unknown as Request;
  let nextCalled = false;
  activity.track(req, {} as Response, (() => { nextCalled = true; }) as NextFunction);
  assert.equal(nextCalled, true);
}

test("an agent call holds activity until the window passes", () => {
  let t = 1_000;
  const a = createAgentActivity(() => t);
  assert.equal(a.within(600_000), false);
  call(a, "claude-desktop");
  t += 599_999;
  assert.equal(a.within(600_000), true);
  t += 1;
  assert.equal(a.within(600_000), false);
});

test("assistant calls and calls without the header don't count", () => {
  const a = createAgentActivity(() => 5);
  call(a, "assistant");
  call(a, undefined);
  assert.equal(a.within(600_000), false);
});

test("clientLabel names known clients and falls back", () => {
  assert.equal(clientLabel("claude-desktop"), "Claude Desktop");
  assert.equal(clientLabel("claude-code"), "Claude Code");
  assert.equal(clientLabel("command"), "a shell agent");
  assert.equal(clientLabel("something-else"), "an agent");
  assert.equal(clientLabel(undefined), "an agent");
  assert.equal(clientLabel(""), "an agent");
});

test("clientLabel ignores prototype keys from the header", () => {
  assert.equal(clientLabel("constructor"), "an agent");
  assert.equal(clientLabel("toString"), "an agent");
  assert.equal(clientLabel("__proto__"), "an agent");
});

test("agentIdleMs defaults to 10 minutes and honors SKILL_VAULT_AGENT_IDLE_MS", () => {
  const prev = process.env.SKILL_VAULT_AGENT_IDLE_MS;
  try {
    delete process.env.SKILL_VAULT_AGENT_IDLE_MS;
    assert.equal(agentIdleMs(), 600_000);
    process.env.SKILL_VAULT_AGENT_IDLE_MS = "1500";
    assert.equal(agentIdleMs(), 1500);
  } finally {
    if (prev === undefined) delete process.env.SKILL_VAULT_AGENT_IDLE_MS;
    else process.env.SKILL_VAULT_AGENT_IDLE_MS = prev;
  }
});
