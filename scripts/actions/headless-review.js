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
import { METERED_VAR, TOKEN_VAR, classify, launchPlan, summaryLine } from "../headless/core.js";
import { reviewEnabled } from "../headless/config.js";
import { loadTiers } from "../log/cli.js";
import { runId } from "./dispatch-comment.js";

const TOOLKIT = process.env.AGENTFLOW_TOOLKIT ?? join(dirname(fileURLToPath(import.meta.url)), "../..");
const MARKER = "<!-- agentflow-headless-review -->";
const AGENT = "code-reviewer";

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

// The comment posted to the PR. A failed or refused run still posts, because a
// review that silently did not happen is indistinguishable from one that found
// nothing — which is the failure mode this whole issue exists to remove.
export function reviewBody({ outcome, reason, text, model, usage }) {
  const head = `${MARKER}\n## Headless review — \`${AGENT}\` (${model ?? "no model"})`;
  if (outcome === "ok") {
    return `${head}\n\n${text}\n\n---\n\`${summaryLine({ agent: AGENT, model, outcome, usage })}\``;
  }
  const explanation = {
    disabled: "Headless review is switched off for this repo, so no review ran.",
    unauthenticated: "The subscription token was missing or rejected, so no review ran.",
    "rate-limited": "The subscription's rate-limit window was already spent, so no review ran.",
    failed: "The review run failed.",
  }[outcome] ?? "The review run did not complete.";
  return `${head}\n\n**${outcome}** — ${explanation}\n\n> ${reason ?? "no reason reported"}\n\n` +
    "This comment exists so the absence of a review is visible. A stage that fails silently is how review disappeared across #30–#69.";
}

function upsertComment(repo, prNumber, body) {
  const existing = JSON.parse(
    sh(["api", `repos/${repo}/issues/${prNumber}/comments`, "--jq", "[.[] | {id, body}]"]),
  ).find((c) => c.body.startsWith(MARKER));
  if (existing) {
    sh(["api", "--method", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`]);
  } else {
    sh(["pr", "comment", String(prNumber), "--repo", repo, "--body", body]);
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

// Extract the agent's text from `--output-format json`. The CLI wraps it, and a
// shape change upstream must degrade to "post what we got" rather than to a
// crash that loses a review already paid for.
export function reviewText(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed?.result ?? parsed?.text ?? stdout;
  } catch {
    return stdout;
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
      reviewBody({ outcome: "unauthenticated", reason: message, text: "", model: tier, usage: null }),
    );
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

  const body = reviewBody({
    outcome: result.outcome,
    reason: result.reason,
    text: reviewText(result.stdout ?? ""),
    model: result.model,
    usage: result.usage,
  });
  upsertComment(repo, prNumber, body);

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
