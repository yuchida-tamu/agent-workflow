import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeature, selectScenarios, slug } from "../scripts/e2e/gherkin.js";
import { runScenarios } from "../scripts/e2e/runner.js";
import {
  classifySuite,
  smokeOutcome,
  smokeSkipped,
  renderSmokeNote,
  EMPTY_SUITE,
  ZERO_TRACES,
  READY,
  SKIPPED,
} from "../scripts/e2e/smoke.js";
import { resolvePackDir, PLATFORM_PACK_DIRS } from "../scripts/e2e/pack.js";

const FEATURE = `
@checkout
Feature: Checkout

  # buyer happy path
  @smoke
  Scenario: Buyer completes a purchase
    Given a signed-in user with an item in the cart
    When the user taps "Checkout"
    And the user confirms payment
    Then the order confirmation screen is shown

  Scenario: Empty cart shows a hint
    Given a signed-in user with an empty cart
    Then the cart hint is shown
`;

test("parseFeature: tags, inheritance, And-keyword folding", () => {
  const f = parseFeature(FEATURE, "checkout.feature");
  assert.equal(f.name, "Checkout");
  assert.deepEqual(f.tags, ["@checkout"]);
  assert.equal(f.scenarios.length, 2);
  const [buy, empty] = f.scenarios;
  assert.deepEqual(buy.tags, ["@checkout", "@smoke"]);
  assert.deepEqual(empty.tags, ["@checkout"]);
  assert.deepEqual(
    buy.steps.map((s) => s.keyword),
    ["given", "when", "when", "then"],
    "And inherits the previous keyword"
  );
});

test("parseFeature: errors carry file and line", () => {
  assert.throws(() => parseFeature("Scenario: x", "f.feature"), /f\.feature:1: Scenario before Feature/);
  assert.throws(() => parseFeature("Feature: x\nwat"), /unrecognized line/);
});

test("selectScenarios filters by all given tags", () => {
  const features = [parseFeature(FEATURE)];
  assert.equal(selectScenarios(features, ["@smoke"]).length, 1);
  assert.equal(selectScenarios(features, ["@checkout"]).length, 2);
  assert.equal(selectScenarios(features, []).length, 2);
});

test("slug", () => {
  assert.equal(slug("Buyer completes a purchase"), "buyer-completes-a-purchase");
});

function makeFakes({ failOn = null, traces = {} } = {}) {
  const calls = [];
  return {
    calls,
    invoke: async (name, payload) => {
      calls.push({ name, op: payload.op });
      if (name === "run") return payload.op === "start" ? { session_id: "s1" } : { ok: true };
      const text = payload.step.text;
      return text === failOn
        ? { status: "failed", failure: { reason: "selector not found" } }
        : { status: "passed", duration_ms: 10 };
    },
    loadTrace: async (scenario) => traces[scenario.name] ?? null,
  };
}

const scenarios = () => selectScenarios([parseFeature(FEATURE)], []);
const fullTrace = (scenario) => ({
  steps: scenario.steps.map((s) => ({ keyword: s.keyword, text: s.text, trace: { actions: [], assertions: [] } })),
});

test("runner: all traces present and passing", async () => {
  const [buy, empty] = scenarios();
  const fakes = makeFakes({ traces: { [buy.name]: fullTrace(buy), [empty.name]: fullTrace(empty) } });
  const outcome = await runScenarios([buy, empty], fakes);
  assert.deepEqual(outcome.summary, { passed: 2, failed: 0, "needs-derivation": 0 });
});

test("runner: a failing step fails the scenario and stops the session anyway", async () => {
  const [buy] = scenarios();
  const fakes = makeFakes({
    failOn: 'the user taps "Checkout"',
    traces: { [buy.name]: fullTrace(buy) },
  });
  const outcome = await runScenarios([buy], fakes);
  assert.equal(outcome.results[0].status, "failed");
  const statuses = outcome.results[0].steps.map((s) => s.status);
  assert.deepEqual(statuses, ["passed", "failed", "skipped", "skipped"]);
  assert.equal(fakes.calls.filter((c) => c.name === "run" && c.op === "stop").length, 1);
});

test("runner: missing trace yields needs-derivation, later steps skipped", async () => {
  const [buy] = scenarios();
  const partial = { steps: fullTrace(buy).steps.slice(0, 1) };
  const outcome = await runScenarios([buy], makeFakes({ traces: { [buy.name]: partial } }));
  assert.equal(outcome.results[0].status, "needs-derivation");
  const statuses = outcome.results[0].steps.map((s) => s.status);
  assert.deepEqual(statuses, ["passed", "needs-derivation", "skipped", "skipped"]);
});

test("runner: no trace at all", async () => {
  const [buy] = scenarios();
  const outcome = await runScenarios([buy], makeFakes());
  assert.equal(outcome.results[0].status, "needs-derivation");
});

// --- post-merge smoke semantics ---------------------------------------------

test("classifySuite: a missing scenario directory is an empty suite, not an error", () => {
  const suite = classifySuite({ scenariosDirExists: false });
  assert.equal(suite.empty, true);
  assert.match(suite.reason, /no scenario directory/);
});

test("classifySuite: a directory with no .feature files is an empty suite", () => {
  const suite = classifySuite({ scenariosDirExists: true, featureFiles: [] });
  assert.equal(suite.empty, true);
  assert.match(suite.reason, /no \.feature files/);
});

test("classifySuite: any feature file means a real suite", () => {
  const suite = classifySuite({ scenariosDirExists: true, featureFiles: ["login.feature"] });
  assert.equal(suite.empty, false);
  assert.equal(suite.count, 1);
});

test("classifySuite defaults to an empty suite when told nothing", () => {
  assert.equal(classifySuite().empty, true);
});

// --- classifySuite: the third state, zero traces (#182) ----------------------
//
// Feature files present but nothing compiled is a distinct fact from "no
// scenarios were ever written" — conflating the two is what let a repo with
// six scenarios and zero traces look identical, at --verify time, to one with
// no suite at all. classifySuite pins all three states so nothing downstream
// has to re-derive the distinction from raw counts.

test("classifySuite: feature files with zero compiled traces is a distinct vacuous state", () => {
  const suite = classifySuite({ scenariosDirExists: true, featureFiles: ["a.feature"], traceCount: 0 });
  assert.equal(suite.empty, true);
  assert.equal(suite.kind, ZERO_TRACES);
  assert.notEqual(suite.kind, EMPTY_SUITE);
  assert.match(suite.reason, /0 compiled traces/);
});

test("classifySuite: feature files with compiled traces is READY — a real, replayable suite", () => {
  const suite = classifySuite({ scenariosDirExists: true, featureFiles: ["a.feature"], traceCount: 4 });
  assert.equal(suite.empty, false);
  assert.equal(suite.kind, READY);
});

test("classifySuite: traceCount omitted (null) keeps the old two-state behaviour", () => {
  // Callers that never check traces (older code, or contexts where it doesn't
  // apply) must not have their feature-files-only suite reclassified as
  // vacuous — this is what keeps the addition backward compatible.
  const suite = classifySuite({ scenariosDirExists: true, featureFiles: ["a.feature"] });
  assert.equal(suite.empty, false);
  assert.equal(suite.kind, READY);
});

test("classifySuite: no scenario dir, no feature files, and zero traces are three distinguishable kinds", () => {
  const noDir = classifySuite({ scenariosDirExists: false });
  const noFiles = classifySuite({ scenariosDirExists: true, featureFiles: [] });
  const zeroTraces = classifySuite({ scenariosDirExists: true, featureFiles: ["a.feature"], traceCount: 0 });
  const ready = classifySuite({ scenariosDirExists: true, featureFiles: ["a.feature"], traceCount: 1 });
  assert.equal(noDir.kind, EMPTY_SUITE);
  assert.equal(noFiles.kind, EMPTY_SUITE);
  assert.equal(zeroTraces.kind, ZERO_TRACES);
  assert.equal(ready.kind, READY);
  assert.deepEqual(new Set([zeroTraces.kind, ready.kind]).size, 2);
});

test("smoke: a zero-traces suite passes vacuously, distinctly labelled from an empty suite", () => {
  const outcome = smokeOutcome({
    suite: classifySuite({ scenariosDirExists: true, featureFiles: ["a.feature", "b.feature"], traceCount: 0 }),
  });
  assert.equal(outcome.status, "passed");
  assert.equal(outcome.vacuous, true);
  assert.equal(outcome.kind, ZERO_TRACES);
  assert.deepEqual(outcome.transition, { from: "merged", to: "verified" });
  assert.match(renderSmokeNote(outcome), /vacuous pass \(zero traces\)/);
});

// --- smokeSkipped: a READY suite that could not actually run (#182) ---------
//
// The bug this issue fixes: a real suite with no resolvable pack used to
// `process.exit(20)` above the transition loop, leaving the linked issue
// CLOSED but stuck at `state:in-review` forever. `smokeSkipped` is the
// pure decision for "record why, transition anyway, exit clean".

test("smokeSkipped: still transitions, exits clean, and names the reason", () => {
  const suite = classifySuite({ scenariosDirExists: true, featureFiles: ["a.feature"], traceCount: 2 });
  const outcome = smokeSkipped({ suite, reason: "no pack resolvable for platform (none configured)" });
  assert.equal(outcome.status, SKIPPED);
  assert.equal(outcome.skipped, true);
  assert.equal(outcome.vacuous, false, "there IS a suite here — this is not the same as an empty/vacuous pass");
  assert.deepEqual(outcome.transition, { from: "merged", to: "verified" });
  assert.match(outcome.note, /no pack resolvable/);
  assert.match(outcome.note, /transition was applied anyway/);
});

test("smokeSkipped: never confusable with a vacuous pass or a real pass/fail", () => {
  const suite = classifySuite({ scenariosDirExists: true, featureFiles: ["a.feature"], traceCount: 2 });
  const skipped = smokeSkipped({ suite, reason: "infra hiccup" });
  const vacuous = smokeOutcome({ suite: classifySuite({ featureFiles: [] }) });
  const passed = smokeOutcome({ suite, result: { summary: { passed: 1, failed: 0, "needs-derivation": 0 } } });
  assert.notEqual(skipped.kind, vacuous.kind);
  assert.notEqual(skipped.kind, passed.kind);
  assert.equal(skipped.status, SKIPPED);
  assert.notEqual(skipped.status, "passed");
  assert.notEqual(skipped.status, "failed");
});

test("renderSmokeNote: a skipped run reads as neither a pass nor a failure", () => {
  const suite = classifySuite({ scenariosDirExists: true, featureFiles: ["a.feature"], traceCount: 2 });
  const note = renderSmokeNote(smokeSkipped({ suite, reason: "no pack resolvable" }));
  assert.match(note, /skipped/i);
  assert.doesNotMatch(note, /✅/);
  assert.doesNotMatch(note, /❌/);
  assert.match(note, /Transition: `merged` → `verified`/);
});

test("smoke: an empty suite passes vacuously and transitions", () => {
  const outcome = smokeOutcome({ suite: classifySuite({ scenariosDirExists: false }) });
  assert.equal(outcome.status, "passed");
  assert.equal(outcome.vacuous, true);
  assert.equal(outcome.kind, EMPTY_SUITE);
  assert.deepEqual(outcome.transition, { from: "merged", to: "verified" });
});

test("smoke: a vacuous pass says so, so the record cannot overstate it", () => {
  const outcome = smokeOutcome({ suite: classifySuite({ featureFiles: [] }) });
  assert.match(outcome.note, /vacuously/);
  assert.match(outcome.note, /nothing was verified by replay/i);
  assert.match(renderSmokeNote(outcome), /vacuous pass \(empty suite\)/);
});

test("smoke: a real suite that passes transitions, and is not marked vacuous", () => {
  const suite = classifySuite({ featureFiles: ["a.feature"] });
  const result = { summary: { passed: 3, failed: 0, "needs-derivation": 0 } };
  const outcome = smokeOutcome({ suite, result });
  assert.equal(outcome.status, "passed");
  assert.equal(outcome.vacuous, false);
  assert.deepEqual(outcome.transition, { from: "merged", to: "verified" });
});

test("smoke: a real suite that fails blocks the transition", () => {
  const suite = classifySuite({ featureFiles: ["a.feature"] });
  const result = { summary: { passed: 1, failed: 2, "needs-derivation": 0 } };
  const outcome = smokeOutcome({ suite, result });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.transition, null);
  assert.match(renderSmokeNote(outcome), /Transition withheld/);
});

test("smoke: scenarios needing derivation also block", () => {
  const suite = classifySuite({ featureFiles: ["a.feature"] });
  const result = { summary: { passed: 1, failed: 0, "needs-derivation": 1 } };
  assert.equal(smokeOutcome({ suite, result }).status, "failed");
  assert.equal(smokeOutcome({ suite, result }).transition, null);
});

test("smoke: an empty suite and a failed suite are never confusable", () => {
  const empty = smokeOutcome({ suite: classifySuite({ featureFiles: [] }) });
  const failed = smokeOutcome({
    suite: classifySuite({ featureFiles: ["a.feature"] }),
    result: { summary: { passed: 0, failed: 1, "needs-derivation": 0 } },
  });
  assert.notEqual(empty.kind, failed.kind);
  assert.notEqual(empty.status, failed.status);
});

// --- resolvePackDir: toolkit-first, consumer-vendored fallback (#182) -------
//
// post-merge used to resolve `packs/` against the *consumer's* checkout,
// where nothing ever puts a pack — `agentflow-init adopt` does not vendor
// one, and no doc tells a human to. The pack actually lives in the toolkit.
// Pure: the caller supplies what it found on disk, so this needs no fs.

test("resolvePackDir: a mapped platform with the toolkit pack present resolves from the toolkit", () => {
  const resolved = resolvePackDir({
    platform: "rn-expo",
    toolkitRoot: "/toolkit",
    toolkitPacks: ["expo"],
    consumerPacks: [],
  });
  assert.equal(resolved.source, "toolkit");
  assert.equal(resolved.dir, "/toolkit/packs/expo");
});

test("resolvePackDir: with no toolkitRoot given, the toolkit pack resolves relative to cwd", () => {
  // Correct when this runs inside the toolkit's own checkout (dogfooding) —
  // there is no separate toolkit root to cross.
  const resolved = resolvePackDir({ platform: "rn-expo", toolkitPacks: ["expo"], consumerPacks: [] });
  assert.equal(resolved.dir, "packs/expo");
});

test("resolvePackDir: an unmapped or unconfigured platform never resolves from the toolkit", () => {
  assert.equal(resolvePackDir({ platform: "node-lib", toolkitPacks: ["expo"] }), null);
  assert.equal(resolvePackDir({ platform: null, toolkitPacks: ["expo"] }), null);
  assert.equal(resolvePackDir({ toolkitPacks: ["expo"] }), null);
});

test("resolvePackDir: a mapped platform whose toolkit pack is missing does not resolve from the toolkit", () => {
  // PLATFORM_PACK_DIRS says "rn-expo" -> "expo", but the toolkit checkout
  // itself doesn't have it (a stale ref, a partial checkout) — must not
  // fabricate a path that doesn't exist.
  const resolved = resolvePackDir({ platform: "rn-expo", toolkitPacks: [], consumerPacks: [] });
  assert.equal(resolved, null);
});

test("resolvePackDir: a consumer-vendored pack is a fallback, tried after the toolkit", () => {
  const resolved = resolvePackDir({ platform: "node-lib", toolkitPacks: ["expo"], consumerPacks: ["my-platform"] });
  assert.equal(resolved.source, "consumer");
  assert.equal(resolved.dir, "packs/my-platform");
});

test("resolvePackDir: the toolkit pack wins over a consumer-vendored one when both are present", () => {
  const resolved = resolvePackDir({
    platform: "rn-expo",
    toolkitRoot: "/toolkit",
    toolkitPacks: ["expo"],
    consumerPacks: ["some-other-pack"],
  });
  assert.equal(resolved.source, "toolkit");
});

test("resolvePackDir: nothing resolvable at all is null, not a throw", () => {
  assert.equal(resolvePackDir(), null);
  assert.equal(resolvePackDir({ platform: "rn-expo" }), null);
});

test("PLATFORM_PACK_DIRS: rn-expo maps to the expo pack directory", () => {
  assert.equal(PLATFORM_PACK_DIRS["rn-expo"], "expo");
});
