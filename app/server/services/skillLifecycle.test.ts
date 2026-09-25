import { test } from "node:test";
import assert from "node:assert/strict";
import { withSkillMdName } from "./skillLifecycle.ts";

test("withSkillMdName rewrites only the name line, keeping line endings", () => {
  assert.equal(withSkillMdName("---\nname: old\ndescription: d\n---\nbody\n", "new"), "---\nname: new\ndescription: d\n---\nbody\n");
  assert.equal(
    withSkillMdName("---\r\ndescription: d\r\nname: \"old\"\r\nx: 1\r\n---\r\nname: body\r\n", "new"),
    "---\r\ndescription: d\r\nname: new\r\nx: 1\r\n---\r\nname: body\r\n",
  );
  assert.equal(withSkillMdName("\uFEFF---\nname: old\n---\n", "new"), "\uFEFF---\nname: new\n---\n");
});

test("withSkillMdName adds a missing name and ignores files without frontmatter", () => {
  assert.equal(withSkillMdName("---\ndescription: d\n---\nb\n", "new"), "---\nname: new\ndescription: d\n---\nb\n");
  assert.equal(withSkillMdName("---\n---\nb\n", "new"), "---\nname: new\n---\nb\n");
  assert.equal(withSkillMdName("no frontmatter\nname: x\n", "new"), null);
  assert.equal(withSkillMdName("---\nname: same\n---\n", "same"), null);
});
