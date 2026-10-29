/**
 * ~/.skill-vault/bin/skill-vault(.cmd): the shared command that gives any
 * agent with a shell the vault tools (the bridge's command mode, see
 * assistant-mcp/cli.ts). Rewritten at every production start so the node
 * and app paths stay current.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function shimDir(home = os.homedir()): string {
  return path.join(home, ".skill-vault", "bin");
}

export function shimContents(nodePath: string, bridgePath: string): { cmd: string; sh: string } {
  const fwd = (p: string) => p.replace(/\\/g, "/");
  return {
    cmd: `@echo off\r\n"${nodePath}" "${bridgePath}" --client command %*\r\n`,
    sh: `#!/bin/sh\nexec "${fwd(nodePath)}" "${fwd(bridgePath)}" --client command "$@"\n`,
  };
}

/** Write both shims; a file is rewritten only when its content differs. Returns the files written. */
export function writeCommandShims(nodePath: string, bridgePath: string, dir = shimDir()): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const { cmd, sh } = shimContents(nodePath, bridgePath);
  const written: string[] = [];
  for (const [file, content, executable] of [
    [path.join(dir, "skill-vault.cmd"), cmd, false],
    [path.join(dir, "skill-vault"), sh, true],
  ] as const) {
    let current: string | null = null;
    try {
      current = fs.readFileSync(file, "utf-8");
    } catch {
      /* not written yet */
    }
    if (current === content) continue;
    fs.writeFileSync(file, content, "utf-8");
    if (executable && process.platform !== "win32") fs.chmodSync(file, 0o755);
    written.push(file);
  }
  return written;
}
