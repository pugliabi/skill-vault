import { test } from "node:test";
import assert from "node:assert/strict";
import { createSignInManager, powershellLoginCommand } from "./signIn.ts";
import { fakeEngine } from "./testFakes.ts";

/** What follows the login command: its exit code becomes the window's, and a failure waits for Enter. */
const EXIT_TAIL =
  "; $code = if ($null -eq $LASTEXITCODE) { 1 } else { $LASTEXITCODE }" +
  '; if ($code -ne 0) { Read-Host "Sign-in did not finish (exit code $code). Press Enter to close this window" | Out-Null }' +
  "; exit $code";

test("powershellLoginCommand quotes every piece, sets the title, and exits with the login's exit code", () => {
  assert.equal(
    powershellLoginCommand("Sign in to O'Brien CLI", { command: "C:\\node\\node.exe", prefixArgs: ["C:\\npm\\x.js"], label: "x" }, ["login"]),
    `$Host.UI.RawUI.WindowTitle = 'Sign in to O''Brien CLI'; & 'C:\\node\\node.exe' 'C:\\npm\\x.js' 'login'${EXIT_TAIL}`,
  );
});

test("powershellLoginCommand doubles curly single quotes too", () => {
  assert.equal(
    powershellLoginCommand("t", { command: "C:\\Users\\Dan\u2019s PC\\x.exe", prefixArgs: [], label: "x" }, ["login"]),
    `$Host.UI.RawUI.WindowTitle = 't'; & 'C:\\Users\\Dan\u2019\u2019s PC\\x.exe' 'login'${EXIT_TAIL}`,
  );
});

/** A window the test drives: exit(code) is the user finishing (or failing) the login. */
function scriptedWindow() {
  const w = { open: true, code: null as number | null, closes: 0 };
  return {
    w,
    exit: (code: number) => {
      w.open = false;
      w.code = code;
    },
    window: { isOpen: () => w.open, close: () => void (w.open = false, w.closes++), exitCode: () => (w.open ? null : w.code) },
  };
}

test("state: an open window, then its exit code once it exits on its own", () => {
  const s = scriptedWindow();
  const m = createSignInManager({ platform: "win32", openWindow: () => s.window, setTimer: () => ({ cancel: () => {} }) });
  assert.equal(m.state("codex"), null);
  m.start(fakeEngine(), {});
  assert.deepEqual(m.state("codex"), { open: true, exit_code: null, already_signed_in: false });
  assert.equal(m.state("copilot"), null, "another engine's sign-in isn't this one");
  s.exit(0);
  assert.deepEqual(m.state("codex"), { open: false, exit_code: 0, already_signed_in: false });
  assert.equal(m.pending(), false);
  assert.equal(m.current(), null);
  m.cancel();
  assert.equal(m.state("codex"), null, "cancel forgets it");
  assert.equal(s.w.closes, 0, "an exited window is never killed");
});

test("already signed in at start: finish() never closes the window; the exit code decides", () => {
  const ok = scriptedWindow();
  const m = createSignInManager({ platform: "win32", openWindow: () => ok.window, setTimer: () => ({ cancel: () => {} }) });
  m.start(fakeEngine(), {}, { alreadySignedIn: true });
  m.finish("codex");
  assert.equal(ok.w.closes, 0);
  assert.deepEqual(m.state("codex"), { open: true, exit_code: null, already_signed_in: true });
  ok.exit(0);
  assert.deepEqual(m.state("codex"), { open: false, exit_code: 0, already_signed_in: true });

  const failed = scriptedWindow();
  const m2 = createSignInManager({ platform: "win32", openWindow: () => failed.window, setTimer: () => ({ cancel: () => {} }) });
  m2.start(fakeEngine(), {}, { alreadySignedIn: true });
  failed.exit(1);
  assert.deepEqual(m2.state("codex"), { open: false, exit_code: 1, already_signed_in: true });
});

test("a window that exits on its own stops its timeout", () => {
  const s = scriptedWindow();
  let cancelled = 0;
  const m = createSignInManager({ platform: "win32", openWindow: () => s.window, setTimer: () => ({ cancel: () => void cancelled++ }) });
  m.start(fakeEngine(), {});
  s.exit(0);
  assert.equal(m.pending(), false);
  assert.ok(cancelled >= 1);
});

test("a window the user closed is finished: no pending, and later close/finish never kill", () => {
  let open = true;
  let kills = 0;
  const m = createSignInManager({
    platform: "win32",
    openWindow: () => ({ isOpen: () => open, close: () => void kills++ }),
    setTimer: () => ({ cancel: () => {} }),
  });
  m.start(fakeEngine(), {});
  assert.equal(m.pending(), true);
  open = false;
  assert.equal(m.pending(), false);
  assert.equal(m.current(), null);
  m.cancel();
  m.finish("codex");
  assert.equal(kills, 0);
});

test("start opens one window; a second start replaces it; cancel and timeout close it", () => {
  const opened: Array<{ title: string; command: string; closed: boolean }> = [];
  let fire: () => void = () => {};
  const m = createSignInManager({
    platform: "win32",
    openWindow: (title, command) => {
      const w = { title, command, closed: false };
      opened.push(w);
      return { isOpen: () => true, close: () => (w.closed = true) };
    },
    setTimer: (fn) => {
      fire = fn;
      return { cancel: () => (fire = () => {}) };
    },
  });
  assert.deepEqual(m.start(fakeEngine(), {}), { started: true });
  assert.equal(opened[0].title, "Sign in to Fake Codex");
  assert.match(opened[0].command, /'login'; \$code = /);
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
  const m = createSignInManager({ platform: "win32", openWindow: () => ({ isOpen: () => true, close: () => {} }), setTimer: () => ({ cancel: () => {} }) });
  const r = m.start(fakeEngine({ target: () => null }), {});
  assert.ok("error" in r && /isn't installed/.test(r.error) && r.reason === "not_installed");
  assert.equal(m.pending(), false);
  const broken = createSignInManager({ platform: "win32", openWindow: () => ({ error: "Couldn't open the sign-in window: spawn powershell.exe ENOENT" }), setTimer: () => ({ cancel: () => {} }) });
  assert.deepEqual(broken.start(fakeEngine(), {}), { error: "Couldn't open the sign-in window: spawn powershell.exe ENOENT", reason: "spawn_failed" });
  assert.equal(broken.pending(), false);
  const mac = createSignInManager({ platform: "darwin", openWindow: () => ({ isOpen: () => true, close: () => {} }), setTimer: () => ({ cancel: () => {} }) });
  assert.deepEqual(mac.start(fakeEngine(), {}), { error: 'Sign-in from the app is Windows only. Run "codex login" in a terminal.', reason: "unsupported" });
});
