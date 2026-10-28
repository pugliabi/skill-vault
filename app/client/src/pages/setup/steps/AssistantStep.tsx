import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { setupApi } from "../../../lib/setup";
import { Button } from "../../../components/ui/primitives";
import type { StepProps } from "../types";
import { ChoiceCard, Hint, StepHeader, StepNav, inputStyle, labelStyle } from "../ui";

export function AssistantStep({ draft, commit, goTo, apiKey, setApiKey }: StepProps) {
  const [refresh, setRefresh] = useState(0);
  const { data: check, isFetching } = useQuery({
    queryKey: ["setup-assistant", refresh],
    queryFn: () => setupApi.assistant(refresh > 0),
  });
  const [auth, setAuth] = useState<"login" | "api_key" | null>(draft.assistant?.auth ?? null);
  const [workspace, setWorkspace] = useState(draft.assistant?.workspace_id ?? "");

  useEffect(() => {
    if (check && auth === null) {
      setAuth(check.saved.auth);
      if (!draft.assistant) setWorkspace(check.saved.workspace_id ?? "");
    }
  }, [check, auth, draft.assistant]);

  const keyAvailable = Boolean(apiKey.trim() || check?.saved.has_saved_key || check?.saved.env_key_present);
  const next = () => commit({ assistant: { auth: auth ?? "login", ...(workspace.trim() ? { workspace_id: workspace.trim() } : {}) } }, "review");

  return (
    <div>
      <StepHeader title="The AI assistant (optional)">
        The assistant uses the Claude Code command-line tool on this PC to help with your skills.
      </StepHeader>

      {check && !check.installed && (
        <div>
          <Hint tone="warn">The claude command-line tool isn't installed{check.reason ? ` (${check.reason})` : ""}.</Hint>
          <Hint>Install it in a terminal with: npm install -g @anthropic-ai/claude-code</Hint>
        </div>
      )}
      {check?.installed && <Hint tone="good">Installed: {check.version}</Hint>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "18px 0" }}>
        <ChoiceCard
          selected={auth === "login"}
          onSelect={() => setAuth("login")}
          title="Sign in with my Claude account"
          description="Uses the account you signed in with in Claude Code. Best for most people."
        />
        <ChoiceCard
          selected={auth === "api_key"}
          onSelect={() => setAuth("api_key")}
          title="Use an API key"
          description="For Anthropic Console keys. Usage is billed to that key."
        />
      </div>

      {auth === "login" && check?.installed && (
        <>
          {check.login?.logged_in && (
            <Hint tone="good">
              Signed in{check.login.auth_method ? ` (${check.login.auth_method})` : ""}
              {check.login.email ? ` as ${check.login.email}` : ""}.
            </Hint>
          )}
          {check.login && !check.login.logged_in && <Hint tone="warn">Not signed in yet. Open a terminal, run claude, and sign in.</Hint>}
          {!check.login && <Hint>Couldn't check the sign-in. If the assistant asks you to sign in later, run claude in a terminal once.</Hint>}
        </>
      )}

      {auth === "api_key" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label htmlFor="api-key" style={labelStyle}>
              api key
            </label>
            <input id="api-key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={inputStyle} />
            {check?.saved.has_saved_key && !apiKey && <Hint>A key is already saved. Leave this empty to keep it.</Hint>}
            {!check?.saved.has_saved_key && check?.saved.env_key_present && !apiKey && <Hint>Leave this empty to use the ANTHROPIC_API_KEY set on this PC.</Hint>}
            <Hint>Saved on this PC when you press Finish. It's never stored in the setup draft.</Hint>
          </div>
          <div>
            <label htmlFor="workspace-id" style={labelStyle}>
              workspace id (only for keys not tied to a workspace)
            </label>
            <input id="workspace-id" type="text" value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="wrkspc_…" style={inputStyle} />
          </div>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <Button kind="ghost" size="sm" onClick={() => setRefresh((n) => n + 1)} disabled={isFetching}>
          {isFetching ? "Checking…" : "Check again"}
        </Button>
      </div>

      <StepNav
        onBack={() => goTo("notion")}
        onSkip={() => commit({ assistant: null }, "review")}
        onNext={next}
        nextDisabled={!auth || (auth === "api_key" && !keyAvailable)}
      />
    </div>
  );
}
