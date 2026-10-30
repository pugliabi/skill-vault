import { test } from "node:test";
import assert from "node:assert/strict";
import { createInstaller, type InstallEvent } from "./install.ts";
import { fakeEngine } from "./testFakes.ts";

function fakeSpawn(code: number | null, lines: string[] = ["added 1 package"]) {
  const calls: Array<{ command: string; args: string[]; verbatim: boolean }> = [];
  return {
    calls,
    spawnLines: (command: string, args: string[], opts: { windowsVerbatimArguments?: boolean }, onLine: (l: string) => void) => {
      calls.push({ command, args, verbatim: opts.windowsVerbatimArguments === true });
      for (const l of lines) onLine(l);
      return { done: Promise.resolve(code), kill: () => {} };
    },
  };
}

test("npm steps run the npm next to node through cmd, streaming each line", async () => {
  const sp = fakeSpawn(0);
  const inst = createInstaller({ platform: "win32", npmPath: () => "C:\\nvm4w\\nodejs\\npm.cmd", spawnLines: sp.spawnLines });
  const events: InstallEvent[] = [];
  const r = await inst.run(fakeEngine(), (e) => events.push(e));
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(events.slice(0, 2), [
    { type: "step", index: 0, label: "Install Fake", display: "npm install -g fake" },
    { type: "line", text: "added 1 package" },
  ]);
  assert.match(sp.calls[0].command, /cmd\.exe$/i);
  assert.ok(sp.calls[0].verbatim);
  // cmd.exe escaping turns each quote into ^" — match the words, not the quoting.
  assert.match(sp.calls[0].args.at(-1) ?? "", /npm\.cmd.*install.*-g.*fake/);
});

test("PowerShell steps run the vendor one-liner with -ExecutionPolicy Bypass for that process", async () => {
  const sp = fakeSpawn(0);
  const inst = createInstaller({ platform: "win32", npmPath: () => null, spawnLines: sp.spawnLines });
  const engine = fakeEngine({ install: [{ kind: "powershell", label: "Install Grok", script: "irm https://x.ai/cli/install.ps1 | iex", source: "x.ai" }] });
  await inst.run(engine, () => {});
  assert.deepEqual(sp.calls[0], {
    command: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://x.ai/cli/install.ps1 | iex"],
    verbatim: false,
  });
});

test("failures: a non-zero exit, no npm, not Windows", async () => {
  const fail = createInstaller({ platform: "win32", npmPath: () => "npm.cmd", spawnLines: fakeSpawn(1).spawnLines });
  assert.deepEqual(await fail.run(fakeEngine(), () => {}), { ok: false, message: "Install Fake failed (exit code 1)." });
  const noNpm = createInstaller({ platform: "win32", npmPath: () => null, spawnLines: fakeSpawn(0).spawnLines });
  assert.match((await noNpm.run(fakeEngine(), () => {})).message ?? "", /npm wasn't found/);
  const mac = createInstaller({ platform: "darwin", npmPath: () => "npm", spawnLines: fakeSpawn(0).spawnLines });
  assert.match((await mac.run(fakeEngine(), () => {})).message ?? "", /Windows only.*npm install -g fake/);
});

test("stop() between steps keeps the next step from starting", async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const inst = createInstaller({
    platform: "win32",
    npmPath: () => "npm.cmd",
    spawnLines: (command) => {
      calls.push(command);
      return { done: new Promise<number>((r) => (finish = () => r(0))), kill: () => {} };
    },
  });
  const engine = fakeEngine({
    install: [
      { kind: "npm", label: "One", args: ["install", "-g", "a"], source: "npmjs.com" },
      { kind: "npm", label: "Two", args: ["install", "-g", "b"], source: "npmjs.com" },
    ],
  });
  const p = inst.run(engine, () => {});
  inst.stop();
  finish();
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1, "step two never spawned");
});
