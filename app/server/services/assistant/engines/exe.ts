/**
 * Finding and running the engines' command-line tools without a shell.
 *
 * npm installs a `.cmd` shim per tool. Spawning a shim needs cmd.exe, which
 * cuts a multi-line argument at the first newline (see claude/cli.ts), so a
 * shim is resolved to what it wraps: a real `.exe`, or a node script run with
 * the app's own node. Installers update the PATH stored in the registry, not
 * the running server's, so when the process PATH and the known install
 * folders both miss, the registry PATH is searched too (two `reg query`
 * spawns, so only then). Callers remember the result per name (common.ts).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SpawnTarget {
  /** A real executable — never a .cmd/.bat, so no shell is ever involved. */
  command: string;
  /** Leading args: the script path when `command` is node. */
  prefixArgs: string[];
  /** Names the tool in errors: "codex CLI". */
  label: string;
}

export type ShimTarget = { kind: "exe"; path: string } | { kind: "node"; script: string };

/** Pure: what an npm `.cmd` shim runs. null when the text isn't a shim we understand. */
export function parseCmdShim(content: string, dir: string): ShimTarget | null {
  const expand = (p: string): string => path.resolve(p.replace(/%~?dp0%?/gi, dir + path.sep));
  const quoted = [...content.matchAll(/"([^"]+)"/g)].map((m) => m[1]).reverse();
  const script = quoted.find((q) => /\.[cm]?js$/i.test(q));
  if (script) return { kind: "node", script: expand(script) };
  const exe = quoted.find((q) => /\.exe$/i.test(q) && !/(^|[\\/=])node\.exe$/i.test(q));
  if (exe) return { kind: "exe", path: expand(exe) };
  return null;
}

/** Pure: the Path value from `reg query <key> /v Path` output, %VARS% expanded. */
export function parseRegQueryPath(stdout: string, env: NodeJS.ProcessEnv): string[] {
  const m = stdout.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im);
  if (!m) return [];
  return m[1]
    .trim()
    .replace(/%([^%]+)%/g, (all, name: string) => env[name] ?? all)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The user + machine PATH as stored right now (an install may have changed it since the app started). */
export function registryPathDirs(): string[] {
  const keys = ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"];
  return keys.flatMap((key) => {
    const r = spawnSync("reg", ["query", key, "/v", "Path"], { encoding: "utf-8", windowsHide: true });
    return r.status === 0 ? parseRegQueryPath(r.stdout, process.env) : [];
  });
}

/** Where the engines' installers put their commands when PATH doesn't say. */
export function knownInstallDirs(env: NodeJS.ProcessEnv = process.env, nodePath: string = process.execPath): string[] {
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  return [
    path.dirname(nodePath), // nvm4w and the Node installer: npm puts global shims next to node
    ...(env.APPDATA ? [path.join(env.APPDATA, "npm")] : []), // npm's default global prefix
    path.join(home, ".local", "bin"), // Claude Code's native installer
    path.join(home, ".grok", "bin"), // Grok Build's installer, per xAI's docs (unverified until Task 20)
  ];
}

export interface ResolveDeps {
  platform?: NodeJS.Platform;
  pathDirs?: () => string[];
  registryPathDirs?: () => string[];
  knownDirs?: string[];
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  /** The node that runs node-script shims. Default: the app's own. */
  nodePath?: string;
}

const processPathDirs = (): string[] =>
  (process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);

/**
 * Find `name` as something spawnable without a shell, or null when it isn't installed.
 * Order: the process PATH, the known install folders, then (Windows, only when both
 * missed) the PATH stored in the registry.
 */
export function resolveTarget(name: string, label: string, deps: ResolveDeps = {}): SpawnTarget | null {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? fs.existsSync;
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf-8"));
  const node = deps.nodePath ?? process.execPath;
  const seen = new Set<string>();

  const search = (dirs: string[]): SpawnTarget | null => {
    for (const dir of dirs) {
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (platform !== "win32") {
        const p = path.join(dir, name);
        if (exists(p)) return { command: p, prefixArgs: [], label };
        continue;
      }
      const exe = path.join(dir, `${name}.exe`);
      if (exists(exe)) return { command: exe, prefixArgs: [], label };
      const cmd = path.join(dir, `${name}.cmd`);
      if (!exists(cmd)) continue;
      let shim: ShimTarget | null = null;
      try {
        shim = parseCmdShim(readFile(cmd), dir);
      } catch {
        shim = null;
      }
      if (shim?.kind === "exe" && exists(shim.path)) return { command: shim.path, prefixArgs: [], label };
      if (shim?.kind === "node" && exists(shim.script)) return { command: node, prefixArgs: [shim.script], label };
    }
    return null;
  };

  const found = search([...(deps.pathDirs ?? processPathDirs)(), ...(deps.knownDirs ?? [])]);
  if (found || platform !== "win32") return found;
  return search((deps.registryPathDirs ?? registryPathDirs)());
}

/** Kill a process and everything it started. */
export function killProcessTree(pid: number | undefined): void {
  if (typeof pid !== "number") return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  target: SpawnTarget,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs: number; cwd?: string; stdin?: string },
) => Promise<CommandResult>;

/** Short, non-interactive calls (`--version`, `login status`). Never rejects: failures come back as code null. */
export const runCommand: CommandRunner = (target, args, opts) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (code: number | null, extra = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr + extra });
    };
    const child = spawn(target.command, [...target.prefixArgs, ...args], {
      cwd: opts.cwd ?? os.tmpdir(),
      env: opts.env,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      done(null, `\n[${target.label} timed out after ${Math.round(opts.timeoutMs / 1000)}s]`);
    }, opts.timeoutMs);
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => done(null, err.message));
    child.on("close", (code) => done(code));
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.stdin ?? "");
  });
