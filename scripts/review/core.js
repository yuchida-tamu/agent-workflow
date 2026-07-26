// Reading a posted review artifact back out of its record, and deciding
// whether it authorises crossing G3. Mirrors scripts/verdict/core.js's shape
// on purpose: a pure reader parses a marker-managed artifact, a pure
// predicate decides whether it authorises the gate, and every ambiguity —
// no artifact, an unparseable one, one about different code — resolves to
// *refuse*. "We reviewed it" must be a fact the machine checks, not a habit
// that erodes under momentum (#81's brief).
//
// Pure: no `gh`, no fs, no clock. Source objects (a native review, a list of
// issue comments) come in as plain data; scripts/review/cli.js is the only
// place that talks to `gh`.
//
// --- authorship is NOT enforced here — read this before wiring a caller ----
//
// This module answers "does a recorded artifact say mergeable at head?", not
// "was it recorded by someone entitled to say so." It has no opinion on who
// posted a marker comment or submitted a native review — it parses whatever
// it is handed. **The composing caller (#113) MUST restrict artifacts to the
// trusted reviewer identity**, the same way `scripts/gate/validator.js`
// restricts `/approve` to human logins via `isBotAuthor` + `approvers`
// before it will mint a gate approval. Skipping that check means a
// `<!-- agentflow-review -->` marker comment authored by *anyone who can
// comment on the PR — including the implementer* — authorises the merge.
// Native-review mode gets partial cover for free (GitHub blocks approving
// your own PR), but solo-comment mode has **no GitHub-side protection at
// all**: nothing stops the PR's own author from posting the marker
// themselves.
//
// **Where the filter runs matters, and it is easy to get wrong in the unsafe
// direction.** `latestReviewComment`/`latestNativeReview` are a latest-wins
// collapse. If a caller collapses first and only then checks the single
// winner's author, a newer *untrusted* artifact shadows an older *trusted*
// one before authorship is ever considered — including a genuine veto:
// a trusted reviewer's `not-mergeable` posted first, followed by the PR's
// own untrusted author posting a newer fake `mergeable`, collapses to the
// fake; checking *that* result's author and finding it untrusted does not
// recover the trusted veto, it just turns "authored by nobody trusted" into
// "no comment at all" — `reviewAuthorises` then sees `{comment: null}` and
// the veto is gone, not preserved. This is not hypothetical: it is a proven
// attack against this exact reader (PR #123's second cold review, finding
// 3), including a native-mode variant where a bot's native APPROVE survives
// unchallenged because the human reviewer's vetoing comment is the one that
// gets laundered away.
//
// The safe order is: **filter the RAW `comments`/`nativeReviews` lists to
// trusted logins with `filterByAuthor` BEFORE calling
// `latestReviewComment`/`latestNativeReview`.** Filtered-then-collapsed
// means an untrusted artifact — however new — was never a candidate to begin
// with, so it cannot shadow a trusted one at any age. `login` is the
// discriminator; `association` (e.g. `OWNER`, `COLLABORATOR`) is a useful
// secondary signal but must never be the primary check — a human `OWNER` and
// a configured bot are both "not the implementer" by association alone, and
// association says nothing about *which* trusted identity posted.
//
// (Found in PR #123's cold review of this module: finding 1 — high, the
// missing filter; finding 3 — high, this filter ordering, found by an
// executed attack against the fix for finding 1.)

import { globToRegExp } from "../policy/engine.js";

export const MARKER = "<!-- agentflow-review -->";
export const VERDICTS = ["mergeable", "not-mergeable"];
export const UX_VALUES = ["mergeable", "not-mergeable", "n/a"];

// Filters a RAW source list (`comments` or `nativeReviews`, whatever shape
// `scripts/review/cli.js` fetched — anything with `.author.login`) down to
// entries authored by one of `trustedLogins`. This is the pre-collapse half
// of the authorship contract described above: call this BEFORE
// `latestReviewComment`/`latestNativeReview`, never after.
//
// Login match is case-insensitive (GitHub logins are) and exact otherwise —
// no substring or prefix matching, which would just move the laundering
// attack from "post a newer comment" to "register a similar-looking login".
//
// No trusted logins given → filters out everything. Absence of a trust list
// is not "trust nobody's individual posts" (which would still let an
// unfiltered `undefined` slip through some other way) — it fails exactly the
// way `filterByAuthor(items, [])` reads: fully closed, same posture as every
// other ambiguity in this module.
export function filterByAuthor(items, trustedLogins) {
  const trusted = new Set((trustedLogins ?? []).map((l) => String(l ?? "").trim().toLowerCase()).filter(Boolean));
  if (!trusted.size) return [];
  return (items ?? []).filter((item) => {
    const login = item?.author?.login;
    return typeof login === "string" && trusted.has(login.trim().toLowerCase());
  });
}

// --- parsing the marker-managed artifact -------------------------------------
//
// One text grammar used for BOTH containers the artifact can live in: a
// solo-comment-mode issue comment, or (see parseNativeReview below) the body
// of a native GitHub PR review. Reusing one parser for both keeps the grammar
// itself single-sourced; only *which* fields are authoritative differs by
// mode.
//
// Canonical field lines, reconciled against what code-reviewer already posts
// on PRs #109/#110/#116 (this repo's own review pass, live before this reader
// existed) rather than only the prose in #111's issue body:
//
//   <!-- agentflow-review -->
//   verdict: mergeable|not-mergeable
//   sha: <sha>
//   ux: mergeable|not-mergeable|n/a
//
// `verdict:` and `sha:` are canonical because that is what the shipped
// artifacts use today. `review verdict:` and `reviewed-sha:` (#111's own
// prose spelling) are accepted as aliases so a reviewer following either
// wording still parses. `ux:` is new — this module is where that field name
// becomes the contract Child #112 emits; there is no shipped artifact to
// reconcile against yet, so this doc comment IS the canonical definition.
// Lines may be markdown-bolded (`**verdict: mergeable**`) or backtick-quoted
// (`` verdict: `mergeable` ``) — both are stripped before matching, so either
// styling parses identically to the plain form.
const strip = (text) => text.replace(/\*\*/g, "").replace(/`/g, "");

// Extracts verdict/sha/ux from already-stripped text, with no validation —
// callers decide which fields are mandatory for their context. In
// particular, `ux` must be extractable even when there is no valid (or no)
// `verdict:` line: a native review's body legitimately carries only marker +
// `ux:`, since the verdict there is already structural (`review.state`).
// Gating ux-extraction on a valid verdict line — this module's original
// mistake, PR #123's cold review finding 2 — silently dropped ux from
// exactly the body shape a native reviewer is expected to write, producing
// false `ui-touched-but-no-ux-review` refusals on every UI-touching
// native-mode PR.
function extractFields(text) {
  const verdict = text.match(/(?:review\s+)?verdict:\s*([a-z-]+)/i)?.[1]?.toLowerCase() ?? null;
  const sha = text.match(/(?:reviewed-)?sha:\s*([0-9a-f]{7,40})/i)?.[1] ?? null;
  const uxRaw = text.match(/ux:\s*([a-z/-]+)/i)?.[1]?.toLowerCase() ?? null;
  const ux = UX_VALUES.includes(uxRaw) ? uxRaw : null;
  return { verdict, sha, ux };
}

// → { verdict, sha, ux, source: "comment", author } | null
//
// Accepts either a raw body string (kept for backwards compatibility, and
// reused internally by parseNativeReview to read a native review's own body
// text) or a source-shaped object `{ body, author }`. When given the latter,
// `author` is threaded straight into the result — see the module-level note
// above on why that field exists and who is responsible for checking it.
export function parseReviewComment(comment) {
  const isSourceObject = typeof comment === "object" && comment !== null;
  const raw = (isSourceObject ? comment.body : comment) ?? "";
  if (!raw.startsWith(MARKER)) return null;

  const { verdict, sha, ux } = extractFields(strip(raw));
  if (!VERDICTS.includes(verdict)) return null; // a comment artifact still requires a valid verdict line

  return { verdict, sha, ux, source: "comment", author: (isSourceObject ? comment.author : null) ?? null };
}

// The most recent marker comment wins, deterministically — same rule
// scripts/verdict/core.js's latestVerdict keeps, so a stale re-post of the
// artifact never outranks the fresh one.
export function latestReviewComment(comments) {
  const parsed = (comments ?? []).map(parseReviewComment).filter(Boolean);
  return parsed.length ? parsed[parsed.length - 1] : null;
}

// --- parsing a native bot-authored review ------------------------------------
//
// GitHub's own review state is the authoritative source for verdict and SHA
// where it exists — a free-text line inside a review body must never be able
// to assert `mergeable` when the review itself is CHANGES_REQUESTED. So
// verdict comes from `review.state` and SHA from `review.commit_id`, both
// structural GitHub fields, never from parsed text.
//
// A native GitHub review has no custom UX slot, though. `ux` is read the
// same way as the comment path: by running the same marker grammar over the
// review's own `body` text, if any — independently of whether that body also
// carries a verdict line (see extractFields' doc comment: gating on one
// broke this for the exact body shape a native reviewer writes).
const NATIVE_STATE_TO_VERDICT = {
  APPROVED: "mergeable",
  CHANGES_REQUESTED: "not-mergeable",
};

// → { verdict, sha, ux, source: "native", author } | null
export function parseNativeReview(review) {
  if (!review) return null;
  const verdict = NATIVE_STATE_TO_VERDICT[review.state] ?? null;
  if (!verdict) return null; // COMMENTED, DISMISSED, PENDING, unknown — no verdict, not a review artifact

  const sha = review.commit_id ?? null;
  const rawBody = review.body ?? "";
  const ux = rawBody.startsWith(MARKER) ? extractFields(strip(rawBody)).ux : null;

  return { verdict, sha, ux, source: "native", author: review.author ?? null };
}

// The most recent *verdict-bearing* native review wins. A dismissed or
// comment-only review parses to null above and is skipped, the same way a
// missing artifact is skipped rather than treated as a stale pass.
export function latestNativeReview(reviews) {
  const parsed = (reviews ?? []).map(parseNativeReview).filter(Boolean);
  return parsed.length ? parsed[parsed.length - 1] : null;
}

// --- the UI-surface predicate -------------------------------------------------
//
// "UI surface" is pack-declared (#81's UX-inclusion rule): the glob list
// itself is sourced from a platform pack by the caller, never decided here.
// This module only owns the pure glob match, reusing the exact glob grammar
// scripts/policy/engine.js already implements rather than inventing a second
// one.
export function uiSurfaceTouched(files, globs) {
  const list = globs ?? [];
  if (!list.length) return false;
  const regexps = list.map(globToRegExp);
  return (files ?? []).some((f) => regexps.some((r) => r.test(f)));
}

// A state is head-fresh when it carries a SHA that prefix-matches the given
// head. No SHA, no head to compare against, or a mismatch — all "not fresh".
// The 7-hex prefix match mirrors scripts/verdict/core.js's `authorises` on
// purpose (parity, not a new decision here).
function isHeadFresh(state, headSha) {
  if (!state || !state.sha || !headSha) return false;
  return headSha.startsWith(state.sha) || state.sha.startsWith(headSha);
}

// --- the predicate -------------------------------------------------------------
//
// reviewAuthorises({ native, comment }, { headSha, uiTouched }) mirrors
// authorises(gate, verdict, { headSha }) in scripts/verdict/core.js in spirit
// (state in, options describing the code being crossed, refuse-by-default),
// but takes BOTH sources rather than one pre-collapsed reviewState. That
// shape is required by the precedence rule below, not a style choice.
//
// --- precedence: veto semantics (2026-07-26 plan amendment to #81) -----------
//
// This module originally collapsed native+comment into one reviewState
// before deciding ("native wins wherever it exists"), which meant a fresh
// `not-mergeable` marker comment could never block a fresh native APPROVE at
// the same head — one reviewer's veto silently lost to the other's pass.
// PR #123's cold review flagged this as a design question; the orchestrator
// resolved it by amending #81's plan: **a head-fresh `not-mergeable` artifact
// from EITHER source refuses, regardless of what the other source says.**
// Review is a gate; gates fail closed on disagreement, they do not let one
// reviewer overrule another by arriving through a different channel.
//
// A STALE artifact has no veto power — it does not describe the code at
// head, so it cannot block a fresh mergeable pass from the other source
// (this is what keeps a stale native shadow from indefinitely blocking a
// fresh, correctly-vetoing marker, and vice versa). Native remains
// authoritative only in the narrower sense that survives the amendment: when
// both sources are head-fresh and agree (or only native is head-fresh and
// mergeable), native's structurally-sourced verdict/sha is what authorises.
//
// Decision table (both columns read "head-fresh"; "—" = absent or stale):
//
//   native          comment         outcome
//   --------------  --------------  -----------------------------------------
//   not-mergeable   (anything)      refuse not-mergeable, source: native (veto)
//   (any/—)         not-mergeable   refuse not-mergeable, source: comment (veto)
//   mergeable       (any, no veto)  authorise (subject to uiTouched/ux), source: native
//   —               mergeable       authorise (subject to uiTouched/ux), source: comment
//   —               —               refuse stale-sha (or no-artifact if neither exists at all)
//
// (Native-veto is checked before comment-veto only for determinism when BOTH
// are head-fresh `not-mergeable` at once; the outcome — refuse — is identical
// either way.)
//
// Refusal codes: no-artifact / not-mergeable / stale-sha /
// ui-touched-but-no-ux-review. Every result — pass or refuse — names which
// source answered via `source: "native" | "comment" | null`.
export function reviewAuthorises({ native = null, comment = null } = {}, { headSha = null, uiTouched = false } = {}) {
  if (!native && !comment) {
    return {
      authorised: false,
      code: "no-artifact",
      reason: "no review recorded — G3 requires a fresh `mergeable` review of the head commit",
      source: null,
    };
  }

  const nativeFresh = isHeadFresh(native, headSha);
  const commentFresh = isHeadFresh(comment, headSha);

  // Veto: either source, if head-fresh and not-mergeable, refuses outright —
  // it does not matter what the other source says.
  if (nativeFresh && native.verdict === "not-mergeable") {
    return {
      authorised: false,
      code: "not-mergeable",
      reason: "native review verdict is `not-mergeable` at head — vetoes regardless of the comment artifact",
      source: "native",
    };
  }
  if (commentFresh && comment.verdict === "not-mergeable") {
    return {
      authorised: false,
      code: "not-mergeable",
      reason: "comment review verdict is `not-mergeable` at head — vetoes regardless of the native review",
      source: "comment",
    };
  }

  // No veto fired. The authorising source is whichever is head-fresh and
  // mergeable; native wins when both qualify (it remains the authoritative,
  // structurally-sourced extraction).
  const authority =
    nativeFresh && native.verdict === "mergeable"
      ? native
      : commentFresh && comment.verdict === "mergeable"
        ? comment
        : null;

  if (!authority) {
    // Neither source is both head-fresh and mergeable — a review describes
    // the code it was submitted against, and nothing here demonstrably
    // describes this head. Name whatever exists for the diagnostic (cheap to
    // include, per PR #123's cold review): this also surfaces a stale
    // not-mergeable, which would otherwise look identical to a stale
    // mergeable in the reason text.
    const describe = (label, state) =>
      state ? `${label} is \`${state.verdict}\` at ${state.sha ?? "no recorded sha"}` : null;
    const parts = [describe("native", native), describe("comment", comment)].filter(Boolean);
    return {
      authorised: false,
      code: "stale-sha",
      reason: `no head-fresh mergeable review at head ${headSha ?? "unknown"} — ${parts.join("; ")}`,
      source: native ? "native" : "comment",
    };
  }

  if (uiTouched && authority.ux !== "mergeable") {
    return {
      authorised: false,
      code: "ui-touched-but-no-ux-review",
      reason: `diff touches pack-declared UI surface but the ${authority.source} review's ux field is ${authority.ux ?? "absent"}, not \`mergeable\``,
      source: authority.source,
    };
  }

  return {
    authorised: true,
    code: "ok",
    reason: `${authority.source} review is \`mergeable\` at head${uiTouched ? ", ux mergeable" : ""}`,
    source: authority.source,
  };
}
