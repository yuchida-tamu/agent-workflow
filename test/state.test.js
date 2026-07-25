import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATES,
  TRANSITIONS,
  gateFor,
  planTransition,
  stateFromLabels,
} from "../scripts/state/machine.js";

test("every transition target is a known state", () => {
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    assert.ok(STATES.includes(from));
    for (const to of targets) assert.ok(STATES.includes(to), `${from} → ${to}`);
  }
});

test("state is read from labels, ignoring non-state labels", () => {
  assert.equal(stateFromLabels(["bug", "state:ready", "risk:low"]), "ready");
  assert.equal(stateFromLabels(["bug"]), null);
  assert.throws(() => stateFromLabels(["state:idea", "state:ready"]), /conflicting/);
});

test("planTransition computes the label edit", () => {
  const plan = planTransition(["state:in-review", "bug"], "merged");
  assert.deepEqual(plan, {
    from: "in-review",
    to: "merged",
    gate: "G3",
    add: ["state:merged"],
    remove: ["state:in-review"],
  });
});

test("illegal transitions throw", () => {
  assert.throws(() => planTransition(["state:idea"], "released"), /illegal transition/);
  assert.throws(() => planTransition([], "ready"), /can only enter "idea"/);
  assert.throws(() => planTransition(["state:ready"], "shipped"), /unknown state/);
});

test("unlabeled item enters the machine at idea, ungated", () => {
  const plan = planTransition([], "idea");
  assert.equal(plan.gate, null);
  assert.deepEqual(plan.add, ["state:idea"]);
});

test("all four gates sit on the right edges", () => {
  assert.equal(gateFor("idea", "spec"), "G1");
  assert.equal(gateFor("planned", "ready"), "G2");
  assert.equal(gateFor("in-review", "merged"), "G3");
  assert.equal(gateFor("verified", "released"), "G4");
  assert.equal(gateFor("ready", "in-progress"), null, "dispatch is ungated");
  assert.equal(gateFor("in-review", "in-progress"), null, "fix loop is ungated");
});
