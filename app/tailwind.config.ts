import type { Config } from "tailwindcss";

// Modern SaaS direction per the design spec:
// neutral warm-gray base + single confident indigo accent, 8px grid.
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
        // The neutral scale + single indigo accent. Semantic greens/reds/
        // yellows come from Tailwind's default palette (green-600, red-600,
        // amber-600) used only on status badges.
        accent: {
          DEFAULT: "#6366F1", // indigo-500
          hover: "#4F46E5",   // indigo-600
          ring: "#A5B4FC",    // indigo-300
          subtle: "#EEF2FF",  // indigo-50
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
