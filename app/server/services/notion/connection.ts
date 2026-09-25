import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { createNotionAuthProvider, resetRegistrationIfRedirectChanged } from "./oauth.ts";
import { clearNotionAuth, readNotionAuth, writeNotionAuth } from "./store.ts";

export const NOTION_MCP_URL = "https://mcp.notion.com/mcp";
export const REQUIRED_TOOLS = [
  "notion-fetch",
  "notion-search-skills",
  "notion-query-data-sources",
  "notion-download-skill",
  "notion-update-data-source",
] as const;

export class NotionNotConnectedError extends Error {
  constructor() {
    super("Notion is not connected — connect it in Settings");
  }
}

function newClient(): Client {
  return new Client({ name: "skill-vault", version: "1.0.0" });
}

/** Connect `client` to Notion's MCP server (injectable so tests never hit the network). */
export type NotionConnector = (client: Client, provider: OAuthClientProvider) => Promise<void>;

const connectToNotion: NotionConnector = (client, provider) =>
  client.connect(new StreamableHTTPClientTransport(new URL(NOTION_MCP_URL), { authProvider: provider }));

/** Exchange the authorization code (injectable for tests). */
export type NotionAuthFinisher = (provider: OAuthClientProvider, code: string) => Promise<void>;

const finishWithNotion: NotionAuthFinisher = async (provider, code) => {
  const transport = new StreamableHTTPClientTransport(new URL(NOTION_MCP_URL), { authProvider: provider });
  try {
    await transport.finishAuth(code);
  } finally {
    await transport.close().catch(() => {});
  }
};

function clearState(): void {
  const auth = readNotionAuth();
  if (!("state" in auth)) return;
  const { state: _s, ...rest } = auth;
  writeNotionAuth(rest);
}

export async function startNotionAuth(
  redirectUrl: string,
  connect: NotionConnector = connectToNotion,
): Promise<{ status: "connected" } | { status: "redirect"; url: string }> {
  resetRegistrationIfRedirectChanged(redirectUrl);
  const provider = createNotionAuthProvider(redirectUrl);
  const client = newClient();
  try {
    await connect(client, provider);
    await client.close();
    return { status: "connected" };
  } catch (err) {
    const url = provider.pendingAuthUrl();
    if (err instanceof UnauthorizedError && url) return { status: "redirect", url };
    throw err;
  }
}

export async function finishNotionAuth(
  redirectUrl: string,
  code: string,
  state: string | undefined,
  finish: NotionAuthFinisher = finishWithNotion,
): Promise<void> {
  try {
    const saved = readNotionAuth().state;
    if (!saved || state !== saved) throw new Error("Notion sign-in state mismatch — start again");
    await finish(createNotionAuthProvider(redirectUrl), code);
  } finally {
    // A state value is single-use, whatever the outcome.
    clearState();
  }
}

/**
 * A connected MCP client. When the stored tokens can no longer be used or
 * refreshed (UnauthorizedError), the tokens are dropped — the client
 * registration is kept — so /status reports connected:false.
 */
export async function getNotionClient(
  redirectUrl: string,
  connect: NotionConnector = connectToNotion,
): Promise<Client> {
  const auth = readNotionAuth();
  if (!auth.tokens) throw new NotionNotConnectedError();
  const provider = createNotionAuthProvider(redirectUrl);
  const client = newClient();
  try {
    await connect(client, provider);
    return client;
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      const { tokens: _t, ...rest } = readNotionAuth();
      writeNotionAuth(rest);
      throw new NotionNotConnectedError();
    }
    throw err;
  }
}

export async function disconnectNotion(): Promise<void> {
  clearNotionAuth();
}

export async function callToolJson<T>(
  client: Pick<Client, "callTool">,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const text = (result.content ?? []).find((c) => c.type === "text")?.text ?? "";
  if (result.isError) throw new Error(text || `${name} failed`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return { text } as T;
  }
}

export async function missingTools(client: Pick<Client, "listTools">): Promise<string[]> {
  const { tools } = await client.listTools();
  const have = new Set(tools.map((t) => t.name));
  return REQUIRED_TOOLS.filter((t) => !have.has(t));
}
