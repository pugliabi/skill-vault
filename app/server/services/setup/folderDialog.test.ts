import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PickerBusyError, createFolderPicker, pickFolderInvocation } from "./folderDialog.ts";

test("the starting folder and title travel in the environment, never in the arguments", () => {
  const nasty = 'C:\\x"; Remove-Item -Recurse C:\\ ; "$(calc)';
  const inv = pickFolderInvocation("C:\\app", { title: "Pick", initial: nasty }, { SystemRoot: "C:\\Windows" });
  assert.equal(inv.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(inv.args, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", path.join("C:\\app", "scripts", "pick-folder.ps1")]);
  assert.equal(inv.env.SV_PICK_INITIAL, nasty);
  assert.equal(inv.env.SV_PICK_TITLE, "Pick");
  assert.ok(!inv.args.join(" ").includes("calc"));
});

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: null,
    kill: () => true,
  });
  return child;
}

test("returns the picked folder, or cancelled; one dialog at a time", async () => {
  const children: ReturnType<typeof fakeChild>[] = [];
  const picker = createFolderPicker({
    appRoot: "C:\\app",
    spawn: () => {
      const c = fakeChild();
      children.push(c);
      return c as never;
    },
  });
  const first = picker.pick({});
  assert.equal(picker.isOpen(), true);
  await assert.rejects(picker.pick({}), PickerBusyError);
  children[0].stdout.emit("data", Buffer.from("C:\\Users\\me\\vault"));
  children[0].emit("close", 0);
  assert.deepEqual(await first, { path: "C:\\Users\\me\\vault" });
  assert.equal(picker.isOpen(), false);

  const second = picker.pick({});
  children[1].emit("close", 0);
  assert.deepEqual(await second, { cancelled: true });

  const third = picker.pick({});
  children[2].stderr.emit("data", Buffer.from("Add-Type : boom\nmore"));
  children[2].emit("close", 1);
  await assert.rejects(third, /boom/);
});

test("a dialog left open is closed after the timeout", async () => {
  let killed = false;
  const picker = createFolderPicker({
    appRoot: "C:\\app",
    timeoutMs: 20,
    spawn: () => fakeChild() as never,
    killTree: () => {
      killed = true;
    },
  });
  assert.deepEqual(await picker.pick({}), { cancelled: true });
  assert.equal(killed, true);
});
