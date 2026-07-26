import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MARKER,
  parseReviewComment,
  latestReviewComment,
  parseNativeReview,
  latestNativeReview,
  readReviewState,
  uiSurfaceTouched,
  reviewAuthorises,
} from "../scripts/review/core.js";

// The canonical, shipped shape — matching what code-reviewer already posts on
// PRs #109/#110/#116 today (`verdict:` / `sha:`, no backticks), not the
// `review verdict:`/`reviewed-sha:` prose in #111's issue body. `ux:` is this
// module's own contract addition (Child #112 has not landed yet).
const comment = ({ verdict = "mergeable", sha = "abc1234def5678", ux = "n/a" } = {}) =>
  `${MARKER}
verdict: ${verdict}
sha: ${sha}
ux: ${ux}
`;

const nativeReview = ({ state = "APPROVED", sha = "abc1234def5678", body = null } = {}) => ({
  state,
  commit_id: sha,
  body,
});

// --- parsing the marker comment -----------------------------------------------

test("a clean mergeable comment parses", () => {
  const v = parseReviewComment(comment());
  assert.deepEqual(v, { verdict: "mergeable", sha: "abc1234def5678", ux: "n/a", source: "comment" });
});

test("a not-mergeable comment parses", () => {
  const v = parseReviewComment(comment({ verdict: "not-mergeable" }));
  assert.equal(v.verdict, "not-mergeable");
});

test("every malformed comment shape yields nothing, not a partial parse", () => {
  const shapes = [
    "",
    null,
    undefined,
    "just a comment",
    "review verdict: `mergeable`", // no marker
    `${MARKER}\nreview verdict: \`spicy\`\nreviewed-sha: abc1234`, // unrecognised verdict
    `${MARKER}\ngarbage, no verdict line at all`,
  ];
  for (const body of shapes) assert.equal(parseReviewComment(body), null, JSON.stringify(body));
});

test("a comment with no reviewed-sha still parses, sha is null", () => {
  const v = parseReviewComment(`${MARKER}\nreview verdict: \`mergeable\`\nux: \`n/a\`\n`);
  assert.equal(v.verdict, "mergeable");
  assert.equal(v.sha, null);
});

test("an unrecognised ux value is reported as absent, not guessed", () => {
  const v = parseReviewComment(`${MARKER}\nreview verdict: \`mergeable\`\nreviewed-sha: abc1234\nux: \`spicy\`\n`);
  assert.equal(v.ux, null);
});

// --- tolerating the shapes shipped artifacts actually use ---------------------
//
// PRs #109/#110/#116 predate this reader; #110's artifact bolds its verdict
// and sha lines. The reader has to parse what already exists, not just what
// the issue prose described.

test("the exact live artifact from PR #109/#116 parses (verdict:/sha:, no bolding)", () => {
  const body = `${MARKER}\nverdict: not-mergeable\nsha: 2a6ee934c01620d5ba475111181c5c14c747518c\n\nfindings...`;
  const v = parseReviewComment(body);
  assert.equal(v.verdict, "not-mergeable");
  assert.equal(v.sha, "2a6ee934c01620d5ba475111181c5c14c747518c");
});

test("the exact live artifact from PR #110 parses (bolded verdict/sha lines)", () => {
  const body = `${MARKER}\n**verdict: not-mergeable**\n**sha: bfde52fd5c7b49cd5a6088c55602179bc35d2f96**\n\nfindings...`;
  const v = parseReviewComment(body);
  assert.equal(v.verdict, "not-mergeable");
  assert.equal(v.sha, "bfde52fd5c7b49cd5a6088c55602179bc35d2f96");
});

test("both the canonical sha: label and the reviewed-sha: alias parse to the same field", () => {
  const withSha = parseReviewComment(`${MARKER}\nverdict: mergeable\nsha: abc1234\n`);
  const withAlias = parseReviewComment(`${MARKER}\nverdict: mergeable\nreviewed-sha: abc1234\n`);
  assert.equal(withSha.sha, "abc1234");
  assert.equal(withAlias.sha, "abc1234");
});

test("both the canonical verdict: label and the review verdict: alias parse to the same field", () => {
  const canonical = parseReviewComment(`${MARKER}\nverdict: mergeable\nsha: abc1234\n`);
  const alias = parseReviewComment(`${MARKER}\nreview verdict: mergeable\nsha: abc1234\n`);
  assert.equal(canonical.verdict, "mergeable");
  assert.equal(alias.verdict, "mergeable");
});

test("the most recent marker comment wins, deterministically", () => {
  const v = latestReviewComment([
    { body: comment({ verdict: "not-mergeable" }) },
    { body: "chatter" },
    { body: comment({ verdict: "mergeable" }) },
  ]);
  assert.equal(v.verdict, "mergeable");
});

test("no comments at all yields nothing", () => {
  assert.equal(latestReviewComment([{ body: "hi" }]), null);
  assert.equal(latestReviewComment([]), null);
  assert.equal(latestReviewComment(undefined), null);
});

// --- parsing a native review ---------------------------------------------------

test("an APPROVED review parses to mergeable, SHA from commit_id", () => {
  const v = parseNativeReview(nativeReview());
  assert.deepEqual(v, { verdict: "mergeable", sha: "abc1234def5678", ux: null, source: "native" });
});

test("a CHANGES_REQUESTED review parses to not-mergeable", () => {
  const v = parseNativeReview(nativeReview({ state: "CHANGES_REQUESTED" }));
  assert.equal(v.verdict, "not-mergeable");
});

test("COMMENTED, DISMISSED, PENDING and unknown states are not a review artifact", () => {
  // Built directly, not via nativeReview()'s defaults: passing `state:
  // undefined` through a destructured default would silently resurrect
  // "APPROVED" and defeat the point of this test.
  for (const state of ["COMMENTED", "DISMISSED", "PENDING", "SPICY", null, undefined]) {
    assert.equal(parseNativeReview({ state, commit_id: "abc1234", body: null }), null, String(state));
  }
});

test("no review object at all yields nothing", () => {
  assert.equal(parseNativeReview(null), null);
  assert.equal(parseNativeReview(undefined), null);
});

test("a native review with no commit_id parses with a null sha", () => {
  const v = parseNativeReview({ state: "APPROVED", commit_id: null, body: null });
  assert.equal(v.sha, null);
});

test("the ux field rides in the native review's body, parsed with the same grammar as a comment", () => {
  const v = parseNativeReview(
    nativeReview({ body: `${MARKER}\nreview verdict: \`mergeable\`\nreviewed-sha: zzzz\nux: \`mergeable\`\n` })
  );
  assert.equal(v.ux, "mergeable");
  // Structural fields still win over anything the embedded text claims —
  // verdict and sha come from review.state/commit_id, never from the body.
  assert.equal(v.verdict, "mergeable");
  assert.equal(v.sha, "abc1234def5678");
});

test("a CHANGES_REQUESTED review cannot be laundered into mergeable via its body text", () => {
  const v = parseNativeReview(
    nativeReview({
      state: "CHANGES_REQUESTED",
      body: `${MARKER}\nreview verdict: \`mergeable\`\nreviewed-sha: abc1234def5678\nux: \`mergeable\`\n`,
    })
  );
  assert.equal(v.verdict, "not-mergeable", "the structural review state is authoritative, not the free text");
});

test("a native review with no body still parses, ux is null", () => {
  const v = parseNativeReview(nativeReview({ body: null }));
  assert.equal(v.ux, null);
});

test("the most recent verdict-bearing native review wins; comment-only ones are skipped", () => {
  const v = latestNativeReview([
    nativeReview({ state: "CHANGES_REQUESTED" }),
    { state: "COMMENTED", commit_id: "zzzz", body: null },
    nativeReview({ state: "APPROVED", sha: "deadbeef" }),
  ]);
  assert.equal(v.verdict, "mergeable");
  assert.equal(v.sha, "deadbeef");
});

test("no native reviews at all yields nothing", () => {
  assert.equal(latestNativeReview([]), null);
  assert.equal(latestNativeReview(undefined), null);
});

// --- combining sources: native wins where it exists ---------------------------

test("readReviewState prefers a verdict-bearing native review over the marker comment", () => {
  const state = readReviewState({
    nativeReviews: [nativeReview({ state: "APPROVED", sha: "native-sha" })],
    comments: [{ body: comment({ verdict: "not-mergeable", sha: "comment-sha" }) }],
  });
  assert.equal(state.source, "native");
  assert.equal(state.sha, "native-sha");
});

test("readReviewState falls back to the marker comment when no native review parses", () => {
  const state = readReviewState({
    nativeReviews: [{ state: "COMMENTED", commit_id: "x", body: null }],
    comments: [{ body: comment({ sha: "c0ffee1" }) }],
  });
  assert.equal(state.source, "comment");
  assert.equal(state.sha, "c0ffee1");
});

test("readReviewState falls back when no native reviews were passed at all (solo-comment mode)", () => {
  const state = readReviewState({ comments: [{ body: comment({ sha: "comment-sha" }) }] });
  assert.equal(state.source, "comment");
});

test("readReviewState is null when neither source has anything", () => {
  assert.equal(readReviewState({ nativeReviews: [], comments: [] }), null);
  assert.equal(readReviewState({}), null);
  assert.equal(readReviewState(), null);
});

// --- the UI-surface glob predicate ---------------------------------------------

test("uiSurfaceTouched matches a touched file against the pack-declared globs", () => {
  assert.equal(uiSurfaceTouched(["packs/expo/screens/Home.tsx"], ["packs/expo/screens/**"]), true);
  assert.equal(uiSurfaceTouched(["scripts/review/core.js"], ["packs/expo/screens/**"]), false);
});

test("uiSurfaceTouched is false with no globs declared, regardless of files", () => {
  assert.equal(uiSurfaceTouched(["packs/expo/screens/Home.tsx"], []), false);
  assert.equal(uiSurfaceTouched(["packs/expo/screens/Home.tsx"], undefined), false);
});

test("uiSurfaceTouched is false with no files touched", () => {
  assert.equal(uiSurfaceTouched([], ["packs/expo/screens/**"]), false);
  assert.equal(uiSurfaceTouched(undefined, ["packs/expo/screens/**"]), false);
});

// --- reviewAuthorises: absence is refusal --------------------------------------

test("no artifact refuses, named no-artifact", () => {
  const r = reviewAuthorises(null, { headSha: "abc1234" });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "no-artifact");
  assert.equal(r.source, null);
});

test("a not-mergeable verdict refuses, named not-mergeable, quoting the verdict", () => {
  const state = { verdict: "not-mergeable", sha: "abc1234", ux: "n/a", source: "comment" };
  const r = reviewAuthorises(state, { headSha: "abc1234" });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "not-mergeable");
  assert.match(r.reason, /not-mergeable/);
  assert.equal(r.source, "comment");
});

test("a stale SHA refuses, named stale-sha, naming both SHAs", () => {
  const state = { verdict: "mergeable", sha: "aaaaaaa", ux: "n/a", source: "comment" };
  const r = reviewAuthorises(state, { headSha: "bbbbbbb" });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "stale-sha");
  assert.match(r.reason, /aaaaaaa/);
  assert.match(r.reason, /bbbbbbb/);
});

test("a missing reviewed SHA is stale too — a review with no SHA never authorises", () => {
  const state = { verdict: "mergeable", sha: null, ux: "n/a", source: "native" };
  const r = reviewAuthorises(state, { headSha: "abc1234" });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "stale-sha");
});

test("a missing head SHA also refuses as stale — nothing to compare against", () => {
  const state = { verdict: "mergeable", sha: "abc1234", ux: "n/a", source: "native" };
  const r = reviewAuthorises(state, { headSha: null });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "stale-sha");
});

test("UI touched with no ux review refuses, named ui-touched-but-no-ux-review", () => {
  const state = { verdict: "mergeable", sha: "abc1234", ux: null, source: "comment" };
  const r = reviewAuthorises(state, { headSha: "abc1234", uiTouched: true });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "ui-touched-but-no-ux-review");
});

test("UI touched with ux n/a still refuses — n/a means 'not required', not 'satisfied'", () => {
  const state = { verdict: "mergeable", sha: "abc1234", ux: "n/a", source: "comment" };
  const r = reviewAuthorises(state, { headSha: "abc1234", uiTouched: true });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "ui-touched-but-no-ux-review");
});

test("UI touched with ux not-mergeable refuses", () => {
  const state = { verdict: "mergeable", sha: "abc1234", ux: "not-mergeable", source: "comment" };
  const r = reviewAuthorises(state, { headSha: "abc1234", uiTouched: true });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "ui-touched-but-no-ux-review");
});

test("UI touched with ux mergeable passes", () => {
  const state = { verdict: "mergeable", sha: "abc1234", ux: "mergeable", source: "comment" };
  const r = reviewAuthorises(state, { headSha: "abc1234", uiTouched: true });
  assert.equal(r.authorised, true);
  assert.equal(r.code, "ok");
});

test("UI not touched: ux n/a and absent both pass — the UX obligation only applies when triggered", () => {
  for (const ux of ["n/a", null]) {
    const state = { verdict: "mergeable", sha: "abc1234", ux, source: "comment" };
    const r = reviewAuthorises(state, { headSha: "abc1234", uiTouched: false });
    assert.equal(r.authorised, true, ux);
  }
});

test("a mergeable artifact whose SHA prefix-matches the head passes exactly as today's risk verdict does", () => {
  const state = { verdict: "mergeable", sha: "abc1234", ux: "n/a", source: "comment" };
  const r = reviewAuthorises(state, { headSha: "abc1234def5678901234" });
  assert.equal(r.authorised, true);
  assert.equal(r.code, "ok");
});

test("every pass and refusal names which source answered", () => {
  const commentState = { verdict: "mergeable", sha: "abc1234", ux: "n/a", source: "comment" };
  const nativeState = { verdict: "mergeable", sha: "abc1234", ux: "n/a", source: "native" };
  assert.equal(reviewAuthorises(commentState, { headSha: "abc1234" }).source, "comment");
  assert.equal(reviewAuthorises(nativeState, { headSha: "abc1234" }).source, "native");
  assert.equal(
    reviewAuthorises({ ...commentState, verdict: "not-mergeable" }, { headSha: "abc1234" }).source,
    "comment"
  );
  assert.equal(reviewAuthorises(null, { headSha: "abc1234" }).source, null);
});

// --- end to end: parse then authorise, both sources ----------------------------

test("a fresh mergeable comment authorises G3 end to end", () => {
  const state = parseReviewComment(comment({ sha: "abc1234def5678" }));
  const r = reviewAuthorises(state, { headSha: "abc1234def5678" });
  assert.equal(r.authorised, true);
});

test("a fresh mergeable native review authorises G3 end to end", () => {
  const state = parseNativeReview(nativeReview({ sha: "abc1234def5678" }));
  const r = reviewAuthorises(state, { headSha: "abc1234def5678" });
  assert.equal(r.authorised, true);
});

test("a stale comment (new commit landed after review) refuses end to end, naming both SHAs", () => {
  const state = parseReviewComment(comment({ sha: "aaaaaaa" }));
  const r = reviewAuthorises(state, { headSha: "bbbbbbb" });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "stale-sha");
  assert.match(r.reason, /aaaaaaa/);
  assert.match(r.reason, /bbbbbbb/);
});
