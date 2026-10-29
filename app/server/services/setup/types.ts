/** Shared shapes for the setup guide (draft file, API bodies). */

export type SetupStep = "welcome" | "vault" | "targets" | "skills" | "notion" | "assistant" | "review";

export interface NotionRef {
  id: string;
  name: string;
}

export interface SetupVault {
  mode: "new" | "existing" | "clone";
  /** Vault root to use. For a clone: <dest>/<subdir> (derived by normalizeDraft). */
  path: string;
  clone?: { url: string; dest: string; subdir: string; skill_names: string[]; notion: NotionRef | null };
  /** Saved as config repo_url on Finish (empty when absent). */
  repo_url?: string;
}

export interface SetupTarget {
  id: string;
  path: string;
  enabled: boolean;
  is_default: boolean;
  known: boolean;
}

export interface NotionChoice {
  data_source_id: string;
  data_source_name: string;
  add_last_edited: boolean;
}

export interface AssistantChoice {
  auth: "login" | "api_key";
  workspace_id?: string;
}

/**
 * The guide's answers until Finish (~/.skill-vault/setup-draft.json).
 * null on targets / notion / assistant = "leave as it is" (Skip). Never holds
 * the API key or Notion tokens.
 */
export interface SetupDraft {
  version: 1;
  started_at: string;
  /** configFingerprint() of the config when the draft started. */
  base: string;
  step: SetupStep;
  vault: SetupVault | null;
  machine_id?: string;
  /** true once the user has been through the Skills step (Next or Skip). */
  skills_reviewed?: boolean;
  targets: SetupTarget[] | null;
  skills: { adopt: { name: string; from: string }[]; push: string[] };
  notion: NotionChoice | null;
  assistant: AssistantChoice | null;
}

/** The config fields the guide reads (appConfig.readSetupBase). */
export interface SetupBase {
  vault_path: string | null;
  agent_locations: Record<string, string>;
  default_targets: string[];
  machine_id: string | null;
  repo_url: string | null;
}
