/**
 * Starts the provider's own login in a window on this PC, then checks every
 * 2 s (up to 10 min) until the provider reports signed in. When it already
 * read as signed in at start ("Sign in again"), that reading proves nothing:
 * the dialog waits for the window to exit instead, and exit code 0 is the
 * success. A window that exits with an error is reported as failed. Cancel
 * closes the window.
 */
import { useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import { assistantApi, type EngineView } from "../../lib/assistant";
import { Button } from "../ui/primitives";
import { Modal } from "../ui/Modal";

const POLL_MS = 2000;
const GIVE_UP_MS = 600_000;

export function EngineSignInDialog({
  engine,
  onClose,
  onSignedIn,
}: {
  engine: EngineView;
  onClose: () => void;
  onSignedIn: (view: EngineView) => void;
}) {
  const [state, setState] = useState<"starting" | "waiting" | "done" | "timeout" | "failed" | "error">("starting");
  const [hint, setHint] = useState(engine.login_hint);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [alreadySignedIn, setAlreadySignedIn] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Per run, so a StrictMode re-run or a retry never leaves a second poll chain going.
    let cancelled = false;
    let already = false;
    let exitedOkPolls = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const started = Date.now();
    const succeed = (view: EngineView) => {
      setAccount(view.auth.account);
      setState("done");
      onSignedIn(view);
    };
    const fail = (code: number | null) => {
      setError(code === null ? "The sign-in window closed before the sign-in finished." : `The sign-in didn't finish (exit code ${code}).`);
      setState("failed");
    };
    const poll = async () => {
      if (cancelled) return;
      if (Date.now() - started > GIVE_UP_MS) {
        setState("timeout");
        void assistantApi.cancelLogin(engine.id).catch(() => {});
        return;
      }
      try {
        // Ask for the login status itself: the saved mode may still be "api_key" (the setup guide saves on Finish).
        // Already signed in: only the window's state matters, so the cached view will do.
        const view = await assistantApi.engine(engine.id, !already, "login");
        if (cancelled) return;
        const win = view.sign_in ?? null;
        if (already) {
          if (!win) return fail(null); // closed by the app (timed out, or another sign-in replaced it)
          if (!win.open) {
            if (win.exit_code !== 0) return fail(win.exit_code);
            const fresh = await assistantApi.engine(engine.id, true, "login").catch(() => view);
            if (!cancelled) succeed(fresh);
            return;
          }
        } else {
          if (view.auth.mode === "login" && view.auth.signed_in === true) return succeed(view);
          if (win && !win.open && win.exit_code !== null && win.exit_code !== 0) return fail(win.exit_code);
          // The login exited fine but nothing reads as signed in: say so after a few polls' grace.
          if (win && !win.open && win.exit_code === 0 && ++exitedOkPolls >= 3) {
            setError(`The sign-in window closed, but ${engine.label} doesn't read as signed in.`);
            setState("failed");
            return;
          }
        }
      } catch {
        /* keep polling */
      }
      if (cancelled) return;
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    setState("starting");
    setError(null);
    assistantApi
      .login(engine.id)
      .then((r) => {
        if (cancelled) return;
        already = r.already_signed_in === true;
        setAlreadySignedIn(already);
        setHint(r.hint);
        setState("waiting");
        timer = setTimeout(() => void poll(), POLL_MS);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Couldn't start the sign-in");
        setState("error");
      });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [engine.id, attempt]);

  const cancel = () => {
    if (state === "starting" || state === "waiting") void assistantApi.cancelLogin(engine.id).catch(() => {});
    onClose();
  };

  return (
    <Modal title={`Sign in to ${engine.label}`} onClose={cancel}>
      {(state === "starting" || state === "waiting") && (
        <>
          <p style={{ margin: 0 }}>Finish signing in in the window that opened.</p>
          <p style={{ margin: 0, color: "var(--ink-3)" }}>{hint}</p>
          <p style={{ margin: 0, fontSize: 12, color: "var(--ink-3)" }}>
            {alreadySignedIn ? "Waiting for the sign-in window to finish…" : `Waiting for ${engine.label} to report you're signed in…`}
          </p>
        </>
      )}
      {state === "done" && <p style={{ margin: 0, color: "var(--ok)" }}>Signed in{account ? ` as ${account}` : ""}.</p>}
      {state === "timeout" && <p style={{ margin: 0, color: "var(--warn)" }}>Didn't see a sign-in — try again.</p>}
      {(state === "error" || state === "failed") && <p style={{ margin: 0, color: "var(--warn)" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        {(state === "timeout" || state === "error" || state === "failed") && (
          <Button kind="default" size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
        )}
        <Button kind={state === "done" ? "primary" : "ghost"} size="sm" onClick={state === "done" ? onClose : cancel}>
          {state === "done" ? "Done" : state === "failed" || state === "timeout" || state === "error" ? "Close" : "Cancel"}
        </Button>
      </div>
    </Modal>
  );
}
