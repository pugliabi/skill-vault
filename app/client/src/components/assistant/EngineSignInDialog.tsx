/**
 * Starts the provider's own login in a window on this PC, then checks every
 * 2 s (up to 10 min) until the provider reports signed in. Cancel closes the
 * window.
 */
import { useEffect, useRef, useState } from "react";
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
  const [state, setState] = useState<"starting" | "waiting" | "done" | "timeout" | "error">("starting");
  const [hint, setHint] = useState(engine.login_hint);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const started = Date.now();
    const poll = async () => {
      if (!live.current) return;
      if (Date.now() - started > GIVE_UP_MS) {
        setState("timeout");
        void assistantApi.cancelLogin(engine.id).catch(() => {});
        return;
      }
      try {
        // Ask for the login status itself: the saved mode may still be "api_key" (the setup guide saves on Finish).
        const view = await assistantApi.engine(engine.id, true, "login");
        if (!live.current) return;
        if (view.auth.mode === "login" && view.auth.signed_in === true) {
          setAccount(view.auth.account);
          setState("done");
          onSignedIn(view);
          return;
        }
      } catch {
        /* keep polling */
      }
      if (!live.current) return;
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    setState("starting");
    assistantApi
      .login(engine.id)
      .then((r) => {
        if (!live.current) return;
        setHint(r.hint);
        setState("waiting");
        timer = setTimeout(() => void poll(), POLL_MS);
      })
      .catch((err) => {
        if (!live.current) return;
        setError(err instanceof ApiError ? err.message : "Couldn't start the sign-in");
        setState("error");
      });
    return () => {
      live.current = false;
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
          <p style={{ margin: 0, fontSize: 12, color: "var(--ink-3)" }}>Waiting for {engine.label} to report you're signed in…</p>
        </>
      )}
      {state === "done" && <p style={{ margin: 0, color: "var(--ok)" }}>Signed in{account ? ` as ${account}` : ""}.</p>}
      {state === "timeout" && <p style={{ margin: 0, color: "var(--warn)" }}>Didn't see a sign-in — try again.</p>}
      {state === "error" && <p style={{ margin: 0, color: "var(--warn)" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        {(state === "timeout" || state === "error") && (
          <Button kind="default" size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
        )}
        <Button kind={state === "done" ? "primary" : "ghost"} size="sm" onClick={state === "done" ? onClose : cancel}>
          {state === "done" ? "Done" : "Cancel"}
        </Button>
      </div>
    </Modal>
  );
}
