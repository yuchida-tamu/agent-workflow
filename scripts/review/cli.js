#!/usr/bin/env node
// agentflow-review — read the review artifact recorded on a PR (native
// bot-authored review, or the `<!-- agentflow-review -->` marker comment),
// and ask whether it authorises crossing G3 without a human.
//
//   agentflow-review read  --repo owner/name --pr N
//   agentflow-review check --repo owner/name --pr N --head <sha>
//                           --reviewer <login> [--reviewer <login> ...]
//                           [--pr-author <login>]
//                           [--files a.js,b.js] [--ui-globs "src/ui/**,app/**"]
//
// `read` prints both parsed sources over the RAW (unfiltered) artifact
// lists — { native, comment } — and exits 0 when either was found, 10 when
// neither was. It is a diagnostic view for a human skimming what exists; it
// makes no gate decision and does not require `--reviewer`.
//
// `check` **is** a gate decision, and `--reviewer <login>` (repeatable) is
// REQUIRED for it — omitting it is a usage error (exit 20), not a refusal.
// `check` exits 0 when the trusted reviewer's artifact authorises the merge,
// 10 when it does not — including when there is no artifact at all, or none
// from a trusted login. Absence is refusal, so a missing, unparseable, or
// untrusted-only review is reported as "not authorised" rather than as an
// error to work around.
//
// --- authorship: enforced HERE, on the raw lists, before collapse ---------
//
// `check` filters the raw comment/review lists to `--reviewer` logins with
// `filterByAuthor` BEFORE `latestReviewComment`/`latestNativeReview` collapse
// them to "the latest". This ordering is load-bearing, not stylistic: a
// caller that collapses first and only then discards an untrusted winner
// does NOT recover an earlier trusted artifact — including a genuine
// `not-mergeable` veto — because latest-wins already picked the untrusted
// one and the earlier trusted one was never a candidate again. This was a
// proven attack against an earlier version of this CLI (PR #123's cold
// review, finding 3): a trusted reviewer posts `not-mergeable`, the PR's own
// author posts a newer fake `mergeable`, and a post-collapse author check
// only turns the fake into "no comment", not back into the real veto. See
// `scripts/review/core.js`'s module doc comment and `filterByAuthor` for the
// full note and the safe/unsafe orderings side by side.
//
// A gate CLI that can authorise a merge from any author's newest marker must
// not exist in any invocable form — that is why `--reviewer` is required
// rather than merely documented as the caller's responsibility (PR #123's
// cold review, orchestrator ruling: the earlier version only documented the
// obligation and left `check` callable without it).
//
// `--files`/`--ui-globs` are optional convenience flags for computing
// `uiTouched` locally; the composing caller (scripts/actions/auto-merge.js,
// scripts/gate/validator.js — Child #113) is expected to source the glob
// list from the platform pack and pass `--ui-globs` itself, or compute
// `uiTouched` another way and skip these flags. Neither flag is required.
//
// `--pr-author <login>` (#187) is the PR-author self-exclusion: trusted-login
// membership alone does not prove a marker comment or native review was NOT
// posted by the PR's own author — a write-capable agent authoring its PR
// under the same trusted login (an App bot, or `github-actions[bot]` under
// headless review) could otherwise post its own passing artifact and clear
// `--reviewer`'s check. Passed straight through to `filterByAuthor`'s
// `excludeAuthor`, in the same pre-collapse pass as the trust filter — never
// required (an omitted flag preserves the pre-#187 behaviour exactly), but a
// caller that has the PR object and skips it is leaving this exact hole
// open.
//
// All I/O — the `gh` calls — lives here. scripts/review/core.js is pure.

import { execFileSync } from "node:child_process";
import { filterByAuthor, latestNativeReview, latestReviewComment, reviewAuthorises, uiSurfaceTouched } from "./core.js";

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[++i];
    if (key === "reviewer") {
      (flags.reviewer ??= []).push(value);
    } else {
      flags[key] = value;
    }
  }
  return flags;
}

const sh = (args) => execFileSync("gh", args, { encoding: "utf8" });

const [command, ...rest] = process.argv.slice(2);
const flags = parseArgs(rest);

if (!["read", "check"].includes(command) || !flags.repo || !flags.pr) {
  console.error(
    "usage: agentflow-review read  --repo owner/name --pr N\n" +
      "       agentflow-review check --repo owner/name --pr N --head <sha> --reviewer <login> [--reviewer <login> ...] [--pr-author <login>] [--files a,b] [--ui-globs g1,g2]"
  );
  process.exit(20);
}

const reviewerLogins = (flags.reviewer ?? []).filter((v) => typeof v === "string" && v.trim().length > 0);

if (command === "check" && reviewerLogins.length === 0) {
  console.error(
    "agentflow-review check requires --reviewer <login> (repeatable) — " +
      "a gate decision made without a trusted identity is not a gate decision. " +
      "See scripts/review/cli.js's header for why this is required rather than merely documented."
  );
  process.exit(20);
}

try {
  // Both fetches carry `user.login`/`author_association` through as
  // `author: { login, association }` so `check` can filter on them.
  const comments = JSON.parse(
    sh([
      "api",
      `repos/${flags.repo}/issues/${flags.pr}/comments`,
      "--jq",
      "[.[] | {body, author: {login: .user.login, association: .author_association}}]",
    ])
  );
  const nativeReviews = JSON.parse(
    sh([
      "api",
      `repos/${flags.repo}/pulls/${flags.pr}/reviews`,
      "--jq",
      "[.[] | {state, commit_id, body, author: {login: .user.login, association: .author_association}}]",
    ])
  );

  if (command === "read") {
    // Diagnostic view over the RAW, unfiltered lists — not a gate decision,
    // so no authorship filtering: a human skimming this wants to see
    // everything that exists, trusted or not.
    const native = latestNativeReview(nativeReviews);
    const comment = latestReviewComment(comments);
    console.log(JSON.stringify({ native, comment }, null, 2));
    process.exit(native || comment ? 0 : 10);
  }

  // command === "check": filter to trusted logins BEFORE collapsing. See the
  // header comment for why this order, not the reverse, is what keeps a
  // trusted veto from being laundered away by a newer untrusted post.
  // `--pr-author`, when given, excludes that login from the trusted set in
  // the same pass (#187) — a trusted login is not proof of "not the PR's own
  // author" once a write principal can author PRs under it.
  const prAuthor = typeof flags["pr-author"] === "string" && flags["pr-author"].trim() ? flags["pr-author"] : null;
  const trustedComments = filterByAuthor(comments, reviewerLogins, prAuthor);
  const trustedNativeReviews = filterByAuthor(nativeReviews, reviewerLogins, prAuthor);
  const native = latestNativeReview(trustedNativeReviews);
  const comment = latestReviewComment(trustedComments);

  const files = flags.files ? flags.files.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const uiGlobs = flags["ui-globs"] ? flags["ui-globs"].split(",").map((s) => s.trim()).filter(Boolean) : [];
  const uiTouched = uiSurfaceTouched(files, uiGlobs);

  const result = reviewAuthorises({ native, comment }, { headSha: flags.head ?? null, uiTouched });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.authorised ? 0 : 10);
} catch (err) {
  console.error(err.message);
  process.exit(20);
}
