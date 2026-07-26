import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDelivery, renderFinding, DELIVERED, NOT_DELIVERED, INCONCLUSIVE } from "../scripts/actions/ancestry.js";

test("an ancestor head delivered", () => {
  const c = classifyDelivery({ isAncestor: true, headSha: "abc1234def" });
  assert.equal(c.status, DELIVERED);
  assert.equal(c.proceed, true);
});

test("a non-ancestor head did not deliver, and does not proceed", () => {
  const c = classifyDelivery({ isAncestor: false, headSha: "f46daf00f413" });
  assert.equal(c.status, NOT_DELIVERED);
  assert.equal(c.proceed, false, "the item must not transition on a merge that landed nothing");
  assert.match(c.reason, /delivered nothing/);
  assert.match(c.reason, /f46daf00/);
});

test("an unanswerable check proceeds — the asymmetry is deliberate", () => {
  // Opposite to the gates' "absence is refusal". A false "not delivered" blocks
  // a legitimate merge and halts the loop; a missed stranding is rare and
  // recoverable. This is a safety net, not a gate.
  for (const isAncestor of [null, undefined]) {
    const c = classifyDelivery({ isAncestor, headSha: "abc1234" });
    assert.equal(c.status, INCONCLUSIVE);
    assert.equal(c.proceed, true, String(isAncestor));
  }
});

test("the default branch name is never assumed", () => {
  const c = classifyDelivery({ isAncestor: false, headSha: "abc1234", defaultBranch: "trunk" });
  assert.match(c.reason, /trunk/);
  assert.doesNotMatch(c.reason, /main/);
});

test("every non-delivered result carries a reason", () => {
  for (const isAncestor of [false, null]) {
    assert.ok(classifyDelivery({ isAncestor }).reason?.length > 0, String(isAncestor));
  }
});

test("the finding names the PR, the cause, and that nothing was transitioned", () => {
  const body = renderFinding({
    prNumber: 39,
    classified: classifyDelivery({ isAncestor: false, headSha: "de64e75e5027" }),
  });
  assert.match(body, /PR #39 merged but did not deliver/);
  assert.match(body, /has \*\*not\*\* been transitioned/);
  assert.match(body, /--delete-branch=false/, "names the specific trap that caused it");
  assert.match(body, /recovery PR/);
});

test("the finding has its own marker, distinct from the post-merge comment", () => {
  const body = renderFinding({ prNumber: 1, classified: classifyDelivery({ isAncestor: false }) });
  assert.ok(body.startsWith("<!-- agentflow-delivery -->"));
});

test("rendering a finding for a delivered PR throws rather than posting nonsense", () => {
  // Caught by running it: with no reason to report, the template emitted
  // "undefined" into an alarming comment body. A loud failure beats publishing
  // that to an issue.
  assert.throws(
    () => renderFinding({ prNumber: 1, classified: classifyDelivery({ isAncestor: true }) }),
    /no finding to report/
  );
  assert.throws(() => renderFinding({ prNumber: 1, classified: null }), /no finding to report/);
});

test("an inconclusive classification can still be rendered — it has a reason", () => {
  const body = renderFinding({ prNumber: 1, classified: classifyDelivery({ isAncestor: null }) });
  assert.match(body, /could not determine/);
});
