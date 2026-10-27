/**
 * How the app's `claude` CLI calls authenticate. The assistant, AI
 * auto-tagging and Claude merge all spawn the same CLI, so one setting
 * covers all of them.
 *
 *   login   — (default) Claude Code's own login. ANTHROPIC_API_KEY and
 *             ANTHROPIC_AUTH_TOKEN are removed from the child env: when
 *             either is set the CLI prefers it over the login, so a key
 *             exported for some other tool would silently take over.
 *   api_key — the saved key, else ANTHROPIC_API_KEY from the environment.
 *             An optional workspace id is sent as `anthropic-workspace-id`
 *             through ANTHROPIC_CUSTOM_HEADERS, which keys that aren't
 *             scoped to a workspace require.
 *
 * Stored as the `assistant` block of ~/.skill-vault/config.json (see
 * appConfig.readAssistantBlock). The saved key is never sent to the client.
 */

export type ClaudeAuthMode = "login" | "api_key";

export interface ClaudeAuthConfig {
  auth?: ClaudeAuthMode;
  api_key?: string;
  workspace_id?: string;
}

export interface ClaudeAuthStatus {
  auth: ClaudeAuthMode;
  has_saved_key: boolean;
  env_key_present: boolean;
  workspace_id: string | null;
}

/** PUT body: an omitted field is kept, an empty string clears it. */
export interface ClaudeAuthPatch {
  auth?: ClaudeAuthMode;
  api_key?: string;
  workspace_id?: string;
}

export function claudeChildEnv(cfg: ClaudeAuthConfig, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  if (cfg.auth !== "api_key") {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
  }
  if (cfg.api_key) env.ANTHROPIC_API_KEY = cfg.api_key;
  if (cfg.workspace_id) {
    const header = `anthropic-workspace-id: ${cfg.workspace_id}`;
    env.ANTHROPIC_CUSTOM_HEADERS = env.ANTHROPIC_CUSTOM_HEADERS ? `${env.ANTHROPIC_CUSTOM_HEADERS}\n${header}` : header;
  }
  return env;
}

export function claudeAuthStatus(cfg: ClaudeAuthConfig, base: NodeJS.ProcessEnv = process.env): ClaudeAuthStatus {
  return {
    auth: cfg.auth === "api_key" ? "api_key" : "login",
    has_saved_key: !!cfg.api_key,
    env_key_present: !!base.ANTHROPIC_API_KEY,
    workspace_id: cfg.workspace_id || null,
  };
}

export function applyClaudeAuthPatch(cfg: ClaudeAuthConfig, patch: ClaudeAuthPatch): ClaudeAuthConfig {
  const next: ClaudeAuthConfig = { ...cfg };
  if (patch.auth !== undefined) {
    if (patch.auth !== "login" && patch.auth !== "api_key") throw new Error('auth must be "login" or "api_key"');
    next.auth = patch.auth;
  }
  for (const field of ["api_key", "workspace_id"] as const) {
    const v = patch[field];
    if (v === undefined) continue;
    const trimmed = v.trim();
    if (trimmed) next[field] = trimmed;
    else delete next[field];
  }
  return next;
}

/** Appends where to fix it when the API rejects a key that needs a workspace id. */
export function withAuthHint(message: string): string {
  if (!/not scoped to a workspace/i.test(message)) return message;
  return `${message} — add the workspace ID in Settings → AI assistant, or switch the assistant to Claude login.`;
}
