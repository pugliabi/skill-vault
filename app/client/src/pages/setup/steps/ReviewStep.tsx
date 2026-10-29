import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ApiError } from "../../../lib/api";
import { setupApi, type SetupDraft, type SetupEvent, type SetupJobState } from "../../../lib/setup";
import { Button } from "../../../components/ui/primitives";
import type { StepProps } from "../types";
import { Hint, StepHeader, StepNav, listBox, rowStyle } from "../ui";

const STEP_NAME: Record<SetupEvent["step"], string> = {
  vault: "Vault",
  config: "Settings",
  adopt: "Adopt",
  push: "Push",
  notion: "Notion",
  done: "Done",
};
const MARK: Record<SetupEvent["state"], string> = { start: "…", done: "✓", skip: "–", error: "✗" };

function plannedActions(d: SetupDraft): string[] {
  const out: string[] = [];
  const v = d.vault;
  if (v?.mode === "new") out.push(`Create a new vault in ${v.path}`);
  if (v?.mode === "existing") out.push(`Use the vault in ${v.path}`);
  if (v?.mode === "clone" && v.clone) out.push(`Clone ${v.clone.url} into ${v.clone.dest}${v.clone.subdir ? ` (vault in ${v.clone.subdir}/)` : ""}`);

  const parts: string[] = [];
  if (d.targets) {
    const on = d.targets.filter((t) => t.enabled);
    parts.push(on.length ? `tools: ${on.map((t) => (t.is_default ? `${t.id} (default)` : t.id)).join(", ")}` : "no tools");
  }
  if (d.machine_id) parts.push(`this PC: ${d.machine_id}`);
  if (v?.repo_url) parts.push(`repo: ${v.repo_url}`);
  if (d.assistant) parts.push(`assistant: ${d.assistant.auth === "login" ? "Claude account" : "API key"}`);
  out.push(`Save settings${parts.length ? ` (${parts.join("; ")})` : ""}`);

  if (d.skills.adopt.length) out.push(`Adopt ${d.skills.adopt.length} skill${d.skills.adopt.length === 1 ? "" : "s"} into the vault`);
  if (d.skills.push.length) out.push(`Push ${d.skills.push.length} skill${d.skills.push.length === 1 ? "" : "s"} to your default tools`);
  if (d.notion) out.push(`Use the Notion database "${d.notion.data_source_name || d.notion.data_source_id}"`);
  return out;
}

export function ReviewStep({ draft, goTo, apiKey, onFinished }: StepProps) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<"review" | "running" | "result">("review");
  const [events, setEvents] = useState<SetupEvent[]>([]);
  const [result, setResult] = useState<SetupJobState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nothingSaved, setNothingSaved] = useState(false);

  const run = async (job: (onEvent: (e: SetupEvent) => void) => Promise<void>, keep: boolean) => {
    setPhase("running");
    setError(null);
    setNothingSaved(false);
    if (!keep) setEvents([]);
    let streamError: string | null = null;
    try {
      await job((e) => setEvents((xs) => [...xs, e]));
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        // Refused before any job started (e.g. nothing to retry): show why, touch nothing else.
        setError(err.message);
        setPhase(result ? "result" : "review");
        return;
      }
      // The stream can drop while the server keeps going; read the job's state below.
      streamError = (err as Error).message;
    }
    // Poll while the job still runs (up to 10 minutes).
    const started = Date.now();
    let state = await setupApi.applyStatus().catch(() => null);
    while (state?.running && Date.now() - started < 10 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 1000));
      state = await setupApi.applyStatus().catch(() => null);
    }
    if (!state || state.running) {
      setError("Lost contact with setup. Check Settings to see what was saved before pressing Finish again.");
      setPhase(result ? "result" : "review");
      return;
    }
    setResult(state);
    if (!state.vault_path) {
      // Steps 1–2 failed: nothing was saved.
      const last = state.events.at(-1);
      setError(last?.state === "error" ? (last.message ?? "Setup failed.") : (streamError ?? "Setup failed."));
      setNothingSaved(true);
      setPhase("review");
      return;
    }
    // The app shell redirects to /setup while its cached config has no vault; refresh it first.
    try {
      await qc.refetchQueries({ queryKey: ["config"] });
    } catch {
      /* ignore: the result screen still shows what happened */
    }
    setPhase("result");
  };

  // The API key is only sent when the user chose "API key" on the Assistant step.
  const key = draft.assistant?.auth === "api_key" ? apiKey : "";
  const finish = () => run((onEvent) => setupApi.apply(draft, key, onEvent), false);
  const retry = () => run((onEvent) => setupApi.retry(onEvent), true);

  const log = (
    <div style={{ ...listBox, maxHeight: 320, marginTop: 16 }}>
      {events.map((e, i) => (
        <div key={i} style={{ ...rowStyle, alignItems: "flex-start" }}>
          <span style={{ width: 16, color: e.state === "error" ? "var(--bad)" : "var(--ink-3)" }}>{MARK[e.state]}</span>
          <span style={{ width: 70, color: "var(--ink-3)", fontSize: 12 }}>{STEP_NAME[e.step]}</span>
          <span style={{ flex: 1 }}>
            {e.item ?? e.message ?? ""}
            {e.item && e.message ? <span style={{ color: e.state === "error" ? "var(--bad)" : "var(--ink-3)" }}> — {e.message}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );

  if (phase === "running") {
    return (
      <div>
        <StepHeader title="Setting things up…">This can take a minute if you're cloning a repo.</StepHeader>
        {log}
      </div>
    );
  }

  if (phase === "result" && result) {
    return (
      <div>
        <StepHeader title={result.ok ? "You're all set" : "Almost done"}>
          {result.ok ? "Everything is saved." : "Your vault and settings are saved, but a few items didn't go through."}
        </StepHeader>
        {log}
        {error && <Hint tone="bad">{error}</Hint>}
        {!result.ok && (
          <>
            <Hint>Anything already moved stays where it is.</Hint>
            <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
              <Button onClick={retry}>Retry failed items</Button>
              <Button kind="ghost" onClick={() => navigate("/adopt")}>
                Open Adopt
              </Button>
              <Button kind="ghost" onClick={() => navigate("/settings")}>
                Open Settings
              </Button>
            </div>
          </>
        )}
        <div style={{ marginTop: 24 }}>
          <Button kind="primary" size="lg" onClick={onFinished}>
            Open Skill Vault
          </Button>
        </div>
      </div>
    );
  }

  const actions = plannedActions(draft);
  return (
    <div>
      <StepHeader title="Ready to set up">Here's exactly what will happen when you press Finish.</StepHeader>
      <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, lineHeight: 1.9, color: "var(--ink)" }}>
        {actions.map((a, i) => (
          <li key={i}>{a}</li>
        ))}
      </ol>
      {error && (
        <Hint tone="bad">
          {error}
          {nothingSaved ? " Nothing was saved. Fix it and press Finish again." : ""}
        </Hint>
      )}
      {events.length > 0 && error && log}
      <StepNav onBack={() => goTo("assistant")} onNext={finish} nextLabel="Finish" nextDisabled={!draft.vault} />
    </div>
  );
}
