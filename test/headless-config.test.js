import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HEADLESS_KEY,
  agentActionableStates,
  dispatchEnabled,
  headlessIssues,
  resolveHeadless,
  reviewEnabled,
} from "../scripts/headless/config.js";
import { DISPATCH } from "../scripts/next/core.js";
import { validateConfig } from "../init/config-schema.js";

const errors = (issues) => issues.filter((i) => i.level === "error");
const paths = (issues) => issues.map((i) => i.path);

// --- resolution: off unless explicitly true ----------------------------------

test("a config with no headless block answers false for every stage, and does not throw", () => {
  // Called from Actions entry points, where a throw is the loudest and least
  // useful way to fail. Absence is a first-class answer.
  for (const config of [{}, { [HEADLESS_KEY]: null }, undefined, null]) {
    const label = JSON.stringify(config);
    assert.equal(reviewEnabled(config), false, label);
    for (const state of agentActionableStates()) {
      assert.equal(dispatchEnabled(config, state), false, `${label} / ${state}`);
    }
  }
});

test("a malformed headless block resolves to off rather than to on", () => {
  // The asymmetry is the point: guessing permissively here means an unattended
  // agent nobody asked for.
  for (const raw of ["review", 1, true, ["review"], 0]) {
    const config = { [HEADLESS_KEY]: raw };
    assert.equal(reviewEnabled(config), false, JSON.stringify(raw));
    assert.equal(dispatchEnabled(config, "spec"), false, JSON.stringify(raw));
  }
});

test("only the boolean true enables a stage", () => {
  for (const truthy of ["true", 1, "yes", {}, []]) {
    assert.equal(reviewEnabled({ [HEADLESS_KEY]: { review: truthy } }), false, JSON.stringify(truthy));
  }
  assert.equal(reviewEnabled({ [HEADLESS_KEY]: { review: true } }), true);
});

test("enabling review leaves every dispatch stage off", () => {
  // The staged rollout is the contract: stage 1 shipping must not imply stage 2.
  const config = { [HEADLESS_KEY]: { review: true } };
  assert.equal(reviewEnabled(config), true);
  for (const state of agentActionableStates()) {
    assert.equal(dispatchEnabled(config, state), false, state);
  }
});

test("a dispatch flag enables exactly its own state", () => {
  const config = { [HEADLESS_KEY]: { dispatch: { spec: true } } };
  assert.equal(dispatchEnabled(config, "spec"), true);
  assert.equal(dispatchEnabled(config, "ready"), false);
  assert.equal(reviewEnabled(config), false);
});

test("resolveHeadless is total over the agent-actionable states", () => {
  // Callers never have to distinguish "absent" from "false".
  const resolved = resolveHeadless({});
  assert.deepEqual(Object.keys(resolved.dispatch).sort(), agentActionableStates().sort());
  assert.equal(
    Object.values(resolved.dispatch).every((v) => v === false),
    true,
  );
});

test("an unknown state is never enabled, whatever the config says", () => {
  assert.equal(dispatchEnabled({ [HEADLESS_KEY]: { dispatch: { merged: true } } }, "merged"), false);
});

// --- the stage list is derived, not restated ---------------------------------

test("agent-actionable states come from the dispatch table itself", () => {
  // A second list would let a state whose actor changes leave behind a flag that
  // can never fire. The dispatch table is the spec; this reads it.
  const expected = Object.keys(DISPATCH).filter((s) => DISPATCH[s].actor === "agent");
  assert.deepEqual(agentActionableStates(), expected);
  assert.equal(expected.includes("spec"), true);
  assert.equal(expected.includes("in-progress"), false, "no agent acts on in-progress");
});

// --- reporting: resolving to off and reporting the typo are different jobs ----

test("a valid config has nothing to report", () => {
  assert.deepEqual(headlessIssues({}), []);
  assert.deepEqual(headlessIssues({ [HEADLESS_KEY]: null }), []);
  assert.deepEqual(
    headlessIssues({ [HEADLESS_KEY]: { review: false, dispatch: { idea: false, spec: false, ready: false } } }),
    [],
  );
});

test("a non-object headless block is reported as an error", () => {
  for (const raw of ["review", 1, ["review"]]) {
    const issues = headlessIssues({ [HEADLESS_KEY]: raw });
    assert.equal(errors(issues).length, 1, JSON.stringify(raw));
    assert.equal(issues[0].path, HEADLESS_KEY);
  }
});

test("a stringly-typed flag resolves to off AND is reported", () => {
  // Both halves matter. Resolving to off keeps the runner safe; reporting is how
  // the human learns their flag did nothing.
  const config = { [HEADLESS_KEY]: { review: "true" } };
  assert.equal(reviewEnabled(config), false);
  assert.deepEqual(paths(errors(headlessIssues(config))), [`${HEADLESS_KEY}.review`]);
});

test("a flag on a state no agent acts on is an error, not a warning", () => {
  // Not merely unrecognised — unfireable. It reads as configured autonomy that
  // can never happen, which is worse than no flag at all.
  const issues = errors(headlessIssues({ [HEADLESS_KEY]: { dispatch: { "in-progress": true } } }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, `${HEADLESS_KEY}.dispatch.in-progress`);
  assert.match(issues[0].message, /no agent acts on state/);
});

test("an unrecognised headless sub-key is a warning, keeping the config extensible", () => {
  const issues = headlessIssues({ [HEADLESS_KEY]: { nightly: true } });
  assert.deepEqual(
    issues.map((i) => i.level),
    ["warn"],
  );
});

// --- integration with the config validator -----------------------------------

const validConfig = {
  platform: null,
  maturity: "steady",
  approvers: ["yuchida-tamu"],
  intake_questions: [],
  unmapped_criticality: "medium",
  unmapped_warn_fraction: 0.2,
  model_overrides: {},
};

test("validateConfig accepts a well-formed headless block", () => {
  assert.deepEqual(validateConfig({ ...validConfig, [HEADLESS_KEY]: { review: false } }), []);
});

test("validateConfig surfaces headless issues rather than swallowing them", () => {
  const issues = validateConfig({ ...validConfig, [HEADLESS_KEY]: { dispatch: { nope: true } } });
  assert.equal(
    errors(issues).some((i) => i.path === `${HEADLESS_KEY}.dispatch.nope`),
    true,
  );
});

test("headless is a known key, so it is never warned about as unrecognised", () => {
  const issues = validateConfig({ ...validConfig, [HEADLESS_KEY]: { review: false } });
  assert.equal(
    issues.some((i) => i.path === HEADLESS_KEY && i.level === "warn"),
    false,
  );
});

// --- what actually ships ------------------------------------------------------

test("the shipped template and this repo's own config both have every flag off", () => {
  // The additive promise: a scaffolded repo that sets nothing behaves exactly as
  // it does today.
  for (const path of ["init/templates/agentflow.config.json", "agentflow.config.json"]) {
    const config = JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
    assert.deepEqual(headlessIssues(config), [], path);
    assert.equal(reviewEnabled(config), false, path);
    for (const state of agentActionableStates()) {
      assert.equal(dispatchEnabled(config, state), false, `${path} / ${state}`);
    }
  }
});
