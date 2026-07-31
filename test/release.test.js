import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tagFor,
  findG4Approval,
  planRelease,
  verifyReleased,
  renderReleaseRecord,
  releaseTagFromComments,
  resolveItemVersion,
} from "../scripts/release/core.js";

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

// --- per-item version resolution (#121) --------------------------------------
//
// `verifyReleased` was always correct given each item's own version — the bug
// was the CLI feeding it HEAD's single `package.json` version for every
// released item instead. The fix grounds resolution in what the release flow
// itself records: a breadcrumb comment on the issue, naming the tag it was
// released at.

test("renderReleaseRecord names the tag, and releaseTagFromComments reads it back", () => {
  const body = renderReleaseRecord({ tag: "v1.0.0" });
  assert.match(body, /Released as `v1\.0\.0`/);
  assert.equal(releaseTagFromComments([{ body }]), "v1.0.0");
});

test("releaseTagFromComments ignores unrelated comments and finds the breadcrumb among them", () => {
  const comments = [
    { body: "/approve G4" },
    { body: "some unrelated chatter" },
    { body: renderReleaseRecord({ tag: "v2.3.0" }) },
  ];
  assert.equal(releaseTagFromComments(comments), "v2.3.0");
});

test("releaseTagFromComments returns null when no breadcrumb exists", () => {
  assert.equal(releaseTagFromComments([]), null);
  assert.equal(releaseTagFromComments([{ body: "/approve G4" }]), null);
  assert.equal(releaseTagFromComments(undefined), null);
});

test("releaseTagFromComments takes the latest breadcrumb if more than one exists", () => {
  const comments = [
    { body: renderReleaseRecord({ tag: "v1.0.0" }) },
    { body: renderReleaseRecord({ tag: "v1.0.1" }) },
  ];
  assert.equal(releaseTagFromComments(comments), "v1.0.1");
});

test("resolveItemVersion resolves from the breadcrumb when present", () => {
  const comments = [{ body: renderReleaseRecord({ tag: "v1.4.0" }) }];
  assert.deepEqual(resolveItemVersion({ comments }), { version: "v1.4.0" });
});

test("a version-less item — no breadcrumb at all — reports unverifiable, not a finding", () => {
  const r = resolveItemVersion({ comments: [{ author: "alice", body: "/approve G4" }] });
  assert.equal(r.version, undefined);
  assert.match(r.unverifiable, /no release breadcrumb/);
});

test("resolveItemVersion is honest about no comments at all too", () => {
  const r = resolveItemVersion({ comments: [] });
  assert.match(r.unverifiable, /no release breadcrumb/);
});

// --- two released items, two different versions, both verify clean ----------
//
// This is the shape the original bug could never pass: #5 at v1.0.0 and #9 at
// v1.1.0 coexisting under `state:released`, resolved from their own
// breadcrumbs rather than a single value borrowed from HEAD.

test("two released items at different versions both verify clean once resolved per-item", () => {
  const itemFive = { number: 5, comments: [{ body: renderReleaseRecord({ tag: "v1.0.0" }) }] };
  const itemNine = { number: 9, comments: [{ body: renderReleaseRecord({ tag: "v1.1.0" }) }] };

  const resolved = [itemFive, itemNine].map((i) => ({
    number: i.number,
    ...resolveItemVersion({ comments: i.comments }),
  }));
  assert.deepEqual(resolved, [
    { number: 5, version: "v1.0.0" },
    { number: 9, version: "v1.1.0" },
  ]);

  const result = verifyReleased({ items: resolved, tags: ["v1.0.0", "v1.1.0"], releaseKind: "tag" });
  assert.deepEqual(result.findings, []);
});

// --- the old false-finding case, pinned dead ---------------------------------
//
// #121's exact failure scenario: #5 was released at v1.0.0 (tag exists).
// Development moved HEAD's package.json on to 1.1.0 with no tag yet. The old
// CLI fed every released item HEAD's version and reported #5 as a false
// finding — "no such tag (v1.1.0)" — against an item that was genuinely
// released. Resolving from #5's own breadcrumb must never reproduce that.

test("false-finding case pinned dead: HEAD moving past a released item's version cannot poison its verify", () => {
  const headPackageJsonVersion = "1.1.0"; // what the old, buggy CLI would have used for every item
  const itemFive = { number: 5, comments: [{ body: renderReleaseRecord({ tag: "v1.0.0" }) }] };

  const resolvedVersion = resolveItemVersion({ comments: itemFive.comments });
  assert.equal(resolvedVersion.version, "v1.0.0", "must resolve #5's own tag, not HEAD's version");
  assert.notEqual(resolvedVersion.version, tagFor(headPackageJsonVersion));

  // No v1.1.0 tag exists yet — only v1.0.0, which is what #5 actually shipped.
  const result = verifyReleased({
    items: [{ number: 5, version: resolvedVersion.version }],
    tags: ["v1.0.0"],
    releaseKind: "tag",
  });
  assert.deepEqual(result.findings, [], "a legitimately released item must never be flagged because HEAD moved on");
});
