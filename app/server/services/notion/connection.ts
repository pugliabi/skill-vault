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
  "notion-upload-skill",
  "notion-create-pages",
  "notion-update-page",
] as const;

export class NotionNotConnectedError extends Error {
  constructor() {
    super("Notion is not connected — connect it in Settings");
  }
}

/** The usual cause behind each network error code Node's fetch reports (`cause.code`). */
const NETWORK_HINTS: Array<[RegExp, string]> = [
  [/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/, "a proxy or antivirus on this network is inspecting HTTPS with a certificate Node.js doesn't trust"],
  [/^(ENOTFOUND|EAI_AGAIN)$/, "the address couldn't be looked up; check the internet connection"],
  [/TIMEOUT|^(ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH)$/, "a firewall or proxy may be blocking Node.js"],
];

/**
 * Message for a failed Notion call. Node's fetch reports every network
 * failure as a bare "fetch failed" and keeps the reason (DNS, TLS, timeout)
 * in `cause`, so that case is spelled out; any other error keeps its message.
 */
export function notionErrorMessage(err: unknown): string {
  if (!(err instanceof TypeError) || err.message !== "fetch failed") {
    return err instanceof Error ? err.message : String(err);
  }
  const cause = err.cause as { code?: unknown; message?: unknown; errors?: Array<{ message?: unknown }> } | undefined;
  const code = typeof cause?.code === "string" ? cause.code : "";
  // Connection attempts to several addresses fail as an AggregateError with an empty message.
  const reason = [cause?.message, cause?.errors?.[0]?.message].find((m): m is string => typeof m === "string" && !!m);
  const hint = NETWORK_HINTS.find(([re]) => re.test(code))?.[1];
  return (
    `Couldn't reach Notion (${new URL(NOTION_MCP_URL).host}): ${reason ?? "network error"}` +
    `${code ? ` [${code}]` : ""}${hint ? ` — ${hint}` : ""}`
  );
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

/** A sign-in sends the app window to notion.com; the idle auto-stop must wait for it — up to this long. */
const SIGN_IN_BUSY_MS = 10 * 60_000;
let signInStartedAt: number | null = null;

/** True while a Notion sign-in started here hasn't come back yet (capped at 10 minutes). */
export function notionSignInPending(now: number = Date.now()): boolean {
  return signInStartedAt !== null && now - signInStartedAt < SIGN_IN_BUSY_MS;
}

/** A sign-in that came back without a code (denied) is over: stop holding the idle stop. */
export function clearNotionSignInPending(): void {
  signInStartedAt = null;
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
    if (err instanceof UnauthorizedError && url) {
      signInStartedAt = Date.now();
      return { status: "redirect", url };
    }
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
    signInStartedAt = null;
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
  signInStartedAt = null;
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
