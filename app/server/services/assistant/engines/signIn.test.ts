import { test } from "node:test";
import assert from "node:assert/strict";
import { createSignInManager, powershellLoginCommand } from "./signIn.ts";
import { fakeEngine } from "./testFakes.ts";

test("powershellLoginCommand quotes every piece and sets the title", () => {
  assert.equal(
    powershellLoginCommand("Sign in to O'Brien CLI", { command: "C:\\node\\node.exe", prefixArgs: ["C:\\npm\\x.js"], label: "x" }, ["login"]),
    "$Host.UI.RawUI.WindowTitle = 'Sign in to O''Brien CLI'; & 'C:\\node\\node.exe' 'C:\\npm\\x.js' 'login'",
  );
});

test("start opens one window; a second start replaces it; cancel and timeout close it", () => {
  const opened: Array<{ title: string; command: string; closed: boolean }> = [];
  let fire: () => void = () => {};
  const m = createSignInManager({
    platform: "win32",
    openWindow: (title, command) => {
      const w = { title, command, closed: false };
      opened.push(w);
      return { close: () => (w.closed = true) };
    },
    setTimer: (fn) => {
      fire = fn;
      return { cancel: () => (fire = () => {}) };
    },
  });
  assert.deepEqual(m.start(fakeEngine(), {}), { started: true });
  assert.equal(opened[0].title, "Sign in to Fake Codex");
  assert.match(opened[0].command, /'login'$/);
  assert.equal(m.current(), "codex");
  m.start(fakeEngine(), {});
  assert.equal(opened[0].closed, true);
  m.cancel();
  assert.equal(opened[1].closed, true);
  assert.equal(m.pending(), false);
  m.start(fakeEngine(), {});
  fire();
  assert.equal(opened[2].closed, true);
  assert.equal(m.pending(), false);
});

test("start refuses an engine that isn't installed, a window that didn't open, and non-Windows", () => {
  const m = createSignInManager({ platform: "win32", openWindow: () => ({ close: () => {} }), setTimer: () => ({ cancel: () => {} }) });
  const r = m.start(fakeEngine({ target: () => null }), {});
  assert.ok("error" in r && /isn't installed/.test(r.error) && r.reason === "not_installed");
  assert.equal(m.pending(), false);
  const broken = createSignInManager({ platform: "win32", openWindow: () => ({ error: "Couldn't open the sign-in window: spawn powershell.exe ENOENT" }), setTimer: () => ({ cancel: () => {} }) });
  assert.deepEqual(broken.start(fakeEngine(), {}), { error: "Couldn't open the sign-in window: spawn powershell.exe ENOENT", reason: "spawn_failed" });
  assert.equal(broken.pending(), false);
  const mac = createSignInManager({ platform: "darwin", openWindow: () => ({ close: () => {} }), setTimer: () => ({ cancel: () => {} }) });
  assert.deepEqual(mac.start(fakeEngine(), {}), { error: 'Sign-in from the app is Windows only. Run "codex login" in a terminal.', reason: "unsupported" });
});
