import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { setupApi, type SkillsPlan } from "../../../lib/setup";
import { SelectAllControl, useChecklistSelection } from "../../../components/Checklist";
import type { StepProps } from "../types";
import { Hint, StepHeader, StepNav, labelStyle, listBox, rowStyle } from "../ui";

function Checklist({
  title,
  rows,
  picked,
  setPicked,
}: {
  title: string;
  rows: { key: string; label: string; detail: string }[];
  picked: Set<string>;
  setPicked: (s: Set<string>) => void;
}) {
  const keys = rows.map((r) => r.key);
  const sel = useChecklistSelection(keys, picked, setPicked);
  if (rows.length === 0) return null;
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
        <span style={{ ...labelStyle, marginBottom: 0, flex: 1 }}>
          {title} ({picked.size} of {rows.length})
        </span>
        <SelectAllControl selection={sel} />
      </div>
      <div style={listBox}>
        {rows.map((r) => (
          <label key={r.key} style={{ ...rowStyle, cursor: "pointer" }} onClick={(e) => { e.preventDefault(); sel.onItemClick(r.key, e); }}>
            <input type="checkbox" readOnly checked={picked.has(r.key)} />
            <span style={{ flex: 1 }}>{r.label}</span>
            <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{r.detail}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function SkillsStep({ draft, commit, goTo }: StepProps) {
  const { data: plan, error, isLoading } = useQuery<SkillsPlan>({
    queryKey: ["setup-plan", draft.vault, draft.targets],
    queryFn: () => setupApi.plan(draft),
  });
  const [adopt, setAdopt] = useState<Set<string> | null>(null);
  const [push, setPush] = useState<Set<string> | null>(null);

  // First visit: everything ticked. Once reviewed, come back with exactly the saved picks
  // (possibly none), so declined skills stay declined and new candidates start unticked.
  useEffect(() => {
    if (!plan || adopt) return;
    const reviewed = draft.skills_reviewed === true;
    setAdopt(new Set(reviewed ? draft.skills.adopt.map((a) => a.name) : plan.adopt.map((a) => a.name)));
    setPush(new Set(reviewed ? draft.skills.push : plan.push.map((p) => p.name)));
  }, [plan, adopt, draft.skills, draft.skills_reviewed]);

  const next = () => {
    if (!plan || !adopt || !push) return;
    void commit(
      {
        skills: {
          adopt: plan.adopt.filter((a) => adopt.has(a.name)).map((a) => ({ name: a.name, from: a.from })),
          push: plan.push.filter((p) => push.has(p.name)).map((p) => p.name),
        },
        skills_reviewed: true,
      },
      "notion",
    );
  };

  const nothing = plan && plan.adopt.length === 0 && plan.push.length === 0;

  return (
    <div>
      <StepHeader title="Bring your skills together">
        Nothing moves until you press Finish. Untick anything you'd rather leave where it is, or skip this step.
      </StepHeader>

      {isLoading && <Hint>Comparing your vault and your tools…</Hint>}
      {error && <Hint tone="bad">{(error as Error).message}</Hint>}
      {nothing && <Hint tone="good">Nothing to move: your vault and your tools already match.</Hint>}

      {plan && adopt && push && (
        <>
          <Checklist
            title="in your tools, not in the vault: adopt"
            rows={plan.adopt.map((a) => ({ key: a.name, label: a.name, detail: `from ${a.from}` }))}
            picked={adopt}
            setPicked={setAdopt}
          />
          <Checklist
            title="in the vault, not in your default tools: push"
            rows={plan.push.map((p) => ({ key: p.name, label: p.name, detail: `to ${p.missing_in.join(", ")}` }))}
            picked={push}
            setPicked={setPush}
          />
          {(plan.differs.length > 0 || plan.adopt_conflicts.length > 0) && (
            <div>
              <span style={labelStyle}>left alone: sort these out later on the Adopt page</span>
              <div style={listBox}>
                {plan.differs.map((d) => (
                  <div key={`${d.name}:${d.target}`} style={rowStyle}>
                    <span style={{ flex: 1 }}>{d.name}</span>
                    <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                      {d.unknown ? `also in ${d.target}; compare after cloning` : `different in ${d.target}`}
                    </span>
                  </div>
                ))}
                {plan.adopt_conflicts.map((c) => (
                  <div key={c.name} style={rowStyle}>
                    <span style={{ flex: 1 }}>{c.name}</span>
                    <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>different in {c.targets.join(" and ")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <StepNav onBack={() => goTo("targets")} onSkip={() => commit({ skills: { adopt: [], push: [] }, skills_reviewed: true }, "notion")} onNext={next} nextDisabled={!plan} />
    </div>
  );
}
