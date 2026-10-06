import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __resetSessionsForTests,
  anyTurnCapacity,
  beginTurn,
  createSession,
  deleteSession,
  endTurn,
  getSession,
  listSessions,
  stopSession,
} from "./session.ts";

beforeEach(() => {
  // Point ~ at a fresh dir so the persisted store never leaks between tests
  // (or into the developer's real ~/.skill-vault).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-assistant-home-"));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  __resetSessionsForTests();
});

test("create → turn → list round-trips, titles from the first message, cost accumulates", () => {
  const s = createSession({ agent: "skill", skill: "pdf-tools", chips: [{ kind: "skill", id: "pdf-tools", label: "skill: pdf-tools" }] });
  assert.ok(beginTurn(s, new AbortController()));
  endTurn(s, { user: "  why   is this skill failing to update?  ", events: [{ type: "turn_end", cost_usd: 0.03 }], costUsd: 0.03 });
  endTurn(s, { user: "second", events: [], costUsd: 0.01 });

  const [summary] = listSessions();
  assert.equal(summary.title, "why is this skill failing to update?");
  assert.equal(summary.agent, "skill");
  assert.equal(summary.skill, "pdf-tools");
  assert.equal(summary.turn_count, 2);
  assert.ok(Math.abs(summary.total_cost_usd - 0.04) < 1e-9);
  assert.equal(summary.running, false);
});

test("sessions persist across a registry reload (app restart) without their run state", () => {
  const s = createSession({ agent: "vault" });
  beginTurn(s, new AbortController());
  endTurn(s, { user: "check updates", events: [{ type: "text_delta", text: "done" }] });

  __resetSessionsForTests(); // simulates restart: in-memory gone, file remains
  const reloaded = getSession(s.id);
  assert.ok(reloaded);
  assert.equal(reloaded.title, "check updates");
  assert.equal(reloaded.running, false);
  assert.deepEqual(reloaded.turns[0].events, [{ type: "text_delta", text: "done" }]);
});

test("one turn per session: beginTurn refuses while running; stop aborts", () => {
  const s = createSession({ agent: "vault" });
  const ac = new AbortController();
  assert.ok(beginTurn(s, ac));
  assert.equal(beginTurn(s, new AbortController()), false);
  assert.equal(stopSession(s.id), true);
  assert.ok(ac.signal.aborted);
  assert.equal(stopSession(s.id), true, "still flagged running until endTurn clears it");
  endTurn(s, { user: "x", events: [] });
  assert.equal(stopSession(s.id), false);
});

test("global capacity cap counts running turns across sessions", () => {
  const a = createSession({ agent: "vault" });
  const b = createSession({ agent: "vault" });
  assert.ok(anyTurnCapacity());
  beginTurn(a, new AbortController());
  assert.ok(anyTurnCapacity());
  beginTurn(b, new AbortController());
  assert.equal(anyTurnCapacity(), false);
  endTurn(a, { user: "x", events: [] });
  assert.ok(anyTurnCapacity());
});

test("deleteSession aborts a running turn and removes the record", () => {
  const s = createSession({ agent: "vault" });
  const ac = new AbortController();
  beginTurn(s, ac);
  assert.ok(deleteSession(s.id));
  assert.ok(ac.signal.aborted);
  assert.equal(getSession(s.id), undefined);
  assert.equal(deleteSession(s.id), false);
});
