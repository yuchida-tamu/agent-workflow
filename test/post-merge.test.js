import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOSING_KEYWORDS, linkedIssues, combineAncestry } from "../scripts/actions/post-merge.js";
import { classifyDelivery, renderFinding } from "../scripts/actions/ancestry.js";

// The full set GitHub itself acts on. If this list ever drifts, every test
// below drifts with it — that's the point of deriving the regex from it.
test("the keyword list is GitHub's full nine, no more, no less", () => {
  assert.deepEqual(
    [...CLOSING_KEYWORDS].sort(),
    ["close", "closed", "closes", "fix", "fixed", "fixes", "resolve", "resolved", "resolves"].sort()
  );
});

// One test per keyword (#119) — each of the nine forms GitHub recognizes must
// be matched, case-insensitively, on its own.
for (const keyword of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) {
  test(`"${keyword} #12" links issue 12`, () => {
    assert.deepEqual(linkedIssues(`${keyword} #12`), [12]);
  });

  test(`"${keyword} #12" links issue 12 case-insensitively`, () => {
    const shouted = keyword.toUpperCase();
    assert.deepEqual(linkedIssues(`${shouted} #12`), [12]);
  });
}

test("multiple keywords in one body link every issue, deduplicated", () => {
  const body = "Fix #1\n\nAlso closes #2 and this Resolved #1 as well.";
  assert.deepEqual(linkedIssues(body).sort(), [1, 2]);
});

test("keywords are matched inside a longer PR body", () => {
  const body = "## Summary\n\nThis change closes #42 by reworking the parser.\n\nfixed #7";
  assert.deepEqual(linkedIssues(body).sort((a, b) => a - b), [7, 42]);
});

// --- negatives ----------------------------------------------------------------

test("a bare '#N' mention with no keyword does not count", () => {
  assert.deepEqual(linkedIssues("See #12 for background."), []);
});

test("a keyword embedded inside a longer word does not fire", () => {
  // "prefix #12" contains "fix" but is not the word "fix" — the \b boundary
  // before the keyword must exclude it.
  assert.deepEqual(linkedIssues("prefix #12"), []);
  assert.deepEqual(linkedIssues("this closest #12"), []);
  assert.deepEqual(linkedIssues("refixes #12"), []);
});

test("a missing PR body links nothing rather than throwing", () => {
  assert.deepEqual(linkedIssues(null), []);
  assert.deepEqual(linkedIssues(undefined), []);
  assert.deepEqual(linkedIssues(""), []);
});

// --- delivery check: squash-blind ancestry (#125) -----------------------------
//
// A squash merge lands a synthetic commit on main — its merge_commit_sha is an
// ancestor, its head sha never is. A true merge lands the head sha too, so both
// are ancestors. `combineAncestry` is the piece that turns those two independent
// git answers into the single tri-state `classifyDelivery` (ancestry.js) expects,
// and these tests pin its truth table directly, without shelling out to git.

test("combineAncestry: either check landing on main is sufficient evidence", () => {
  assert.equal(combineAncestry(true, false), true, "merge commit ancestor, head sha not — squash-shaped");
  assert.equal(combineAncestry(false, true), true, "head sha ancestor, merge commit not");
  assert.equal(combineAncestry(true, true), true, "both ancestors — true-merge-shaped");
});

test("combineAncestry: only both checks explicitly saying no reads as undelivered", () => {
  assert.equal(combineAncestry(false, false), false);
});

test("combineAncestry: one indeterminate check does not manufacture a false alarm", () => {
  assert.equal(combineAncestry(null, false), null);
  assert.equal(combineAncestry(false, null), null);
  assert.equal(combineAncestry(null, null), null);
  assert.equal(combineAncestry(null, true), true, "the other check still proves delivery");
});

// End-to-end through the same classifyDelivery/renderFinding the script calls,
// exercising the exact payload shapes the plan calls out.

test("squash-shaped payload: merge_commit_sha on main, head sha absent — delivery proceeds", () => {
  const isAncestor = combineAncestry(/* mergeAncestor */ true, /* headAncestor */ false);
  const delivery = classifyDelivery({ isAncestor, headSha: "0ef9099a", defaultBranch: "main" });
  assert.equal(delivery.proceed, true);
  assert.equal(delivery.status, "delivered");
});

test("true-merge-shaped payload: both shas land on main — delivery proceeds", () => {
  const isAncestor = combineAncestry(true, true);
  const delivery = classifyDelivery({ isAncestor, headSha: "abc1234", defaultBranch: "main" });
  assert.equal(delivery.proceed, true);
  assert.equal(delivery.status, "delivered");
});

test("genuinely undelivered payload: neither sha an ancestor — still fails loudly", () => {
  const isAncestor = combineAncestry(false, false);
  const delivery = classifyDelivery({ isAncestor, headSha: "deadbee", defaultBranch: "main" });
  assert.equal(delivery.proceed, false);
  assert.match(delivery.reason, /delivered nothing/);
  const finding = renderFinding({ prNumber: 999, classified: delivery, defaultBranch: "main" });
  assert.match(finding, /did not deliver/);
});
