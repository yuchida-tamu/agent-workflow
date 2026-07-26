import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATES,
  TRANSITIONS,
  gateFor,
  pendingGateFor,
  transitionsFrom,
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

test("pendingGateFor maps states to their comment-approvable gate", () => {
  assert.deepEqual(pendingGateFor("idea"), { gate: "G1", to: "spec" });
  assert.deepEqual(pendingGateFor("planned"), { gate: "G2", to: "ready" });
  assert.deepEqual(pendingGateFor("verified"), { gate: "G4", to: "released" });
  assert.equal(pendingGateFor("ready"), null);
  assert.equal(pendingGateFor("spec"), null);
});

test("all four gates sit on the right edges", () => {
  assert.equal(gateFor("idea", "spec"), "G1");
  assert.equal(gateFor("planned", "ready"), "G2");
  assert.equal(gateFor("in-review", "merged"), "G3");
  assert.equal(gateFor("verified", "released"), "G4");
  assert.equal(gateFor("ready", "in-progress"), null, "dispatch is ungated");
  assert.equal(gateFor("in-review", "in-progress"), null, "fix loop is ungated");
});

// --- release_kind: what `released` means for this repo ------------------------

test("release kinds that release keep verified → released and its G4", () => {
  for (const releaseKind of ["store", "tag"]) {
    assert.deepEqual(transitionsFrom("verified", { releaseKind }), ["released"]);
    assert.deepEqual(pendingGateFor("verified", { releaseKind }), { gate: "G4", to: "released" });
  }
});

test("release_kind none makes verified terminal", () => {
  assert.deepEqual(transitionsFrom("verified", { releaseKind: "none" }), []);
  assert.equal(pendingGateFor("verified", { releaseKind: "none" }), null);
});

test("release_kind none refuses verified → released, and says why", () => {
  assert.throws(
    () => planTransition(["state:verified"], "released", { releaseKind: "none" }),
    /release_kind is "none".*terminal/s
  );
});

test("release_kind none leaves every other transition alone", () => {
  const plan = planTransition(["state:in-review"], "merged", { releaseKind: "none" });
  assert.equal(plan.gate, "G3");
  assert.deepEqual(transitionsFrom("merged", { releaseKind: "none" }), ["verified"]);
});

test("omitting options preserves the pre-release_kind behaviour exactly", () => {
  assert.deepEqual(transitionsFrom("verified"), ["released"]);
  assert.deepEqual(pendingGateFor("verified"), { gate: "G4", to: "released" });
  assert.equal(planTransition(["state:verified"], "released").gate, "G4");
});
