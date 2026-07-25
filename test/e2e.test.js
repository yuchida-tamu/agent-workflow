import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeature, selectScenarios, slug } from "../scripts/e2e/gherkin.js";
import { runScenarios } from "../scripts/e2e/runner.js";

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
