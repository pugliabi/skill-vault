/**
 * Typed wrapper over Notion MCP tools. Every tool call goes through a
 * ToolCaller so tests can inject a fake; parsers are pure.
 */
import type { NotionCacheRow } from "./store.ts";

export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<any>;

export function pageIdFromUrl(url: string): string {
  const base = url.split(/[?#]/)[0];
  const hex = base.replace(/-/g, "").match(/[0-9a-f]{32}(?=[^0-9a-f]*$)/i)?.[0];
  if (!hex) throw new Error(`no page id in ${url}`);
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function parseParentDataSource(text: string): { url: string; id: string; name: string } | null {
  const m = /<parent-data-source url="(collection:\/\/([0-9a-f-]+))" name="([^"]*)"\s*\/>/i.exec(text);
  return m ? { url: m[1], id: m[2], name: m[3] } : null;
}

export function parseSchemaProperties(text: string): Record<string, { type: string }> {
  const m = /<data-source-state>\s*([\s\S]*?)\s*<\/data-source-state>/.exec(text);
  if (!m) return {};
  try {
    const state = JSON.parse(m[1]);
    return (state?.schema ?? {}) as Record<string, { type: string }>;
  } catch {
    return {};
  }
}

function jsonArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string" || !v.trim()) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function rowFromSql(r: Record<string, unknown>, lastEditedProp: string | null): NotionCacheRow {
  const row: NotionCacheRow = {
    page_id: pageIdFromUrl(typeof r.url === "string" ? r.url : ""),
    title: String(r["Skill name"] ?? ""),
    description: String(r.Description ?? ""),
    tags: jsonArray(r.Tags).map(String),
    has_files: jsonArray(r.Files).length > 0,
  };
  if (lastEditedProp && typeof r[lastEditedProp] === "string") row.edited_at = r[lastEditedProp] as string;
  return row;
}

const PAGE_SIZE = 100;
/** Hard stop for listRows: 100 pages × 100 rows. */
const MAX_PAGES = 100;

/** notion-fetch marks a page with no content with this tag (verified against a real blank page). */
export const BLANK_PAGE_MARKER = "<blank-page>";

export class NotionApi {
  constructor(private readonly call: ToolCaller) {}

  async searchSkills(): Promise<Array<{ name: string; url: string }>> {
    const r = await this.call("notion-search-skills", {});
    return (r?.results ?? []).map((x: any) => ({ name: String(x.name), url: String(x.url) }));
  }

  async fetch(idOrUrl: string): Promise<{ text: string; page_last_edited_at?: string; title?: string }> {
    const r = await this.call("notion-fetch", { id: idOrUrl });
    return { text: String(r?.text ?? ""), page_last_edited_at: r?.page_last_edited_at, title: r?.title };
  }

  /**
   * True when Notion reports the page as blank (no content at all). Note that
   * download-skill still succeeds on such a page, so this is the only
   * reliable "empty page" signal; callers also require the row's has_files
   * to be false.
   */
  async isBlankPage(pageId: string): Promise<boolean> {
    return (await this.fetch(pageId)).text.includes(BLANK_PAGE_MARKER);
  }

  async detectSkillsDataSources(): Promise<Array<{ id: string; name: string }>> {
    const found = new Map<string, string>();
    for (const s of (await this.searchSkills()).slice(0, 10)) {
      const parent = parseParentDataSource((await this.fetch(s.url)).text);
      if (parent) found.set(parent.id, parent.name);
    }
    return [...found].map(([id, name]) => ({ id, name }));
  }

  async hasProperty(dataSourceId: string, name: string, type: string): Promise<boolean> {
    const props = parseSchemaProperties((await this.fetch(`collection://${dataSourceId}`)).text);
    return props[name]?.type === type;
  }

  async listRows(dataSourceId: string, lastEditedProp: string | null): Promise<NotionCacheRow[]> {
    const table = `collection://${dataSourceId}`;
    const cols = ['url', '"Skill name"', '"Description"', '"Tags"', '"Files"'];
    if (lastEditedProp) cols.push(`"${lastEditedProp.replace(/"/g, '""')}"`);
    const out: NotionCacheRow[] = [];
    let prevFirstUrl: unknown;
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const r = await this.call("notion-query-data-sources", {
        data: {
          data_source_urls: [table],
          query: `SELECT ${cols.join(", ")} FROM "${table}" ORDER BY url LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
        },
      });
      if (!Array.isArray(r?.results)) {
        throw new Error(`notion-query-data-sources returned no results array for ${table}`);
      }
      const results = r.results as Record<string, unknown>[];
      // A server that ignores OFFSET would return the same page forever.
      if (page > 0 && results.length > 0 && results[0]?.url === prevFirstUrl) break;
      prevFirstUrl = results[0]?.url;
      for (const x of results) {
        try {
          out.push(rowFromSql(x, lastEditedProp));
        } catch (err) {
          console.warn(`[notion] skipping row without a usable url: ${(err as Error).message}`);
        }
      }
      if (results.length < PAGE_SIZE) break;
    }
    return out;
  }

  async downloadSkill(pageId: string): Promise<{ versionId: string; url: string }> {
    const r = await this.call("notion-download-skill", { id: pageId });
    if (!r?.version_id || !r?.url) throw new Error(`download-skill returned no archive for ${pageId}`);
    return { versionId: String(r.version_id), url: String(r.url) };
  }

  async addLastEditedProperty(dataSourceId: string, name: string): Promise<void> {
    await this.call("notion-update-data-source", {
      data_source_id: dataSourceId,
      statements: `ADD COLUMN "${name.replace(/"/g, '""')}" LAST_EDITED_TIME`,
    });
  }

  async prepareUpload(
    pageId: string,
    contentLength: number,
    crc32Base64: string,
  ): Promise<{ uploadUrl: string; headers: Record<string, string>; token: string; method: string }> {
    const r = await this.call("notion-upload-skill", {
      action: "prepare",
      page_id: pageId,
      content_length: contentLength,
      checksum_crc32: crc32Base64,
    });
    const uploadUrl = r?.upload_url ?? r?.uploadUrl;
    const rawHeaders = r?.upload_headers ?? r?.uploadHeaders;
    const token = r?.upload_token ?? r?.uploadToken;
    const method = String(r?.upload_method ?? r?.uploadMethod ?? "PUT");
    if (!uploadUrl || !rawHeaders || !token) {
      throw new Error(`notion-upload-skill prepare returned no upload details for ${pageId}`);
    }
    return { uploadUrl: String(uploadUrl), headers: normalizeHeaders(rawHeaders), token: String(token), method };
  }

  async completeUpload(pageId: string, token: string): Promise<void> {
    await this.call("notion-upload-skill", { action: "complete", page_id: pageId, upload_token: token });
  }

  async createSkillPage(dataSourceId: string, name: string, description: string): Promise<string> {
    const r = await this.call("notion-create-pages", {
      parent: { data_source_id: dataSourceId },
      pages: [{ properties: { "Skill name": name, Description: description }, is_skill: true }],
    });
    const url = findFirstUrl(r);
    if (url) return pageIdFromUrl(url);
    const id = findFirstBareId(r);
    if (id) return pageIdFromUrl(id);
    throw new Error(`no page id in notion-create-pages result for ${name}`);
  }

  async setTitle(pageId: string, title: string): Promise<void> {
    await this.call("notion-update-page", {
      page_id: pageId,
      command: "update_properties",
      properties: { "Skill name": title },
    });
  }
}

/**
 * Notion's `upload_headers` may be a plain object or an array of
 * `{name, value}` pairs (the real API shape). Normalize either to a
 * `Record<string,string>`.
 */
function normalizeHeaders(raw: unknown): Record<string, string> {
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const entry of raw) {
      if (entry && typeof entry === "object" && "name" in entry && "value" in entry) {
        out[String((entry as { name: unknown }).name)] = String((entry as { value: unknown }).value);
      }
    }
    return out;
  }
  if (raw && typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v);
    return out;
  }
  return {};
}

/** Depth-first search of a JSON-ish value for the first notion.so/notion.com URL. */
function findFirstUrl(value: unknown): string | null {
  if (typeof value === "string") {
    const m = /https?:\/\/[^\s"'<>]*notion\.(?:so|com)[^\s"'<>]*/i.exec(value);
    return m ? m[0] : null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findFirstUrl(v);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) {
      const found = findFirstUrl(v);
      if (found) return found;
    }
  }
  return null;
}

/** Depth-first search of a JSON-ish value for the first standalone 32-hex id. */
function findFirstBareId(value: unknown): string | null {
  if (typeof value === "string") {
    const m = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i.exec(value);
    return m ? m[0] : null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findFirstBareId(v);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) {
      const found = findFirstBareId(v);
      if (found) return found;
    }
  }
  return null;
}
