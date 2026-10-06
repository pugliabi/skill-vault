/**
 * Process-wide runtime facts that only exist after boot. Today that is a
 * single value: the port the HTTP server actually bound (the launcher may
 * walk past a busy preferred port). The assistant needs it to hand the MCP
 * bridge a working `SKILL_VAULT_URL` — reading config would give the
 * *preferred* port, which is wrong exactly when it matters.
 */

let serverPort: number | null = null;

export function setServerPort(port: number): void {
  serverPort = port;
}

export function getServerPort(): number | null {
  return serverPort;
}

/** TEST-ONLY. */
export function __resetRuntimeForTests(): void {
  serverPort = null;
}
