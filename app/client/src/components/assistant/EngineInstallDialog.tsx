/**
 * Confirm → install (streamed output) → installed, or what failed with the
 * command to run yourself. When the provider signs in with an account and
 * isn't signed in yet, a finished install goes straight on to the sign-in
 * dialog. While it runs, Escape and the backdrop do nothing, but Cancel
 * install stops it.
 */
import { useState } from "react";
import { assistantApi, installEngine, type EngineView } from "../../lib/assistant";
import { Button } from "../ui/primitives";
import { Modal } from "../ui/Modal";
import { EngineSignInDialog } from "./EngineSignInDialog";

type Phase = "confirm" | "running" | "done" | "failed" | "signin";

const logStyle = {
  fontFamily: "var(--mono)",
  fontSize: 11.5,
  background: "var(--bg)",
  border: "0.5px solid var(--border)",
  borderRadius: 6,
  padding: "8px 10px",
  maxHeight: 220,
  overflow: "auto",
  whiteSpace: "pre-wrap" as const,
  color: "var(--ink-2)",
};

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

export function EngineInstallDialog({
  engine,
  onClose,
  onInstalled,
  onSignedIn,
}: {
  engine: EngineView;
  onClose: () => void;
  onInstalled: (view: EngineView) => void;
  /** Called when the sign-in that follows the install finishes. */
  onSignedIn?: (view: EngineView) => void;
}) {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [lines, setLines] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [installed, setInstalled] = useState<EngineView | null>(null);
  const [stopping, setStopping] = useState(false);
  const commands = engine.install.map((s) => s.display).join("\n");
  const sources = [...new Set(engine.install.map((s) => s.source))].join(", ");

  /** The install is done: report it, then sign in if the provider uses an account login. */
  const finish = (view: EngineView) => {
    setInstalled(view);
    setVersion(view.version);
    onInstalled(view);
    setPhase(view.auth.mode === "login" && view.auth.signed_in !== true ? "signin" : "done");
  };

  const run = async () => {
    setPhase("running");
    setStopping(false);
    setLines([]);
    setMessage(null);
    let ok = false;
    try {
      await installEngine(engine.id, (e) => {
        if (e.type === "line") setLines((xs) => [...xs.slice(-199), e.text]);
        if (e.type === "step") setLines((xs) => [...xs, `> ${e.display}`]);
        if (e.type === "done") {
          ok = e.ok;
          setVersion(e.version ?? null);
          setMessage(e.message ?? null);
        }
      });
    } catch (err) {
      setMessage(errorText(err, "The install didn't start."));
    }
    if (!ok) {
      setPhase("failed");
      return;
    }
    try {
      finish(await assistantApi.engine(engine.id, true));
    } catch (err) {
      // Installed, but the fresh state didn't load: say so and skip the hand-off.
      setMessage(errorText(err, "Couldn't check the provider again."));
      setPhase("done");
    }
  };

  /** Stops the running install; its stream then ends with "The install was stopped." and the dialog shows it. */
  const stop = async () => {
    setStopping(true);
    try {
      await assistantApi.cancelInstall(engine.id);
    } catch (err) {
      setStopping(false);
      setMessage(errorText(err, "Couldn't stop the install."));
    }
  };

  const checkAgain = async () => {
    try {
      const view = await assistantApi.engine(engine.id, true);
      if (view.installed) finish(view);
      else setMessage("Still not found.");
    } catch (err) {
      setMessage(errorText(err, "Couldn't check the provider again."));
    }
  };

  if (phase === "signin" && installed) {
    return <EngineSignInDialog engine={installed} onClose={onClose} onSignedIn={(v) => onSignedIn?.(v)} />;
  }

  return (
    <Modal title={`Install ${engine.label}`} busy={phase === "running"} onClose={onClose}>
      {phase === "confirm" && (
        <>
          <p style={{ margin: 0 }}>
            This installs a program on this PC. Skill Vault will run, from {sources}:
          </p>
          <pre style={logStyle}>{commands}</pre>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button kind="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button kind="primary" size="sm" onClick={() => void run()}>Install</Button>
          </div>
        </>
      )}
      {phase !== "confirm" && <pre style={logStyle}>{(phase === "failed" ? lines.slice(-20) : lines).join("\n") || "Starting…"}</pre>}
      {phase === "running" && (
        <>
          {message && <p style={{ margin: 0, color: "var(--warn)" }}>{message}</p>}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button kind="ghost" size="sm" disabled={stopping} onClick={() => void stop()}>
              {stopping ? "Stopping…" : "Cancel install"}
            </Button>
          </div>
        </>
      )}
      {phase === "done" && (
        <>
          <p style={{ margin: 0, color: "var(--ok)" }}>Installed{version ? ` — ${version}` : ""}.</p>
          {message && <p style={{ margin: 0, color: "var(--warn)" }}>{message}</p>}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button kind="primary" size="sm" onClick={onClose}>Continue</Button>
          </div>
        </>
      )}
      {phase === "failed" && (
        <>
          <p style={{ margin: 0, color: "var(--warn)" }}>{message ?? "The install didn't finish."}</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button kind="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(commands)}>Copy command</Button>
            <Button kind="ghost" size="sm" onClick={() => void checkAgain()}>Check again</Button>
            <Button kind="default" size="sm" onClick={() => void run()}>Try again</Button>
            <Button kind="ghost" size="sm" onClick={onClose}>Close</Button>
          </div>
        </>
      )}
    </Modal>
  );
}
