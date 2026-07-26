import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stateLabelsOn,
  childIsDone,
  shouldCloseParent,
  planSweep,
} from "../scripts/actions/parent-close.js";

test("stateLabelsOn finds only real state labels", () => {
  assert.deepEqual(stateLabelsOn(["state:merged", "priority:p1", "bug"]), ["state:merged"]);
  assert.deepEqual(stateLabelsOn(["state:not-a-state", "priority:p1"]), []);
  assert.deepEqual(stateLabelsOn([]), []);
  assert.deepEqual(stateLabelsOn(undefined), []);
});

test("a child is done when merged onward, or simply closed", () => {
  for (const state of ["merged", "verified", "released"]) {
    assert.equal(childIsDone({ state }), true, state);
  }
  assert.equal(childIsDone({ state: "in-review", closed: true }), true, "dropped, not merged");
  for (const state of ["idea", "spec", "planned", "ready", "in-progress", "in-review"]) {
    assert.equal(childIsDone({ state }), false, state);
  }
});

test("a verified parent with all children done is closed", () => {
  const verdict = shouldCloseParent({
    state: "verified",
    children: [{ number: 1, state: "merged" }, { number: 2, state: "released" }],
  });
  assert.equal(verdict.close, true);
  assert.match(verdict.reason, /all 2 child/);
});

test("a parent with any child still open is left alone, and says which", () => {
  const verdict = shouldCloseParent({
    state: "verified",
    children: [{ number: 1, state: "merged" }, { number: 7, state: "ready" }],
  });
  assert.equal(verdict.close, false);
  assert.match(verdict.reason, /#7/);
});

test("children being done is not enough — the parent must have reached verified", () => {
  for (const state of ["idea", "spec", "planned", "ready", "in-progress", "in-review", "merged"]) {
    const verdict = shouldCloseParent({ state, children: [{ number: 1, state: "merged" }] });
    assert.equal(verdict.close, false, state);
    assert.match(verdict.reason, /not verified/);
  }
});

test("a released parent is closeable too", () => {
  assert.equal(shouldCloseParent({ state: "released", children: [{ number: 1, state: "merged" }] }).close, true);
});

test("an issue with no children is not a parent", () => {
  const verdict = shouldCloseParent({ state: "verified", children: [] });
  assert.equal(verdict.close, false);
  assert.match(verdict.reason, /not a parent/);
});

test("an already-closed parent is not closed again", () => {
  const verdict = shouldCloseParent({
    state: "verified",
    closed: true,
    children: [{ number: 1, state: "merged" }],
  });
  assert.equal(verdict.close, false);
  assert.match(verdict.reason, /already closed/);
});

test("an unlabelled parent is never closed", () => {
  const verdict = shouldCloseParent({ state: null, children: [{ number: 1, state: "merged" }] });
  assert.equal(verdict.close, false);
  assert.match(verdict.reason, /unlabelled/);
});

test("every verdict carries a reason", () => {
  const cases = [
    { state: "verified", children: [{ number: 1, state: "merged" }] },
    { state: "ready", children: [] },
    { state: "verified", closed: true, children: [] },
    { state: null, children: [] },
  ];
  for (const c of cases) assert.ok(shouldCloseParent(c).reason.length > 0, JSON.stringify(c));
});

// --- sweep -------------------------------------------------------------------

test("sweep plans clearing state labels from closed issues only", () => {
  const plans = planSweep([
    { number: 1, closed: true, labels: ["state:spec", "priority:p1"] },
    { number: 2, closed: true, labels: ["state:merged"] },
    { number: 3, closed: false, labels: ["state:ready"] },
  ]);
  assert.deepEqual(plans, [
    { number: 1, remove: ["state:spec"] },
    { number: 2, remove: ["state:merged"] },
  ]);
});

test("sweep reports nothing for an already-clean repo", () => {
  assert.deepEqual(planSweep([{ number: 1, closed: true, labels: ["priority:p1"] }]), []);
  assert.deepEqual(planSweep([]), []);
  assert.deepEqual(planSweep(undefined), []);
});

test("sweep never touches an open issue's state label", () => {
  const plans = planSweep([{ number: 9, closed: false, labels: ["state:in-review"] }]);
  assert.deepEqual(plans, []);
});
