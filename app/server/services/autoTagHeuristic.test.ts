// The keyword fallback lives in the client bundle (it runs in the browser),
// but it is dependency-free, so it is tested here with the server suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSuggestions, diffTags, suggestTags } from "../../client/src/lib/autoTag.ts";
import type { Skill } from "../../client/src/lib/types.ts";

const sk = (name: string, description: string, tags: string[] = []) =>
  ({ name, description, tags }) as unknown as Skill;

test("Fabric skills get fabric, not cli, even with -cli names", () => {
  for (const [name, desc] of [
    ["dataflows-authoring-cli", "Author Microsoft Fabric Dataflow Gen2 items with the Fabric REST API."],
    ["dataflows-consumption-cli", "Run and monitor dataflows."],
    ["spark-authoring-cli", "Create Spark job definitions and notebooks."],
    ["eventhouse-consumption-cli", "Query KQL in an eventhouse."],
  ]) {
    const tags = suggestTags(sk(name, desc));
    assert.ok(tags.includes("fabric"), `${name}: ${tags}`);
    assert.ok(!tags.includes("cli"), `${name}: ${tags}`);
  }
});

test("Fabric migration and architecture skills are recognised from the description", () => {
  assert.ok(suggestTags(sk("databricks-migration", "Migrate Databricks workloads to Fabric lakehouses.")).includes("fabric"));
  assert.ok(suggestTags(sk("e2e-medallion-architecture", "Bronze/silver/gold medallion design.")).includes("fabric"));
});

test("powerbi no longer absorbs Fabric terms", () => {
  const t = suggestTags(sk("lakehouse-thing", "Load files into a lakehouse with OneLake."));
  assert.ok(t.includes("fabric"));
  assert.ok(!t.includes("powerbi"));
  assert.ok(suggestTags(sk("bpa-rules", "Author BPA rules for Power BI semantic models.")).includes("powerbi"));
});

test("an unrelated 'Fabric' model mention is not Fabric", () => {
  const t = suggestTags(sk("ai-video-generation", "Models: Veo, Seedance, OmniHuman, Fabric, HunyuanVideo."));
  assert.ok(!t.includes("fabric"), String(t));
});

test("cli only for skills that are about a command-line tool", () => {
  assert.ok(suggestTags(sk("authoring-clink-autocompletions", "Create Clink Lua tab completion scripts.")).includes("cli"));
  assert.ok(suggestTags(sk("opencli", "A command-line tool for web pages.")).includes("cli"));
  assert.ok(suggestTags(sk("cli-anything", "Build a harness for a GUI app.")).includes("cli"));
  // Merely mentioning a CLI is not enough.
  assert.ok(!suggestTags(sk("deploy-helper", "Deploys the site; run the CLI with --prod.")).includes("cli"));
  // Platform skills that are CLIs are tagged by platform.
  assert.ok(!suggestTags(sk("te2-cli", "CLI syntax reference for Tabular Editor 2.")).includes("cli"));
});

test("existing tags are excluded and untagged filter still applies", () => {
  const skills = [
    sk("spark-operations-cli", "Manage Spark sessions.", ["fabric"]),
    sk("sqldw-authoring-cli", "Author warehouse tables."),
  ];
  const rows = buildSuggestions(skills);
  assert.deepEqual(rows.map((r) => r.skill), ["sqldw-authoring-cli"]);
  assert.ok(rows[0].suggested.includes("fabric"));
  const all = buildSuggestions(skills, { onlyUntagged: false });
  assert.ok(!all.find((r) => r.skill === "spark-operations-cli")?.suggested.includes("fabric"));
});

test("diffTags splits a recommendation into adds and removals", () => {
  assert.deepEqual(diffTags(["cli", "data"], ["fabric", "data"]), { add: ["fabric"], remove: ["cli"] });
  assert.deepEqual(diffTags([], ["ai"]), { add: ["ai"], remove: [] });
  assert.deepEqual(diffTags(["ai"], ["ai"]), { add: [], remove: [] });
});

test("sqldb skills get fabric, not cli (prefix and 'in Fabric' phrasing)", () => {
  for (const [name, desc] of [
    ["sqldb-consumption-cli", "Query and explore a SQL database in Microsoft Fabric from the command line."],
    ["sqldb-operations-cli", "Manage SQL database in Fabric items: create, configure, monitor."],
    ["sqldb-authoring-cli", "Author tables and views."],
  ]) {
    const tags = suggestTags(sk(name, desc));
    assert.ok(tags.includes("fabric"), `${name}: ${tags}`);
    assert.ok(!tags.includes("cli"), `${name}: ${tags}`);
  }
  assert.ok(suggestTags(sk("mirroring-helper", "Replicate data into a warehouse in Fabric.")).includes("fabric"));
});

test("other Fabric families keep their expectations", () => {
  for (const [name, desc] of [
    ["dataflows-authoring-cli", "Author dataflows."],
    ["spark-operations-cli", "Manage Spark sessions."],
    ["sqldw-authoring-cli", "Author warehouse tables."],
    ["fabriciq-ontology-authoring-cli", "Author ontologies."],
  ]) {
    const tags = suggestTags(sk(name, desc));
    assert.ok(tags.includes("fabric"), `${name}: ${tags}`);
    assert.ok(!tags.includes("cli"), `${name}: ${tags}`);
  }
  assert.ok(suggestTags(sk("e2e-medallion-architecture", "Bronze/silver/gold medallion design.")).includes("fabric"));
  const te2 = suggestTags(sk("te2-cli", "CLI syntax reference for Tabular Editor 2."));
  assert.ok(te2.includes("powerbi") && !te2.includes("cli"), String(te2));
});

test("fallback suggestions are capped at 5", () => {
  const t = suggestTags(
    sk("kitchen-sink", "PDF, video, audio, image, Excel spreadsheet, Notion, Slack, GitHub and Docker in one."),
  );
  assert.ok(t.length <= 5, String(t));
});
