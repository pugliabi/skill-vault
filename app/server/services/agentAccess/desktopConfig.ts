/**
 * Claude Desktop's MCP config (claude_desktop_config.json): find it, and
 * add or remove the "skill-vault" server entry that runs this app's bridge.
 *
 * withEntry / withoutEntry are pure (config in → config out); every key
 * other than mcpServers["skill-vault"] comes back exactly as parsed.
 * readDesktopConfig / writeDesktopConfig do the disk work, with a backup
 * and an atomic rename.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SERVER_NAME = "skill-vault";
const CONFIG_FILE = "claude_desktop_config.json";

export type JsonObject = Record<string, unknown>;

export interface McpEntry {
  command: string;
  args: string[];
}

export interface PathEnv {
  platform: NodeJS.Platform;
  appData?: string;
  localAppData?: string;
  home: string;
  exists: (p: string) => boolean;
  list: (dir: string) => string[];
}

export function realPathEnv(): PathEnv {
  return {
    platform: process.platform,
    appData: process.env.APPDATA,
    localAppData: process.env.LOCALAPPDATA,
    home: os.homedir(),
    exists: (p) => fs.existsSync(p),
    list: (dir) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
  };
}

/** The config file Claude Desktop reads, or null when Claude Desktop isn't installed for this user. */
export function desktopConfigPath(env: PathEnv): string | null {
  if (env.platform === "win32") {
    if (env.appData && env.exists(path.join(env.appData, "Claude"))) {
      return path.join(env.appData, "Claude", CONFIG_FILE);
    }
    if (env.localAppData) {
      const packages = path.join(env.localAppData, "Packages");
      for (const name of env.list(packages)) {
        if (!name.startsWith("Claude_")) continue;
        const dir = path.join(packages, name, "LocalCache", "Roaming", "Claude");
        if (env.exists(dir)) return path.join(dir, CONFIG_FILE);
      }
    }
    return null;
  }
  if (env.platform === "darwin") {
    const dir = path.join(env.home, "Library", "Application Support", "Claude");
    return env.exists(dir) ? path.join(dir, CONFIG_FILE) : null;
  }
  return null;
}

export function bridgeEntry(nodePath: string, bridgePath: string, client: string): McpEntry {
  return { command: nodePath, args: [bridgePath, "--client", client] };
}

/** True when the entry runs a Skill Vault bridge (from any install location). */
export function isOurEntry(entry: unknown): boolean {
  const args = (entry as { args?: unknown } | null | undefined)?.args;
  return Array.isArray(args) && typeof args[0] === "string" && args[0].replace(/\\/g, "/").endsWith("dist/assistant-mcp.js");
}

export type EntryState = "not_connected" | "connected" | "broken" | "name_taken";

export function entryState(entry: unknown, exists: (p: string) => boolean): EntryState {
  if (entry === undefined) return "not_connected";
  if (!isOurEntry(entry)) return "name_taken";
  const e = entry as McpEntry;
  return exists(e.command) && exists(e.args[0]) ? "connected" : "broken";
}

export class DesktopConfigError extends Error {}

function serversOf(config: JsonObject): JsonObject | undefined {
  const s = config.mcpServers;
  if (s === undefined) return undefined;
  if (s === null || typeof s !== "object" || Array.isArray(s)) {
    throw new DesktopConfigError("mcpServers in the Claude Desktop config isn't an object");
  }
  return s as JsonObject;
}

export function getEntry(config: JsonObject): unknown {
  return serversOf(config)?.[SERVER_NAME];
}

export function withEntry(config: JsonObject, entry: McpEntry): JsonObject {
  const servers = serversOf(config);
  const existing = servers?.[SERVER_NAME];
  if (existing !== undefined && !isOurEntry(existing)) {
    throw new DesktopConfigError(`Claude Desktop already has an MCP server named "${SERVER_NAME}" that isn't from Skill Vault`);
  }
  return { ...config, mcpServers: { ...(servers ?? {}), [SERVER_NAME]: entry } };
}

export function withoutEntry(config: JsonObject): JsonObject {
  const servers = serversOf(config);
  if (!servers || !isOurEntry(servers[SERVER_NAME])) return config;
  const rest = { ...servers };
  delete rest[SERVER_NAME];
  return { ...config, mcpServers: rest };
}

/** Parse the config. A missing or empty file is {}; anything but a JSON object throws. */
export function readDesktopConfig(file: string): JsonObject {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new DesktopConfigError(`Couldn't read ${file}: ${(err as Error).message}`);
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new DesktopConfigError(`${file} isn't valid JSON (${(err as Error).message}). Fix it, then try again.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DesktopConfigError(`${file} doesn't hold a JSON object`);
  }
  return parsed as JsonObject;
}

/** Copy the current file to <file>.skill-vault.bak, then write through a temp file and rename. */
export function writeDesktopConfig(file: string, config: JsonObject): void {
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.skill-vault.bak`);
    } catch (err) {
      throw new DesktopConfigError(`Couldn't back up ${file}: ${(err as Error).message}`);
    }
  }
  const tmp = `${file}.skill-vault.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}
