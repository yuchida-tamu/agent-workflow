#!/usr/bin/env node
// GitHub Actions entry: pull_request opened/synchronize/reopened → run the
// repo's own code-reviewer with no human session present, post its findings,
// and open/close a run-ledger row around it.
//
// This is the stage that pays for #83: the review step is what quietly
// disappeared across #30–#69, and a review nobody has to remember to run is the
// only kind that cannot be skipped.
//
// Two credentials, two questions, deliberately not collapsed into one:
//   CLAUDE_CODE_OAUTH_TOKEN — which model account pays (the subscription)
//   GH_TOKEN                — who GitHub thinks is acting (the App, via #87)
//
// Env: GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN,
// GITHUB_STEP_SUMMARY (optional), AGENTFLOW_TOOLKIT (defaults to ../..).

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Composed from the primitives rather than through `launch()`: the review text
// is the artifact here, and `launch()` returns only the classification, not the
// child's stdout. Composing keeps this inside the declared file surface and uses
// seams #91 already exports. (`launch()` growing a stdout passthrough would let
// this collapse back to one call — worth doing, but not by widening this PR.)
import { runProcess } from "../headless/run.js";
import { METERED_VAR, TOKEN_VAR, classify, extractJsonFence, launchPlan, reviewText, summaryLine } from "../headless/core.js";
import { reviewEnabled } from "../headless/config.js";
import { loadTiers } from "../log/cli.js";
import { runId } from "./dispatch-comment.js";
// The review-artifact contract (#111, merged): marker + verdict/sha/ux lines
// the G3 guard's reader parses back. This is what #112 exists to emit —
// reusing the reader's own exported constants rather than restating the
// grammar here keeps the writer and reader from drifting apart.
// `filterByAuthor` is the pre-collapse trust filter #113 requires before any
// list of reviews is treated as authoritative — reused here (#181-A) so this
// module's own reconciliation of its PRIOR native reviews follows the exact
// same "filter to trust, then collapse" discipline the G3 guard itself is
// held to, rather than re-deriving a second, weaker notion of "ours".
import { MARKER, VERDICTS, filterByAuthor } from "../review/core.js";
import { resolveIdentity, botLogin, trustedReviewerLogins } from "../identity/identity.js";

const TOOLKIT = process.env.AGENTFLOW_TOOLKIT ?? join(dirname(fileURLToPath(import.meta.url)), "../..");
const AGENT = "code-reviewer";
// The only severity that flips the verdict on its own. Matches the three-tier
// scale (`high`/`medium`/`low`) agents/code-reviewer.md's Artifact format
// section now instructs the agent to use — "blocking" per #112's brief.
const BLOCKING_SEVERITY = "high";

// Named from the reader's own array rather than restated, so the two literal
// words this module is allowed to write can never drift from what
// `parseReviewComment`/`VERDICTS` accept.
const [MERGEABLE, NOT_MERGEABLE] = VERDICTS;

const sh = (args) => execFileSync("gh", args, { encoding: "utf8" });

// The prompt carries the *task*, never the rubric. The rubric lives in
// `agents/code-reviewer.md` and reaches the run through `--agent`, so the
// headless reviewer and the session reviewer follow one definition rather than
// two that drift.
export function reviewPrompt({ repo, prNumber, baseSha, headSha }) {
  return [
    `Review pull request #${prNumber} in ${repo}.`,
    `The diff is \`git diff ${baseSha}...${headSha}\` — three dots, the merge-base form.`,
    "CI is already green; do not re-litigate what lint, typecheck or tests cover.",
    "Output only the JSON object your definition specifies. An empty findings list is a valid result.",
  ].join("\n");
}

// Extracts the `findings` array the agent's own JSON output carries, if any.
// Two attempts, in order:
//
//  1. `JSON.parse` the WHOLE text. Preserves the original behaviour for a
//     compliant JSON-only agent that emits nothing but the envelope.
//  2. Otherwise scan for fenced ` ```json ` blocks (`extractJsonFence`,
//     scripts/headless/core.js — shared with dispatch-comment.js's
//     plan.json extraction, #175) and take the LAST one that parses to an
//     object carrying a `findings` array.
//
// (2) is the fix for #171: a full prose review ending in a fenced
// `{"findings": [...]}` block used to fail step (1)'s whole-text parse and
// fall straight to `null` — indistinguishable, downstream, from a review
// that genuinely refused to produce anything readable. Trying the fence scan
// is what lets a compliant-but-chatty agent's real findings be read instead
// of discarded.
//
// Anything that satisfies NEITHER attempt is not a shape this can trust —
// `verdictFromFindings` (via `reviewBasis`) treats that the same as a review
// that produced nothing usable.
export function findingsFromText(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.findings)) return parsed.findings;
  } catch {
    // Not a bare JSON envelope — fall through to the fenced-block scan.
  }
  const fenced = extractJsonFence(
    text,
    (candidate) => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate) && Array.isArray(candidate.findings),
  );
  return fenced ? fenced.findings : null;
}

// The deterministic half of the contract (Determinism-first, CLAUDE.md ground
// rule 1): a script decides the verdict from the agent's own structured
// findings, rather than trusting free text the agent might phrase as
// "Verdict: APPROVE" — see agents/code-reviewer.md's Artifact format section
// for the live incident that phrasing caused (the guard read it as no review
// at all). Any finding at the blocking severity makes the run
// `not-mergeable`; an empty or all-lower-severity list is `mergeable`. A
// findings value that isn't even an array is NOT mergeable — an unreadable
// result must not be trusted as a pass, same "absence is refusal" posture
// scripts/review/core.js keeps for a missing artifact.
export function verdictFromFindings(findings) {
  if (!Array.isArray(findings)) return NOT_MERGEABLE;
  // Folded to lowercase and trimmed before comparing: the agent's own JSON
  // is free text, not a validated enum, and "High"/"HIGH" (or trailing
  // whitespace) must not silently downgrade a blocking finding to a false
  // `mergeable` — a case mismatch here is exactly the class of failure this
  // module exists to prevent by deciding the verdict itself instead of
  // trusting the agent's prose.
  return findings.some((f) => String(f?.severity ?? "").trim().toLowerCase() === BLOCKING_SEVERITY)
    ? NOT_MERGEABLE
    : MERGEABLE;
}

// The three reasons a run can end up NOT_MERGEABLE — not GitHub's vocabulary,
// this module's own, closed the same way `VERDICTS` is closed, so a caller
// and its test cannot drift on the literal spelling.
//
//   "clean"      — findings were readable and none were blocking → MERGEABLE
//   "finding"    — findings were readable and at least one blocks → NOT_MERGEABLE
//   "unreadable" — no trustworthy findings at all: the run didn't produce
//                  output (a non-"ok" outcome) or its output didn't parse as
//                  `{ findings: [...] }` even after the fenced-block scan
//
// "finding" and "unreadable" used to be byte-identical downstream — both
// just `not-mergeable`, both wielding the same sticky native
// CHANGES_REQUESTED (#181's own root incident: a parse failure is not
// evidence of a real defect, and treating it as one is what "absence is
// refusal" is supposed to prevent from being invisible). This is the value
// that lets a caller finally tell the two apart.
export const BASIS_CLEAN = "clean";
export const BASIS_FINDING = "finding";
export const BASIS_UNREADABLE = "unreadable";

// The single place both the posted comment and the native review (if any)
// derive their verdict — AND their basis — from, so the two artifacts can
// never disagree about the same run (the "native vs comment divergence"
// risk #81's plan calls out). A non-"ok" outcome (disabled, unauthenticated,
// rate-limited, failed) never produced findings to read, so it is
// `not-mergeable`/`unreadable` unconditionally — the PR was not reviewed,
// and the guard must refuse rather than pass on a run that did not happen.
export function reviewBasis({ outcome, text }) {
  if (outcome !== "ok") return { verdict: NOT_MERGEABLE, basis: BASIS_UNREADABLE, findings: null };
  const findings = findingsFromText(text);
  if (!Array.isArray(findings)) return { verdict: NOT_MERGEABLE, basis: BASIS_UNREADABLE, findings: null };
  const verdict = verdictFromFindings(findings);
  return { verdict, basis: verdict === NOT_MERGEABLE ? BASIS_FINDING : BASIS_CLEAN, findings };
}

// Convenience for callers that only need the verdict — `reviewBody`'s
// contract line and this module's own pre-#181 test suite both do, and
// re-deriving it from `reviewBasis` keeps this file from carrying two
// independent verdict computations that could disagree.
export function reviewVerdict({ outcome, text }) {
  return reviewBasis({ outcome, text }).verdict;
}

// The comment posted to the PR. A failed or refused run still posts, because a
// review that silently did not happen is indistinguishable from one that found
// nothing — which is the failure mode this whole issue exists to remove.
//
// The first three lines after the marker are the review-artifact contract
// (#111's scripts/review/core.js): `verdict:`, `sha:`, `ux:`, each on its own
// line with no other text — the exact shape `parseReviewComment` requires.
// `sha` is always the full head commit, never abbreviated, so a later commit
// can never be mistaken for the one this artifact describes. `ux` is always
// `n/a` here: the headless path only ever runs code-reviewer, never
// ux-reviewer (see agents/ux-reviewer.md's Artifact format section for when a
// UX pass records something else on this same artifact).
export function reviewBody({ outcome, reason, text, model, usage, headSha }) {
  const verdict = reviewVerdict({ outcome, text });
  const contract = `${MARKER}\nverdict: ${verdict}\nsha: ${headSha}\nux: n/a`;
  const head = `## Headless review — \`${AGENT}\` (${model ?? "no model"})`;
  if (outcome === "ok") {
    return `${contract}\n\n${head}\n\n${text}\n\n---\n\`${summaryLine({ agent: AGENT, model, outcome, usage })}\``;
  }
  const explanation = {
    disabled: "Headless review is switched off for this repo, so no review ran.",
    unauthenticated: "The subscription token was missing or rejected, so no review ran.",
    "rate-limited": "The subscription's rate-limit window was already spent, so no review ran.",
    failed: "The review run failed.",
  }[outcome] ?? "The review run did not complete.";
  return `${contract}\n\n${head}\n\n**${outcome}** — ${explanation}\n\n> ${reason ?? "no reason reported"}\n\n` +
    "This comment exists so the absence of a review is visible. A stage that fails silently is how review disappeared across #30–#69.";
}

// Should this run also submit a native GitHub review, alongside the comment
// artifact? Pure, mirroring scripts/actions/auto-merge.js's decideBotReview:
// every "no" names itself, and an unknown acting login still attempts the
// review rather than skipping it on a guess — the comment artifact is the G3
// record either way, so trying costs nothing worse than an ignorable API
// error.
//
// Unlike decideBotReview, there is no risk-verdict gate here: the authority
// for *this* review is the review itself (this run's own verdict), not a
// separately-recorded risk level — so the only questions are "is there an
// identity to act as" and "would this be a forbidden self-review".
export function decideNativeReview({ identity, prAuthor = null, actingLogin = null }) {
  if (!identity?.configured) {
    return { review: false, reason: "no agent_identity configured — the comment artifact is the G3 record" };
  }
  if (actingLogin && prAuthor && actingLogin.toLowerCase() === prAuthor.toLowerCase()) {
    return {
      review: false,
      reason: `@${actingLogin} authored this PR — GitHub forbids approving your own pull request`,
    };
  }
  return {
    review: true,
    reason: `agent_identity configured (@${botLogin(identity.slug)}) — submitting a native review alongside the comment`,
  };
}

// The native review's body — three cases, not one (#181-B). Before this, a
// `not-mergeable` from a real `high` finding and a `not-mergeable` from
// findings that could not even be parsed rendered byte-identical text, which
// is exactly backwards: those two want OPPOSITE responses from a human
// (fix the code vs. go look at why the review couldn't be read), and the one
// place meant to make that distinction visible was erasing it.
//
// Findings still live in the comment artifact either way (both modes keep
// it, per #112's plan, so solo and native-review repos audit identically) —
// this is only the record that a native review exists, what it says, and
// (now) why.
export function renderNativeReview({ verdict, basis, headSha }) {
  if (verdict === MERGEABLE) {
    return `⚙️ agentflow headless review: \`mergeable\` at \`${headSha}\`. Approved.`;
  }
  if (basis === BASIS_UNREADABLE) {
    return (
      `⚙️ agentflow headless review: \`not-mergeable\` at \`${headSha}\`. ` +
      "The findings could not be parsed from the agent's output — refusing by default is the safe " +
      "posture here, not evidence of a real defect. See the review-artifact comment on this PR for " +
      "whatever was captured."
    );
  }
  return (
    `⚙️ agentflow headless review: \`not-mergeable\` at \`${headSha}\`. ` +
    "Findings are in the review-artifact comment on this PR."
  );
}

// The GitHub review event AND the review state it results in, decided from
// the SAME (verdict, basis) pair `renderNativeReview` reads — one source, so
// the flag submitted, the state GitHub records, and the wording a human sees
// can never independently drift.
//
// #181-C: a real `high` finding still `--request-changes` — a genuine
// blocking veto belongs in the review-state channel scripts/review/core.js's
// native-review precedence already trusts. A parse failure or a run that
// produced no output (`basis === "unreadable"`) uses `--comment` instead, so
// an unreadable result never wields the same sticky, blocking
// CHANGES_REQUESTED a real finding does — it records the artifact and lets
// the comment-artifact veto (scripts/review/core.js, #113's G3 guard) do the
// actual refusing.
export function nativeReviewEvent({ verdict, basis }) {
  if (verdict === MERGEABLE) return { flag: "--approve", state: "APPROVED" };
  if (basis === BASIS_FINDING) return { flag: "--request-changes", state: "CHANGES_REQUESTED" };
  return { flag: "--comment", state: "COMMENTED" };
}

// What to do about the bot's OWN prior native reviews before this run submits
// a fresh one (#181-A). `reviews` is the raw list this module fetched,
// ALREADY filtered to the trusted identity by the caller (`filterByAuthor` +
// `trustedReviewerLogins`, same discipline scripts/review/core.js's header
// insists every collapse follow) — never filtered here, so an untrusted
// review can never be mistaken for one this function is entitled to dismiss.
// Pure: the caller does the fetching and the dismissing this decides.
//
// A CHANGES_REQUESTED at a SHA that isn't head is stale — the code it
// blocked has moved on. Nothing else clears it: branch protection's own
// `dismiss_stale_reviews` is unavailable on a free private repo, and only an
// APPROVE from the same reviewer self-heals it, which never arrives while
// the verdict stays not-mergeable across pushes (#181's observed failure —
// #21 and #22 each accumulated two undismissed CHANGES_REQUESTED). Every
// stale one is dismissed, not just the newest, so a run that resumes after
// several stuck pushes clears all of them rather than leaving a remainder to
// keep accumulating.
//
// A review already at head in the EXACT state this run is about to submit is
// a duplicate, not evidence of anything new — `skip` says so, so the caller
// does not add a second identical review on top of one that already stands.
export function reconcileNativeReviews({ reviews, headSha, state }) {
  const list = reviews ?? [];
  const stale = list.filter((r) => r.state === "CHANGES_REQUESTED" && r.commit_id !== headSha);
  const duplicate = list.some((r) => r.commit_id === headSha && r.state === state);
  return { dismissIds: stale.map((r) => r.id), skip: duplicate };
}

function upsertComment(repo, prNumber, body) {
  // `.find()` edits the FIRST marker comment it sees, while the reader
  // (scripts/review/core.js's latestReviewComment) trusts the LAST one when
  // several exist — safe ONLY because this workflow is the single writer of
  // this marker and its concurrency group is `cancel-in-progress: true`
  // (.github/workflows/agentflow-review.yml), so at most one marker comment
  // is ever live at a time. A second concurrent writer to this same marker
  // (another workflow, ux-reviewer posting independently, a human pasting
  // the marker by hand) would create a first/last split this function does
  // not detect or reconcile.
  const existing = JSON.parse(
    sh(["api", `repos/${repo}/issues/${prNumber}/comments`, "--jq", "[.[] | {id, body}]"]),
  ).find((c) => c.body.startsWith(MARKER));
  if (existing) {
    sh(["api", "--method", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`]);
  } else {
    sh(["pr", "comment", String(prNumber), "--repo", repo, "--body", body]);
  }
}

// Where an App identity is configured, the comment above is joined by a
// native review — the artifact the guard treats as authoritative in
// native-review mode (scripts/review/core.js's precedence). The comment
// artifact is kept in both modes regardless (auto-merge.js's record-vs-review
// split, mirrored here): a native review that fails to submit must never lose
// the record, and a solo-comment repo must audit identically to a
// native-review one.
function submitNativeReview({ config, repo, prNumber, pr, verdict, basis, headSha }) {
  let actingLogin = null;
  try {
    actingLogin = sh(["api", "user", "--jq", ".login"]).trim() || null;
  } catch {
    actingLogin = null; // an App installation token cannot read /user; decide without it
  }
  const decision = decideNativeReview({
    identity: resolveIdentity(config),
    prAuthor: pr.user?.login ?? null,
    actingLogin,
  });
  if (!decision.review) {
    console.log(`headless review: no native review — ${decision.reason}`);
    return;
  }

  const { flag, state } = nativeReviewEvent({ verdict, basis });

  // Reconcile before submitting (#181-A): dismiss any stale CHANGES_REQUESTED
  // left by a PRIOR run of this same reviewer, and skip submitting a
  // duplicate of what already stands at head. Reconciliation is a courtesy,
  // not a gate — if listing or dismissing fails (rate limit, a token that
  // can't read reviews), the run still submits its own review rather than
  // losing the artifact over a housekeeping step.
  try {
    const trusted = trustedReviewerLogins({ config });
    const raw = JSON.parse(
      sh([
        "api", `repos/${repo}/pulls/${prNumber}/reviews`, "--jq",
        "[.[] | {id, state, commit_id, author: {login: .user.login, association: .author_association}}]",
      ]),
    );
    const ownReviews = filterByAuthor(raw, trusted.logins);
    const { dismissIds, skip } = reconcileNativeReviews({ reviews: ownReviews, headSha, state });
    for (const id of dismissIds) {
      try {
        sh([
          "api", "--method", "PUT", `repos/${repo}/pulls/${prNumber}/reviews/${id}/dismissals`,
          "-f", "message=superseded by a fresh headless review at a later commit",
          "-f", "event=DISMISS",
        ]);
      } catch (err) {
        console.log(`headless review: could not dismiss stale review ${id} (${err.message})`);
      }
    }
    if (skip) {
      console.log(`headless review: a native review already stands at ${headSha} in state ${state} — not duplicating`);
      return;
    }
  } catch (err) {
    console.log(`headless review: reconciliation skipped (${err.message}) — submitting anyway`);
  }

  try {
    sh(["pr", "review", String(prNumber), "--repo", repo, flag, "--body", renderNativeReview({ verdict, basis, headSha })]);
    console.log(`headless review: native review submitted (${verdict}/${basis}, ${flag}) — ${decision.reason}`);
  } catch (err) {
    // Never fatal. The comment artifact is the record either way — mirrors
    // auto-merge.js's posture on a review that fails to submit.
    console.log(`headless review: native review could not be submitted (${err.message}) — the comment artifact stands`);
  }
}

function summarise(line) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, `${line}\n`);
  } catch {
    // A summary is a courtesy; failing to write one must not fail the run.
  }
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = event.pull_request;
  const prNumber = pr.number;

  const config = existsSync("agentflow.config.json")
    ? JSON.parse(readFileSync("agentflow.config.json", "utf8"))
    : {};

  // Checked here as well as inside the launcher so a switched-off repo costs
  // nothing at all — no ledger row, no comment, no API calls.
  if (!reviewEnabled(config)) {
    console.log("headless review is off for this repo (headless.review) — nothing to do");
    summarise("headless review: off (`headless.review` is false) — nothing ran");
    return 0;
  }

  // The declared tier, read once and used for both the invocation and the ledger
  // row. A literal here would let the row disagree with what actually ran the
  // moment the roster changes tier — which is not hypothetical: that exact drift
  // produced two `agentflow-log audit` violations while this issue was being
  // built.
  const tiers = loadTiers(join(TOOLKIT, "agents"));
  const tier = tiers[AGENT] ?? null;

  if (!process.env[TOKEN_VAR]) {
    // Named loudly and early, before anything else is attempted — and posted,
    // not just logged. This repo asked for review by enabling the flag; not
    // getting one has to be as visible on the PR as a finding would be. (The
    // opted-out path above stays silent on purpose: a repo that never asked for
    // headless review should not get a comment on every pull request.)
    const message = `headless disabled: no subscription token (${TOKEN_VAR}). See docs/headless-runbook.md.`;
    console.error(message);
    summarise(`headless review: **disabled** — ${message}`);
    upsertComment(
      repo,
      prNumber,
      reviewBody({ outcome: "unauthenticated", reason: message, text: "", model: tier, usage: null, headSha: pr.head.sha }),
    );
    submitNativeReview({ config, repo, prNumber, pr, verdict: NOT_MERGEABLE, basis: BASIS_UNREADABLE, headSha: pr.head.sha });
    return 0;
  }

  const run = runId(`review-${prNumber}-headless`);
  const log = (args) => {
    try {
      execFileSync("node", [join(TOOLKIT, "scripts/log/cli.js"), ...args], { encoding: "utf8" });
    } catch (err) {
      // The ledger is evidence, not a gate. Losing a row must not lose a review.
      console.error(`ledger: ${err.message}`);
    }
  };

  // Opened before the work, closed after — including on failure, so an
  // abandoned run is recorded rather than left open.
  log(["start", "--issue", String(prNumber), "--run", run, "--phase", "in-review",
       "--agent", AGENT, "--model", tier ?? "unknown", "--repo", repo]);

  let result;
  try {
    const plan = launchPlan({
      agent: AGENT,
      stage: "review",
      config,
      env: process.env,
      tiers,
      prompt: reviewPrompt({ repo, prNumber, baseSha: pr.base.sha, headSha: pr.head.sha }),
    });
    if (plan.launch) {
      const finished = await runProcess(plan);
      result = { ...classify(finished), model: plan.model, stdout: finished.stdout };
    } else {
      result = { outcome: plan.outcome, reason: plan.reason, usage: null, model: null, stdout: "" };
    }
  } catch (err) {
    result = { outcome: "failed", reason: err.message, usage: null, model: null, stdout: "" };
  }

  const text = reviewText(result.stdout ?? "");
  const headSha = pr.head.sha;
  const body = reviewBody({
    outcome: result.outcome,
    reason: result.reason,
    text,
    model: result.model,
    usage: result.usage,
    headSha,
  });
  upsertComment(repo, prNumber, body);
  const { verdict, basis } = reviewBasis({ outcome: result.outcome, text });
  submitNativeReview({ config, repo, prNumber, pr, verdict, basis, headSha });

  const ledgerOutcome = result.outcome === "ok" ? "ok" : result.outcome === "disabled" ? "abandoned" : "failed";
  log(["end", "--issue", String(prNumber), "--run", run, "--outcome", ledgerOutcome, "--repo", repo]);

  summarise(summaryLine({ agent: AGENT, model: result.model, outcome: result.outcome, usage: result.usage }));
  if (process.env[METERED_VAR]) {
    summarise(`> note: \`${METERED_VAR}\` was present in the environment and was withheld from the run.`);
  }

  console.log(`headless review: ${result.outcome}${result.reason ? ` — ${result.reason}` : ""}`);
  // A review that could not run is reported, not thrown: the PR carries the
  // comment, the ledger carries the row, and the workflow stays green so a
  // rate-limited window does not read as a broken build.
  return 0;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err.message);
    process.exit(20);
  });
}
