import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { assistantApi, type EngineId, type EngineView } from "../../../lib/assistant";
import { Button } from "../../../components/ui/primitives";
import { EngineInstallDialog } from "../../../components/assistant/EngineInstallDialog";
import { EngineSignInDialog } from "../../../components/assistant/EngineSignInDialog";
import type { StepProps } from "../types";
import { ChoiceCard, Hint, StepHeader, StepNav, inputStyle, labelStyle } from "../ui";

const BLURB: Record<EngineId, string> = {
  claude: "Anthropic's Claude Code. Sign in with your Claude account or an Anthropic API key.",
  codex: "OpenAI's Codex. Sign in with ChatGPT or an OpenAI API key.",
  copilot: "GitHub Copilot CLI. Sign in with GitHub (needs a Copilot plan) or a fine-grained token.",
  grok: "xAI's Grok Build. Sign in with your grok.com account or an xAI API key.",
};

export function AssistantStep({ draft, commit, goTo, apiKey, setApiKey }: StepProps) {
  const { data, refetch, isFetching } = useQuery({ queryKey: ["assistant-engines"], queryFn: () => assistantApi.engines() });
  // Claude's saved workspace ID: the engine views don't carry it.
  const claudeAuth = useQuery({ queryKey: ["assistant-auth"], queryFn: () => assistantApi.auth(), enabled: !draft.assistant });
  const engines = data?.engines ?? [];
  const [engineId, setEngineId] = useState<EngineId | null>(draft.assistant?.engine ?? null);
  const current = engines.find((e) => e.id === (engineId ?? engines.find((x) => x.selected)?.id)) ?? null;
  // null until the user picks: then the draft's choice, else what's saved, so Next without a click changes nothing.
  const [auth, setAuth] = useState<"login" | "api_key" | null>(draft.assistant?.auth ?? null);
  const mode = auth ?? current?.auth.mode ?? "login";
  const [workspace, setWorkspace] = useState<string | null>(draft.assistant ? (draft.assistant.workspace_id ?? "") : null);
  const ws = workspace ?? claudeAuth.data?.workspace_id ?? "";
  const [dialog, setDialog] = useState<"install" | "signin" | null>(null);
  // A sign-in finished in this step (the views report the saved mode, which may still be the API key).
  const [signedIn, setSignedIn] = useState<EngineView | null>(null);

  const pick = (v: EngineView) => {
    setEngineId(v.id);
    setAuth(v.auth.mode);
    setApiKey("");
  };
  const keyAvailable = Boolean(apiKey.trim() || current?.auth.has_saved_key || current?.auth.env_key_present);
  // Sign-in status only means something when it was checked for the mode chosen here.
  const loginView = signedIn && signedIn.id === current?.id ? signedIn : current?.auth.mode === "login" ? current : null;
  const next = () =>
    current &&
    commit(
      { assistant: { engine: current.id, auth: mode, ...(current.id === "claude" && ws.trim() ? { workspace_id: ws.trim() } : {}) } },
      "review",
    );
  const refresh = async () => {
    try {
      await assistantApi.engines(true);
      await refetch();
    } catch {
      /* the list keeps its last state; Check again can be pressed again */
    }
  };

  return (
    <div>
      <StepHeader title="The AI assistant (optional)">
        The assistant runs on an AI command-line tool on this PC. Pick one; Skill Vault can install it and help you sign in.
      </StepHeader>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "18px 0" }}>
        {engines.map((v) => (
          <ChoiceCard
            key={v.id}
            selected={current?.id === v.id}
            onSelect={() => pick(v)}
            title={`${v.label}${v.installed ? "" : " — not installed"}`}
            description={BLURB[v.id]}
          />
        ))}
      </div>

      {current && !current.installed && (
        <div style={{ marginBottom: 12 }}>
          <Hint tone="warn">{current.label} isn't installed on this PC yet.</Hint>
          <Button kind="primary" size="sm" onClick={() => setDialog("install")}>Install {current.label}</Button>
        </div>
      )}
      {current?.installed && <Hint tone="good">Installed: {current.version}</Hint>}

      {current?.installed && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0" }}>
          <ChoiceCard selected={mode === "login"} onSelect={() => setAuth("login")} title="Sign in with my account" description="Uses the tool's own sign-in. Best for most people." />
          <ChoiceCard selected={mode === "api_key"} onSelect={() => setAuth("api_key")} title="Use an API key" description="Usage is billed to that key." />
        </div>
      )}

      {current?.installed && mode === "login" && (
        <div style={{ marginBottom: 12 }}>
          {loginView?.auth.signed_in === true ? (
            <Hint tone="good">Signed in{loginView.auth.account ? ` as ${loginView.auth.account}` : ""}.</Hint>
          ) : (
            <>
              <Hint tone="warn">{loginView ? "Not signed in yet." : `Sign in to use your ${current.label} account.`}</Hint>
              <Button kind="primary" size="sm" onClick={() => setDialog("signin")}>Sign in to {current.label}</Button>
            </>
          )}
        </div>
      )}

      {current?.installed && mode === "api_key" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label htmlFor="api-key" style={labelStyle}>api key</label>
            <input id="api-key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={inputStyle} />
            {current.auth.has_saved_key && !apiKey && <Hint>A key is already saved. Leave this empty to keep it.</Hint>}
            {!current.auth.has_saved_key && current.auth.env_key_present && !apiKey && <Hint>Leave this empty to use the key set in this PC's environment.</Hint>}
            <Hint>Saved on this PC when you press Finish. It's never stored in the setup draft.</Hint>
          </div>
          {current.id === "claude" && (
            <div>
              <label htmlFor="workspace-id" style={labelStyle}>workspace id (only for keys not tied to a workspace)</label>
              <input id="workspace-id" type="text" value={ws} onChange={(e) => setWorkspace(e.target.value)} placeholder="wrkspc_…" style={inputStyle} />
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <Button kind="ghost" size="sm" onClick={() => void refresh()} disabled={isFetching}>{isFetching ? "Checking…" : "Check again"}</Button>
      </div>

      {dialog === "install" && current && (
        <EngineInstallDialog
          engine={current}
          onClose={() => {
            setDialog(null);
            void refresh();
          }}
          onInstalled={() => void refresh()}
          onSignedIn={(v) => setSignedIn(v)}
        />
      )}
      {dialog === "signin" && current && (
        <EngineSignInDialog
          engine={current}
          onClose={() => {
            setDialog(null);
            void refresh();
          }}
          onSignedIn={(v) => setSignedIn(v)}
        />
      )}

      <StepNav
        onBack={() => goTo("notion")}
        onSkip={() => commit({ assistant: null }, "review")}
        onNext={next}
        nextDisabled={!current || (mode === "api_key" && !keyAvailable)}
      />
    </div>
  );
}
