import type { SearchScope } from "./search";

export interface ActiveFilters {
  providers?: string[];
  tags?: string[];
  hasSkillMd?: boolean;
  minFiles?: number;
  /** Filter to a single target provider (first-class toolbar control). */
  target?: string;
  /**
   * When `target` is set, narrow to the skill's sync state in that target.
   * "configured" = listed in the skill's targets regardless of on-disk state;
   * the rest match `target_status[target]` exactly.
   */
  targetState?: "configured" | "synced" | "stale" | "missing";
}

export type SkillsFilterPill =
  | "all"
  | "production"
  | "staging"
  | "stale"
  | "vault-only"
  | "missing"
  | "desktop-outdated";

/** A named snapshot of the Skills view state (excludes the transient search). */
export interface SavedView {
  name: string;
  filter: SkillsFilterPill;
  filters: ActiveFilters;
  sortBy: SkillsPreferences["sortBy"];
  sortDir: SkillsPreferences["sortDir"];
  layout: SkillsPreferences["layout"];
  groupBy: SkillsPreferences["groupBy"];
}

export interface SkillsPreferences {
  layout: "list" | "cards" | "grouped" | "matrix";
  groupBy: "tag" | "provider" | "stage" | "status";
  sortBy: "name" | "modified" | "created" | "file_count" | "status";
  sortDir: "asc" | "desc";
  filters: ActiveFilters;
  savedViews: SavedView[];
  /** Which fields the Skills search box matches against. */
  searchScope: SearchScope;
}

const KEY = "sv-skills-prefs";
const DEFAULTS: SkillsPreferences = {
  layout: "list",
  groupBy: "tag",
  sortBy: "name",
  sortDir: "asc",
  filters: {},
  savedViews: [],
  searchScope: "all",
};

export function loadPrefs(): SkillsPreferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<SkillsPreferences>;
    return {
      ...DEFAULTS,
      ...parsed,
      filters: { ...DEFAULTS.filters, ...(parsed.filters ?? {}) },
    };
  } catch {
    return DEFAULTS;
  }
}

export function savePrefs(prefs: SkillsPreferences): void {
  localStorage.setItem(KEY, JSON.stringify(prefs));
}
