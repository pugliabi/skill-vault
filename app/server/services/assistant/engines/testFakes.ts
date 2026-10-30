/** Test-only: a configurable engine that never spawns anything, and the flags no turn may carry. */
import type { AssistantEngine } from "./types.ts";

/** The Global Constraints' list. Matched with `includes`, so `--flag=value` forms are caught too. */
export const FORBIDDEN_FLAGS = [
  "--yolo",
  "--allow-all",
  "--allow-all-tools",
  "--allow-all-paths",
  "--allow-all-urls",
  "bypassPermissions",
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
];

export function fakeEngine(over: Partial<AssistantEngine> = {}): AssistantEngine {
  return {
    id: "codex",
    label: "Fake Codex",
    cliName: "codex",
    verifiedVersion: "1.0.0",
    subagents: false,
    apiKeyEnv: ["FAKE_KEY"],
    install: [{ kind: "npm", label: "Install Fake", args: ["install", "-g", "fake"], source: "npmjs.com" }],
    loginArgs: ["login"],
    loginHint: "Do the thing.",
    loginEnv: () => ({}),
    target: () => ({ command: "C:\\fake\\codex.exe", prefixArgs: [], label: "codex CLI" }),
    detect: async () => ({ installed: true, version: "codex-cli 1.0.0" }),
    authStatus: async () => ({ signed_in: true, method: "login", account: "me" }),
    childEnv: (_c, base) => ({ ...base }),
    buildTurn: (i) => ({ label: "codex CLI", args: ["exec"], stdin: i.message, cwd: i.vaultPath }),
    createParser: () => ({ parse: () => [] }),
    authHint: (m) => m,
    ...over,
  };
}
