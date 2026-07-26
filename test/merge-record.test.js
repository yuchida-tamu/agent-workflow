import { test } from "node:test";
import assert from "node:assert/strict";
import { stateOf, planMergeClose, renderMergeRecord, MARKER } from "../scripts/actions/merge-record.js";

test("stateOf reads the state label and ignores the rest", () => {
  assert.equal(stateOf(["priority:p1", "state:in-review"]), "in-review");
  assert.equal(stateOf(["priority:p1"]), null);
  assert.equal(stateOf([]), null);
  assert.equal(stateOf(undefined), null);
});

test("an in-review item completes its passage, then clears", () => {
  // Clearing alone would leave `in-review → (closed)` with no record of ever
  // reaching merged or verified — a gap the ledger audit would rightly flag.
  const p = planMergeClose({ labels: ["state:in-review"] });
  assert.deepEqual(p.transitions, ["merged", "verified"]);
  assert.equal(p.clearLabel, true);
});

test("an item already at merged only needs the rest of the passage", () => {
  const p = planMergeClose({ labels: ["state:merged"] });
  assert.deepEqual(p.transitions, ["verified"]);
});

test("an item elsewhere is cleared but not marched through states it never occupied", () => {
  const p = planMergeClose({ labels: ["state:ready"] });
  assert.deepEqual(p.transitions, [], "a truthful gap beats an invented history");
  assert.equal(p.clearLabel, true);
  assert.match(p.note, /not a state a merge completes/);
});

test("an item with no state label is left alone", () => {
  const p = planMergeClose({ labels: ["priority:p2"] });
  assert.deepEqual(p.transitions, []);
  assert.equal(p.clearLabel, false);
});

test("nothing happens when the close was not a merge", () => {
  const p = planMergeClose({ labels: ["state:in-review"], closedByMerge: false });
  assert.deepEqual(p.transitions, []);
  assert.equal(p.clearLabel, false);
});

test("running it twice is a no-op — it races parent-close --sweep harmlessly", () => {
  const first = planMergeClose({ labels: ["state:in-review"] });
  assert.equal(first.clearLabel, true);
  const second = planMergeClose({ labels: [] });
  assert.deepEqual(second.transitions, []);
  assert.equal(second.clearLabel, false);
});

// --- the record must never look like an approval -----------------------------

test("the record is an observation and says so", () => {
  const body = renderMergeRecord({
    prNumber: 65, mergedBy: "yuchida-tamu", headSha: "edf0cb3f3bfe",
    plan: planMergeClose({ labels: ["state:in-review"] }),
  });
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /Merged via #65/);
  assert.match(body, /@yuchida-tamu/);
  assert.match(body, /edf0cb3f/);
  assert.match(body, /observation of what happened, not an approval/);
});

test("the record can never be parsed as a gate approval", () => {
  // The sharpest edge here. `/approve G3` is a human's assertion and the gate
  // validator accepts it; anything the loop writes must be unmistakably not
  // that, or the loop could manufacture its own approvals.
  const bodies = [
    renderMergeRecord({ prNumber: 1, mergedBy: "x", headSha: "abc1234", plan: planMergeClose({ labels: ["state:in-review"] }) }),
    renderMergeRecord({ prNumber: 2, mergedBy: "y", headSha: "def5678", plan: planMergeClose({ labels: ["state:ready"] }) }),
  ];
  for (const body of bodies) {
    assert.doesNotMatch(body, /^\/approve/m, "must not start a line with /approve");
    assert.doesNotMatch(body, /^\/reject/m);
    for (const line of body.split("\n")) {
      assert.ok(!line.trim().startsWith("/"), `no line may begin with a slash command: ${line}`);
    }
  }
});

test("the record states the passage it completed, or why it did not", () => {
  const completed = renderMergeRecord({ prNumber: 1, mergedBy: "x", headSha: "abc", plan: planMergeClose({ labels: ["state:in-review"] }) });
  assert.match(completed, /Completed: `merged` → `verified`/);
  const skipped = renderMergeRecord({ prNumber: 1, mergedBy: "x", headSha: "abc", plan: planMergeClose({ labels: ["state:ready"] }) });
  assert.match(skipped, /No transition applied/);
});
