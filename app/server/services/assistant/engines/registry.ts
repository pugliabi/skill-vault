/** The engines this build of the app can run, and where each keeps its per-turn files. */
import os from "node:os";
import path from "node:path";
import { createClaudeEngine } from "./claude.ts";
import { createCodexEngine } from "./codex.ts";
import { createCopilotEngine } from "./copilot.ts";
import { createGrokEngine } from "./grok.ts";
import type { AssistantEngine, EngineId } from "./types.ts";

export interface EngineRegistry {
  get(id: EngineId): AssistantEngine | undefined;
  list(): AssistantEngine[];
}

export function createRegistry(engines: AssistantEngine[]): EngineRegistry {
  const byId = new Map(engines.map((e) => [e.id, e] as const));
  return { get: (id) => byId.get(id), list: () => [...byId.values()] };
}

let shared: EngineRegistry | null = null;

/** The app's engines, in the order Settings lists them. */
export function defaultRegistry(): EngineRegistry {
  shared ??= createRegistry([createClaudeEngine(), createCodexEngine(), createCopilotEngine(), createGrokEngine()]);
  return shared;
}

/** ~/.skill-vault/engines/<id>/ — the prompt files an engine writes per turn. */
export function engineWorkDir(id: EngineId, home: string = os.homedir()): string {
  return path.join(home, ".skill-vault", "engines", id);
}
