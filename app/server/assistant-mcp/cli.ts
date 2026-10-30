/**
 * Arguments and command mode for the bridge entry (main.ts):
 *
 *   assistant-mcp.js [--client <id>]                         MCP over stdio
 *   assistant-mcp.js [--client <id>] tools                   every tool with its JSON schema
 *   assistant-mcp.js [--client <id>] <tool> [--file <path>]  JSON arguments from the file or
 *                                                            stdin → JSON result on stdout
 *
 * The shared ~/.skill-vault/bin/skill-vault command runs the last two with
 * --client command, so agents without MCP get the same tools.
 */
import fs from "node:fs";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TOOLS, type BridgeHttp } from "./bridge.ts";

export interface BridgeArgs {
  client: string;
  command: string | null;
  /** --file: read the tool's JSON arguments from here instead of stdin. */
  file: string | null;
}

/**
 * The client when --client isn't given. The in-app assistant always sets
 * SKILL_VAULT_URL; anything else (a hand-made MCP config such as Cursor's)
 * is an agent, so its calls count as activity.
 */
export function defaultClient(env: NodeJS.ProcessEnv): string {
  return env.SKILL_VAULT_URL ? "assistant" : "agent";
}

export function parseBridgeArgs(argv: string[], fallbackClient: string): BridgeArgs {
  let client = fallbackClient;
  let command: string | null = null;
  let file: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client") client = argv[++i] ?? client;
    else if (a.startsWith("--client=")) client = a.slice("--client=".length);
    // A bare trailing --file is "" so the read fails loudly instead of waiting on stdin.
    else if (a === "--file") file = argv[++i] ?? "";
    else if (a.startsWith("--file=")) file = a.slice("--file=".length);
    else if (command === null) command = a;
  }
  return { client, command, file };
}

/** A tool's JSON arguments: text read from stdin, or the file named by --file. */
export type CommandInput = string | { file: string };

/**
 * Decode an --file: UTF-16LE when it starts with FF FE (what Windows
 * PowerShell 5.1's `>` and Out-File write), otherwise UTF-8 with any BOM
 * dropped.
 */
export function readArgsFile(file: string): string {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf-8");
  return buf.toString("utf-8");
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
  input: CommandInput,
  http: BridgeHttp,
  sleep: (ms: number) => Promise<void>,
): Promise<{ code: 0 | 1; out: unknown }> {
  if (command === "tools") return { code: 0, out: listTools() };
  // Own-property check: "constructor" / "toString" must not resolve to Object.prototype members.
  if (!Object.hasOwn(TOOLS, command)) {
    return { code: 1, out: { error: `unknown tool: ${command}. Run "skill-vault tools" for the list.` } };
  }
  const def = TOOLS[command];
  let inputText: string;
  if (typeof input === "string") {
    inputText = input;
  } else {
    try {
      inputText = readArgsFile(input.file);
    } catch (err) {
      return { code: 1, out: { error: `couldn't read --file ${input.file}: ${(err as Error).message}` } };
    }
  }
  // Windows PowerShell 5.1 writes a byte-order mark at the start of piped/redirected text.
  const text = inputText.startsWith("﻿") ? inputText.slice(1) : inputText;
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
