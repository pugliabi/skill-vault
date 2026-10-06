import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSuggestions, type SuggestionInputs } from "./suggestions.ts";
import type { Skill } from "../../types/vault.ts";

const NOW = new Date("2026-10-06T12:00:00Z");

function makeSkill(name: string, over: Partial<Skill> = {}): Skill {
  return {
    name,
    targets: ["claude"],
    tags: ["x"],
    stage: "production",
    source: "",
    file_count: 1,
    has_skill_md: true,
    description: "",
    modified_at: "2026-10-06T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    target_status: {},
    status: "synced",
    desktop_status: "not-packaged",
    origin: { type: "dir", path: "C:\\x", subpath: name, adopted_at: "2026-01-01T00:00:00Z", content_hash: "h" },
    ...over,
  } as Skill;
}

function base(over: Partial<SuggestionInputs> = {}): SuggestionInputs {
  return {
    skills: [],
    audit: [],
    nameMismatches: [],
    activity: [],
    sweep: null,
    dismissals: [],
    now: NOW,
    ...over,
  };
}

test("empty inputs produce no cards", () => {
  assert.deepEqual(composeSuggestions(base()), []);
});

test("sweep statuses map to the right cards with freshness, and ranking puts action tier first", () => {
  const inputs = base({
    skills: [
      makeSkill("a"),
      makeSkill("b"),
      makeSkill("c"),
      makeSkill("d", { status: "stale" }),
    ],
    sweep: {
      checked_at: "2026-10-06T08:00:00Z",
      vault_path: "C:\\vault",
      results: [
        { name: "a", status: "update_available" },
        { name: "b", status: "upstream_missing" },
        { name: "c", status: "conflict" },
        { name: "zz", status: "up_to_date" },
      ],
      guard: { ahead: 0, behind: 2 },
    },
  });
  const cards = composeSuggestions(inputs);
  const kinds = cards.map((c) => c.kind);
  assert.deepEqual(kinds, ["update_conflicts", "upstream_gone", "vault_behind", "updates_available", "stale_skills"]);
  const gone = cards.find((c) => c.kind === "upstream_gone")!;
  assert.equal(gone.severity, "action");
  assert.equal(gone.freshness, "2026-10-06T08:00:00Z");
  assert.deepEqual(gone.skills, ["b"]);
  assert.equal(gone.actions[0].type, "ask-ai");
  assert.match((gone.actions[0] as { prompt: string }).prompt, /set_origin/);
  const behind = cards.find((c) => c.kind === "vault_behind")!;
  assert.match((behind.actions[0] as { prompt: string }).prompt, /must NOT run git push\/pull/);
});

test("sweep rows already acted on (origin re-stamped after the sweep) are dropped", () => {
  const inputs = base({
    skills: [
      makeSkill("fixed", { origin: { type: "git", url: "u", subpath: "s", adopted_at: "2026-10-06T10:00:00Z", content_hash: "h" } }),
      makeSkill("still", { origin: { type: "git", url: "u", subpath: "s2", adopted_at: "2026-01-01T00:00:00Z", content_hash: "h" } }),
    ],
    sweep: {
      checked_at: "2026-10-06T08:00:00Z",
      vault_path: "C:\\vault",
      results: [
        { name: "fixed", status: "upstream_missing" },
        { name: "still", status: "upstream_missing" },
      ],
    },
  });
  const gone = composeSuggestions(inputs).find((c) => c.kind === "upstream_gone")!;
  assert.deepEqual(gone.skills, ["still"]);
  assert.equal(gone.count, 1);
});

test("failed_ops: 24h window, newest per kind+skill, failure chip carries entries", () => {
  const inputs = base({
    activity: [
      { at: "2026-10-04T12:00:00Z", kind: "push", skill: "old", ok: false, message: "too old" },
      { at: "2026-10-06T09:00:00Z", kind: "push", skill: "a", ok: false, message: "first" },
      { at: "2026-10-06T10:00:00Z", kind: "push", skill: "a", ok: false, message: "second" },
      { at: "2026-10-06T10:30:00Z", kind: "pull", skill: "b", ok: true },
      { at: "2026-10-06T11:00:00Z", kind: "update", skill: "c", ok: false, message: "boom" },
    ],
  });
  const [cardA] = composeSuggestions(inputs);
  assert.equal(cardA.kind, "failed_ops");
  assert.equal(cardA.count, 2); // push:a (deduped) + update:c
  const chip = (cardA.actions[0] as { chips: Array<{ data?: { entries?: Array<{ message?: string }> } }> }).chips[0];
  const messages = chip.data!.entries!.map((e) => e.message);
  assert.ok(messages.includes("second") && !messages.includes("first"), "newest per kind+skill wins");
});

test("notion cards derive from notion_status and stay disjoint (changed excludes conflicts)", () => {
  const inputs = base({
    skills: [
      makeSkill("c1", { notion_status: "conflict" }),
      makeSkill("v1", { notion_status: "changed-vault" }),
      makeSkill("n1", { notion_status: "changed-notion" }),
      makeSkill("n2", { notion_status: "changed-notion" }),
      makeSkill("l1", { notion_status: "legacy" }),
      makeSkill("m1", { notion_status: "missing-in-notion" }),
      makeSkill("ok", { notion_status: "synced" }),
    ],
  });
  const cards = composeSuggestions(inputs);
  const conflicts = cards.find((c) => c.kind === "notion_conflicts")!;
  assert.deepEqual(conflicts.skills, ["c1"]);
  const changed = cards.find((c) => c.kind === "notion_changed")!;
  assert.equal(changed.count, 3);
  assert.ok(!changed.skills!.includes("c1"));
  // More changed-notion than changed-vault → link points at the pull review.
  const link = changed.actions.find((a) => a.type === "link") as { href: string };
  assert.equal(link.href, "/notion/pull");
  assert.ok(cards.some((c) => c.kind === "notion_legacy"));
  assert.ok(cards.some((c) => c.kind === "notion_missing_page"));
});

test("skills list caps at 20 but count stays full", () => {
  const names = Array.from({ length: 30 }, (_, i) => `s${String(i).padStart(2, "0")}`);
  const inputs = base({ skills: names.map((n) => makeSkill(n, { status: "stale" })) });
  const stale = composeSuggestions(inputs).find((c) => c.kind === "stale_skills")!;
  assert.equal(stale.count, 30);
  assert.equal(stale.skills!.length, 20);
});

test("info-tier thresholds: untagged needs >=3; staging lingering needs >7 days", () => {
  const few = base({ skills: [makeSkill("a", { tags: [] }), makeSkill("b", { tags: [] })] });
  assert.ok(!composeSuggestions(few).some((c) => c.kind === "untagged"));

  const many = base({
    skills: [
      makeSkill("a", { tags: [] }),
      makeSkill("b", { tags: [] }),
      makeSkill("c", { tags: [] }),
      makeSkill("fresh-staging", { stage: "staging", modified_at: "2026-10-05T00:00:00Z" }),
      makeSkill("old-staging", { stage: "staging", modified_at: "2026-09-01T00:00:00Z" }),
    ],
  });
  const cards = composeSuggestions(many);
  assert.ok(cards.some((c) => c.kind === "untagged"));
  const lingering = cards.find((c) => c.kind === "staging_lingering")!;
  assert.deepEqual(lingering.skills, ["old-staging"]);
});

test("no_origin and desktop_outdated and audit and name mismatches emit", () => {
  const inputs = base({
    skills: [
      makeSkill("free", { origin: undefined }),
      makeSkill("packaged", { desktop_status: "outdated" }),
    ],
    audit: [
      { id: "1", kind: "orphan_folder", target: "T", description: "", fixes: [] },
      { id: "2", kind: "broken_link", target: "T2", description: "", fixes: [] },
    ],
    nameMismatches: [{ folder: "f", name: "n", name_is_valid: true, folder_exists_for_name: false, folder_is_valid: true }],
  });
  const kinds = composeSuggestions(inputs).map((c) => c.kind);
  assert.ok(kinds.includes("no_origin"));
  assert.ok(kinds.includes("desktop_outdated"));
  assert.ok(kinds.includes("audit_issues"));
  assert.ok(kinds.includes("name_mismatches"));
  const audit = composeSuggestions(inputs).find((c) => c.kind === "audit_issues")!;
  assert.match(audit.detail!, /1 orphan folder · 1 broken link/);
});

test("dismissals suppress, revive on fingerprint change, and expire after 7 days", () => {
  const skills = [makeSkill("a", { status: "stale" })];
  const card = composeSuggestions(base({ skills }))[0];

  // Fresh dismissal with the matching fingerprint → suppressed.
  const suppressed = composeSuggestions(
    base({ skills, dismissals: [{ id: card.id, fingerprint: card.fingerprint, at: "2026-10-05T12:00:00Z" }] }),
  );
  assert.deepEqual(suppressed, []);

  // Content changed (another stale skill) → fingerprint differs → revived.
  const revived = composeSuggestions(
    base({
      skills: [...skills, makeSkill("b", { status: "stale" })],
      dismissals: [{ id: card.id, fingerprint: card.fingerprint, at: "2026-10-05T12:00:00Z" }],
    }),
  );
  assert.equal(revived.length, 1);
  assert.equal(revived[0].count, 2);

  // Old dismissal (8 days) → expired → shown again.
  const expired = composeSuggestions(
    base({ skills, dismissals: [{ id: card.id, fingerprint: card.fingerprint, at: "2026-09-28T11:00:00Z" }] }),
  );
  assert.equal(expired.length, 1);
});

test("sweep cache from a different vault is ignored by gather (store-level) — composer trusts its input", () => {
  // Composer-level sanity: a null sweep yields no sweep cards even with skills present.
  const cards = composeSuggestions(base({ skills: [makeSkill("a")] }));
  assert.ok(!cards.some((c) => ["updates_available", "upstream_gone", "update_conflicts", "vault_behind"].includes(c.kind)));
});
