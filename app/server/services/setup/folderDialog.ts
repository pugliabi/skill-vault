/**
 * The Windows "Select folder" dialog for the setup guide's Browse buttons:
 * runs scripts/pick-folder.ps1 (modern IFileOpenDialog, top-most owner).
 * The title and starting folder go through environment variables so no path
 * is ever pasted into PowerShell code. One dialog at a time; a dialog left
 * open is closed after 10 minutes.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { defaultKillTree, type ChildProcessLike } from "../claude/cli.ts";

export interface PickFolderOptions {
  title?: string;
  initial?: string;
}

export type PickResult = { path: string } | { cancelled: true };

export class PickerBusyError extends Error {}

export function pickFolderInvocation(
  appRoot: string,
  opts: PickFolderOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const systemRoot = baseEnv.SystemRoot ?? baseEnv.SYSTEMROOT ?? "C:\\Windows";
  return {
    file: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", path.join(appRoot, "scripts", "pick-folder.ps1")],
    env: { ...baseEnv, SV_PICK_TITLE: opts.title ?? "Select a folder", SV_PICK_INITIAL: opts.initial ?? "" },
  };
}

type SpawnLike = (
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; windowsHide: boolean; stdio: ["ignore", "pipe", "pipe"] },
) => ChildProcessLike;

export interface FolderPicker {
  isOpen(): boolean;
  pick(opts: PickFolderOptions): Promise<PickResult>;
}

export function createFolderPicker(deps: {
  appRoot: string;
  spawn?: SpawnLike;
  killTree?: (child: ChildProcessLike) => void;
  timeoutMs?: number;
}): FolderPicker {
  const spawnFn: SpawnLike = deps.spawn ?? ((f, a, o) => spawn(f, a, o) as unknown as ChildProcessLike);
  let open = false;
  return {
    isOpen: () => open,
    pick(opts) {
      if (open) return Promise.reject(new PickerBusyError("A folder dialog is already open."));
      open = true;
      const inv = pickFolderInvocation(deps.appRoot, opts);
      let child: ChildProcessLike;
      try {
        child = spawnFn(inv.file, inv.args, { env: inv.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        // A synchronous spawn failure (e.g. a NUL byte in an env value) must not leave the picker stuck open.
        open = false;
        return Promise.reject(err);
      }
      return new Promise<PickResult>((resolve, reject) => {
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          open = false;
          fn();
        };
        const timer = setTimeout(() => {
          (deps.killTree ?? defaultKillTree)(child);
          settle(() => resolve({ cancelled: true }));
        }, deps.timeoutMs ?? 10 * 60_000);
        child.stdout?.on("data", (d) => out.push(Buffer.from(d as Buffer)));
        child.stderr?.on("data", (d) => err.push(Buffer.from(d as Buffer)));
        child.on("error", (e) => settle(() => reject(e)));
        child.on("close", (code) =>
          settle(() => {
            const picked = Buffer.concat(out).toString("utf8").trim();
            if (code === 0) resolve(picked ? { path: picked } : { cancelled: true });
            else reject(new Error(Buffer.concat(err).toString("utf8").trim().split(/\r?\n/)[0] || `folder dialog failed (exit ${code})`));
          }),
        );
      });
    },
  };
}
