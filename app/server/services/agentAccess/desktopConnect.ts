/**
 * Claude Desktop's side of agent access: the status row and the connect.
 * Shared by Settings → Agent access (routes/agentAccess.ts) and the setup
 * guide's Finish (services/setup/applyDeps.ts).
 */
import fs from "node:fs";
import {
  bridgeEntry, desktopConfigPath, entryState, getEntry, readDesktopConfig, withEntry, writeDesktopConfig,
  type EntryState, type PathEnv,
} from "./desktopConfig.ts";

export type DesktopState = EntryState | "not_installed" | "unreadable";

export interface DesktopStatus {
  state: DesktopState;
  config_path: string | null;
  error?: string;
}

export const DESKTOP_NOT_INSTALLED = "Claude Desktop isn't installed for this user.";
export const BRIDGE_NOT_BUILT = "Build the app first: the bridge (dist/assistant-mcp.js) isn't built yet.";

export class DesktopConnectError extends Error {}

export function desktopStatus(env: PathEnv): DesktopStatus {
  const file = desktopConfigPath(env);
  if (!file) return { state: "not_installed", config_path: null };
  try {
    return { state: entryState(getEntry(readDesktopConfig(file)), (p) => fs.existsSync(p)), config_path: file };
  } catch (err) {
    return { state: "unreadable", config_path: file, error: (err as Error).message };
  }
}

/**
 * Add (or rewrite) the skill-vault MCP entry and return the file written.
 * Reads the config fresh, so a file changed since the last status still
 * gets checked (bad JSON and someone else's "skill-vault" are refused by
 * readDesktopConfig / withEntry). Other errors (disk) come through raw.
 */
export function connectDesktop(opts: { env: PathEnv; nodePath: string; bridgePath: string }): string {
  if (!fs.existsSync(opts.bridgePath)) throw new DesktopConnectError(BRIDGE_NOT_BUILT);
  const file = desktopConfigPath(opts.env);
  if (!file) throw new DesktopConnectError(DESKTOP_NOT_INSTALLED);
  writeDesktopConfig(file, withEntry(readDesktopConfig(file), bridgeEntry(opts.nodePath, opts.bridgePath, "claude-desktop")));
  return file;
}
