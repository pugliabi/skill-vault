/**
 * Notion sync storage.
 *   <vault>/notion.json                 shared settings (committed with the vault)
 *   ~/.skill-vault/notion-auth.json     OAuth client + tokens (per machine, never in git)
 *   ~/.skill-vault/notion-cache.json    last known Notion-side state (per machine)
 * Home is resolved at call time so tests (and sandboxes) can override it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readManifest, writeManifest } from "../vault.ts";
import type { NotionLink } from "../../types/vault.ts";

export interface NotionSettings {
  data_source_id?: string;
  data_source_name?: string;
  /** Name of the last-edited-time property; null = user declined / not available. */
  last_edited_property?: string | null;
  linked_at?: string;
  [key: string]: unknown;
}

export interface NotionAuthFile {
  redirect_url?: string;
  client_information?: unknown;
  tokens?: unknown;
  code_verifier?: string;
  state?: string;
}

export interface NotionCacheRow {
  page_id: string;
  title: string;
  description: string;
  tags: string[];
  has_files: boolean;
  edited_at?: string;
  version_id?: string;
}

export interface NotionCache {
  checked_at?: string;
  data_source_id?: string;
  rows: NotionCacheRow[];
}

function homeDir(): string {
  return path.join(os.homedir(), ".skill-vault");
}

function readJson<T>(abs: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(abs: string, data: unknown): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, abs);
}

export function readNotionSettings(vaultPath: string): NotionSettings {
  return readJson<NotionSettings>(path.join(vaultPath, "notion.json"), {});
}

export function writeNotionSettings(vaultPath: string, s: NotionSettings): void {
  const existing = readNotionSettings(vaultPath);
  const merged = { ...existing, ...s };
  writeJson(path.join(vaultPath, "notion.json"), merged);
}

const authPath = () => path.join(homeDir(), "notion-auth.json");
const cachePath = () => path.join(homeDir(), "notion-cache.json");

export function readNotionAuth(): NotionAuthFile {
  return readJson<NotionAuthFile>(authPath(), {});
}

export function writeNotionAuth(a: NotionAuthFile): void {
  writeJson(authPath(), a);
}

export function clearNotionAuth(): void {
  fs.rmSync(authPath(), { force: true });
}

export function readNotionCache(): NotionCache {
  const c = readJson<NotionCache>(cachePath(), { rows: [] });
  return Array.isArray(c.rows) ? c : { rows: [] };
}

export function writeNotionCache(c: NotionCache): void {
  writeJson(cachePath(), c);
}

export function setNotionLink(vaultPath: string, skill: string, link: NotionLink | undefined): void {
  const manifest = readManifest(vaultPath);
  const entry = manifest.skills[skill];
  if (!entry) throw new Error(`skill "${skill}" is not in skills.json`);
  if (link) entry.notion = link;
  else delete entry.notion;
  writeManifest(vaultPath, manifest);
}
