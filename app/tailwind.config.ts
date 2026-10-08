import type { Config } from "tailwindcss";

// Modern SaaS direction per the design spec:
// neutral warm-gray base + the Skill Vault amber/brown brand, 8px grid.
export default {
  content: ["./client/index.html", "./client/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        display: [
          "'Inter Tight'",
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "'JetBrains Mono'",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      colors: {
        // The neutral scale + brand palette. Semantic greens/reds/
        // yellows come from Tailwind's default palette (green-600, red-600,
        // amber-600) used only on status badges.
        // Skill Vault brand palette (docs/brand.md). The UI accent itself
        // is the --accent CSS var in index.css.
        brand: {
          amber: "#EBA640",
          brown: "#7A4B26",
          ink: "#0F0E0D",
          panel: "#191715",
          deep: "#3D2817",
          cream: "#EFE9E1",
        },
      },
      boxShadow: {
        // Borders do visual separation at rest; shadows only on overlays.
        overlay:
          "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
      },
    },
  },
  plugins: [],
} satisfies Config;
