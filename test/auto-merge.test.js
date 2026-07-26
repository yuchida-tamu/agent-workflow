import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAutoMerge, decideBotReview, renderRecord, uiGlobsFor, MARKER } from "../scripts/actions/auto-merge.js";
import { resolveTrustedReviewState } from "../scripts/identity/identity.js";

const sha = "09d673d1a2b3c4d5e6f70819";
const clean = { level: "low", require: [], block: [], matched: [], sha };
// A passing review is now part of the ordinary "everything is fine" fixture:
// #113 composes the review guard alongside the risk verdict at this exact
// call site, independently (AND-ed) — every pre-existing verdict-only
// refusal case below still refuses for the SAME reason it always did,
// because the verdict check runs first and short-circuits before the review
// is ever consulted; only the base "clean" case needed a review to keep
// merging.
const passingReview = { native: null, comment: { verdict: "mergeable", sha, ux: "n/a", source: "comment" } };
const base = { verdict: clean, headSha: sha, checksPassing: true, reviewState: passingReview };

test("a clean verdict on a green PR merges", () => {
  const d = decideAutoMerge(base);
  assert.equal(d.merge, true);
  assert.match(d.reason, /no obligation requiring a human/);
});

test("every refusal names itself", () => {
  const cases = [
    [{ ...base, draft: true }, /draft/],
    [{ ...base, mergeable: false }, /not mergeable/],
    [{ ...base, checksPassing: false }, /CI is not green/],
    [{ ...base, verdict: null }, /no risk verdict/],
    [{ ...base, verdict: { ...clean, sha: null } }, /records no SHA/],
    [{ ...base, verdict: { ...clean, require: ["human-merge"] } }, /requires a human merge/],
    [{ ...base, verdict: { ...clean, block: ["auto-merge"] } }, /requires a human merge/],
    [{ ...base, headSha: "deadbeef1234" }, /does not describe this head/],
  ];
  for (const [input, pattern] of cases) {
    const d = decideAutoMerge(input);
    assert.equal(d.merge, false, JSON.stringify(input.verdict));
    assert.match(d.reason, pattern);
  }
});

test("CI with no checks at all is not treated as green", () => {
  // `checksPassing` is computed by the caller, but the decision must refuse a
  // false value rather than treat absence of failure as success.
  assert.equal(decideAutoMerge({ ...base, checksPassing: false }).merge, false);
});

test("a verdict requiring G2 but not human-merge still merges", () => {
  // G2 is a plan-stage obligation. It has no bearing on whether a merged diff
  // needs a human — conflating them would block every plan-gated feature's PRs.
  const d = decideAutoMerge({ ...base, verdict: { ...clean, require: ["G2"] } });
  assert.equal(d.merge, true);
});

test("a stale verdict never merges, however clean it looks", () => {
  const stale = { ...clean, sha: "aaaaaaaaaaaa" };
  assert.equal(decideAutoMerge({ ...base, verdict: stale }).merge, false);
});

test("the most permissive fabricated verdict still cannot merge without a SHA", () => {
  const fabricated = { level: "low", require: [], block: [], matched: [], sha: null };
  assert.equal(decideAutoMerge({ ...base, verdict: fabricated }).merge, false);
});

// --- the review guard composition (#113) --------------------------------------
//
// `decideAutoMerge` is one of the two places the machine mints a G3 outcome.
// The risk verdict already authorises every case below (`base`'s `clean`
// verdict, unmodified) — only the review half of the composition varies, so
// a failure here can only be the review guard, never the verdict check
// regressing.

test("no review artifact at all refuses, even though the risk verdict allows", () => {
  const d = decideAutoMerge({ ...base, reviewState: null });
  assert.equal(d.merge, false);
  assert.match(d.reason, /review guard/);
  assert.match(d.reason, /no review recorded/);
});

test("an untrusted-only artifact refuses exactly like no artifact — pre-collapse filtering holds", () => {
  // Raw comments include a `mergeable` post from someone who is NOT the
  // trusted login. `resolveTrustedReviewState` must filter it out before
  // collapsing to "the latest" (scripts/review/core.js's documented
  // obligation) — if it didn't, this would wrongly merge.
  const rawComments = [
    {
      body: "<!-- agentflow-review -->\nverdict: mergeable\nsha: " + sha + "\nux: n/a",
      author: { login: "pr-author", association: "OWNER" },
    },
  ];
  const trust = resolveTrustedReviewState({
    config: { headless: { review: true } }, // solo-comment, trusts only github-actions[bot]
    nativeReviews: [],
    comments: rawComments,
  });
  assert.equal(trust.comment, null, "the untrusted post was never a candidate");
  const d = decideAutoMerge({ ...base, reviewState: { native: trust.native, comment: trust.comment } });
  assert.equal(d.merge, false);
  assert.match(d.reason, /review guard/);
});

test("a trusted mergeable review at head merges, when the risk verdict also allows", () => {
  const rawComments = [
    {
      body: "<!-- agentflow-review -->\nverdict: mergeable\nsha: " + sha + "\nux: n/a",
      author: { login: "github-actions[bot]", association: "NONE" },
    },
  ];
  const trust = resolveTrustedReviewState({
    config: { headless: { review: true } },
    nativeReviews: [],
    comments: rawComments,
  });
  assert.equal(trust.comment.verdict, "mergeable");
  const d = decideAutoMerge({ ...base, reviewState: { native: trust.native, comment: trust.comment } });
  assert.equal(d.merge, true);
  assert.match(d.reason, /comment review is `mergeable`/);
});

test("a trusted not-mergeable review vetoes, even though the risk verdict allows", () => {
  const rawComments = [
    {
      body: "<!-- agentflow-review -->\nverdict: not-mergeable\nsha: " + sha + "\nux: n/a",
      author: { login: "github-actions[bot]", association: "NONE" },
    },
  ];
  const trust = resolveTrustedReviewState({
    config: { headless: { review: true } },
    nativeReviews: [],
    comments: rawComments,
  });
  const d = decideAutoMerge({ ...base, reviewState: { native: trust.native, comment: trust.comment } });
  assert.equal(d.merge, false);
  assert.match(d.reason, /review guard/);
  assert.match(d.reason, /not-mergeable/);
});

test("a stale trusted artifact refuses, naming the mismatch, even though the risk verdict allows", () => {
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
  const d = decideAutoMerge({ ...base, reviewState: { native: trust.native, comment: trust.comment } });
  assert.equal(d.merge, false);
  assert.match(d.reason, /review guard/);
  assert.equal(d.review.code, "stale-sha", JSON.stringify(d));
  assert.match(d.reason, new RegExp(sha)); // names the head the review failed to describe
});

test("a trusted review from the native-review mode's App bot login is honoured", () => {
  const rawNativeReviews = [
    { state: "APPROVED", commit_id: sha, body: null, author: { login: "agentflow-bot[bot]", association: "NONE" } },
  ];
  const trust = resolveTrustedReviewState({
    config: { agent_identity: "agentflow-bot" },
    nativeReviews: rawNativeReviews,
    comments: [],
  });
  assert.equal(trust.mode, "native-review");
  assert.equal(trust.native.verdict, "mergeable");
  const d = decideAutoMerge({ ...base, reviewState: { native: trust.native, comment: trust.comment } });
  assert.equal(d.merge, true);
});

// --- uiGlobsFor: the uiTouched derivation seam --------------------------------

test("uiGlobsFor is empty with no config at all, or a config that declares no ui_surface", () => {
  assert.deepEqual(uiGlobsFor(undefined), []);
  assert.deepEqual(uiGlobsFor({}), []);
  assert.deepEqual(uiGlobsFor({ platform: "expo" }), []);
});

test("uiGlobsFor reads a future ui_surface config key, once something sets it", () => {
  assert.deepEqual(uiGlobsFor({ ui_surface: ["app/**", "src/ui/**"] }), ["app/**", "src/ui/**"]);
});

test("uiGlobsFor drops non-string entries rather than passing them to the glob matcher", () => {
  assert.deepEqual(uiGlobsFor({ ui_surface: ["app/**", 42, null] }), ["app/**"]);
});

// --- the record --------------------------------------------------------------

test("the record names the verdict, its obligations, and the exact head", () => {
  const body = renderRecord({
    verdict: { ...clean, matched: [{ pack: "baseline", rule: "medium-diff" }] },
    headSha: sha,
  });
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /G3 auto-merged/);
  assert.match(body, /`low`/);
  assert.match(body, /baseline\/medium-diff/);
  assert.match(body, new RegExp(sha));
});

test("the record says what would have stopped it", () => {
  // In solo mode this comment replaces the human's SHA-naming /approve — so it
  // has to carry the same information a reader would have gone looking for.
  const body = renderRecord({ verdict: clean, headSha: sha });
  assert.match(body, /human-merge/);
  assert.match(body, /different SHA|absent/);
  assert.match(body, /would have waited for a person/);
});

test("a record is distinguishable from a human approval", () => {
  const body = renderRecord({ verdict: clean, headSha: sha });
  assert.ok(body.startsWith(MARKER), "its own marker, not the /approve grammar");
  assert.doesNotMatch(body, /^\/approve/m, "must never look like a human's artifact");
});

test("the record names the review source when one authorised the merge (#113)", () => {
  const review = { authorised: true, code: "ok", reason: "comment review is `mergeable` at head", source: "comment" };
  const body = renderRecord({ verdict: clean, headSha: sha, review });
  assert.match(body, /\| review \|.*comment.*\|/);
  assert.match(body, /fresh/);
  assert.match(body, /mergeable/);
});

test("the record still renders with no review passed (backwards-compatible shape)", () => {
  const body = renderRecord({ verdict: clean, headSha: sha });
  assert.ok(body.startsWith(MARKER));
  assert.doesNotMatch(body, /\| review \|/);
});

// --- the approving review ----------------------------------------------------
//
// An auto-merge crosses G3 with no human. Today its only artifact is a comment.
// Once agentflow has an identity, the engine's decision can leave a *review*
// instead — the artifact G3 was designed around — without granting anyone new
// authority: the same verdict that authorises the merge authorises the review.

const identity = { configured: true, slug: "agentflow-bot", appId: null, source: "config" };
const reviewBase = { identity, verdict: clean, headSha: sha, prAuthor: "yuchida-tamu", actingLogin: null };

test("an authorising verdict on a configured repo produces a review", () => {
  const d = decideBotReview(reviewBase);
  assert.equal(d.review, true);
});

test("an unconfigured repo attempts no review at all", () => {
  // The comment record is unchanged there — every path keeps a working
  // unconfigured branch, because the toolkit ships to repos with no App.
  const d = decideBotReview({ ...reviewBase, identity: { configured: false, slug: null } });
  assert.equal(d.review, false);
  assert.match(d.reason, /agent_identity|not configured/i);
});

test("a verdict that does not authorise produces no review", () => {
  for (const verdict of [null, { ...clean, sha: null }, { ...clean, require: ["human-merge"] }]) {
    const d = decideBotReview({ ...reviewBase, verdict });
    assert.equal(d.review, false, JSON.stringify(verdict));
    assert.match(d.reason, /verdict/i);
  }
});

test("the acting identity never tries to approve its own PR", () => {
  // GitHub forbids it, and once agent PRs are authored by the App this is the
  // ordinary case rather than an edge. Naming the refusal beats an API error.
  const d = decideBotReview({
    ...reviewBase,
    prAuthor: "agentflow-bot[bot]",
    actingLogin: "agentflow-bot[bot]",
  });
  assert.equal(d.review, false);
  assert.match(d.reason, /own pull request|self/i);
});

test("a different bot may review an App-authored PR", () => {
  // In Actions the reviewer is usually github-actions[bot] while the PR is the
  // App's — two bots, so no self-review, and the verdict authorises both.
  const d = decideBotReview({
    ...reviewBase,
    prAuthor: "agentflow-bot[bot]",
    actingLogin: "github-actions[bot]",
  });
  assert.equal(d.review, true);
});

test("an unknown acting identity still attempts the review", () => {
  // Better to try and let GitHub refuse than to silently skip the artifact on a
  // guess. The merge does not depend on the review succeeding.
  const d = decideBotReview({ ...reviewBase, prAuthor: "agentflow-bot[bot]", actingLogin: null });
  assert.equal(d.review, true);
});

test("every review refusal names itself", () => {
  const refusals = [
    { ...reviewBase, identity: { configured: false } },
    { ...reviewBase, verdict: null },
    { ...reviewBase, prAuthor: "agentflow-bot[bot]", actingLogin: "agentflow-bot[bot]" },
  ];
  for (const input of refusals) {
    const d = decideBotReview(input);
    assert.equal(d.review, false);
    assert.ok(d.reason && d.reason.length > 10, JSON.stringify(d));
  }
});
