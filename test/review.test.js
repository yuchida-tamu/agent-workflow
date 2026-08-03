import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MARKER,
  filterByAuthor,
  parseReviewComment,
  latestReviewComment,
  parseNativeReview,
  latestNativeReview,
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

const nativeReview = ({ state = "APPROVED", sha = "abc1234def5678", body = null, author = null } = {}) => ({
  state,
  commit_id: sha,
  body,
  author,
});

const HEAD = "abc1234def5678";
const OLD = "0000000000000";
const mergeableAt = (sha, source, ux = "n/a") => ({ verdict: "mergeable", sha, ux, source, author: null });
const notMergeableAt = (sha, source, ux = "n/a") => ({ verdict: "not-mergeable", sha, ux, source, author: null });

// --- parsing the marker comment -----------------------------------------------

test("a clean mergeable comment parses", () => {
  const v = parseReviewComment(comment());
  assert.deepEqual(v, { verdict: "mergeable", sha: "abc1234def5678", ux: "n/a", source: "comment", author: null });
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

// --- authorship: threaded through, never examined here (PR #123 finding 1) ----

test("parseReviewComment threads a source object's author straight through, untouched", () => {
  const author = { login: "some-implementer", association: "OWNER" };
  const v = parseReviewComment({ body: comment(), author });
  assert.deepEqual(v.author, author);
});

test("parseReviewComment given a plain string (no author info available) reports author: null", () => {
  const v = parseReviewComment(comment());
  assert.equal(v.author, null);
});

test("parseReviewComment does not filter, reject, or otherwise judge any author — that is the composing caller's job", () => {
  // Proves the gap the reviewer found: a marker comment "authored" by the PR's
  // own implementer still parses to a usable, authorising reviewState. This
  // module has no opinion on that — see its module doc comment for who does.
  const v = parseReviewComment({ body: comment(), author: { login: "the-pr-author", association: "OWNER" } });
  assert.equal(v.verdict, "mergeable");
  const r = reviewAuthorises({ comment: v }, { headSha: "abc1234def5678" });
  assert.equal(r.authorised, true, "the reader authorises regardless of who posted it — composition must add the check");
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
  assert.deepEqual(v, { verdict: "mergeable", sha: "abc1234def5678", ux: null, source: "native", author: null });
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

test("ux is extracted from a native review's body even with NO verdict line at all (PR #123 finding 2)", () => {
  // The natural shape a native reviewer writes: the verdict is already
  // structural (review.state), so the body only needs marker + ux. The
  // original implementation gated ux-extraction on a valid `verdict:` line
  // and silently returned ux: null for exactly this shape.
  const v = parseNativeReview(nativeReview({ body: `${MARKER}\nux: mergeable\n` }));
  assert.equal(v.ux, "mergeable");
  assert.equal(v.verdict, "mergeable"); // still structural, from review.state
});

test("ux is still extracted body-only when the body carries an (ignored) invalid verdict line", () => {
  const v = parseNativeReview(nativeReview({ body: `${MARKER}\nverdict: not-a-real-value\nux: mergeable\n` }));
  assert.equal(v.ux, "mergeable");
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

test("a native review's body with no marker at all does not leak a stray ux: match", () => {
  const v = parseNativeReview(nativeReview({ body: "looks good, ux: whatever, ship it" }));
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

test("parseNativeReview threads the review's author straight through, untouched", () => {
  const author = { login: "code-reviewer[bot]", association: "NONE" };
  const v = parseNativeReview(nativeReview({ author }));
  assert.deepEqual(v.author, author);
});

test("a native review with no author info reports author: null", () => {
  const v = parseNativeReview(nativeReview());
  assert.equal(v.author, null);
});

// --- filterByAuthor: the pre-collapse half of the authorship contract ----------
//
// Must run on the RAW list, before latestReviewComment/latestNativeReview
// collapse it — see core.js's module doc comment and the dedicated attack
// test further down for why the ordering (not just the presence) of this
// filter is load-bearing.

const authored = (login, association = "COLLABORATOR") => ({ login, association });

test("filterByAuthor keeps only items authored by a trusted login", () => {
  const items = [
    { body: "a", author: authored("trusted-reviewer") },
    { body: "b", author: authored("someone-else") },
  ];
  const kept = filterByAuthor(items, ["trusted-reviewer"]);
  assert.deepEqual(kept, [items[0]]);
});

test("filterByAuthor login match is case-insensitive", () => {
  const items = [{ body: "a", author: authored("Trusted-Reviewer") }];
  assert.deepEqual(filterByAuthor(items, ["trusted-reviewer"]), items);
  assert.deepEqual(filterByAuthor(items, ["TRUSTED-REVIEWER"]), items);
});

test("filterByAuthor does not do substring/prefix matching — exact login only", () => {
  const items = [{ body: "a", author: authored("trusted-reviewer-imposter") }];
  assert.deepEqual(filterByAuthor(items, ["trusted-reviewer"]), []);
});

test("filterByAuthor: association alone never substitutes for login", () => {
  // Same association as a trusted account, different login — must not pass.
  const items = [{ body: "a", author: authored("impostor", "OWNER") }];
  assert.deepEqual(filterByAuthor(items, ["real-owner"]), []);
});

test("filterByAuthor with no trusted logins filters out everything — fails closed", () => {
  const items = [{ body: "a", author: authored("anyone") }];
  assert.deepEqual(filterByAuthor(items, []), []);
  assert.deepEqual(filterByAuthor(items, undefined), []);
  assert.deepEqual(filterByAuthor(items, null), []);
});

test("filterByAuthor drops items with no author info at all", () => {
  const items = [{ body: "a", author: null }, { body: "b" }];
  assert.deepEqual(filterByAuthor(items, ["trusted-reviewer"]), []);
});

test("filterByAuthor on an empty or missing list yields an empty list", () => {
  assert.deepEqual(filterByAuthor([], ["trusted-reviewer"]), []);
  assert.deepEqual(filterByAuthor(undefined, ["trusted-reviewer"]), []);
});

// --- filterByAuthor: PR-author self-exclusion (#187) ---------------------------
//
// Trusted-login membership alone used to be sufficient. It is not: a
// write-capable agent that authors its own PR under the same trusted login
// this guard trusts (the App bot, or `github-actions[bot]` under headless
// review) could post its own `<!-- agentflow-review -->` marker on that PR
// and pass `filterByAuthor`'s trust check unchanged — the login matches,
// even though "reviewer" and "implementer" are the same principal. This is
// the exact hole #189's future headless implementer would open the moment it
// ships. `excludeAuthor` closes it in the SAME pre-collapse pass as the
// trust filter, mirroring `decideBotReview`'s self-exclusion for native
// review *submission* on the *reading* side.

test("filterByAuthor drops an item authored by excludeAuthor even though its login is trusted", () => {
  const items = [{ body: "a", author: authored("agentflow-bot[bot]") }];
  assert.deepEqual(filterByAuthor(items, ["agentflow-bot[bot]"], "agentflow-bot[bot]"), []);
});

test("filterByAuthor's excludeAuthor match is case-insensitive, same as the trust check", () => {
  const items = [{ body: "a", author: authored("Agentflow-Bot[bot]") }];
  assert.deepEqual(filterByAuthor(items, ["agentflow-bot[bot]"], "AGENTFLOW-BOT[BOT]"), []);
});

test("filterByAuthor's excludeAuthor does not touch a DIFFERENT trusted author's item", () => {
  const items = [
    { body: "implementer's own post", author: authored("agentflow-bot[bot]") },
    { body: "a genuine reviewer's post", author: authored("real-human-reviewer") },
  ];
  const kept = filterByAuthor(items, ["agentflow-bot[bot]", "real-human-reviewer"], "agentflow-bot[bot]");
  assert.deepEqual(kept, [items[1]], "the excluded author's item is dropped; the other trusted author's survives");
});

test("filterByAuthor with excludeAuthor omitted (or null) behaves exactly as before — additive, not a new default", () => {
  const items = [{ body: "a", author: authored("trusted-reviewer") }];
  assert.deepEqual(filterByAuthor(items, ["trusted-reviewer"]), items);
  assert.deepEqual(filterByAuthor(items, ["trusted-reviewer"], null), items);
  assert.deepEqual(filterByAuthor(items, ["trusted-reviewer"], undefined), items);
});

test("filterByAuthor's excludeAuthor never widens what's trusted — an untrusted login is still dropped regardless", () => {
  const items = [{ body: "a", author: authored("someone-else") }];
  assert.deepEqual(filterByAuthor(items, ["trusted-reviewer"], "someone-else"), []);
});

// --- the veto-laundering attack (PR #123's second cold review, finding 3) ------
//
// Proven attack: a trusted reviewer posts `not-mergeable` at head. The PR's
// own (untrusted) author then posts a NEWER fake `mergeable` marker, also at
// head. `latestReviewComment` is latest-wins, so collapsing the unfiltered
// list picks the fake. The only safe fix is filtering the RAW list to
// trusted logins BEFORE that collapse — filtering the already-collapsed
// single winner's author does not recover the earlier trusted veto.

test("ATTACK: an untrusted newer marker cannot launder away a trusted reviewer's veto when filtered pre-collapse", () => {
  const rawComments = [
    { body: comment({ verdict: "not-mergeable", sha: HEAD }), author: authored("trusted-reviewer") },
    { body: comment({ verdict: "mergeable", sha: HEAD }), author: authored("pr-author") }, // posted after, untrusted
  ];
  const native = parseNativeReview(nativeReview({ state: "APPROVED", sha: HEAD, author: authored("agentflow-bot") }));
  const trustedLogins = ["trusted-reviewer", "agentflow-bot"];

  // SAFE order: filter the raw list first, THEN collapse.
  const safeComment = latestReviewComment(filterByAuthor(rawComments, trustedLogins));
  assert.equal(safeComment.verdict, "not-mergeable", "the untrusted fake was never a candidate, so it can't shadow the veto");

  const safeResult = reviewAuthorises({ native, comment: safeComment }, { headSha: HEAD });
  assert.equal(safeResult.authorised, false, "the trusted veto survives pre-collapse filtering");
  assert.equal(safeResult.code, "not-mergeable");
  assert.equal(safeResult.source, "comment");
});

test("ANTI-PATTERN, pinned so it is never re-derived as acceptable: filtering AFTER collapse loses the veto", () => {
  // This is the exact vulnerability the safe pattern above closes. Do not
  // copy this ordering into any composing caller.
  const rawComments = [
    { body: comment({ verdict: "not-mergeable", sha: HEAD }), author: authored("trusted-reviewer") },
    { body: comment({ verdict: "mergeable", sha: HEAD }), author: authored("pr-author") },
  ];
  const native = parseNativeReview(nativeReview({ state: "APPROVED", sha: HEAD, author: authored("agentflow-bot") }));
  const trustedLogins = ["trusted-reviewer", "agentflow-bot"];

  // UNSAFE order: collapse first (latest-wins picks the untrusted fake),
  // THEN check the single winner's author.
  const collapsedFirst = latestReviewComment(rawComments);
  assert.equal(collapsedFirst.verdict, "mergeable", "latest-wins picks the newer, untrusted, fake");
  const postFilterComment = trustedLogins.includes(collapsedFirst.author?.login) ? collapsedFirst : null;
  assert.equal(postFilterComment, null, "the fake is untrusted, so it's discarded — but discarding it does not bring the veto back");

  const brokenResult = reviewAuthorises({ native, comment: postFilterComment }, { headSha: HEAD });
  assert.equal(
    brokenResult.authorised,
    true,
    "BROKEN: the trusted reviewer's veto is gone, not recovered — native mergeable authorises unchallenged. " +
      "This is why filtering must happen before collapse, not after (see the ATTACK test above for the fix)."
  );
});

// --- SECURITY (#187): the PR author cannot self-authorise the comment path -----
//
// Surfaced by PR #186's review: `filterByAuthor`'s trust check has no
// self-exclusion analogue to `decideBotReview`'s. Latent while only humans
// author agent PRs; LIVE the moment a write-capable headless implementer
// (#189) ships and authors its own PR under the same trusted login this
// guard trusts. This block pins the exact "implementer is its own reviewer"
// scenario #189 would create, end to end through the real reader pipeline
// (filter → collapse → authorise), not just the filter in isolation.

test("SECURITY (#189 scenario): the PR's own author, posting under the trusted bot login, never authorises its own PR", () => {
  const implementerLogin = "agentflow-bot[bot]"; // the write principal's login == the trusted App login
  const rawComments = [
    { body: comment({ verdict: "mergeable", sha: HEAD }), author: authored(implementerLogin) },
  ];
  const trustedLogins = [implementerLogin];

  const filtered = filterByAuthor(rawComments, trustedLogins, implementerLogin);
  const collapsed = latestReviewComment(filtered);
  assert.equal(collapsed, null, "the implementer's own post must never survive the filter, however trusted its login");

  const result = reviewAuthorises({ comment: collapsed }, { headSha: HEAD });
  assert.equal(result.authorised, false, "an implementer cannot be its own reviewer");
  assert.equal(result.code, "no-artifact");
});

test("SECURITY: a GENUINE different trusted reviewer's artifact still authorises when excludeAuthor is set", () => {
  const implementerLogin = "agentflow-bot[bot]";
  const rawComments = [
    { body: comment({ verdict: "mergeable", sha: HEAD }), author: authored("a-real-code-reviewer") },
  ];
  const trustedLogins = [implementerLogin, "a-real-code-reviewer"];

  const filtered = filterByAuthor(rawComments, trustedLogins, implementerLogin);
  const collapsed = latestReviewComment(filtered);
  assert.equal(collapsed?.verdict, "mergeable", "excluding the implementer must not exclude a genuinely different trusted reviewer");

  const result = reviewAuthorises({ comment: collapsed }, { headSha: HEAD });
  assert.equal(result.authorised, true);
  assert.equal(result.source, "comment");
});

test("SECURITY: a human reviewer's CHANGES_REQUESTED veto is unaffected by PR-author self-exclusion", () => {
  const implementerLogin = "the-implementer";
  const rawNative = [
    { state: "CHANGES_REQUESTED", commit_id: HEAD, body: null, author: authored("human-reviewer") },
  ];
  const trustedLogins = [implementerLogin, "human-reviewer"];

  const filtered = filterByAuthor(rawNative, trustedLogins, implementerLogin);
  const native = latestNativeReview(filtered);
  assert.equal(native?.verdict, "not-mergeable", "the human's veto must survive — exclusion only ever targets the implementer's own login");

  const result = reviewAuthorises({ native }, { headSha: HEAD });
  assert.equal(result.authorised, false);
  assert.equal(result.code, "not-mergeable");
  assert.equal(result.source, "native");
});

test("SECURITY: self-excluding the PR author still leaves absence-is-refusal and stale-sha semantics unchanged", () => {
  // No artifact at all, even with excludeAuthor set — still refuses the
  // ordinary way, not a special-cased security refusal.
  const noArtifact = filterByAuthor([], ["trusted-reviewer"], "the-implementer");
  assert.deepEqual(noArtifact, []);
  assert.equal(reviewAuthorises({ comment: latestReviewComment(noArtifact) }, { headSha: HEAD }).code, "no-artifact");

  // A genuinely trusted, non-implementer artifact that is merely STALE still
  // refuses as stale-sha, not as a security refusal — self-exclusion must not
  // change the shape of an unrelated refusal.
  const staleComments = [{ body: comment({ verdict: "mergeable", sha: OLD }), author: authored("trusted-reviewer") }];
  const staleFiltered = filterByAuthor(staleComments, ["trusted-reviewer", "the-implementer"], "the-implementer");
  const staleCollapsed = latestReviewComment(staleFiltered);
  const staleResult = reviewAuthorises({ comment: staleCollapsed }, { headSha: HEAD });
  assert.equal(staleResult.authorised, false);
  assert.equal(staleResult.code, "stale-sha");
});

test("SECURITY ATTACK: self-exclusion cannot be defeated by pairing a fake self-authored mergeable with a genuine trusted veto — the veto still wins", () => {
  // Combines #187 (self-exclusion) with the #123 veto-laundering fix in one
  // scenario: a trusted human reviewer posts a genuine `not-mergeable` first;
  // the PR's own author (posting under the SAME trusted login the App uses)
  // posts a newer fake `mergeable`. Both protections must hold at once — the
  // fake is dropped for being self-authored, AND even if it weren't, a fresh
  // veto from the other source would still win.
  const implementerLogin = "agentflow-bot[bot]";
  const rawComments = [
    { body: comment({ verdict: "not-mergeable", sha: HEAD }), author: authored("trusted-human-reviewer") },
    { body: comment({ verdict: "mergeable", sha: HEAD }), author: authored(implementerLogin) }, // newer, self-authored, trusted-shaped login
  ];
  const trusted = [implementerLogin, "trusted-human-reviewer"];

  const filtered = filterByAuthor(rawComments, trusted, implementerLogin);
  const collapsed = latestReviewComment(filtered);
  assert.equal(collapsed?.verdict, "not-mergeable", "the implementer's fake pass never survives the filter, leaving only the genuine veto");

  const result = reviewAuthorises({ comment: collapsed }, { headSha: HEAD });
  assert.equal(result.authorised, false);
  assert.equal(result.code, "not-mergeable");
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

// --- reviewAuthorises: absence is refusal, veto semantics -----------------------
//
// Precedence table pinned by this block (see core.js's reviewAuthorises doc
// comment for the full rationale — this is the 2026-07-26 #81 plan amendment,
// prompted by PR #123's cold review):
//
//   native          comment         outcome
//   --------------  --------------  -----------------------------------------
//   not-mergeable   (anything)      refuse not-mergeable, source: native (veto)
//   (any/—)         not-mergeable   refuse not-mergeable, source: comment (veto)
//   mergeable       (any, no veto)  authorise, source: native
//   —               mergeable       authorise, source: comment
//   —               —               refuse stale-sha (or no-artifact if neither exists)
//
// Both "not-mergeable" rows require the vetoing artifact to be head-fresh — a
// stale artifact never vetoes.

test("no artifact at all refuses, named no-artifact, no source", () => {
  const r = reviewAuthorises({}, { headSha: HEAD });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "no-artifact");
  assert.equal(r.source, null);
});

test("only a fresh mergeable native authorises, source: native", () => {
  const r = reviewAuthorises({ native: mergeableAt(HEAD, "native") }, { headSha: HEAD });
  assert.equal(r.authorised, true);
  assert.equal(r.code, "ok");
  assert.equal(r.source, "native");
});

test("only a fresh mergeable comment authorises, source: comment (solo-comment mode)", () => {
  const r = reviewAuthorises({ comment: mergeableAt(HEAD, "comment") }, { headSha: HEAD });
  assert.equal(r.authorised, true);
  assert.equal(r.source, "comment");
});

test("a fresh not-mergeable native refuses, named not-mergeable, even with no comment at all", () => {
  const r = reviewAuthorises({ native: notMergeableAt(HEAD, "native") }, { headSha: HEAD });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "not-mergeable");
  assert.equal(r.source, "native");
});

test("a fresh not-mergeable comment refuses, named not-mergeable, even with no native at all", () => {
  const r = reviewAuthorises({ comment: notMergeableAt(HEAD, "comment") }, { headSha: HEAD });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "not-mergeable");
  assert.equal(r.source, "comment");
});

test("PLAN AMENDMENT: a fresh not-mergeable marker VETOES a fresh mergeable native at the same head", () => {
  // This is the exact scenario the amendment exists for: two reviewers
  // disagreeing at head must refuse, not have native silently win.
  const r = reviewAuthorises(
    { native: mergeableAt(HEAD, "native"), comment: notMergeableAt(HEAD, "comment") },
    { headSha: HEAD }
  );
  assert.equal(r.authorised, false);
  assert.equal(r.code, "not-mergeable");
  assert.equal(r.source, "comment", "the reason names comment as the vetoing source");
  assert.match(r.reason, /vetoes/);
});

test("the symmetric case: a fresh not-mergeable native VETOES a fresh mergeable marker at the same head", () => {
  const r = reviewAuthorises(
    { native: notMergeableAt(HEAD, "native"), comment: mergeableAt(HEAD, "comment") },
    { headSha: HEAD }
  );
  assert.equal(r.authorised, false);
  assert.equal(r.code, "not-mergeable");
  assert.equal(r.source, "native");
  assert.match(r.reason, /vetoes/);
});

test("both fresh and not-mergeable: refuses, native named first, deterministically", () => {
  const r = reviewAuthorises(
    { native: notMergeableAt(HEAD, "native"), comment: notMergeableAt(HEAD, "comment") },
    { headSha: HEAD }
  );
  assert.equal(r.authorised, false);
  assert.equal(r.code, "not-mergeable");
  assert.equal(r.source, "native");
});

test("both fresh and mergeable: authorises, native named (native remains authoritative when both agree)", () => {
  const r = reviewAuthorises(
    { native: mergeableAt(HEAD, "native"), comment: mergeableAt(HEAD, "comment") },
    { headSha: HEAD }
  );
  assert.equal(r.authorised, true);
  assert.equal(r.source, "native");
});

// --- stale artifacts have no veto power -----------------------------------------

test("a STALE not-mergeable native does NOT veto a fresh mergeable comment", () => {
  const r = reviewAuthorises(
    { native: notMergeableAt(OLD, "native"), comment: mergeableAt(HEAD, "comment") },
    { headSha: HEAD }
  );
  assert.equal(r.authorised, true, "a stale artifact cannot describe the head, so it cannot block it either");
  assert.equal(r.source, "comment");
});

test("a STALE not-mergeable comment does NOT veto a fresh mergeable native", () => {
  const r = reviewAuthorises(
    { native: mergeableAt(HEAD, "native"), comment: notMergeableAt(OLD, "comment") },
    { headSha: HEAD }
  );
  assert.equal(r.authorised, true);
  assert.equal(r.source, "native");
});

test("stale-native-shadowing a fresh not-mergeable marker: still refuses (verified-safe outcome preserved)", () => {
  // The exact scenario PR #123's cold review judged SAFE under the old
  // precedence (refusal, just via a less informative stale-sha reason). Under
  // veto semantics it refuses for a MORE informative reason: the fresh
  // marker's veto fires directly, rather than the guard tripping over a
  // stale SHA mismatch.
  const r = reviewAuthorises(
    { native: mergeableAt(OLD, "native"), comment: notMergeableAt(HEAD, "comment") },
    { headSha: HEAD }
  );
  assert.equal(r.authorised, false, "refusal outcomes stay refusals");
  assert.equal(r.code, "not-mergeable");
  assert.equal(r.source, "comment");
});

test("a STALE mergeable native and no comment refuses as stale-sha, naming both SHAs it has", () => {
  const r = reviewAuthorises({ native: mergeableAt(OLD, "native") }, { headSha: HEAD });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "stale-sha");
  assert.match(r.reason, new RegExp(OLD));
  assert.match(r.reason, new RegExp(HEAD));
});

test("both sources stale refuses as stale-sha, and the reason mentions both (cheap diagnostic)", () => {
  const r = reviewAuthorises(
    { native: mergeableAt(OLD, "native"), comment: notMergeableAt("1111111", "comment") },
    { headSha: HEAD }
  );
  assert.equal(r.authorised, false);
  assert.equal(r.code, "stale-sha");
  assert.match(r.reason, /native/);
  assert.match(r.reason, /comment/);
});

test("a missing SHA is stale too — a review with no SHA never authorises or vetoes", () => {
  const r = reviewAuthorises({ native: { verdict: "mergeable", sha: null, ux: "n/a", source: "native" } }, { headSha: HEAD });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "stale-sha");
});

test("a missing head SHA refuses as stale — nothing to compare against", () => {
  const r = reviewAuthorises({ native: mergeableAt(HEAD, "native") }, { headSha: null });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "stale-sha");
});

test("a short SHA prefix matches its full head (parity with verdict/core.js)", () => {
  const r = reviewAuthorises({ comment: mergeableAt("abc1234", "comment") }, { headSha: "abc1234def5678901234" });
  assert.equal(r.authorised, true);
});

// --- ux / UI-surface obligation, applied to whichever source authorises --------

test("UI touched, authorising native has no ux (missing) refuses ui-touched-but-no-ux-review", () => {
  const r = reviewAuthorises({ native: mergeableAt(HEAD, "native", null) }, { headSha: HEAD, uiTouched: true });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "ui-touched-but-no-ux-review");
  assert.equal(r.source, "native");
});

test("UI touched, authorising comment has ux n/a refuses — n/a means 'not required', not 'satisfied'", () => {
  const r = reviewAuthorises({ comment: mergeableAt(HEAD, "comment", "n/a") }, { headSha: HEAD, uiTouched: true });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "ui-touched-but-no-ux-review");
});

test("UI touched, authorising source has ux mergeable passes", () => {
  const r = reviewAuthorises({ native: mergeableAt(HEAD, "native", "mergeable") }, { headSha: HEAD, uiTouched: true });
  assert.equal(r.authorised, true);
  assert.equal(r.code, "ok");
});

test("UI touching APPROVED native at head with body-only ux (no verdict line) authorises end to end", () => {
  // Combines finding #2's fix (ux extraction independent of a verdict line)
  // with the veto-semantics predicate: this is the exact shape a native
  // reviewer is expected to write for a UI-touching PR.
  const native = parseNativeReview(nativeReview({ body: `${MARKER}\nux: mergeable\n` }));
  const r = reviewAuthorises({ native }, { headSha: HEAD, uiTouched: true });
  assert.equal(r.authorised, true);
  assert.equal(r.code, "ok");
  assert.equal(r.source, "native");
});

test("UI not touched: ux n/a or absent both still pass — the UX obligation only applies when triggered", () => {
  for (const ux of ["n/a", null]) {
    const r = reviewAuthorises({ comment: mergeableAt(HEAD, "comment", ux) }, { headSha: HEAD, uiTouched: false });
    assert.equal(r.authorised, true, String(ux));
  }
});

test("every pass and refusal names which source answered", () => {
  assert.equal(reviewAuthorises({ comment: mergeableAt(HEAD, "comment") }, { headSha: HEAD }).source, "comment");
  assert.equal(reviewAuthorises({ native: mergeableAt(HEAD, "native") }, { headSha: HEAD }).source, "native");
  assert.equal(
    reviewAuthorises({ comment: notMergeableAt(HEAD, "comment") }, { headSha: HEAD }).source,
    "comment"
  );
  assert.equal(reviewAuthorises({}, { headSha: HEAD }).source, null);
});

// --- end to end: parse then authorise, both sources ----------------------------

test("a fresh mergeable comment authorises G3 end to end", () => {
  const state = parseReviewComment(comment({ sha: HEAD }));
  const r = reviewAuthorises({ comment: state }, { headSha: HEAD });
  assert.equal(r.authorised, true);
});

test("a fresh mergeable native review authorises G3 end to end", () => {
  const state = parseNativeReview(nativeReview({ sha: HEAD }));
  const r = reviewAuthorises({ native: state }, { headSha: HEAD });
  assert.equal(r.authorised, true);
});

test("a stale comment (new commit landed after review) refuses end to end, naming both SHAs", () => {
  const state = parseReviewComment(comment({ sha: "aaaaaaa" }));
  const r = reviewAuthorises({ comment: state }, { headSha: "bbbbbbb" });
  assert.equal(r.authorised, false);
  assert.equal(r.code, "stale-sha");
  assert.match(r.reason, /aaaaaaa/);
  assert.match(r.reason, /bbbbbbb/);
});

test("a fresh not-mergeable native review parsed from a real object refuses end to end", () => {
  const native = parseNativeReview(nativeReview({ state: "CHANGES_REQUESTED", sha: HEAD }));
  const comment_ = parseReviewComment(comment({ verdict: "mergeable", sha: HEAD }));
  const r = reviewAuthorises({ native, comment: comment_ }, { headSha: HEAD });
  assert.equal(r.authorised, false, "the native CHANGES_REQUESTED vetoes the mergeable marker");
  assert.equal(r.code, "not-mergeable");
  assert.equal(r.source, "native");
});
