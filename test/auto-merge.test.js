import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAutoMerge, decideBotReview, renderRecord, MARKER } from "../scripts/actions/auto-merge.js";

const sha = "09d673d1a2b3c4d5e6f70819";
const clean = { level: "low", require: [], block: [], matched: [], sha };
const base = { verdict: clean, headSha: sha, checksPassing: true };

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
