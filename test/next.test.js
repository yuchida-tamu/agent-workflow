import { test } from "node:test";
import assert from "node:assert/strict";
import { DISPATCH, pickNext } from "../scripts/next/core.js";
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
