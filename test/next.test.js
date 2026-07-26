import { test } from "node:test";
import assert from "node:assert/strict";
import { DISPATCH, dispatchFor, pickNext } from "../scripts/next/core.js";
import { STATES } from "../scripts/state/machine.js";

const issue = (number, labels, createdAt = "2026-07-01T00:00:00Z", title = `issue ${number}`) => ({
  number,
  title,
  labels,
  createdAt,
});

test("dispatch table covers every state", () => {
  for (const state of STATES) assert.ok(DISPATCH[state], state);
});

test("picks by priority, then age", () => {
  const next = pickNext([
    issue(1, ["state:ready"], "2026-07-01T00:00:00Z"),
    issue(2, ["state:idea", "priority:p0"], "2026-07-20T00:00:00Z"),
    issue(3, ["state:spec", "priority:p0"], "2026-07-10T00:00:00Z"),
  ]);
  assert.equal(next.issue, 3, "same priority → older first");
  assert.equal(next.queue, 3);
  assert.equal(next.dispatch.who, "architect");
});

test("skips blocked, unlabeled, waiting, and conflicting issues", () => {
  const next = pickNext([
    issue(1, ["state:ready", "blocked"]),
    issue(2, ["bug"]),
    issue(3, ["state:in-progress"]),
    issue(4, ["state:idea", "state:ready"]),
    issue(5, ["state:merged"]),
  ]);
  assert.equal(next.issue, 5);
  assert.equal(next.queue, 1);
});

test("idle backlog returns null", () => {
  assert.equal(pickNext([issue(1, ["state:released"])]), null);
  assert.equal(pickNext([]), null);
});

test("dispatchFor: verified reads differently per release kind", () => {
  assert.match(dispatchFor("verified", { releaseKind: "store" }).action, /workflow_dispatch/);
  assert.match(dispatchFor("verified", { releaseKind: "tag" }).action, /agentflow-release tags/);
  assert.equal(dispatchFor("verified", { releaseKind: "none" }).actor, "none");
  assert.match(dispatchFor("verified", { releaseKind: "none" }).action, /no release step/);
});

test("dispatchFor: every other state is unaffected by release kind", () => {
  for (const state of STATES.filter((s) => s !== "verified")) {
    assert.deepEqual(dispatchFor(state, { releaseKind: "none" }), DISPATCH[state], state);
  }
});

test("dispatchFor defaults to the store wording, as before", () => {
  assert.deepEqual(dispatchFor("verified"), DISPATCH.verified);
});

test("pickNext carries the repo's release kind into its dispatch line", () => {
  const next = pickNext([issue(1, ["state:merged", "priority:p1"])], { releaseKind: "tag" });
  assert.equal(next.state, "merged");
  assert.deepEqual(next.dispatch, DISPATCH.merged);
});

test("a planned item whose verdict requires no gate dispatches to the script, not a human", () => {
  const waiting = dispatchFor("planned");
  const autopass = dispatchFor("planned", { g2Authorised: true });
  assert.equal(waiting.actor, "human");
  assert.equal(autopass.actor, "script");
  assert.match(autopass.action, /auto-pass/);
});

test("planned dispatch only auto-passes on an explicit true", () => {
  // null means "not yet determined" — a dispatcher that has not read the
  // verdict must report the human gate, never assume it can be skipped.
  for (const g2Authorised of [null, undefined, false]) {
    assert.equal(dispatchFor("planned", { g2Authorised }).actor, "human", String(g2Authorised));
  }
});

test("the dispatch table no longer promises a path that does not exist", () => {
  // It claimed "or auto-pass per risk verdict" while nothing implemented it.
  assert.doesNotMatch(DISPATCH.planned.action, /auto-pass/);
});

test("a parent with open children is never dispatched to an implementer", () => {
  // The visible face of the bug: the dispatcher told an implementer to build
  // #18, #45 and #50 — items whose work had already shipped.
  const d = dispatchFor("ready", { parent: { hasChildren: true, allChildrenDone: false, openChildren: [66, 67] } });
  assert.notEqual(d.who, "implementer");
  assert.match(d.action, /waiting on 2 child/);
  assert.match(d.action, /#66, #67/);
});

test("a parent whose children are done is dispatched to the script, not a human", () => {
  const d = dispatchFor("ready", { parent: { hasChildren: true, allChildrenDone: true } });
  assert.equal(d.actor, "script");
  assert.match(d.action, /verified/);
});

test("a childless ready item still goes to the implementer", () => {
  for (const parent of [{ hasChildren: false }, null, undefined]) {
    assert.equal(dispatchFor("ready", { parent }).who, "implementer", JSON.stringify(parent));
  }
});

test("parent facts do not leak into other states", () => {
  const parent = { hasChildren: true, allChildrenDone: false, openChildren: [1] };
  for (const state of STATES.filter((s) => s !== "ready" && s !== "verified")) {
    assert.deepEqual(dispatchFor(state, { parent }), DISPATCH[state], state);
  }
});
