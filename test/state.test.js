import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATES,
  TRANSITIONS,
  gateFor,
  pendingGateFor,
  transitionsFrom,
  parentMayComplete,
  planTransition,
  stateFromLabels,
  resolveApply,
} from "../scripts/state/machine.js";
import { describeApply } from "../scripts/state/cli.js";

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

// --- parents complete when their children do ---------------------------------

test("a parent with all children done may go ready → verified", () => {
  const parent = { hasChildren: true, allChildrenDone: true };
  assert.ok(transitionsFrom("ready", { parent }).includes("verified"));
  const plan = planTransition(["state:ready"], "verified", { parent });
  assert.equal(plan.from, "ready");
  assert.equal(plan.to, "verified");
});

test("the parent edge is ungated — every child already cost a human a G3", () => {
  const plan = planTransition(["state:ready"], "verified", {
    parent: { hasChildren: true, allChildrenDone: true },
  });
  assert.equal(plan.gate, null);
});

test("a parent with any child still open cannot complete", () => {
  const parent = { hasChildren: true, allChildrenDone: false };
  assert.ok(!transitionsFrom("ready", { parent }).includes("verified"));
  assert.throws(() => planTransition(["state:ready"], "verified", { parent }), /illegal transition/);
});

test("a childless item cannot use the parent edge", () => {
  // The guard that keeps an ordinary work item's path untouched: without it,
  // anything at `ready` could skip implementation entirely.
  for (const parent of [{ hasChildren: false, allChildrenDone: true }, {}, null, undefined]) {
    assert.throws(
      () => planTransition(["state:ready"], "verified", { parent }),
      /illegal transition/,
      JSON.stringify(parent)
    );
  }
});

test("omitting the parent option preserves the ordinary path exactly", () => {
  assert.deepEqual(transitionsFrom("ready"), ["in-progress"]);
  assert.equal(planTransition(["state:ready"], "in-progress").to, "in-progress");
});

test("a parent keeps the ordinary edge too, in case it ever does open a PR", () => {
  const targets = transitionsFrom("ready", { parent: { hasChildren: true, allChildrenDone: true } });
  assert.deepEqual(targets.sort(), ["in-progress", "verified"]);
});

test("the parent edge applies only from ready", () => {
  const parent = { hasChildren: true, allChildrenDone: true };
  for (const state of ["idea", "spec", "planned", "in-progress", "in-review", "merged"]) {
    assert.ok(!transitionsFrom(state, { parent }).includes("verified") || state === "merged", state);
  }
});

// --- resolveApply: the compare-and-swap race matrix (#126) --------------------
//
// Two drivers — the manual CLI and the async gate workflow — can each decide
// to apply the same transition; `resolveApply` is what either one asks,
// against a freshly re-read label set, right before it writes. The matrix is
// from×to presence: {present,absent} × {present,absent}.

test("CAS: from present, to absent → apply, unchanged from the plan", () => {
  const plan = planTransition(["state:idea", "bug"], "spec");
  const resolution = resolveApply(["state:idea", "bug"], plan);
  assert.deepEqual(resolution, { action: "apply", add: ["state:spec"], remove: ["state:idea"] });
});

test("CAS: from absent, to already present → no-op, named as another driver's win", () => {
  const plan = planTransition(["state:idea"], "spec");
  // The fresh read shows the OTHER driver already landed this exact transition.
  const resolution = resolveApply(["state:spec", "bug"], plan);
  assert.equal(resolution.action, "noop");
  assert.match(resolution.note, /already applied by another driver/);
  assert.match(resolution.note, /state:spec is already present/);
});

test("CAS: both from and to present → heal — drop the stale from, keep to, say so", () => {
  // The exact #119 corruption: two drivers each wrote their half of the same
  // transition and both stuck. There is exactly one correct resolution.
  const plan = planTransition(["state:idea"], "spec");
  const resolution = resolveApply(["state:idea", "state:spec", "bug"], plan);
  assert.equal(resolution.action, "heal");
  assert.deepEqual(resolution.remove, ["state:idea"]);
  assert.equal(resolution.add, undefined, "the target is already there — nothing to add");
  assert.match(resolution.note, /both state:idea and state:spec were present/);
  assert.match(resolution.note, /removed the stale state:idea/);
});

test("CAS: neither from nor to present → refuses, naming exactly what was found", () => {
  // A third transition beat both drivers — the fresh read is `ready`, not the
  // `idea`/`spec` this plan was computed against.
  const plan = planTransition(["state:idea"], "spec");
  assert.throws(
    () => resolveApply(["state:ready", "bug"], plan),
    /cannot apply idea → spec: neither state:idea nor state:spec is present \(found: state:ready\)/
  );
});

test("CAS: neither present and no state label survives either → says 'none'", () => {
  const plan = planTransition(["state:idea"], "spec");
  assert.throws(() => resolveApply(["bug"], plan), /found: none/);
});

test("CAS: the unlabeled-entry plan (from: null) still resolves — to-absent applies", () => {
  const plan = planTransition([], "idea");
  const resolution = resolveApply(["bug"], plan);
  assert.deepEqual(resolution, { action: "apply", add: ["state:idea"], remove: [] });
});

test("CAS: the unlabeled-entry plan no-ops when another driver already labeled it", () => {
  const plan = planTransition([], "idea");
  const resolution = resolveApply(["state:idea"], plan);
  assert.equal(resolution.action, "noop");
  assert.match(resolution.note, /already applied by another driver/);
});

// --- describeApply: the CLI's own seam (cli.js apply, re-fetch + report) ------
//
// `resolveApply` is the decision, shared with gate-comment.js; `describeApply`
// is what `cli.js apply` does with it — the `gh` edit args (or none, for a
// no-op) and the JSON this command prints.

const plan = planTransition(["state:idea"], "spec");
const ctx = { plan, issue: "42", repoArgs: ["--repo", "o/r"] };

test("describeApply: apply → real edit args, plan echoed in the output", () => {
  const resolution = resolveApply(["state:idea"], plan);
  const { editArgs, output } = describeApply(resolution, ctx);
  assert.deepEqual(editArgs, ["issue", "edit", "42", "--repo", "o/r", "--add-label", "state:spec", "--remove-label", "state:idea"]);
  assert.equal(output.action, "apply");
  assert.deepEqual(output.applied, plan);
  assert.equal(output.note, null, "no note on a clean apply — nothing raced");
});

test("describeApply: no-op → no edit args at all, applied is null", () => {
  const resolution = resolveApply(["state:spec"], plan);
  const { editArgs, output } = describeApply(resolution, ctx);
  assert.equal(editArgs, null);
  assert.deepEqual(output, { applied: null, action: "noop", note: resolution.note, authorisedBy: null });
});

test("describeApply: heal → edit args only remove the stale label, no --add-label", () => {
  const resolution = resolveApply(["state:idea", "state:spec"], plan);
  const { editArgs, output } = describeApply(resolution, ctx);
  assert.deepEqual(editArgs, ["issue", "edit", "42", "--repo", "o/r", "--remove-label", "state:idea"]);
  assert.equal(output.action, "heal");
  assert.match(output.note, /both state:idea and state:spec were present/);
});

test("describeApply: authorisedBy is only reported on a real edit, and carries the auto-pass shape", () => {
  const resolution = resolveApply(["state:idea"], plan);
  const authorisedBy = { level: "low", require: [], block: [], matched: [] };
  const { output } = describeApply(resolution, { ...ctx, authorisedBy });
  assert.deepEqual(output.authorisedBy, { level: "low", auto: true });
});
