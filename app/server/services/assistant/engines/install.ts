/**
 * Installing an engine's CLI. The commands come from the engine module —
 * never from the request — and are shown to the user before they run. npm
 * steps use the npm next to the app's own node (falling back to PATH);
 * PowerShell steps run the vendor's documented one-liner with the execution
 * policy bypassed for that one process. Windows only; elsewhere the user is
 * shown the command to run.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildWindowsShellInvocation } from "../../claude/cli.ts";
import { killProcessTree } from "./exe.ts";
import { installDisplay, type AssistantEngine } from "./types.ts";

export type InstallEvent =
  | { type: "step"; index: number; label: string; display: string }
  | { type: "line"; text: string }
  | { type: "done"; ok: boolean; version?: string; message?: string };

export interface InstallDeps {
  platform: NodeJS.Platform;
  npmPath(): string | null;
  spawnLines(
    command: string,
    args: string[],
    opts: { windowsVerbatimArguments?: boolean },
    onLine: (line: string) => void,
  ): { done: Promise<number | null>; kill(): void };
}

export interface Installer {
  isRunning(): boolean;
  stop(): void;
  run(engine: AssistantEngine, onEvent: (e: InstallEvent) => void): Promise<{ ok: boolean; message?: string }>;
}

function defaultNpmPath(): string | null {
  const dirs = [path.dirname(process.execPath), ...(process.env.PATH || process.env.Path || "").split(path.delimiter)];
  for (const dir of dirs.filter(Boolean)) {
    const p = path.join(dir, "npm.cmd");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function defaultSpawnLines(command: string, args: string[], opts: { windowsVerbatimArguments?: boolean }, onLine: (l: string) => void) {
  const child = spawn(command, args, { windowsHide: true, windowsVerbatimArguments: opts.windowsVerbatimArguments });
  let pending = "";
  const feed = (chunk: unknown): void => {
    pending += String(chunk);
    let nl: number;
    while ((nl = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, nl).replace(/\r$/, "");
      pending = pending.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  };
  child.stdout?.on("data", feed);
  child.stderr?.on("data", feed);
  const done = new Promise<number | null>((resolve) => {
    child.on("error", (err) => {
      onLine(err.message);
      resolve(null);
    });
    child.on("close", (code) => {
      if (pending.trim()) onLine(pending.trim());
      resolve(code);
    });
  });
  return { done, kill: () => killProcessTree(child.pid) };
}

export function createInstaller(over: Partial<InstallDeps> = {}): Installer {
  const deps: InstallDeps = {
    platform: over.platform ?? process.platform,
    npmPath: over.npmPath ?? defaultNpmPath,
    spawnLines: over.spawnLines ?? defaultSpawnLines,
  };
  let current: { kill(): void } | null = null;
  let running = false;
  let stopped = false;

  return {
    isRunning: () => running,
    stop: () => {
      stopped = true;
      current?.kill();
    },
    async run(engine, onEvent) {
      if (deps.platform !== "win32") {
        return { ok: false, message: `Automatic install is Windows only. Run this yourself: ${engine.install.map(installDisplay).join(" && ")}` };
      }
      running = true;
      stopped = false;
      try {
        for (const [index, step] of engine.install.entries()) {
          if (stopped) return { ok: false, message: "The install was stopped." };
          onEvent({ type: "step", index, label: step.label, display: installDisplay(step) });
          let command: string;
          let args: string[];
          let verbatim = false;
          if (step.kind === "npm") {
            const npm = deps.npmPath();
            if (!npm) return { ok: false, message: "npm wasn't found. Install Node.js from nodejs.org, then try again." };
            const inv = buildWindowsShellInvocation(npm, step.args);
            command = inv.command;
            args = inv.args;
            verbatim = true;
          } else {
            command = "powershell.exe";
            args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", step.script];
          }
          const proc = deps.spawnLines(command, args, { windowsVerbatimArguments: verbatim }, (text) => onEvent({ type: "line", text }));
          current = proc;
          const code = await proc.done;
          current = null;
          if (code !== 0) return { ok: false, message: `${step.label} failed (exit code ${code ?? "none"}).` };
        }
        return { ok: true };
      } finally {
        running = false;
        current = null;
      }
    },
  };
}
