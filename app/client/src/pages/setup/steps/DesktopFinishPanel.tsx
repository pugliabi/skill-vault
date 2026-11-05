/**
 * After Finish: what's left in Claude Desktop. Restart it (when this job
 * connected it), then install the skill-vault skill from the prompt or the
 * zip. Shown when the Agents step wasn't skipped and Desktop is connected,
 * or Connect was ticked and didn't go through.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../../../lib/api";
import { setupApi, type SetupDraft, type SetupEvent } from "../../../lib/setup";
import { Button } from "../../../components/ui/primitives";
import { Hint } from "../ui";

const errText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

const box = {
  marginTop: 16,
  background: "var(--surface)",
  border: "0.5px solid var(--border)",
  borderRadius: 8,
  padding: "14px 18px",
  fontSize: 13,
  color: "var(--ink)",
  lineHeight: 1.6,
} as const;

export function DesktopFinishPanel({ draft, events }: { draft: SetupDraft; events: SetupEvent[] }) {
  const agents = draft.agents;
  // Ask again after every job (a Retry adds events), so a fixed connect shows up.
  const { data } = useQuery({
    queryKey: ["setup-agents-after", events.length],
    queryFn: () => setupApi.agents(draft),
    enabled: agents !== null,
  });
  const copy = useMutation({
    mutationFn: async () => navigator.clipboard.writeText((await api.vaultSkillPrompt()).prompt),
    onSuccess: () => toast.success("Install prompt copied: paste it into a new Claude Desktop chat"),
    onError: (err) => toast.error(errText(err, "Couldn't copy the prompt")),
  });
  const zip = useMutation({
    mutationFn: () => api.vaultSkillZip(),
    onSuccess: () => toast.success("skill-vault.zip is ready: upload it in Claude Desktop"),
    onError: (err) => toast.error(errText(err, "Couldn't build the zip")),
  });

  if (!agents || !data) return null;
  const connected = data.desktop.state === "connected";
  if (!connected && !agents.desktop_connect) return null;

  if (!connected) {
    return (
      <div style={box}>
        <div style={{ fontWeight: 600 }}>Finish in Claude Desktop</div>
        <Hint tone="warn">Claude Desktop isn't connected yet. Press Retry failed items, or connect it later in Settings → Agent access.</Hint>
      </div>
    );
  }

  const connectedNow = events.some((e) => e.step === "desktop" && e.state === "done");
  return (
    <div style={box}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Finish in Claude Desktop</div>
      <ol style={{ margin: 0, paddingLeft: 20 }}>
        {connectedNow && (
          <li>
            Quit Claude Desktop from its tray icon (closing the window isn't enough), then open it again. It loads the vault tools only when it starts.
          </li>
        )}
        <li>
          In a new chat, paste the install prompt and save the skill Claude gives you.
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "8px 0 4px" }}>
            <Button size="sm" kind="primary" onClick={() => copy.mutate()} disabled={copy.isPending}>
              Copy install prompt
            </Button>
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>or</span>
            <Button size="sm" onClick={() => zip.mutate()} disabled={zip.isPending}>
              Download skill zip
            </Button>
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>and upload it in Claude Desktop → Settings → Capabilities → Skills.</span>
          </div>
        </li>
      </ol>
      <Hint>Claude Desktop then reads and saves skills in your vault, {data.vault_path}, the folder set in Settings.</Hint>
    </div>
  );
}
