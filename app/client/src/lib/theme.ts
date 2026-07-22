import { useEffect, useState } from "react";

/**
 * Theme tokens — applied to document.documentElement as CSS vars on
 * mount and on every change. The CSS file in index.css defines the
 * default (warm) values inside :root; these overrides win because they
 * land on the same selector at runtime.
 */
export type ThemeName = "warm" | "light" | "dark";

const THEMES: Record<
  ThemeName,
  {
    bg: string;
    surface: string;
    surface2: string;
    border: string;
    border2: string;
    ink: string;
    ink2: string;
    ink3: string;
    ink4: string;
  }
> = {
  warm: {
    bg:       "oklch(0.985 0.005 80)",
    surface:  "oklch(0.975 0.006 75)",
    surface2: "oklch(0.96 0.008 70)",
    border:   "oklch(0.91 0.01 70)",
    border2:  "oklch(0.86 0.012 70)",
    ink:      "oklch(0.22 0.012 60)",
    ink2:     "oklch(0.42 0.01 60)",
    ink3:     "oklch(0.62 0.008 60)",
    ink4:     "oklch(0.78 0.006 60)",
  },
  light: {
    bg:       "oklch(1 0 0)",
    surface:  "oklch(0.985 0 0)",
    surface2: "oklch(0.965 0 0)",
    border:   "oklch(0.92 0 0)",
    border2:  "oklch(0.88 0 0)",
    ink:      "oklch(0.18 0 0)",
    ink2:     "oklch(0.4 0 0)",
    ink3:     "oklch(0.6 0 0)",
    ink4:     "oklch(0.78 0 0)",
  },
  dark: {
    bg:       "oklch(0.18 0.008 60)",
    surface:  "oklch(0.22 0.008 60)",
    surface2: "oklch(0.26 0.008 60)",
    border:   "oklch(0.32 0.008 60)",
    border2:  "oklch(0.4 0.008 60)",
    ink:      "oklch(0.95 0.005 60)",
    ink2:     "oklch(0.78 0.006 60)",
    ink3:     "oklch(0.6 0.008 60)",
    ink4:     "oklch(0.45 0.008 60)",
  },
};

const STORAGE_KEY = "skill-vault.theme";

function applyTheme(name: ThemeName): void {
  const t = THEMES[name];
  const root = document.documentElement;
  root.style.setProperty("--bg", t.bg);
  root.style.setProperty("--surface", t.surface);
  root.style.setProperty("--surface-2", t.surface2);
  root.style.setProperty("--border", t.border);
  root.style.setProperty("--border-2", t.border2);
  root.style.setProperty("--ink", t.ink);
  root.style.setProperty("--ink-2", t.ink2);
  root.style.setProperty("--ink-3", t.ink3);
  root.style.setProperty("--ink-4", t.ink4);
  root.dataset.theme = name;
}

function readStoredTheme(): ThemeName {
  if (typeof window === "undefined") return "warm";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "warm" || stored === "light" || stored === "dark") return stored;
  return "warm";
}

export function useTheme(): [ThemeName, (t: ThemeName) => void] {
  const [theme, setTheme] = useState<ThemeName>(readStoredTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* private mode / quota — non-fatal */
    }
  }, [theme]);

  return [theme, setTheme];
}

export const THEME_LABELS: Record<ThemeName, string> = {
  warm: "warm",
  light: "light",
  dark: "dark",
};
