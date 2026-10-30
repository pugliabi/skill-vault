/**
 * Settings → AI assistant → Provider: which CLI runs new assistant chats,
 * whether it's installed and signed in, and how it signs in. Claude keeps
 * its existing panel (login vs API key + workspace ID), plus the same Sign in
 * button as the other rows when it uses the login.
 */
import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "../../lib/api";
import { assistantApi, type EngineView } from "../../lib/assistant";
import { Button } from "../ui/primitives";
import { AUTH_FIELD_STYLE, ClaudeSignIn } from "./ClaudeSignIn";
import { EngineInstallDialog } from "./EngineInstallDialog";
import { EngineSignInDialog } from "./EngineSignInDialog";

const KEY_PLACEHOLDER: Record<string, string> = {
  codex: "OpenAI API key (sk-…)",
  copilot: "GitHub fine-grained token with Copilot Requests (github_pat_…)",
  grok: "xAI API key (xai-…)",
};

function stateText(v: EngineView): string {
  if (!v.installed) return "Not installed";
  if (v.auth.mode === "api_key") return v.auth.has_saved_key ? "API key saved" : v.auth.env_key_present ? "API key from environment" : "No API key";
  if (v.auth.signed_in === true) return v.auth.account ? `Signed in as ${v.auth.account}` : "Signed in";
  if (v.auth.signed_in === false) return "Not signed in";
  return `Installed ${v.version ?? ""}`.trim();
}

export function ProviderSettings() {
  const qc = useQueryClient();
  const { data, refetch, isFetching } = useQuery({ queryKey: ["assistant-engines"], queryFn: () => assistantApi.engines() });
  const [dialog, setDialog] = useState<{ kind: "install" | "signin"; engine: EngineView } | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["assistant-engines"] });
    void qc.invalidateQueries({ queryKey: ["assistant-status"] });
  };
  const select = useMutation({
    mutationFn: (id: EngineView["id"]) => assistantApi.setEngine(id),
    onSuccess: refresh,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Couldn't change the provider"),
  });
  const checkAgain = async () => {
    try {
      await assistantApi.engines(true);
      await refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't check the providers");
    }
  };
  const engines = data?.engines ?? [];
  const selected = engines.find((e) => e.selected);
  const muted = { color: "var(--ink-3)", fontSize: 12 } as const;
  const headingId = useId();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 12, borderBottom: "0.5px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span id={headingId} style={{ fontWeight: 600, color: "var(--ink)" }}>Provider</span>
        <span style={muted}>runs new assistant chats</span>
        <span style={{ flex: 1 }} />
        <Button kind="ghost" size="sm" disabled={isFetching} onClick={() => void checkAgain()}>
          {isFetching ? "Checking…" : "Check again"}
        </Button>
      </div>
      <fieldset aria-labelledby={headingId} style={FIELDSET_STYLE}>
        {engines.map((v) => (
          <div key={v.id} style={{ border: "0.5px solid var(--border)", borderRadius: 6, padding: "8px 10px", background: v.selected ? "var(--bg)" : undefined }}>
            {/* Wraps when the panel is narrow: the version line drops below instead of squeezing every column. */}
            <label style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 8, rowGap: 2, cursor: "pointer", fontSize: 12.5 }}>
              <input
                type="radio"
                name="assistant-provider"
                value={v.id}
                aria-label={v.label}
                // Shows the choice at once; the provider list takes a few seconds to come back.
                checked={select.isPending ? select.variables === v.id : v.selected}
                onChange={() => select.mutate(v.id)}
                style={{ accentColor: "var(--accent)", flexShrink: 0 }}
              />
              <span style={{ fontWeight: 500, color: "var(--ink)" }}>{v.label}</span>
              <span style={muted}>{stateText(v)}</span>
              {v.installed && v.version && (
                <span style={{ ...muted, marginLeft: "auto" }}>
                  {v.version} · checked with {v.verified_version}
                </span>
              )}
            </label>
            {v.selected && (
              <div style={{ paddingLeft: 22, paddingTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                {!v.installed ? (
                  <div>
                    <Button kind="primary" size="sm" onClick={() => setDialog({ kind: "install", engine: v })}>Install {v.label}</Button>
                  </div>
                ) : v.id === "claude" ? (
                  <>
                    {v.auth.mode === "login" && <SignInButton view={v} onClick={() => setDialog({ kind: "signin", engine: v })} />}
                    <ClaudeSignIn />
                  </>
                ) : (
                  <EngineAuth view={v} onSignIn={() => setDialog({ kind: "signin", engine: v })} onSaved={refresh} />
                )}
                {!v.subagents && <span style={muted}>Runs without the specialist subagents; the lead does their work using the same skills.</span>}
              </div>
            )}
          </div>
        ))}
      </fieldset>
      {selected && selected.id !== "claude" && <span style={muted}>AI tagging and merge-on-update still use Claude Code.</span>}
      {dialog?.kind === "install" && (
        <EngineInstallDialog
          engine={dialog.engine}
          onClose={() => {
            setDialog(null);
            refresh();
          }}
          onInstalled={() => refresh()}
          onSignedIn={() => refresh()}
        />
      )}
      {dialog?.kind === "signin" && (
        <EngineSignInDialog
          engine={dialog.engine}
          onClose={() => {
            setDialog(null);
            refresh();
          }}
          onSignedIn={() => refresh()}
        />
      )}
    </div>
  );
}

/** An unstyled fieldset: it only groups (and names) a set of radios. */
const FIELDSET_STYLE = { border: 0, margin: 0, padding: 0, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 } as const;

/** Every provider's account sign-in button, Claude's included: "Sign in again" once it reads as signed in. */
function SignInButton({ view, onClick }: { view: EngineView; onClick: () => void }) {
  return (
    <div>
      <Button kind={view.auth.signed_in === true ? "ghost" : "primary"} size="sm" onClick={onClick}>
        {view.auth.signed_in === true ? "Sign in again" : "Sign in"}
      </Button>
    </div>
  );
}

function EngineAuth({ view, onSignIn, onSaved }: { view: EngineView; onSignIn: () => void; onSaved: () => void }) {
  const [mode, setMode] = useState(view.auth.mode);
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: (body: { auth?: "login" | "api_key"; api_key?: string }) => assistantApi.setEngineAuth(view.id, body),
    onSuccess: () => {
      setKey("");
      onSaved();
      toast.success("Saved");
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Failed to save"),
  });
  const radio = { display: "flex", alignItems: "baseline", gap: 8, fontSize: 12.5, cursor: "pointer" } as const;
  const choose = (m: "login" | "api_key") => {
    setMode(m);
    if (m !== view.auth.mode) save.mutate({ auth: m });
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <fieldset style={{ ...FIELDSET_STYLE, gap: 6 }}>
        <legend style={{ padding: 0, marginBottom: 6, fontSize: 12, color: "var(--ink-3)" }}>Sign in with</legend>
        <label style={radio}>
          <input type="radio" name={`auth-${view.id}`} value="login" aria-label="Account login" checked={mode === "login"} onChange={() => choose("login")} style={{ accentColor: "var(--accent)" }} />
          <span>Account login</span>
        </label>
        <label style={radio}>
          <input type="radio" name={`auth-${view.id}`} value="api_key" aria-label="API key" checked={mode === "api_key"} onChange={() => choose("api_key")} style={{ accentColor: "var(--accent)" }} />
          <span>API key</span>
        </label>
      </fieldset>
      {mode === "login" && <SignInButton view={view} onClick={onSignIn} />}
      {mode === "api_key" && (
        <div style={{ display: "flex", gap: 6, maxWidth: 520 }}>
          <input
            type="password"
            autoComplete="off"
            aria-label={`${view.label} API key`}
            placeholder={view.auth.has_saved_key ? "Saved. Paste a new key to replace it" : KEY_PLACEHOLDER[view.id] ?? "API key"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            style={AUTH_FIELD_STYLE}
          />
          <Button kind="primary" size="sm" disabled={!key.trim() || save.isPending} onClick={() => save.mutate({ auth: "api_key", api_key: key.trim() })}>Save</Button>
          {view.auth.has_saved_key && (
            <Button kind="ghost" size="sm" disabled={save.isPending} onClick={() => save.mutate({ api_key: "" })}>Remove</Button>
          )}
        </div>
      )}
    </div>
  );
}
