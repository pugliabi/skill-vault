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
  auto-matching until relinked. **Settings → Notion** lists unlinked skills
  with a **Relink** button: it forgets the old link, and the next **Link
  skills** run matches the skill to a Notion page again (by name, like a
  skill that was never linked).
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
  appropriate action: re-create the Notion page, or (pull, page gone from
  Notion) delete the skill from the vault — it stays in history. A skill
  deleted from the vault can only be unlinked: Notion pages can't be moved
  to trash by the app itself (a Notion API limitation), so trash the page
  in Notion yourself.
- **Rename** rows come from either side. On **Push**, the vault folder was
  renamed since the last link/sync: running the row renames the Notion
  skill to match. On **Pull**, the skill was renamed in Notion (its title is
  a valid skill name and differs from the vault name): running the row
  renames the vault folder to the Notion title. Either way `SKILL.md`'s
  `name` field follows the new name, and a skill that was in sync before
  the rename stays in sync afterwards.

Nothing is written until you click **Run**, and only the rows you selected
are touched.

## Push selected skills

The bulk **Push to Notion** action on the Skills page pushes just the
skills you selected — a normal push, not a force. It uploads each selected
skill's vault changes and creates a Notion page for any selected skill that
doesn't have one yet. It never overwrites a Notion edit: a skill whose
Notion copy changed since the last sync (or that has never synced) is
reported as "Changed in Notion — resolve in Conflicts" and left alone.
Legacy, unlinked and folder-less skills are skipped with a reason, and a
skill with no vault changes is left as is. Each skill's outcome is shown
when the run finishes.

## Force push / force pull

Force actions skip the normal update flow and overwrite one side outright —
useful when you know which copy should win and don't want to review a diff.
They're available only from the Notion menu (**Force push…** / **Force
pull…**) and apply to every linked, non-legacy skill whose folder exists.
Every force action:

- Shows a confirmation with the number of linked skills it will touch
  before running.
- Saves the copy being overwritten to that skill's version history first —
  **nothing is ever lost**, even on a force overwrite.
- Never deletes a skill on either side. Skills without a folder, and legacy
  or unlinked links, aren't touched; a force pull also skips skills that
  are already in sync.

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

When Claude isn't available on this machine, or the change is too large for
a single Claude call, **Edit manually** opens the same review with each
differing file pre-filled with the vault copy for you to edit (compare it
with Notion's copy side by side), then **Apply** it the same way.

### Merge with Claude

This option only appears when a local `claude` CLI is available on the
machine running Skill Vault (checked automatically, cached briefly). If
Claude isn't installed or can't be launched, the button is hidden rather
than shown and failing, and **Edit manually** is offered instead.

**What's sent to Claude:** only the sections that actually differ between
the vault and Notion copies of a file — never a whole file, and never a
file that's identical on both sides. Sections that differ only in
formatting (whitespace, list markers, code-fence language tags, table
separator rows, emphasis style, HTML vs. Markdown emphasis, backslash
escapes) are resolved
automatically in the vault's favor and aren't sent to Claude at all, since
Notion is known to rewrite formatting on its own copies (see
[Known limitations](#known-notion-limitations)). Binary files and any file
too large to compare are excluded and must be resolved by picking a side.
If the combined size of what needs merging is too large for a single
Claude call, you'll be told to pick a side or use **Edit manually** instead.

**Nothing is written until you click Apply.** The merge is a preview: an
explanation of what changed on each side, a per-section recommendation, and
what the Claude call cost. You can flip any overlapping recommendation
between "keep vault" and "keep Notion", or edit a merged file by hand,
before applying — nothing round-trips to Claude again for that. Clicking
**Apply** writes the merged result to the vault (recorded in history as a
Claude-assisted merge, or as a regular vault edit if you flipped a
recommendation, edited by hand, or used Edit manually) and force-pushes it
to Notion in the same action.

Only one Notion action runs at a time: while a push, pull, force, link or
another resolution is running, Apply (and the Keep buttons) are refused
with "Another Notion job is running" — try again when it finishes.

If either side changed again while you were reviewing, Apply is rejected
and you're asked to refresh — the resolution is validated against the exact
vault and Notion versions you were looking at.

## Background Notion check

While the app is open with Notion connected, it periodically re-checks
Notion in the background (starting shortly after launch, then at a regular
interval) so status pills and the Conflicts count stay current without you
having to push or pull first. The check never runs while a push, pull,
force, link or conflict resolution is running, and it never writes to the
vault — it only updates what a skill's status is compared against. You can
also trigger a check on demand from **Notion ▾ → Check Notion now**, but it
is refused while a push, pull, force, link or conflict resolution job is
already running (try again once it finishes; opening a review page meanwhile
uses the last check's results).

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
  for merge — only Unlink (and then Relink) touches it.
