import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, validateApproval, approvalTransitions } from "../scripts/gate/validator.js";
import { resolveTrustedReviewState } from "../scripts/identity/identity.js";
import { resolveApply } from "../scripts/state/machine.js";
import { renderApprovalComment } from "../scripts/actions/gate-comment.js";

test("parseCommand finds the command anywhere in the body", () => {
  assert.deepEqual(parseCommand("looks good!\n/approve"), { command: "approve", gate: null });
  assert.deepEqual(parseCommand("/approve g2"), { command: "approve", gate: "G2" });
  assert.deepEqual(parseCommand("/reject needs a smaller scope"), {
    command: "reject",
    reason: "needs a smaller scope",
  });
  assert.equal(parseCommand("nice work"), null);
  assert.equal(parseCommand("/retest"), null);
  assert.equal(parseCommand("/approve G9").command, "invalid");
});

const base = { author: "alice", authorized: ["alice", "bob"], expectedGate: "G1" };

// #113: G3 approvals now also require the review guard to authorise, so any
// test exercising a passing G3 case needs a `headSha` and a `reviewState`
// that describes it as fresh and `mergeable`. Shared here so gate-mismatch,
// release-kind and bot-carve-out tests can each opt in without restating it.
const prHead = "abc1234def5678";
const passingReviewState = { native: null, comment: { verdict: "mergeable", sha: prHead, ux: "n/a", source: "comment" } };

test("valid approval", () => {
  const v = validateApproval({ ...base, body: "/approve" });
  assert.deepEqual(v, { ok: true, gate: "G1", approver: "alice" });
});

test("unauthorized author is refused", () => {
  const v = validateApproval({ ...base, author: "mallory", body: "/approve" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not an authorized approver/);
});

test("author check is case-insensitive", () => {
  assert.ok(validateApproval({ ...base, author: "Alice", body: "/approve" }).ok);
});

test("gate mismatch is refused", () => {
  const v = validateApproval({ ...base, body: "/approve G3" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /approves G3.*pending gate is G1/);
});

test("rejection is not ok but is flagged", () => {
  const v = validateApproval({ ...base, body: "/reject too risky" });
  assert.equal(v.ok, false);
  assert.equal(v.rejected, true);
  assert.equal(v.reason, "too risky");
});

test("plain comment is not an approval", () => {
  assert.equal(validateApproval({ ...base, body: "ship it!" }).ok, false);
});

test("G4 is refused on a repo that never releases", () => {
  const v = validateApproval({ ...base, expectedGate: "G4", body: "/approve G4", releaseKind: "none" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /G4 does not apply.*release_kind is "none"/);
});

test("G4 is accepted on repos that do release", () => {
  for (const releaseKind of ["store", "tag", null]) {
    const v = validateApproval({ ...base, expectedGate: "G4", body: "/approve G4", releaseKind });
    assert.equal(v.ok, true, String(releaseKind));
  }
});

test("release_kind none does not touch the other gates", () => {
  for (const gate of ["G1", "G2"]) {
    const v = validateApproval({ ...base, expectedGate: gate, body: `/approve ${gate}`, releaseKind: "none" });
    assert.equal(v.ok, true, gate);
  }
});

test("release_kind none does not touch G3 either, given a passing review", () => {
  // G3 now also composes the #113 review guard, so unlike G1/G2 it needs a
  // `reviewState` to pass at all — release_kind is still what this test is
  // about, so the review side is fixed to a passing artifact throughout.
  const v = validateApproval({
    ...base,
    expectedGate: "G3",
    body: "/approve G3",
    releaseKind: "none",
    headSha: prHead,
    reviewState: passingReviewState,
  });
  assert.equal(v.ok, true);
});

// --- which gates transition on approval --------------------------------------

test("G1, G2 and G3 approvals are themselves the act", () => {
  for (const gate of ["G1", "G2", "G3"]) {
    for (const releaseKind of ["tag", "store", "none", null]) {
      assert.equal(approvalTransitions({ gate, releaseKind }), true, `${gate}/${releaseKind}`);
    }
  }
});

test("a G4 approval on a releasing repo does NOT transition", () => {
  // It authorises a release that has not happened. Moving the label here would
  // assert a release that does not exist — and lock agentflow-release out,
  // since it requires `verified`. This is the #45 defect.
  for (const releaseKind of ["tag", "store"]) {
    assert.equal(approvalTransitions({ gate: "G4", releaseKind }), false, releaseKind);
  }
});

test("under release_kind none the question is moot", () => {
  // No G4 exists there — the validator already refuses it — so the ordinary
  // path applies and nothing special-cases a gate that cannot occur.
  assert.equal(approvalTransitions({ gate: "G4", releaseKind: "none" }), true);
});

test("the label can lag reality but never lead it", () => {
  // The invariant this encodes: for every gate, either the approval performs
  // the transition, or something that produces an artifact does. There is no
  // gate where the label moves ahead of the thing it describes.
  const releasing = ["G1", "G2", "G3", "G4"].map((gate) => approvalTransitions({ gate, releaseKind: "tag" }));
  assert.deepEqual(releasing, [true, true, true, false]);
});

// --- bot authors -------------------------------------------------------------
//
// "Agents never mint gate approvals" was a rule enforced by prompt text: an
// agent-minted `/approve` was byte-identical to a human one. These are the cases
// that make it mechanical — and the one narrow case where a bot approval stands
// because the *engine*, not the bot, is what authorised it.

const bot = { author: "agentflow-bot[bot]", authorType: "Bot", authorized: ["yuchida-tamu"] };
const authorisingVerdict = { level: "low", require: [], block: [], run: [], matched: [], sha: "abc1234" };
// `prHead` / `passingReviewState` are shared, defined near `base` above.

test("a bot may not approve a document gate, whatever the gate", () => {
  for (const gate of ["G1", "G2", "G4"]) {
    const v = validateApproval({ ...bot, body: "/approve", expectedGate: gate, releaseKind: "tag" });
    assert.equal(v.ok, false, gate);
    assert.match(v.reason, /bot/i);
  }
});

test("a bot is refused even where it has somehow reached the approvers list", () => {
  // Config validation already rejects this, so it is defence in depth: the bot
  // check runs before the approver check, so a config that slipped through does
  // not become an approval.
  const v = validateApproval({
    ...bot,
    authorized: ["yuchida-tamu", "agentflow-bot[bot]"],
    body: "/approve",
    expectedGate: "G1",
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /bot/i);
});

test("a bot is recognised from its login when the payload carries no type", () => {
  const v = validateApproval({ ...bot, authorType: null, body: "/approve", expectedGate: "G1" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /bot/i);
});

test("a bot may not approve G3 on an issue, even with an authorising verdict", () => {
  // The gate workflow only ever sees issue comments, so this is what keeps the
  // carve-out unreachable there by construction rather than by configuration.
  const v = validateApproval({
    ...bot,
    body: "/approve G3",
    expectedGate: "G3",
    surface: "issue",
    verdict: authorisingVerdict,
    headSha: prHead,
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /bot/i);
});

test("a bot MAY approve G3 on a PR the engine already authorised, given a passing review", () => {
  // The positive case matters as much as the refusals: a suite that only proved
  // refusal would pass just as happily if the carve-out were dead code. #113
  // adds a further, independent condition (a fresh review of the head) — this
  // fixture supplies one so the test still proves the verdict-based carve-out.
  const v = validateApproval({
    ...bot,
    body: "/approve G3",
    expectedGate: "G3",
    surface: "pr",
    verdict: authorisingVerdict,
    headSha: prHead,
    reviewState: passingReviewState,
  });
  assert.equal(v.ok, true);
  assert.equal(v.gate, "G3");
  assert.equal(v.approver, "agentflow-bot[bot]");
  // The outcome has to name what authorised it, or the audit trail records a bot
  // approving a merge with no visible reason it was allowed to.
  assert.equal(v.authorisedBy.verdict, "low");
  assert.equal(v.authorisedBy.sha, "abc1234");
});

test("the bot's G3 carve-out refuses every verdict that does not authorise", () => {
  const cases = [
    [null, /verdict/i],
    [{ ...authorisingVerdict, sha: null }, /verdict/i],
    [{ ...authorisingVerdict, sha: "9999999" }, /verdict/i],
    [{ ...authorisingVerdict, require: ["human-merge"] }, /verdict/i],
    [{ ...authorisingVerdict, block: ["auto-merge"] }, /verdict/i],
  ];
  for (const [verdict, pattern] of cases) {
    const v = validateApproval({
      ...bot,
      body: "/approve G3",
      expectedGate: "G3",
      surface: "pr",
      verdict,
      headSha: prHead,
    });
    assert.equal(v.ok, false, JSON.stringify(verdict));
    assert.match(v.reason, pattern);
  }
});

test("a bot rejection still stands — refusing to advance grants nothing", () => {
  const v = validateApproval({ ...bot, body: "/reject the plan misses auth", expectedGate: "G1" });
  assert.equal(v.rejected, true);
  assert.equal(v.ok, false);
});

test("humans are entirely unaffected at G1 — the review guard only reaches G3", () => {
  const human = { author: "yuchida-tamu", authorType: "User", authorized: ["yuchida-tamu"] };
  assert.ok(validateApproval({ ...human, body: "/approve", expectedGate: "G1" }).ok);
});

test("a human's G3 approval also requires the review guard (#113), given as a passing review it still works", () => {
  const human = { author: "yuchida-tamu", authorType: "User", authorized: ["yuchida-tamu"] };
  const v = validateApproval({
    ...human,
    body: "/approve G3",
    expectedGate: "G3",
    surface: "pr",
    headSha: prHead,
    reviewState: passingReviewState,
  });
  assert.ok(v.ok, JSON.stringify(v));
});

test("a human's G3 approval is refused with no review artifact, same as the bot carve-out", () => {
  const human = { author: "yuchida-tamu", authorType: "User", authorized: ["yuchida-tamu"] };
  const v = validateApproval({
    ...human,
    body: "/approve G3",
    expectedGate: "G3",
    surface: "pr",
    headSha: prHead,
    // reviewState omitted — no artifact recorded at all.
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /review guard/);
  assert.match(v.reason, /no review recorded/);
});

// --- the review guard composition (#113) --------------------------------------
//
// `validateApproval`'s G3 branch is the second of the guard's two
// enforcement points, alongside `decideAutoMerge` (scripts/actions/auto-merge.js).
// Every case below is otherwise-valid (a human on the approvers list, or the
// bot carve-out with an authorising verdict) so a failure can only be the
// review guard, never the existing checks regressing.

test("an untrusted-only artifact refuses G3 exactly like no artifact — pre-collapse filtering holds", () => {
  const rawComments = [
    {
      body: "<!-- agentflow-review -->\nverdict: mergeable\nsha: " + prHead + "\nux: n/a",
      author: { login: "pr-author", association: "OWNER" }, // not the trusted login
    },
  ];
  const trust = resolveTrustedReviewState({
    config: { headless: { review: true } }, // solo-comment, trusts only github-actions[bot]
    nativeReviews: [],
    comments: rawComments,
  });
  assert.equal(trust.comment, null, "the untrusted post was never a candidate");
  const v = validateApproval({
    author: "alice",
    authorized: ["alice", "bob"],
    body: "/approve G3",
    expectedGate: "G3",
    surface: "pr",
    headSha: prHead,
    reviewState: { native: trust.native, comment: trust.comment },
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /review guard/);
});

test("a trusted mergeable review authorises a human's G3 approval end to end", () => {
  const rawComments = [
    {
      body: "<!-- agentflow-review -->\nverdict: mergeable\nsha: " + prHead + "\nux: n/a",
      author: { login: "github-actions[bot]", association: "NONE" },
    },
  ];
  const trust = resolveTrustedReviewState({
    config: { headless: { review: true } },
    nativeReviews: [],
    comments: rawComments,
  });
  const v = validateApproval({
    author: "alice",
    authorized: ["alice", "bob"],
    body: "/approve G3",
    expectedGate: "G3",
    surface: "pr",
    headSha: prHead,
    reviewState: { native: trust.native, comment: trust.comment },
  });
  assert.equal(v.ok, true, JSON.stringify(v));
});

test("a trusted not-mergeable review vetoes a human's G3 approval", () => {
  const rawComments = [
    {
      body: "<!-- agentflow-review -->\nverdict: not-mergeable\nsha: " + prHead + "\nux: n/a",
      author: { login: "github-actions[bot]", association: "NONE" },
    },
  ];
  const trust = resolveTrustedReviewState({
    config: { headless: { review: true } },
    nativeReviews: [],
    comments: rawComments,
  });
  const v = validateApproval({
    author: "alice",
    authorized: ["alice", "bob"],
    body: "/approve G3",
    expectedGate: "G3",
    surface: "pr",
    headSha: prHead,
    reviewState: { native: trust.native, comment: trust.comment },
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /review guard/);
  assert.match(v.reason, /not-mergeable/);
});

test("a stale trusted artifact refuses a human's G3 approval, naming the head it does not describe", () => {
  const rawComments = [
    {
      body: "<!-- agentflow-review -->\nverdict: mergeable\nsha: 0000000000000000\nux: n/a",
      author: { login: "github-actions[bot]", association: "NONE" },
    },
  ];
  const trust = resolveTrustedReviewState({
    config: { headless: { review: true } },
    nativeReviews: [],
    comments: rawComments,
  });
  const v = validateApproval({
    author: "alice",
    authorized: ["alice", "bob"],
    body: "/approve G3",
    expectedGate: "G3",
    surface: "pr",
    headSha: prHead,
    reviewState: { native: trust.native, comment: trust.comment },
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, new RegExp(prHead));
});

// --- gate-comment.js's re-fetch: the compare-and-swap it shares with the CLI (#126) --
//
// `gate-comment.js` trusted the webhook event payload's labels — a snapshot
// from whenever the comment was posted — and wrote its edit straight from
// that snapshot. By execution time a second driver (the manual CLI, most
// often) can have already applied the very transition this approval names,
// or carried the issue further still; observed live on #119, where this
// workflow added `state:spec` back onto an issue the CLI had already carried
// to `state:ready`, stacking both labels. It now re-reads labels immediately
// before the edit and runs them through the same `resolveApply` the CLI
// uses — these tests build the exact `{from, to, add, remove}` shape
// `gate-comment.js` constructs from `pendingGateFor` (it never calls
// `planTransition`) and drive it through the full matrix.

const g1Plan = { from: "idea", to: "spec", add: ["state:spec"], remove: ["state:idea"] };

test("gate-comment CAS: fresh read still shows from, no to → applies exactly as the event implied", () => {
  const resolution = resolveApply(["state:idea", "bug"], g1Plan);
  assert.deepEqual(resolution, { action: "apply", add: ["state:spec"], remove: ["state:idea"] });
  assert.equal(
    renderApprovalComment({ gate: "G1", plan: g1Plan, author: "alice", resolution }),
    "agentflow: ✅ **G1 approved** by @alice — `state:idea` → `state:spec`."
  );
});

test("gate-comment CAS: fresh read shows the CLI already won → no-op, no edit, says so", () => {
  const resolution = resolveApply(["state:spec", "bug"], g1Plan);
  assert.equal(resolution.action, "noop");
  const rendered = renderApprovalComment({ gate: "G1", plan: g1Plan, author: "alice", resolution });
  assert.match(rendered, /`G1` was already approved by another driver/);
  assert.match(rendered, /`state:spec` is already present/);
  assert.match(rendered, /No change made/);
});

test("gate-comment CAS: fresh read shows both labels stacked (#119) → heals and says a race happened", () => {
  const resolution = resolveApply(["state:idea", "state:spec"], g1Plan);
  assert.equal(resolution.action, "heal");
  assert.deepEqual(resolution.remove, ["state:idea"]);
  const rendered = renderApprovalComment({ gate: "G1", plan: g1Plan, author: "alice", resolution });
  assert.match(rendered, /✅ \*\*G1 approved\*\* by @alice — `state:idea` → `state:spec`/);
  assert.match(rendered, /Two drivers had raced this transition/);
  assert.match(rendered, /stale `state:idea` has been removed/);
});

test("gate-comment CAS: fresh read shows the issue moved past this transition entirely → refuses, names what was found", () => {
  // The exact #119 shape from the CLI's side: the manual chain had already
  // carried the issue to `ready` by the time this workflow's edit ran.
  assert.throws(
    () => resolveApply(["state:ready", "bug"], g1Plan),
    /cannot apply idea → spec: neither state:idea nor state:spec is present \(found: state:ready\)/
  );
  // gate-comment.js catches exactly this and turns it into an issue comment
  // rather than crashing the workflow — the message it wraps is this one.
});

test("a bot's G3 carve-out is refused with no review artifact, quoting the review guard's reason", () => {
  const v = validateApproval({
    ...bot,
    body: "/approve G3",
    expectedGate: "G3",
    surface: "pr",
    verdict: authorisingVerdict,
    headSha: prHead,
    // reviewState omitted.
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /review guard/);
  assert.match(v.reason, /no review recorded/);
});
