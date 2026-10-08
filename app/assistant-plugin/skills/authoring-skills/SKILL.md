---
name: authoring-skills
description: Use this skill when creating a new skill or improving an existing SKILL.md in the vault — writing frontmatter, crafting a trigger-rich description, structuring the body with progressive disclosure, splitting depth into references files, registering the new folder in the manifest, and reviewing against a quality checklist. Triggers: "create a skill", "write a SKILL.md", "make me a skill for X", "improve this skill's description", "why isn't my skill triggering", "skill best practices", "review my skill", "add a skill to the vault".
---

# Authoring skills in the vault

Write skills to the same standard the user's own skill-creator methodology
prescribes. See ./references/review-checklist.md for the full checklist and
anti-pattern list — run it on every create or improve.

## Creating a skill (mechanics first)

1. Gather intent: what should trigger it, what should it teach or do, one
   concrete example of use.
2. Write the folder — cwd IS the vault, so plain relative paths work:
   `skills/<name>/SKILL.md` (+ `references/`, `scripts/` only if earned).
3. **REGISTER it** — a hand-written folder is an orphan until it's in the
   manifest: `audit_vault` → find the orphan_folder issue →
   `fix_repair {kind:"orphan_folder", target:<path>, action:"add_to_manifest"}`.
4. Run the review checklist; fix what fails.
5. Offer next steps: `push_to_provider` to the user's agents; tags.

## Naming

Folder = `name:` frontmatter = kebab-case; gerund form preferred
(`processing-pdfs`, not `pdf-helper`); ≤64 chars; describes the capability,
not the tool.

## The description — the field that gates everything

Formula: start **"Use this skill when…"**, third person, then pack in ≥5
concrete trigger keywords and alternative phrasings a user would actually
type, then concrete coverage. ≤1024 chars. Test it: list five realistic user
requests — would each plausibly match words IN the description? If not, add
the missing phrasings.

Weak → strong example:
- ✗ "Helps with CSV files."
- ✓ "Use this skill when working with CSV files — exploring structure,
  filtering rows, selecting columns, joining datasets, or converting to
  JSON. Triggers: 'parse this CSV', 'filter the spreadsheet', 'join these
  tables', 'csv to json'."

## Body standard

- Imperative voice ("To X, do Y") — never second person, never first.
- 150–200 lines target; 500 hard max.
- Lead with the core workflow; recipes over prose; tables for decision
  matrices; zero filler ("this powerful skill…").
- Challenge every paragraph: does the agent NEED this to act? Cut context
  that's obvious or merely interesting.

## Progressive disclosure

Three loading levels: metadata (always loaded — why the description matters
most) → SKILL.md body (loads on trigger) → `references/` files (read only
when needed). Push depth down a level: detailed specs, long cookbooks, and
field tables go in `references/<intention-revealing-name>.md` with a
one-line pointer from the body ("See ./references/x.md for …"). Never
duplicate content across levels.

## Improving an existing skill

1. Read it fully. 2. Diagnose the DESCRIPTION first — a skill that never
triggers has a description problem, not a body problem. 3. Then structure
(body length, what belongs in references), then voice, then content gaps.
4. Make minimal edits in the author's voice — improve, don't rewrite
wholesale. 5. Report before/after for the description and what moved where.

## In-vault specifics

Hash normalization ignores line-ending churn, so edits won't false-trigger
update checks. If the skill was adopted from a source, content edits will
show as `local_changed` on future checks — tell the user that's expected.
A skill authored here can be pushed to every configured agent via
`push_to_provider`.
