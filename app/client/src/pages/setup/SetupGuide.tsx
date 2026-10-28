/**
 * The setup guide at /setup (design: docs/superpowers/specs/2026-10-27-setup-guide-design.md).
 * Holds the draft (saved to the server on every step change), the API key
 * (page memory only), and renders the current step. First run (no vault yet)
 * has no Close button; a re-run asks before discarding.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Logo } from "@/components/ui/Logo";
import { api } from "../../lib/api";
import { setupApi, type SetupDraft, type SetupStep } from "../../lib/setup";
import { Button } from "../../components/ui/primitives";
import type { StepProps } from "./types";
import { Hint, StepHeader } from "./ui";
import { VaultStep } from "./steps/VaultStep";
import { TargetsStep } from "./steps/TargetsStep";
import { SkillsStep } from "./steps/SkillsStep";
import { NotionStep } from "./steps/NotionStep";
import { AssistantStep } from "./steps/AssistantStep";
import { ReviewStep } from "./steps/ReviewStep";

const RAIL: { id: SetupStep; label: string }[] = [
  { id: "vault", label: "Vault" },
  { id: "targets", label: "Tools" },
  { id: "skills", label: "Skills" },
  { id: "notion", label: "Notion" },
  { id: "assistant", label: "Assistant" },
  { id: "review", label: "Finish" },
];

function Rail({ current }: { current: SetupStep }) {
  const at = RAIL.findIndex((s) => s.id === current);
  return (
    <ol style={{ display: "flex", gap: 6, listStyle: "none", padding: 0, margin: "0 0 32px", flexWrap: "wrap" }}>
      {RAIL.map((s, i) => (
        <li
          key={s.id}
          aria-current={s.id === current ? "step" : undefined}
          style={{
            fontSize: 12,
            padding: "4px 10px",
            borderRadius: 999,
            border: "0.5px solid var(--border-2)",
            background: s.id === current ? "var(--ink)" : "transparent",
            color: s.id === current ? "var(--bg)" : i < at ? "var(--ink-2)" : "var(--ink-3)",
            fontWeight: s.id === current ? 600 : 500,
          }}
        >
          {i + 1}. {s.label}
        </li>
      ))}
    </ol>
  );
}

function Welcome({
  firstRun,
  saved,
  stale,
  onResume,
  onStart,
}: {
  firstRun: boolean;
  saved: SetupDraft | null;
  stale: boolean;
  onResume: () => void;
  onStart: () => void;
}) {
  return (
    <div>
      <StepHeader title={firstRun ? "Welcome to Skill Vault" : "Setup guide"}>
        A few short steps: where your skills live, the tools you use, Notion and the assistant. Nothing is saved until you press Finish.
      </StepHeader>
      {saved && stale && <Hint tone="warn">Your settings changed since you last used the guide, so it starts over.</Hint>}
      <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
        {saved && !stale ? (
          <>
            <Button kind="primary" size="lg" onClick={onResume}>
              Resume where I left off
            </Button>
            <Button kind="ghost" size="lg" onClick={onStart}>
              Start over
            </Button>
          </>
        ) : (
          <Button kind="primary" size="lg" onClick={onStart}>
            {firstRun ? "Get started" : "Start"}
          </Button>
        )}
      </div>
    </div>
  );
}

export default function SetupGuide() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: () => api.getConfig() });
  const { data: caps } = useQuery({ queryKey: ["setup-capabilities"], queryFn: () => setupApi.capabilities() });
  const [saved, setSaved] = useState<{ draft: SetupDraft | null; stale: boolean } | null>(null);
  const [draft, setDraft] = useState<SetupDraft | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const firstRun = !config?.vault_path;

  useEffect(() => {
    setupApi
      .getDraft()
      .then((r) => {
        setSaved(r);
        // Back from Notion's sign-in: straight to the step the draft was on.
        if (new URLSearchParams(location.search).has("notion") && r.draft && !r.stale) setDraft(r.draft);
      })
      .catch((err) => setLoadError((err as Error).message));
  }, []);

  const save = async (next: SetupDraft) => {
    setDraft(next);
    try {
      await setupApi.saveDraft(next);
    } catch (err) {
      toast.error(`Couldn't save your progress: ${(err as Error).message}`);
    }
  };

  const start = async () => {
    try {
      setDraft((await setupApi.startDraft()).draft);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const close = async () => {
    if (!window.confirm("Discard your changes?")) return;
    await setupApi.discardDraft().catch(() => {});
    navigate("/settings");
  };

  const props: StepProps | null = draft
    ? {
        draft,
        commit: (patch, to) => save({ ...draft, ...patch, step: to }),
        goTo: (to) => void save({ ...draft, step: to }),
        folderDialog: Boolean(caps?.folder_dialog),
        apiKey,
        setApiKey,
        onFinished: async () => {
          await qc.invalidateQueries();
          navigate("/");
        },
      }
    : null;

  const step = draft?.step === "welcome" ? "vault" : draft?.step;

  return (
    <div className="sv-fade-in" style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", justifyContent: "center", padding: "64px 24px" }}>
      <div style={{ width: "100%", maxWidth: 640 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
          <Logo size={30} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", flex: 1 }}>Skill Vault</span>
          {!firstRun && (
            <Button kind="ghost" size="sm" onClick={close}>
              Close
            </Button>
          )}
        </div>

        {loadError && <Hint tone="bad">{loadError}</Hint>}
        {saved && !draft && <Welcome firstRun={firstRun} saved={saved.draft} stale={saved.stale} onResume={() => setDraft(saved.draft)} onStart={start} />}
        {props && step && (
          <>
            <Rail current={step} />
            {step === "vault" && <VaultStep {...props} />}
            {step === "targets" && <TargetsStep {...props} />}
            {step === "skills" && <SkillsStep {...props} />}
            {step === "notion" && <NotionStep {...props} />}
            {step === "assistant" && <AssistantStep {...props} />}
            {step === "review" && <ReviewStep {...props} />}
          </>
        )}
      </div>
    </div>
  );
}
