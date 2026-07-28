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
import { METERED_VAR, TOKEN_VAR, classify, launchPlan, reviewText, summaryLine } from "../headless/core.js";
import { reviewEnabled } from "../headless/config.js";
import { loadTiers } from "../log/cli.js";
import { runId } from "./dispatch-comment.js";
// The review-artifact contract (#111, merged): marker + verdict/sha/ux lines
// the G3 guard's reader parses back. This is what #112 exists to emit —
// reusing the reader's own exported constants rather than restating the
// grammar here keeps the writer and reader from drifting apart.
import { MARKER, VERDICTS } from "../review/core.js";
import { resolveIdentity, botLogin } from "../identity/identity.js";

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
// Anything that doesn't parse as `{ findings: [...] }` is not a shape this
// can trust — `verdictFromFindings` treats that the same as a review that
// produced nothing usable.
export function findingsFromText(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.findings) ? parsed.findings : null;
  } catch {
    return null;
  }
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

// The single place both the posted comment and the native review (if any)
// derive their verdict from, so the two artifacts can never disagree about
// the same run (the "native vs comment divergence" risk #81's plan calls
// out). A non-"ok" outcome (disabled, unauthenticated, rate-limited, failed)
// never produced findings to read, so it is `not-mergeable` unconditionally —
// the PR was not reviewed, and the guard must refuse rather than pass on a
// run that did not happen.
export function reviewVerdict({ outcome, text }) {
  if (outcome !== "ok") return NOT_MERGEABLE;
  return verdictFromFindings(findingsFromText(text));
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

// The native review's body. Short on purpose: the findings live in the
// comment artifact (both modes keep it, per #112's plan, so solo and
// native-review repos audit identically); this is only the record that a
// native review exists and what it says.
export function renderNativeReview({ verdict, headSha }) {
  return `⚙️ agentflow headless review: \`${verdict}\` at \`${headSha}\`. Findings are in the review-artifact comment on this PR.`;
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
function submitNativeReview({ config, repo, prNumber, pr, verdict, headSha }) {
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
  try {
    sh([
      "pr", "review", String(prNumber), "--repo", repo,
      verdict === MERGEABLE ? "--approve" : "--request-changes",
      "--body", renderNativeReview({ verdict, headSha }),
    ]);
    console.log(`headless review: native review submitted (${verdict}) — ${decision.reason}`);
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
    submitNativeReview({ config, repo, prNumber, pr, verdict: NOT_MERGEABLE, headSha: pr.head.sha });
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
  submitNativeReview({ config, repo, prNumber, pr, verdict: reviewVerdict({ outcome: result.outcome, text }), headSha });

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
