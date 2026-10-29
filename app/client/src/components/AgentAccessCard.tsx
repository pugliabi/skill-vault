/**
 * Settings → Agent access: connect Claude Desktop and Claude Code to the
 * vault tools, put the skill-vault skill in the vault, and show the shared
 * command for other agents (server: routes/agentAccess.ts).
 */
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import type { AgentAccessStatus } from "../lib/types";
import { Button, Rule } from "./ui/primitives";

const ENTRY_TEXT: Record<string, string> = {
  not_connected: "Not connected",
  connected: "Connected",
  broken: "Broken: the entry points at a file that's gone. Reconnect to fix it.",
  name_taken: 'Another MCP server is already named "skill-vault". Rename it to connect this one.',
  not_installed: "Claude Desktop isn't installed for this user.",
  unreadable: "Can't read the Claude Desktop config.",
  cli_missing: "Claude Code CLI not found.",
};

const SKILL_TEXT: Record<AgentAccessStatus["skill"]["state"], string> = {
  no_vault: "Set up a vault first.",
  not_in_vault: "Not in your vault yet.",
  in_vault: "In your vault.",
  update_available: "Update available: this app has a newer copy.",
  name_taken: 'Your vault already has a skill named "skill-vault" from somewhere else.',
};

const errText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

const MONO = { fontFamily: "var(--mono)", fontSize: 11.5 } as const;

function Row({ title, status, children }: { title: string; status: ReactNode; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 0", borderTop: "0.5px solid var(--border)" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", minWidth: 120 }}>{title}</span>
        <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{status}</span>
      </div>
      {children && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", paddingLeft: 130 }}>{children}</div>}
    </div>
  );
}

export function AgentAccessCard() {
  const qc = useQueryClient();
  const { data: s } = useQuery({ queryKey: ["agent-access"], queryFn: () => api.agentAccess() });
  const refresh = () => qc.invalidateQueries({ queryKey: ["agent-access"] });

  const run = (fn: () => Promise<unknown>, ok: string, fail: string) => ({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(ok);
      refresh();
    },
    onError: (err: unknown) => toast.error(errText(err, fail)),
  });

  const addSkill = useMutation({
    mutationFn: () => api.addVaultSkill(),
    onSuccess: (r) => {
      toast.success(r.pushed.length ? `Added; pushed to ${r.pushed.join(", ")}` : "skill-vault is up to date in your vault");
      for (const f of r.failed) toast.error(`Couldn't push to ${f.provider_id}: ${f.error}`);
      refresh();
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => toast.error(errText(err, "Couldn't add the skill")),
  });
  const zip = useMutation(run(() => api.vaultSkillZip(), "skill-vault.zip is ready: upload it in Claude Desktop", "Couldn't build the zip"));
  const prompt = useMutation({
    mutationFn: async () => navigator.clipboard.writeText((await api.vaultSkillPrompt()).prompt),
    onSuccess: () => toast.success("Install prompt copied: paste it into a Claude Desktop chat"),
    onError: (err) => toast.error(errText(err, "Couldn't copy the prompt")),
  });
  const desktopOn = useMutation(run(() => api.connectDesktop(), "Connected. Quit Claude Desktop from the tray icon and reopen it.", "Couldn't connect Claude Desktop"));
  const desktopOff = useMutation(run(() => api.disconnectDesktop(), "Disconnected Claude Desktop", "Couldn't disconnect Claude Desktop"));
  const codeOn = useMutation(run(() => api.connectClaudeCode(), "Connected Claude Code", "Couldn't connect Claude Code"));
  const codeOff = useMutation(run(() => api.disconnectClaudeCode(), "Disconnected Claude Code", "Couldn't disconnect Claude Code"));

  const notBuilt = s && !s.bridge_built ? "Build the app first" : undefined;
  const desktop = s?.claude_desktop;
  const code = s?.claude_code;

  return (
    <>
      <Rule label="Agent access" />
      <div
        style={{
          background: "var(--surface)",
          border: "0.5px solid var(--border)",
          borderRadius: 8,
          padding: "14px 18px",
          marginBottom: 22,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
          Let Claude Desktop, Claude Code and other agents save skills to your vault, load them, push them to your
          tools and run Notion syncs. The <code style={{ fontFamily: "var(--mono)" }}>skill-vault</code> skill tells
          them how.
        </p>

        <Row title="skill-vault skill" status={s ? `${SKILL_TEXT[s.skill.state]}${s.skill.targets.length ? ` Targets: ${s.skill.targets.join(", ")}.` : ""}` : "…"}>
          {(s?.skill.state === "not_in_vault" || s?.skill.state === "update_available") && (
            <Button size="sm" kind="primary" onClick={() => addSkill.mutate()} disabled={addSkill.isPending}>
              {s.skill.state === "update_available" ? "Update" : "Add to vault"}
            </Button>
          )}
        </Row>

        <Row
          title="Claude Desktop"
          status={desktop ? `${ENTRY_TEXT[desktop.state]}${desktop.error ? ` ${desktop.error}` : ""}` : "…"}
        >
          {desktop && desktop.state !== "not_installed" && desktop.state !== "unreadable" && desktop.state !== "name_taken" && (
            <>
              {desktop.state === "connected" ? (
                <Button size="sm" onClick={() => desktopOff.mutate()} disabled={desktopOff.isPending}>Disconnect</Button>
              ) : (
                <Button size="sm" kind="primary" onClick={() => desktopOn.mutate()} disabled={!!notBuilt || desktopOn.isPending} title={notBuilt}>
                  {desktop.state === "broken" ? "Reconnect" : "Connect"}
                </Button>
              )}
              <Button size="sm" onClick={() => zip.mutate()} disabled={zip.isPending}>Download skill zip</Button>
              <Button size="sm" onClick={() => prompt.mutate()} disabled={prompt.isPending}>Copy install prompt</Button>
            </>
          )}
        </Row>
        {desktop?.state === "connected" && (
          <p style={{ margin: "0 0 6px 130px", fontSize: 12, color: "var(--ink-3)" }}>
            After connecting, quit Claude Desktop from the tray icon and reopen it. Install the skill with the zip
            (Settings → Capabilities → Skills) or the prompt.
          </p>
        )}

        <Row title="Claude Code" status={code ? `${ENTRY_TEXT[code.state]}${code.reason ? ` (${code.reason})` : ""}` : "…"}>
          {code && code.state !== "cli_missing" && code.state !== "name_taken" &&
            (code.state === "connected" ? (
              <Button size="sm" onClick={() => codeOff.mutate()} disabled={codeOff.isPending}>Disconnect</Button>
            ) : (
              <Button size="sm" kind="primary" onClick={() => codeOn.mutate()} disabled={!!notBuilt || codeOn.isPending} title={notBuilt}>
                {code.state === "broken" ? "Reconnect" : "Connect"}
              </Button>
            ))}
        </Row>

        <Row title="Other agents" status="Agents with a shell can run the vault tools from the command line.">
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--ink-2)", lineHeight: 1.5 }}>
            <div>
              cmd / PowerShell: <code style={MONO}>{s?.command.windows ?? "…"}</code>
            </div>
            <div>
              sh / Git Bash / macOS / Linux: <code style={MONO}>{s?.command.posix ?? "~/.skill-vault/bin/skill-vault"}</code>
            </div>
            <div style={{ color: "var(--ink-3)" }}>
              <code style={MONO}>skill-vault tools</code> lists the tools. Give a tool its JSON arguments on stdin.
              Push the skill to the agent's targets as usual.
            </div>
          </div>
        </Row>
      </div>
    </>
  );
}
