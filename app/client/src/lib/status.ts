/**
 * Format an ISO date as a coarse "Nm/h/d/w ago" string for the UI.
 * Drift status itself comes from the server (`Skill.status`).
 */
export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d ago`;
  const w = Math.round(d / 7);
  if (w < 9) return `${w}w ago`;
  const mo = Math.round(d / 30);
  return `${mo}mo ago`;
}
