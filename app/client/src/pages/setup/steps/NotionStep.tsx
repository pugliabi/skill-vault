import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../../../lib/api";
import { setupApi, type NotionRef } from "../../../lib/setup";
import { Button } from "../../../components/ui/primitives";
import type { StepProps } from "../types";
import { Hint, StepHeader, StepNav, labelStyle, listBox, rowStyle } from "../ui";

export function NotionStep({ draft, commit, goTo }: StepProps) {
  const qc = useQueryClient();
  const { data: status, refetch } = useQuery({ queryKey: ["notion-status"], queryFn: () => api.notionStatus() });
  const connected = Boolean(status?.connected);
  const { data: sources, error: sourcesError, isLoading: loadingSources } = useQuery({
    queryKey: ["notion-data-sources"],
    queryFn: () => api.notionDataSources(),
    enabled: connected,
  });
  const [current, setCurrent] = useState<NotionRef | null>(null);
  const [choice, setChoice] = useState<string | null>(draft.notion?.data_source_id ?? null);
  const [addLastEdited, setAddLastEdited] = useState(draft.notion?.add_last_edited ?? true);
  const [connecting, setConnecting] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  // Back from Notion's sign-in page: ?notion=connected | error&message=…
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const result = params.get("notion");
    if (!result) return;
    if (result === "connected") {
      toast.success("Notion connected");
      void qc.invalidateQueries({ queryKey: ["notion-status"] });
    } else {
      setSignInError(params.get("message") ?? "Notion sign-in didn't finish.");
    }
    history.replaceState(null, "", location.pathname);
  }, [qc]);

  // The database this vault already uses, if any (its notion.json).
  useEffect(() => {
    const v = draft.vault;
    if (!v) return;
    if (v.mode === "clone") setCurrent(v.clone?.notion ?? null);
    else setupApi.inspect(v.path).then((i) => setCurrent(i.notion)).catch(() => setCurrent(null));
  }, [draft.vault]);

  const connect = async () => {
    setConnecting(true);
    setSignInError(null);
    try {
      await setupApi.saveDraft({ ...draft, step: "notion" }); // the sign-in leaves this page
      const r = await api.notionConnect("setup");
      if (r.status === "redirect") window.location.href = r.url;
      else await refetch();
    } catch (err) {
      setSignInError((err as Error).message);
    } finally {
      setConnecting(false);
    }
  };

  const list = sources?.data_sources ?? [];
  const chosen = list.find((s) => s.id === choice) ?? null;
  const next = () =>
    commit(
      { notion: chosen ? { data_source_id: chosen.id, data_source_name: chosen.name, add_last_edited: addLastEdited } : null },
      "assistant",
    );

  return (
    <div>
      <StepHeader title="Notion (optional)">
        Keep a copy of your skills in a Notion database, so you can read and edit them there.
      </StepHeader>

      {current && (
        <Hint tone="good">
          This vault already uses the Notion database "{current.name || current.id}". It stays that way unless you pick another one.
        </Hint>
      )}
      {signInError && <Hint tone="bad">{signInError}</Hint>}

      {!connected && (
        <div style={{ marginTop: 16 }}>
          <Button kind="primary" onClick={connect} disabled={connecting}>
            {connecting ? "Opening Notion…" : "Connect Notion"}
          </Button>
          <Hint>Signing in saves the Notion sign-in on this PC right away. Everything else waits for Finish.</Hint>
        </div>
      )}

      {connected && (
        <div style={{ marginTop: 16 }}>
          <Hint tone="good">Notion is connected.</Hint>
          {loadingSources && <Hint>Looking for your Skills database…</Hint>}
          {sourcesError && <Hint tone="bad">{(sourcesError as Error).message}</Hint>}
          {list.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <span style={labelStyle}>skills database</span>
              <div style={listBox}>
                <label style={rowStyle}>
                  <input type="radio" name="notion-ds" checked={choice === null} onChange={() => setChoice(null)} />
                  {current ? "Keep the current one" : "Don't choose one now"}
                </label>
                {list.map((s) => (
                  <label key={s.id} style={rowStyle}>
                    <input type="radio" name="notion-ds" checked={choice === s.id} onChange={() => setChoice(s.id)} />
                    {s.name || s.id}
                  </label>
                ))}
              </div>
              {chosen && (
                <label style={{ display: "flex", gap: 8, fontSize: 13, marginTop: 10, color: "var(--ink)" }}>
                  <input type="checkbox" checked={addLastEdited} onChange={(e) => setAddLastEdited(e.target.checked)} />
                  Add a "Last edited" property (helps spot changes made in Notion)
                </label>
              )}
            </div>
          )}
          {!loadingSources && !sourcesError && list.length === 0 && (
            <Hint tone="warn">No Skills database found in your Notion workspace yet. You can set it up later in Settings → Notion.</Hint>
          )}
        </div>
      )}

      <StepNav onBack={() => goTo("skills")} onSkip={() => commit({ notion: null }, "assistant")} onNext={next} />
    </div>
  );
}
