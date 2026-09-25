# Notion Sync

Skill Vault can two-way sync your skills with a Notion "Skills" database:
push vault changes to Notion, pull Notion changes into the vault, and
resolve conflicts either by picking a side or with Claude's help. This page
covers the Skill Vault App's Notion features end to end.

## Connect and link

From **Settings → Notion**, sign in and pick the Notion database (data
source) to use as your Skills source. Once connected, a **Notion ▾** menu
appears in the app toolbar.

Linking matches vault skills to Notion pages (by page ID, or by name during
an initial pass) and records the match on the skill. A link can be:

- **linked** — an ordinary two-way link to a Notion-native page.
- **legacy** — the Notion page looks like a converted summary copy of the
  vault skill rather than a full Notion-native page (see
  [Known limitations](#known-notion-limitations)). Legacy links are frozen:
  no push, pull, force, or merge ever touches them.
- **unlinked** — you disconnected the skill from Notion; it's excluded from
  auto-matching until relinked.
- **vault-only** — you marked the skill as intentionally not represented in
  Notion.

Every skill's sync status is one of: **synced**, **vault changed**, **Notion
changed**, **conflict**, **not in Notion**, **missing in Notion** (linked,
but the page can't be found), **vault-only**, **unlinked**, **legacy**, or
**unchecked** (no fresh Notion data yet — trigger a check). A skill that has
never been confirmed equivalent on both sides — including a first link where
content differed — starts life as a **conflict**, not as a neutral or
unknown state.

## Push and Pull review pages

**Notion ▾ → Push to Notion…** or **Pull from Notion…** opens a review page
listing every skill that differs, grouped as **Update · New · Rename ·
Deleted · Conflict**. Select the rows you want (checkboxes, group
select-all, `J`/`K` to move focus, `Space` to toggle), inspect a live
vault-vs-Notion diff for the selected row, and click **Run** to apply only
those rows.

- **Conflict** rows can't be run from here — they link out to the
  [Conflicts page](#conflicts-and-merge-with-claude).
- **Deleted** rows offer **Unlink** (always available), plus a direction-
  appropriate action: recreate the missing side, or remove/trash the
  side that's gone. Notion pages can't be moved to trash by the app itself
  (a Notion API limitation) — trashing has to be done in Notion, then
  Unlink here.
- **Rename** rows appear when a skill's vault folder name no longer matches
  what it was named at the last link/sync; running one renames the other
  side to match and keeps `SKILL.md`'s `name` field in sync.

Nothing is written until you click **Run**, and only the rows you selected
are touched.

## Force push / force pull

Force actions skip the normal update flow and overwrite one side outright —
useful when you know which copy should win and don't want to review a diff.
Available from the Notion menu (**Force push…** / **Force pull…**, applies
to every linked, non-legacy skill) and, for a specific selection, from the
bulk **Push to Notion** action on the Skills page. Every force action:

- Shows a confirmation with the exact number of skills affected before
  running.
- Saves the copy being overwritten to that skill's version history first —
  **nothing is ever lost**, even on a force overwrite.
- Never deletes a skill on either side; skills without a folder, without a
  page, or with a legacy/unlinked link are skipped with a reason shown in
  the confirmation, not silently dropped.

## Conflicts page and Merge with Claude

**Notion ▾ → Conflicts (N)** lists every skill that needs a decision:
linked, non-legacy skills that have never synced, or whose vault and Notion
copies have both changed since the last sync. Selecting one shows a
per-file diff (vault vs. Notion vs. the last common base) so you can see
exactly what moved on each side.

Three ways to resolve a conflict:

- **Keep vault** — force-pushes the vault's copy to Notion.
- **Keep Notion** — force-pulls Notion's copy into the vault.
- **Merge with Claude** — asks the local Claude CLI to help merge, file by
  file, section by section.

### Merge with Claude

This option only appears when a local `claude` CLI is available on the
machine running Skill Vault (checked automatically, cached briefly). If
Claude isn't installed or can't be launched, the button is hidden rather
than shown and failing.

**What's sent to Claude:** only the sections that actually differ between
the vault and Notion copies of a file — never a whole file, and never a
file that's identical on both sides. Sections that differ only in
formatting (whitespace, list markers, code-fence language tags, table
separator rows, smart quotes vs. plain, emphasis style) are resolved
automatically in the vault's favor and aren't sent to Claude at all, since
Notion is known to rewrite formatting on its own copies (see
[Known limitations](#known-notion-limitations)). Binary files and any file
too large to compare are excluded and must be resolved by picking a side.
If the combined size of what needs merging is too large for a single
Claude call, you'll be told to pick a side or edit manually instead.

**Nothing is written until you click Apply.** The merge is a preview: an
explanation of what changed on each side, a per-section recommendation, and
a running cost estimate. You can flip any individual recommendation between
"keep vault" and "keep Notion" before applying — nothing round-trips to
Claude again for that. Clicking **Apply** writes the merged result to the
vault (recorded in history as a Claude-assisted merge, or as a regular edit
if you changed a recommendation yourself) and force-pushes it to Notion in
the same action.

If either side changed again while you were reviewing, Apply is rejected
and you're asked to refresh — the resolution is validated against the exact
vault and Notion versions you were looking at.

## Background Notion check

While the app is open with Notion connected, it periodically re-checks
Notion in the background (starting shortly after launch, then at a regular
interval) so status pills and the Conflicts count stay current without you
having to push or pull first. The check never runs while you're actively
running a push, pull, or force action, and it never writes to the vault —
it only updates what a skill's status is compared against. You can also
trigger a check on demand from **Notion ▾ → Check Notion now**.

## Multi-device guard

If your vault is a git repository, Skill Vault checks it against its remote
before any Push/Pull run or force action: it fetches, then compares your
local `HEAD` to the upstream branch. If your vault is behind — meaning
another device may have pushed changes you don't have yet — the action is
blocked with a banner explaining how many commits you're behind, so you
don't sync from a stale copy. You can override and run anyway once you've
seen the banner; a fetch failure (offline, no upstream configured) is shown
as an informational note but never blocks anything on its own.

## Known Notion limitations

- **`SKILL.md` is regenerated from Notion's blocks on every download**, so
  formatting is rewritten to Notion's own conventions (code-fence language
  tags, list marker style, table separators, emphasis style, escaped
  characters). This is why merges compare content, not raw bytes, and why
  formatting-only differences are auto-resolved rather than shown to you.
- **Table cells containing a pipe (`|`) inside inline code can be
  truncated** by Notion when it converts a table back to Markdown. Double-
  check tables with code-in-cells after a pull.
- **Uploading to a Notion page never deletes files it previously held.** If
  you remove a supporting file from the vault side, the old copy stays
  attached to the Notion page after your next push — this is a limitation
  of the upload API, not a bug. Push review flags this so you know to clean
  it up in Notion by hand if needed.
- **Legacy pages are frozen.** A Notion page that looks like a converted
  summary of a vault skill (see `docs/vault-format.md` for the exact
  detection rule) is never pushed to, pulled from, force-synced, or offered
  for merge — only unlink/relink touches it.
