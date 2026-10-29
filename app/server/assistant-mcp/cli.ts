/**
 * Arguments and command mode for the bridge entry (main.ts):
 *
 *   assistant-mcp.js [--client <id>]           MCP over stdio
 *   assistant-mcp.js [--client <id>] tools     every tool with its JSON schema
 *   assistant-mcp.js [--client <id>] <tool>    JSON arguments on stdin → JSON result on stdout
 *
 * The shared ~/.skill-vault/bin/skill-vault command runs the last two with
 * --client command, so agents without MCP get the same tools.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TOOLS, type BridgeHttp } from "./bridge.ts";

export interface BridgeArgs {
  client: string;
  command: string | null;
}

export function parseBridgeArgs(argv: string[]): BridgeArgs {
  let client = "assistant";
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client") client = argv[++i] ?? client;
    else if (a.startsWith("--client=")) client = a.slice("--client=".length);
    else if (command === null) command = a;
  }
  return { client, command };
}

export function listTools(): Array<{ name: string; description: string; input_schema: unknown }> {
  return Object.entries(TOOLS).map(([name, def]) => ({
    name,
    description: def.description,
    input_schema: zodToJsonSchema(z.object(def.schema), { $refStrategy: "none" }),
  }));
}

/** One command-mode run. Never throws: failures come back as { code: 1, out: { error } }. */
export async function runCommand(
  command: string,
  stdinText: string,
  http: BridgeHttp,
  sleep: (ms: number) => Promise<void>,
): Promise<{ code: 0 | 1; out: unknown }> {
  if (command === "tools") return { code: 0, out: listTools() };
  // Own-property check: "constructor" / "toString" must not resolve to Object.prototype members.
  if (!Object.hasOwn(TOOLS, command)) {
    return { code: 1, out: { error: `unknown tool: ${command}. Run "skill-vault tools" for the list.` } };
  }
  const def = TOOLS[command];
  // Windows PowerShell 5.1 writes a byte-order mark at the start of piped/redirected text.
  const text = stdinText.startsWith("﻿") ? stdinText.slice(1) : stdinText;
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return { code: 1, out: { error: `arguments must be JSON: ${(err as Error).message}` } };
    }
  }
  const parsed = z.object(def.schema).safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(arguments)"}: ${i.message}`).join("; ");
    return { code: 1, out: { error: `invalid arguments for ${command}: ${detail}` } };
  }
  try {
    return { code: 0, out: (await def.handler(parsed.data, http, sleep)) ?? null };
  } catch (err) {
    return { code: 1, out: { error: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * Read all of stdin, or "" when nothing arrives within `firstByteMs`: some
 * agents run commands with stdin left open and never send anything.
 */
export function readStdinWithin(stream: NodeJS.ReadableStream, firstByteMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      if (chunks.length > 0) return;
      stream.removeAllListeners("data");
      stream.removeAllListeners("end");
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      resolve("");
    }, firstByteMs);
    stream.on("data", (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    stream.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
