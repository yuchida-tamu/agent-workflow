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
