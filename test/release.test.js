import { test } from "node:test";
import assert from "node:assert/strict";
import { tagFor, findG4Approval, planRelease } from "../scripts/release/core.js";

const authorized = ["alice"];
const approvalComments = [{ author: "alice", body: "/approve G4" }];

const base = {
  releaseKind: "tag",
  state: "verified",
  version: "0.1.0",
  existingTags: [],
  comments: approvalComments,
  authorized,
};

test("tagFor prefixes a bare version, and leaves a prefixed one alone", () => {
  assert.equal(tagFor("0.1.0"), "v0.1.0");
  assert.equal(tagFor("v0.1.0"), "v0.1.0");
});

test("tagFor refuses a missing version", () => {
  for (const version of [undefined, null, "", "   ", 3]) {
    assert.throws(() => tagFor(version), /no version to release/);
  }
});

// --- the approval must be real ----------------------------------------------

test("an approval from an authorized approver is found", () => {
  const approval = findG4Approval({ comments: approvalComments, authorized, releaseKind: "tag" });
  assert.equal(approval.approver, "alice");
});

test("an approval from anybody else is not an approval", () => {
  const approval = findG4Approval({
    comments: [{ author: "mallory", body: "/approve G4" }],
    authorized,
    releaseKind: "tag",
  });
  assert.equal(approval, null);
});

test("a comment that merely talks about approving is not an approval", () => {
  const approval = findG4Approval({
    comments: [{ author: "alice", body: "I think we should approve G4 on this" }],
    authorized,
    releaseKind: "tag",
  });
  assert.equal(approval, null);
});

test("an approval naming a different gate does not release", () => {
  const approval = findG4Approval({
    comments: [{ author: "alice", body: "/approve G3" }],
    authorized,
    releaseKind: "tag",
  });
  assert.equal(approval, null);
});

test("a bare /approve counts — the pending gate on a verified item is G4", () => {
  const approval = findG4Approval({
    comments: [{ author: "alice", body: "ship it\n/approve" }],
    authorized,
    releaseKind: "tag",
  });
  assert.equal(approval.approver, "alice");
});

test("an earlier rejection does not veto a later approval", () => {
  const approval = findG4Approval({
    comments: [
      { author: "alice", body: "/reject not yet" },
      { author: "alice", body: "/approve G4" },
    ],
    authorized,
    releaseKind: "tag",
  });
  assert.equal(approval.approver, "alice");
});

// --- planRelease -------------------------------------------------------------

test("a verified item with a real approval releases", () => {
  const plan = planRelease(base);
  assert.deepEqual(plan, { ok: true, tag: "v0.1.0", approver: "alice" });
});

test("no approval means no release", () => {
  const plan = planRelease({ ...base, comments: [] });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /no validated G4 approval/);
});

test("release_kind none refuses, naming the kind", () => {
  const plan = planRelease({ ...base, releaseKind: "none" });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /"none".*terminal/);
});

test("release_kind store refuses, pointing at the ship adapter", () => {
  const plan = planRelease({ ...base, releaseKind: "store" });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /ship adapter/);
});

test("an unknown release_kind refuses rather than guessing", () => {
  assert.match(planRelease({ ...base, releaseKind: "tags" }).reason, /unknown release_kind/);
});

test("only a verified item can be released", () => {
  for (const state of ["idea", "spec", "planned", "ready", "in-progress", "in-review", "merged", "released", null]) {
    const plan = planRelease({ ...base, state });
    assert.equal(plan.ok, false, String(state));
    assert.match(plan.reason, /not `verified`/);
  }
});

test("an existing tag refuses rather than overwriting", () => {
  const plan = planRelease({ ...base, existingTags: ["v0.1.0"] });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /already exists.*never a silent overwrite/);
});

test("an unrelated existing tag does not block", () => {
  assert.equal(planRelease({ ...base, existingTags: ["v0.0.9"] }).ok, true);
});

test("a missing version refuses", () => {
  assert.match(planRelease({ ...base, version: undefined }).reason, /no version to release/);
});

test("the release kind is checked before the approval — cheapest refusal first", () => {
  const plan = planRelease({ ...base, releaseKind: "none", comments: [], state: "idea" });
  assert.match(plan.reason, /"none"/, "should report the kind, not the missing approval");
});

test("no path returns ok without both a verified state and a real approver", () => {
  const cases = [
    { ...base, state: "merged" },
    { ...base, comments: [] },
    { ...base, comments: [{ author: "mallory", body: "/approve G4" }] },
    { ...base, authorized: [] },
    { ...base, releaseKind: "none" },
  ];
  for (const c of cases) assert.equal(planRelease(c).ok, false, JSON.stringify(c.state ?? c));
});
