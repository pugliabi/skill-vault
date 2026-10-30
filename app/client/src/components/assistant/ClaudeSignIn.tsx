import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "../../lib/api";
import { assistantApi } from "../../lib/assistant";
import { Button } from "../ui/primitives";

export const AUTH_FIELD_STYLE = {
  fontFamily: "var(--mono)",
  fontSize: 12,
  color: "var(--ink)",
  background: "var(--bg)",
  border: "0.5px solid var(--border-2)",
  borderRadius: 5,
  padding: "0 10px",
  height: 30,
  outline: 0,
  width: "100%",
} as const;

/**
 * How the assistant (and AI tagging / Claude merge) signs in. Claude login
 * ignores any ANTHROPIC_API_KEY in the environment; API key mode uses the
 * saved key, else the environment's, plus an optional workspace ID.
 */
export function ClaudeSignIn() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["assistant-auth"], queryFn: () => assistantApi.auth() });
  const [mode, setMode] = useState<"login" | "api_key">("login");
  const [key, setKey] = useState("");
  const [workspace, setWorkspace] = useState("");
  useEffect(() => {
    if (!data) return;
    setMode(data.auth);
    setWorkspace(data.workspace_id ?? "");
  }, [data]);

  const save = useMutation({
    mutationFn: (body: Parameters<typeof assistantApi.setAuth>[0]) => assistantApi.setAuth(body),
    onSuccess: (r) => {
      qc.setQueryData(["assistant-auth"], r);
      qc.invalidateQueries({ queryKey: ["assistant-engines"] });
      qc.invalidateQueries({ queryKey: ["assistant-status"] });
      setKey("");
      toast.success(r.auth === "login" ? "Assistant will use your Claude login" : "Assistant will use the API key");
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Failed to save sign-in"),
  });

  const noKey = mode === "api_key" && !key.trim() && !data?.has_saved_key && !data?.env_key_present;
  const dirty =
    !!data && (mode !== data.auth || key.trim() !== "" || workspace.trim() !== (data.workspace_id ?? ""));
  const keyPlaceholder = data?.has_saved_key
    ? "Saved. Paste a new key to replace it"
    : data?.env_key_present
      ? "Using ANTHROPIC_API_KEY from your environment"
      : "sk-ant-…";
  const muted = { color: "var(--ink-3)", fontSize: 12 } as const;
  const radioRow = { display: "flex", alignItems: "baseline", gap: 8, fontSize: 12.5, cursor: "pointer" } as const;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        paddingBottom: 12,
        borderBottom: "0.5px solid var(--border)",
      }}
    >
      <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        <legend style={{ padding: 0, marginBottom: 8, fontWeight: 600, color: "var(--ink)" }}>Sign in with</legend>
        <label style={radioRow}>
          <input
            type="radio"
            name="assistant-auth"
            value="login"
            aria-label="Claude login"
            checked={mode === "login"}
            onChange={() => setMode("login")}
            style={{ accentColor: "var(--accent)" }}
          />
          <span>
            Claude login <span style={muted}>(your Claude Code subscription; ignores ANTHROPIC_API_KEY)</span>
          </span>
        </label>
        <label style={radioRow}>
          <input
            type="radio"
            name="assistant-auth"
            value="api_key"
            aria-label="API key"
            checked={mode === "api_key"}
            onChange={() => setMode("api_key")}
            style={{ accentColor: "var(--accent)" }}
          />
          <span>
            API key <span style={muted}>(billed to your Anthropic API account)</span>
          </span>
        </label>
      </fieldset>
      {mode === "api_key" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 22, maxWidth: 460 }}>
          <input
            type="password"
            autoComplete="off"
            aria-label="Anthropic API key"
            placeholder={keyPlaceholder}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            style={AUTH_FIELD_STYLE}
          />
          <input
            aria-label="Workspace ID"
            placeholder="Workspace ID (only for keys not scoped to a workspace)"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            style={AUTH_FIELD_STYLE}
          />
          <span style={muted}>
            A saved key is stored in plain text in{" "}
            <code style={{ fontFamily: "var(--mono)" }}>~/.skill-vault/config.json</code>.
          </span>
          {noKey && (
            <span style={{ fontSize: 12, color: "var(--warn)" }}>
              No key found. Paste one, or set ANTHROPIC_API_KEY and restart the app.
            </span>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <Button
          kind="primary"
          size="sm"
          disabled={!dirty || noKey || save.isPending}
          onClick={() =>
            save.mutate({
              auth: mode,
              workspace_id: workspace.trim(),
              ...(key.trim() ? { api_key: key.trim() } : {}),
            })
          }
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {mode === "api_key" && data?.has_saved_key && (
          <Button kind="ghost" size="sm" disabled={save.isPending} onClick={() => save.mutate({ api_key: "" })}>
            Forget saved key
          </Button>
        )}
      </div>
    </div>
  );
}
