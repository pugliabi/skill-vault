import type { NotionGuardStatus } from "../lib/types";

/**
 * Multi-device guard banner: "Vault is N commits behind its remote — pull
 * first." Two modes:
 *
 *   - Checkbox mode (`onOverrideChange`): used on the push/pull review pages,
 *     where the guard blocks the Run button until "Run anyway" is ticked.
 *   - Action mode (`onRunAnyway`): used by one-shot actions (force push/pull,
 *     bulk push) that only learn about the guard from a 409 `vault_behind`
 *     response — "Run anyway" immediately retries with `override_guard:true`.
 *
 * When the vault isn't behind but the guard couldn't check the remote at all
 * (e.g. `git fetch` failed or timed out), an informational line is shown
 * instead — it never blocks anything, there's no "Run anyway".
 *
 * Renders nothing when there's no guard status, the vault isn't behind, and
 * there's no error to report.
 */
export function GuardBanner({
  guard,
  overrideGuard,
  onOverrideChange,
  onRunAnyway,
  onDismiss,
}: {
  guard: NotionGuardStatus | null | undefined;
  overrideGuard?: boolean;
  onOverrideChange?: (value: boolean) => void;
  onRunAnyway?: () => void;
  onDismiss?: () => void;
}) {
  if (!guard) return null;
  const blocked = guard.behind > 0;
  if (!blocked && !guard.error) return null;
  if (!blocked) {
    return (
      <div
        role="status"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 24px",
          background: "var(--surface-2)",
          color: "var(--ink-3)",
          fontSize: 12.5,
          borderBottom: "0.5px solid var(--border)",
        }}
      >
        <span style={{ flex: 1 }}>Couldn't check the remote: {guard.error}</span>
      </div>
    );
  }
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 24px",
        background: "var(--bad-bg)",
        color: "var(--bad)",
        fontSize: 12.5,
        borderBottom: "0.5px solid var(--border)",
      }}
    >
      <span style={{ flex: 1 }}>
        Vault is {guard.behind} commit{guard.behind === 1 ? "" : "s"} behind its remote — pull first.
      </span>
      {onRunAnyway ? (
        <>
          <button
            type="button"
            onClick={onRunAnyway}
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: "var(--bad)",
              background: "transparent",
              border: "0.5px solid var(--bad)",
              borderRadius: 6,
              padding: "3px 10px",
              cursor: "pointer",
            }}
          >
            Run anyway
          </button>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss"
              style={{ fontSize: 12, color: "var(--bad)", background: "transparent", border: 0, cursor: "pointer" }}
            >
              ✕
            </button>
          )}
        </>
      ) : (
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={!!overrideGuard}
            onChange={(e) => onOverrideChange?.(e.target.checked)}
          />
          Run anyway
        </label>
      )}
    </div>
  );
}
