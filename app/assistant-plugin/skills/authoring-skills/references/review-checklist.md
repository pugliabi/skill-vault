# Skill review checklist

Run every item on create AND improve. Report failures with the fix applied
or proposed.

## Frontmatter

- [ ] `name:` equals the folder name exactly; kebab-case; ≤64 chars;
      gerund/capability form (not `pdf-helper` / `x-utils`)
- [ ] `description:` starts "Use this skill when…"
- [ ] Third person throughout (no "I help you…")
- [ ] ≥5 concrete trigger keywords/phrasings a user would type
- [ ] Mentions the main alternative phrasings ("update", "check for
      updates", "sync from source" — not just one)
- [ ] ≤1024 characters
- [ ] Trigger test passes: five realistic user asks each match words
      present in the description

## Body

- [ ] Imperative voice; no second-person instruction, no self-reference
      ("this skill will…")
- [ ] ≤200 lines (hard max 500); if over, something belongs in references/
- [ ] Core workflow appears in the first screen; background (if any) last
- [ ] Recipes are copy-runnable: real commands, real tool names, real field
      names — nothing invented
- [ ] Decision logic is a table, not paragraphs
- [ ] No duplicated content between body and references
- [ ] Every references file is pointed to exactly once, with an
      intention-revealing one-line pointer

## Resources

- [ ] `references/` names are lowercase and intention-revealing
      (`tool-reference.md`, not `notes.md`)
- [ ] scripts/ only for genuinely reusable executables; assets/ only for
      output material — neither exists "just in case"

## Anti-patterns (reject on sight)

Vague descriptions ("This skill can help with…") · noun-pile names ·
trigger-free descriptions · monolith bodies with everything inline ·
background essays before the first actionable line · first person ·
generic reference names · content duplicated at two disclosure levels ·
absolute machine-specific paths in examples.

## In-vault finishing steps

- [ ] Folder registered in the manifest (audit_vault shows no orphan for it)
- [ ] SKILL.md name == folder confirmed (the /skill-names page would be empty
      for it)
- [ ] Offered: push to providers, tags
