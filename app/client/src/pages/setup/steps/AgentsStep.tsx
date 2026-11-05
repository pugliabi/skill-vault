/**
 * The Agents step: add the skill-vault skill to the vault and connect
 * Claude Desktop, both applied at Finish
 * (docs/superpowers/specs/2026-11-05-setup-agents-step-design.md).
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { setupApi, type DesktopState } from "../../../lib/setup";
import type { StepProps } from "../types";
import { Hint, StepHeader, StepNav, listBox } from "../ui";

const DESKTOP_TEXT: Record<DesktopState, string> = {
  not_connected: "Not connected.",
  broken: "The connection points at a file that's gone.",
  connected: "Already connected.",
  not_installed: "Claude Desktop isn't installed for this user.",
  name_taken: 'Claude Desktop already has another MCP server named "skill-vault". Rename it to connect this one.',
  unreadable: "Can't read the Claude Desktop config.",
};

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ padding: "10px 14px", borderTop: "0.5px solid var(--border)", fontSize: 13, color: "var(--ink)" }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

function Tick({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: disabled ? "default" : "pointer", color: disabled ? "var(--ink-3)" : "var(--ink)" }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

export function AgentsStep({ draft, commit, goTo }: StepProps) {
  const { data: status, error, isLoading } = useQuery({
    queryKey: ["setup-agents", draft.vault, draft.targets, draft.skills.adopt],
    queryFn: () => setupApi.agents(draft),
  });
  // First visit (or after Skip): what's offered starts ticked. Otherwise the saved choice.
  const [addSkill, setAddSkill] = useState(draft.agents ? draft.agents.add_skill : true);
  const [connect, setConnect] = useState(draft.agents ? draft.agents.desktop_connect : true);

  const skillOffered = status?.skill.state === "not_in_vault";
  const desktop = status?.desktop;
  const desktopOffered = desktop?.state === "not_connected" || desktop?.state === "broken";
  const desktopUsable = desktopOffered && status?.bridge_built === true;

  const next = () =>
    commit({ agents: { add_skill: Boolean(skillOffered && addSkill), desktop_connect: Boolean(desktopUsable && connect) } }, "review");

  const defaults = status?.default_targets ?? [];

  return (
    <div>
      <StepHeader title="Claude Desktop and other agents (optional)">
        Let Claude Desktop and your other AI tools work with your vault: find and load skills, save new ones, push them to your tools and run Notion syncs.
      </StepHeader>

      {error && <Hint tone="warn">{error instanceof Error ? error.message : "Couldn't check Claude Desktop and the vault."}</Hint>}
      {isLoading && <Hint>Checking…</Hint>}

      {status && (
        <div style={{ ...listBox, maxHeight: "none", padding: 0 }}>
          <Row title="The skill-vault skill">
            {skillOffered ? (
              <>
                <Tick checked={addSkill} onChange={setAddSkill}>Add it to my vault</Tick>
                <Hint>
                  It tells agents how to use your vault.{" "}
                  {defaults.length ? `It's also pushed to your default tools: ${defaults.join(", ")}.` : "You can push it to your tools later."}
                </Hint>
              </>
            ) : status.skill.state === "adopting" ? (
              <Hint>You're adopting skill-vault from {status.skill.adopting_from} on the Skills step.</Hint>
            ) : (
              <Hint tone="good">Already in your vault.</Hint>
            )}
          </Row>

          <Row title="Claude Desktop">
            {desktop && desktopOffered ? (
              <>
                <Tick checked={connect && desktopUsable} disabled={!status.bridge_built} onChange={setConnect}>
                  {desktop.state === "broken" ? "Reconnect Claude Desktop" : "Connect Claude Desktop"}
                </Tick>
                {!status.bridge_built && <Hint tone="warn">Build the app first.</Hint>}
                {desktop.state === "broken" && <Hint tone="warn">{DESKTOP_TEXT.broken}</Hint>}
                <Hint>
                  Adds a skill-vault server to Claude Desktop's settings. Your other servers stay as they are, and the file is backed up first. You'll
                  restart Claude Desktop after Finish.
                </Hint>
              </>
            ) : desktop ? (
              <Hint tone={desktop.state === "connected" ? "good" : desktop.state === "not_installed" ? "info" : "warn"}>
                {desktop.state === "unreadable"
                  ? `${DESKTOP_TEXT.unreadable.replace(/\.$/, "")}: ${(desktop.error ?? "unknown error")
                      .replace(/\s*Fix it, then try again\.\s*$/, "")
                      .replace(/\.\s*$/, "")}. Fix the file, then come back to this step.`
                  : DESKTOP_TEXT[desktop.state]}
              </Hint>
            ) : null}
          </Row>
        </div>
      )}

      <StepNav onBack={() => goTo("assistant")} onSkip={() => commit({ agents: null }, "review")} onNext={next} nextDisabled={isLoading} />
    </div>
  );
}
