import { useEffect, useState } from "react";
import { setupApi, joinPath, repoNameFromUrl, type FolderInfo, type SetupVault, type VaultCandidate } from "../../../lib/setup";
import type { StepProps } from "../types";
import { ChoiceCard, FolderField, Hint, StepHeader, StepNav, inputStyle, labelStyle } from "../ui";

type Mode = SetupVault["mode"];

/** Plain-words summary of an inspected folder for the chosen mode; `ok` = Next may proceed. */
function describe(mode: Mode, info: FolderInfo | null): { text: string; tone: "info" | "good" | "warn" | "bad"; ok: boolean } | null {
  if (!info) return null;
  if (info.kind === "not_dir") return { text: "That's a file, not a folder.", tone: "bad", ok: false };
  if (info.kind === "unreadable") return { text: "Skill Vault can't open this folder. Check its permissions or pick another one.", tone: "bad", ok: false };
  if (!info.writable) return { text: "Skill Vault can't write to this folder.", tone: "bad", ok: false };
  if (mode === "new") {
    if (info.kind === "missing") return { text: "The folder will be created when you press Finish.", tone: "good", ok: true };
    if (info.kind === "empty") return { text: "Empty folder: the vault will be set up here.", tone: "good", ok: true };
    return { text: "This folder isn't empty. Pick an empty or new folder, or choose \"Use a folder I have\".", tone: "bad", ok: false };
  }
  switch (info.kind) {
    case "missing":
      return { text: "That folder doesn't exist.", tone: "bad", ok: false };
    case "vault":
      return { text: `Vault found: ${info.skill_count} skill${info.skill_count === 1 ? "" : "s"}.`, tone: "good", ok: true };
    case "vault_no_manifest":
      return { text: `${info.skill_count} skill folders and no skills.json yet: one will be created.`, tone: "good", ok: true };
    case "empty":
      return { text: "Empty folder: skills.json and a skills folder will be created.", tone: "good", ok: true };
    case "skills_folder":
      return {
        text: `This looks like a tool's skills folder (${info.skill_count} skills), not a vault. Add it as a target on the next step, and pick or create a separate vault folder here.`,
        tone: "bad",
        ok: false,
      };
    default:
      return { text: "skills.json and a skills folder will be created in this folder.", tone: "info", ok: true };
  }
}

export function VaultStep({ draft, commit, folderDialog }: StepProps) {
  const v = draft.vault;
  const [mode, setMode] = useState<Mode | null>(v?.mode ?? null);
  const [folder, setFolder] = useState(v && v.mode !== "clone" ? v.path : "");
  const [info, setInfo] = useState<FolderInfo | null>(null);
  const [url, setUrl] = useState(v?.clone?.url ?? "");
  const [parent, setParent] = useState(v?.clone ? v.clone.dest.replace(/[\\/][^\\/]+$/, "") : "");
  const [dest, setDest] = useState(v?.clone?.dest ?? "");
  const [destTouched, setDestTouched] = useState(Boolean(v?.clone));
  const [destInfo, setDestInfo] = useState<FolderInfo | null>(null);
  const [candidates, setCandidates] = useState<VaultCandidate[] | null>(v?.clone ? [{ subdir: v.clone.subdir, skill_names: v.clone.skill_names, notion: v.clone.notion }] : null);
  const [subdir, setSubdir] = useState<string | null>(v?.clone?.subdir ?? null);
  const [useAsNew, setUseAsNew] = useState(false);
  const [checking, setChecking] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [machineId, setMachineId] = useState(draft.machine_id ?? "");
  const [more, setMore] = useState(false);

  // Inspect the folder (new / existing) a moment after typing stops.
  useEffect(() => {
    if (mode === "clone" || !folder.trim()) {
      setInfo(null);
      return;
    }
    const t = setTimeout(() => {
      setupApi.inspect(folder.trim()).then(setInfo).catch(() => setInfo(null));
    }, 350);
    return () => clearTimeout(t);
  }, [mode, folder]);

  // Default clone destination: <parent>\<repo name>, until the user edits it.
  useEffect(() => {
    if (!destTouched && parent.trim() && url.trim()) setDest(joinPath(parent.trim(), repoNameFromUrl(url)));
  }, [parent, url, destTouched]);

  useEffect(() => {
    if (mode !== "clone" || !dest.trim()) {
      setDestInfo(null);
      return;
    }
    const t = setTimeout(() => {
      setupApi.inspect(dest.trim()).then(setDestInfo).catch(() => setDestInfo(null));
    }, 350);
    return () => clearTimeout(t);
  }, [mode, dest]);

  // A new URL means the old preview no longer applies.
  const changeUrl = (next: string) => {
    setUrl(next);
    setCandidates(null);
    setSubdir(null);
    setUseAsNew(false);
    setCloneError(null);
  };

  const folderState = mode && mode !== "clone" ? describe(mode, info) : null;
  const destOk = destInfo && (destInfo.kind === "missing" || destInfo.kind === "empty") && destInfo.writable;
  const picked = candidates?.find((c) => c.subdir === subdir) ?? null;

  const checkRepo = async () => {
    setChecking(true);
    setCloneError(null);
    try {
      const r = await setupApi.clonePreview(url.trim());
      setCandidates(r.candidates);
      setSubdir(r.candidates.length === 1 ? r.candidates[0].subdir : null);
    } catch (err) {
      setCloneError((err as Error).message);
      setCandidates(null);
    } finally {
      setChecking(false);
    }
  };

  const next = async () => {
    const machine_id = machineId.trim() || undefined;
    if (mode === "clone") {
      if (!candidates) return void (await checkRepo());
      const chosen = useAsNew ? { subdir: "", skill_names: [], notion: null } : picked;
      if (!chosen) return;
      const vault: SetupVault = {
        mode: "clone",
        path: joinPath(dest.trim(), chosen.subdir),
        clone: { url: url.trim(), dest: dest.trim(), subdir: chosen.subdir, skill_names: chosen.skill_names, notion: chosen.notion },
        repo_url: url.trim(),
      };
      await commit({ vault, machine_id }, "targets");
      return;
    }
    if (!mode) return;
    const samePath = v && v.mode !== "clone" && v.path === folder.trim();
    const repo_url = samePath ? v?.repo_url : (info?.git?.origin ?? undefined);
    await commit({ vault: { mode, path: folder.trim(), ...(repo_url ? { repo_url } : {}) }, machine_id }, "targets");
  };

  const cloneReady = Boolean(url.trim() && dest.trim() && destOk);
  const nextDisabled =
    !mode ||
    (mode === "clone"
      ? !cloneReady || (candidates !== null && !useAsNew && !picked)
      : !folder.trim() || !folderState?.ok);

  return (
    <div>
      <StepHeader title="Where your skills live">
        Your vault is the one folder that holds every skill. Skill Vault links each skill from here into the tools you use.
      </StepHeader>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
        <ChoiceCard selected={mode === "new"} onSelect={() => setMode("new")} title="Start a new vault" description="Pick an empty or new folder." />
        <ChoiceCard selected={mode === "existing"} onSelect={() => setMode("existing")} title="Use a folder I have" description="A vault you already use, or a folder to turn into one." />
        <ChoiceCard selected={mode === "clone"} onSelect={() => setMode("clone")} title="Clone from GitHub" description="Copy a vault repo to this PC, for a second computer or a shared team vault." />
      </div>

      {mode && mode !== "clone" && (
        <>
          <FolderField
            id="vault-folder"
            label="vault folder"
            value={folder}
            onChange={setFolder}
            folderDialog={folderDialog}
            dialogTitle={mode === "new" ? "Choose a folder for your new vault" : "Choose your vault folder"}
            placeholder="C:\\Users\\you\\skill-vault"
          />
          {folderState && <Hint tone={folderState.tone}>{folderState.text}</Hint>}
          {info?.git && (
            <Hint>
              Inside the git repo {info.git.root}
              {info.git.origin ? ` (${info.git.origin})` : ""}.
            </Hint>
          )}
        </>
      )}

      {mode === "clone" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label htmlFor="clone-url" style={labelStyle}>
              repo url
            </label>
            <input id="clone-url" type="text" value={url} onChange={(e) => changeUrl(e.target.value)} placeholder="https://github.com/you/skill-vault.git" style={inputStyle} />
          </div>
          <FolderField id="clone-parent" label="put it in" value={parent} onChange={setParent} folderDialog={folderDialog} dialogTitle="Choose where to put the cloned vault" placeholder="C:\\Github" />
          <div>
            <label htmlFor="clone-dest" style={labelStyle}>
              clone folder
            </label>
            <input
              id="clone-dest"
              type="text"
              value={dest}
              onChange={(e) => {
                setDest(e.target.value);
                setDestTouched(true);
              }}
              style={inputStyle}
            />
            {destInfo && !destOk && <Hint tone="bad">This folder must be new or empty.</Hint>}
          </div>
          {cloneError && <Hint tone="bad">{cloneError}</Hint>}
          {candidates && candidates.length === 1 && (
            <Hint tone="good">
              Vault found {candidates[0].subdir ? `in ${candidates[0].subdir}/` : "at the top of the repo"}: {candidates[0].skill_names.length} skills.
            </Hint>
          )}
          {candidates && candidates.length > 1 && (
            <div>
              <span style={labelStyle}>this repo has more than one vault: pick one</span>
              {candidates.map((c) => (
                <label key={c.subdir} style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0", color: "var(--ink)" }}>
                  <input type="radio" name="vault-subdir" checked={subdir === c.subdir} onChange={() => setSubdir(c.subdir)} />
                  {c.subdir}/ ({c.skill_names.length} skills)
                </label>
              ))}
            </div>
          )}
          {candidates && candidates.length === 0 && (
            <div>
              <Hint tone="warn">No vault (skills.json) in this repo.</Hint>
              <label style={{ display: "flex", gap: 8, fontSize: 13, marginTop: 6, color: "var(--ink)" }}>
                <input type="checkbox" checked={useAsNew} onChange={(e) => setUseAsNew(e.target.checked)} />
                Use it as a new vault anyway
              </label>
            </div>
          )}
          <Hint>The repo is only cloned when you press Finish. Checking it now uses a quick temporary copy.</Hint>
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <button type="button" onClick={() => setMore(!more)} style={{ background: "none", border: 0, padding: 0, color: "var(--ink-2)", fontSize: 12.5, cursor: "pointer" }}>
          {more ? "▾" : "▸"} More
        </button>
        {more && (
          <div style={{ marginTop: 10 }}>
            <label htmlFor="machine-id" style={labelStyle}>
              this pc's name
            </label>
            <input id="machine-id" type="text" value={machineId} onChange={(e) => setMachineId(e.target.value)} style={inputStyle} />
            <Hint>Used to tell your computers apart when you sync between them.</Hint>
          </div>
        )}
      </div>

      <StepNav onNext={next} nextLabel={mode === "clone" && !candidates ? "Check repo" : "Next"} nextDisabled={nextDisabled} busy={checking} />
    </div>
  );
}
