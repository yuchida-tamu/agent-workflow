import { test } from "node:test";
import assert from "node:assert/strict";
import {
  labelCreateCommands,
  labelPlan,
  remainingItems,
  renderSummary,
  scaffoldSummary,
} from "../init/adopt.js";

const labelsDoc = {
  labels: [
    { name: "state:idea", color: "E8E5FB", description: "Intake: awaiting shaping" },
    { name: "priority:p1", color: "D93F0B", description: "Next up" },
    { name: "blocked", color: "000000", description: "Not dispatchable; see comments" },
  ],
};

const steps = [
  { from: "/tk/templates/agentflow.config.json", to: "/app/agentflow.config.json" },
  { from: "/tk/templates/domains.yml", to: "/app/domains.yml" },
  { dir: "/app/e2e/scenarios" },
];

test("labelPlan: every label missing → all created", () => {
  const plan = labelPlan(labelsDoc, []);
  assert.deepEqual(plan.create, ["state:idea", "priority:p1", "blocked"]);
  assert.deepEqual(plan.present, []);
});

test("labelPlan: every label already on the repo → none created", () => {
  const plan = labelPlan(labelsDoc, ["blocked", "state:idea", "bug", "priority:p1"]);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.present, ["state:idea", "priority:p1", "blocked"], "doc order, not repo order");
});

test("labelPlan: mixed → only the missing ones are created", () => {
  const plan = labelPlan(labelsDoc, ["blocked"]);
  assert.deepEqual(plan.create, ["state:idea", "priority:p1"]);
  assert.deepEqual(plan.present, ["blocked"]);
});

test("labelCreateCommands: additive — never --force, and only for the named labels", () => {
  const commands = labelCreateCommands(labelsDoc, ["priority:p1"], "o/r");
  assert.deepEqual(commands, [
    ["label", "create", "priority:p1", "--repo", "o/r", "--color", "D93F0B", "--description", "Next up"],
  ]);
  assert.ok(!commands.flat().includes("--force"), "adoption never rewrites a brownfield repo's labels");
});

test("labelCreateCommands: no --repo when none given", () => {
  assert.deepEqual(labelCreateCommands(labelsDoc, ["blocked"], undefined), [
    ["label", "create", "blocked", "--color", "000000", "--description", "Not dispatchable; see comments"],
  ]);
});

test("scaffoldSummary: nothing exists yet → every step is created", () => {
  const summary = scaffoldSummary(steps, []);
  assert.deepEqual(summary.created, ["/app/agentflow.config.json", "/app/domains.yml", "/app/e2e/scenarios"]);
  assert.deepEqual(summary.present, []);
});

test("scaffoldSummary: partially present → existing paths are present, never rewritten", () => {
  const summary = scaffoldSummary(steps, ["/app/domains.yml", "/app/e2e/scenarios"]);
  assert.deepEqual(summary.created, ["/app/agentflow.config.json"]);
  assert.deepEqual(summary.present, ["/app/domains.yml", "/app/e2e/scenarios"]);
});

test("scaffoldSummary: accepts a Set and keeps step order", () => {
  const summary = scaffoldSummary(steps, new Set(["/app/agentflow.config.json"]));
  assert.deepEqual(summary.created, ["/app/domains.yml", "/app/e2e/scenarios"]);
  assert.deepEqual(summary.present, ["/app/agentflow.config.json"]);
});

test("remainingItems: a fresh scaffold owes the domain map, platform, approvers, settings", () => {
  const items = remainingItems({
    config: { platform: "rn-expo", approvers: ["CHANGE_ME"] },
    domains: null,
  });
  assert.equal(items.length, 4);
  assert.match(items[0], /domains\.yml/);
  assert.match(items[1], /platform/);
  assert.match(items[2], /approvers/);
  assert.match(items[3], /repo settings/);
});

test("remainingItems: a configured repo owes only the manual repo settings", () => {
  const items = remainingItems({
    config: { platform: "web-next", approvers: ["yuchida-tamu"] },
    domains: { checkout: { criticality: "critical", paths: ["src/checkout/**"] } },
  });
  assert.deepEqual(items.map((i) => /repo settings/.test(i)), [true]);
});

test("remainingItems: an empty approver list is as unset as CHANGE_ME", () => {
  const of = (config) => remainingItems({ config, domains: { a: {} } }).join("\n");
  assert.match(of({ platform: "web", approvers: [] }), /approvers/);
  assert.match(of({ platform: "web" }), /approvers/);
  assert.match(of({ platform: "web", approvers: ["ok", "CHANGE_ME"] }), /approvers/);
  assert.doesNotMatch(of({ platform: "web", approvers: ["ok"] }), /approvers/);
});

test("remainingItems: an unreadable config owes everything it can't confirm", () => {
  const items = remainingItems({ config: null, domains: null });
  assert.match(items.join("\n"), /platform/);
  assert.match(items.join("\n"), /approvers/);
});

test("remainingItems: extra items are appended after the standing ones", () => {
  const items = remainingItems({
    config: { platform: "web", approvers: ["ok"] },
    domains: { a: {} },
    extra: ["labels not verified — gh label list failed"],
  });
  assert.equal(items.length, 2);
  assert.match(items[1], /labels not verified/);
});

test("renderSummary: sections print created · present · remaining, whatever the key order", () => {
  const out = renderSummary({
    remaining: ["repo settings not configured"],
    present: ["domains.yml"],
    created: ["agentflow.config.json", "label state:idea"],
  });
  const headings = out.split("\n").filter((l) => /^(created|present|remaining)\b/.test(l));
  assert.deepEqual(headings, ["created (2)", "present (1)", "remaining (1)"]);
  assert.ok(out.indexOf("agentflow.config.json") < out.indexOf("domains.yml"));
  assert.ok(out.indexOf("domains.yml") < out.indexOf("repo settings"));
});

test("renderSummary: empty sections still print, so a half-finished adoption is legible", () => {
  const out = renderSummary({ created: [], present: [], remaining: [] });
  assert.match(out, /created \(0\)/);
  assert.match(out, /present \(0\)/);
  assert.match(out, /remaining \(0\)/);
});

test("renderSummary: dry run says nothing was written", () => {
  assert.match(renderSummary({ created: ["a"], present: [], remaining: [], dryRun: true }), /dry run/);
  assert.doesNotMatch(renderSummary({ created: ["a"], present: [], remaining: [] }), /dry run/);
});
