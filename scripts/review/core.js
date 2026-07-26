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

import { globToRegExp } from "../policy/engine.js";

export const MARKER = "<!-- agentflow-review -->";
export const VERDICTS = ["mergeable", "not-mergeable"];
export const UX_VALUES = ["mergeable", "not-mergeable", "n/a"];

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

// → { verdict, sha, ux, source: "comment" } | null
export function parseReviewComment(body) {
  const raw = body ?? "";
  if (!raw.startsWith(MARKER)) return null;
  const text = strip(raw);

  const verdict = text.match(/(?:review\s+)?verdict:\s*([a-z-]+)/i)?.[1]?.toLowerCase() ?? null;
  if (!VERDICTS.includes(verdict)) return null;

  const sha = text.match(/(?:reviewed-)?sha:\s*([0-9a-f]{7,40})/i)?.[1] ?? null;
  const uxRaw = text.match(/ux:\s*([a-z/-]+)/i)?.[1]?.toLowerCase() ?? null;
  const ux = UX_VALUES.includes(uxRaw) ? uxRaw : null;

  return { verdict, sha, ux, source: "comment" };
}

// The most recent marker comment wins, deterministically — same rule
// scripts/verdict/core.js's latestVerdict keeps, so a stale re-post of the
// artifact never outranks the fresh one.
export function latestReviewComment(comments) {
  const parsed = (comments ?? [])
    .map((c) => parseReviewComment(c?.body))
    .filter(Boolean);
  return parsed.length ? parsed[parsed.length - 1] : null;
}

// --- parsing a native bot-authored review ------------------------------------
//
// GitHub's own review state is the authoritative source for verdict and SHA
// where it exists (#111's contract: "authoritative where it exists") — a
// free-text line inside a review body must never be able to assert
// `mergeable` when the review itself is CHANGES_REQUESTED. So verdict comes
// from `review.state` and SHA from `review.commit_id`, both structural
// GitHub fields, never from parsed text.
//
// A native GitHub review has no custom UX slot, though. Rather than invent a
// second grammar for it, `ux` is read the same way as the comment path: by
// running the same marker parser over the review's own `body` text, if any.
// This is a contract decision the plan left unstated (#111's body describes
// the native path only in terms of verdict+SHA) — documented here and in the
// PR body rather than silently assumed.
const NATIVE_STATE_TO_VERDICT = {
  APPROVED: "mergeable",
  CHANGES_REQUESTED: "not-mergeable",
};

// → { verdict, sha, ux, source: "native" } | null
export function parseNativeReview(review) {
  if (!review) return null;
  const verdict = NATIVE_STATE_TO_VERDICT[review.state] ?? null;
  if (!verdict) return null; // COMMENTED, DISMISSED, PENDING, unknown — no verdict, not a review artifact

  const sha = review.commit_id ?? null;
  const embedded = parseReviewComment(review.body);

  return { verdict, sha, ux: embedded?.ux ?? null, source: "native" };
}

// The most recent *verdict-bearing* native review wins. A dismissed or
// comment-only review parses to null above and is skipped, the same way a
// missing artifact is skipped rather than treated as a stale pass.
export function latestNativeReview(reviews) {
  const parsed = (reviews ?? []).map(parseNativeReview).filter(Boolean);
  return parsed.length ? parsed[parsed.length - 1] : null;
}

// --- combining the two sources into one canonical state ----------------------
//
// Precedence: native wins whenever a verdict-bearing native review is present.
// The plan is not silent here — #111's body calls the native review
// "authoritative where it exists" — so this is not a judgment call, it is
// that sentence made mechanical. Only when no native review parses does the
// reader fall back to the marker comment (solo-comment mode, or a
// native-review-mode repo whose bot review has not landed yet).
//
// Callers pass whichever source(s) they have; this module never decides which
// G3 mode a repo is in (that is scripts/identity/identity.js's g3Mode) — it
// just reads whatever state is handed to it and reports which source
// answered.
export function readReviewState({ nativeReviews, comments } = {}) {
  const native = latestNativeReview(nativeReviews);
  if (native) return native;
  return latestReviewComment(comments);
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

// --- the predicate -------------------------------------------------------------
//
// reviewAuthorises(reviewState, { headSha, uiTouched }) mirrors authorises(gate,
// verdict, { headSha }) in scripts/verdict/core.js: same call shape (state in,
// options describing the code being crossed). It returns a richer result than
// authorises' plain boolean — { authorised, code, reason, source } — because
// #81's acceptance criteria demand refusals name a specific reason and which
// source (native vs marker) answered; scripts/actions/auto-merge.js's
// decideAutoMerge already returns { merge, reason } for the identical reason,
// so this keeps the same discipline rather than pushing reason-construction
// out to a second place the way verdict/cli.js's `why` text does today.
//
// Refusal codes: no-artifact / not-mergeable / stale-sha /
// ui-touched-but-no-ux-review. There is deliberately no fifth "ok" path that
// skips naming its source — a pass names which source answered exactly like a
// refusal does.
export function reviewAuthorises(reviewState, { headSha = null, uiTouched = false } = {}) {
  if (!reviewState) {
    return {
      authorised: false,
      code: "no-artifact",
      reason: "no review recorded — G3 requires a fresh `mergeable` review of the head commit",
      source: null,
    };
  }

  const { verdict, sha, ux, source } = reviewState;

  if (verdict !== "mergeable") {
    return {
      authorised: false,
      code: "not-mergeable",
      reason: `${source} review verdict is \`${verdict}\``,
      source,
    };
  }

  // A review describes the code it was submitted against. Without a recorded
  // SHA, or a head that does not match it, there is no way to know it still
  // does — so it does not authorise. Both SHAs are named, same as a stale
  // risk verdict would be.
  const stale = !sha || !headSha || !(headSha.startsWith(sha) || sha.startsWith(headSha));
  if (stale) {
    return {
      authorised: false,
      code: "stale-sha",
      reason: `${source} review is for ${sha ?? "no recorded sha"}, but the head is now ${headSha ?? "unknown"}`,
      source,
    };
  }

  if (uiTouched && ux !== "mergeable") {
    return {
      authorised: false,
      code: "ui-touched-but-no-ux-review",
      reason: `diff touches pack-declared UI surface but the ${source} review's ux field is ${ux ?? "absent"}, not \`mergeable\``,
      source,
    };
  }

  return {
    authorised: true,
    code: "ok",
    reason: `${source} review is \`mergeable\` at head${uiTouched ? ", ux mergeable" : ""}`,
    source,
  };
}
