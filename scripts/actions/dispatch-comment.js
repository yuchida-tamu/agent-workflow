#!/usr/bin/env node
// GitHub Actions entry: issues.labeled with a state:* label → either post the
// dispatch line saying who acts next, or *launch* that agent headlessly.
//
// Which one happens is per state and per repo: `headless.dispatch.<state>`.
// Every flag ships false, so the default behaviour is exactly what it has always
// been — a comment. The launch path is stage 2 of #83; stage 1 (review on
// pull_request) is the stage enabled first.
//
// Env: GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GH_TOKEN,
// CLAUDE_CODE_OAUTH_TOKEN (launch path only), AGENTFLOW_TOOLKIT.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DISPATCH } from "../next/core.js";
import { LABEL_PREFIX } from "../state/machine.js";
import { dispatchEnabled } from "../headless/config.js";
import { TOKEN_VAR, classify, launchPlan, summaryLine } from "../headless/core.js";
import { runProcess } from "../headless/run.js";
import { loadTiers } from "../log/cli.js";

const TOOLKIT = process.env.AGENTFLOW_TOOLKIT ?? join(dirname(fileURLToPath(import.meta.url)), "../..");
const MARKER = "<!-- agentflow-dispatch -->";

// What this event should cause. Pure, so the branch deciding whether an agent
// runs unattended is testable without an event, a token, or a network — the
// same split `pr-verdict` and the headless launcher already keep.
//
// → { act: "ignore" | "comment" | "launch", state?, dispatch?, reason? }
export function dispatchAction({ label, config = {}, env = {} }) {
  if (!label?.startsWith(LABEL_PREFIX)) return { act: "ignore", reason: "not a state label" };

  const state = label.slice(LABEL_PREFIX.length);
  const dispatch = DISPATCH[state];
  if (!dispatch || dispatch.actor === "none") {
    return { act: "ignore", state, reason: `no actor for state "${state}"` };
  }

  // Only an agent can be launched. A state whose actor is a human or a script
  // still gets its comment: launching is an execution path for the `agent:`
  // rows, not a replacement for the dispatch line.
  if (dispatch.actor !== "agent") {
    return { act: "comment", state, dispatch, reason: `${dispatch.actor} acts here` };
  }

  if (!dispatchEnabled(config, state)) {
    return { act: "comment", state, dispatch, reason: `headless.dispatch.${state} is off` };
  }
  if (!env[TOKEN_VAR]) {
    // Flag on, credential absent. Comment rather than fail: the dispatch line is
    // what the repo had before headless existed, so falling back to it leaves
    // the loop working instead of silently dropping the event.
    return {
      act: "comment",
      state,
      dispatch,
      reason: `headless.dispatch.${state} is on but ${TOKEN_VAR} is not set — falling back to the dispatch comment`,
    };
  }
  return { act: "launch", state, dispatch };
}

export function commentBody(dispatch, note = null) {
  const line = `${MARKER}
**agentflow next:** \`${dispatch.actor}:${dispatch.who}\` — ${dispatch.action}`;
  return note ? `${line}\n\n${note}` : line;
}

// The prompt names the work item and stops. What the agent does with it is its
// own definition's business, reached through `--agent` — one rubric per agent
// rather than two that drift.
export function launchPrompt({ repo, issue, state, who }) {
  return [
    `You are the ${who}. Act on issue #${issue} in ${repo}, which has just entered state \`${state}\`.`,
    "Follow your definition. Post your artifact to the issue.",
    "You may not transition state labels or approve any gate — the gate workflow owns both.",
  ].join("\n");
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });

function upsertComment(repo, issue, body) {
  const existing = JSON.parse(
    sh("gh", ["api", `repos/${repo}/issues/${issue}/comments`, "--jq", "[.[] | {id, body}]"]),
  ).find((c) => c.body.startsWith(MARKER));
  if (existing) {
    sh("gh", ["api", "--method", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`]);
  } else {
    sh("gh", ["issue", "comment", issue, "--repo", repo, "--body", body]);
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
  const issue = String(event.issue.number);
  const config = existsSync("agentflow.config.json")
    ? JSON.parse(readFileSync("agentflow.config.json", "utf8"))
    : {};

  const decision = dispatchAction({ label: event.label?.name ?? "", config, env: process.env });

  if (decision.act === "ignore") {
    console.log(`dispatch: nothing to do — ${decision.reason}`);
    return 0;
  }

  if (decision.act === "comment") {
    upsertComment(repo, issue, commentBody(decision.dispatch));
    console.log(`dispatched: state:${decision.state} → ${decision.dispatch.actor}:${decision.dispatch.who}`);
    if (decision.reason) console.log(`            (${decision.reason})`);
    return 0;
  }

  // --- launch ---------------------------------------------------------------
  const { state, dispatch } = decision;
  const agent = dispatch.who;
  const tiers = loadTiers(join(TOOLKIT, "agents"));
  const tier = tiers[agent] ?? null;
  const run = `dispatch-${issue}-${state}`;

  const log = (args) => {
    try {
      execFileSync("node", [join(TOOLKIT, "scripts/log/cli.js"), ...args], { encoding: "utf8" });
    } catch (err) {
      // The ledger is evidence, not a gate. Losing a row must not lose the work.
      console.error(`ledger: ${err.message}`);
    }
  };

  log(["start", "--issue", issue, "--run", run, "--phase", state,
       "--agent", agent, "--model", tier ?? "unknown", "--repo", repo]);

  let result;
  try {
    const plan = launchPlan({
      agent,
      stage: state,
      config,
      env: process.env,
      tiers,
      prompt: launchPrompt({ repo, issue, state, who: agent }),
    });
    result = plan.launch
      ? { ...classify(await runProcess(plan)), model: plan.model }
      : { outcome: plan.outcome, reason: plan.reason, usage: null, model: null };
  } catch (err) {
    result = { outcome: "failed", reason: err.message, usage: null, model: null };
  }

  const ledgerOutcome = result.outcome === "ok" ? "ok" : result.outcome === "disabled" ? "abandoned" : "failed";
  log(["end", "--issue", issue, "--run", run, "--outcome", ledgerOutcome, "--repo", repo]);

  // Escalate exactly once, by comment, and never retry. For a spent rate-limit
  // window a retry is a spin; for an expired token it is a spin that also looks
  // like a broken agent. The comment restores the dispatch line, so the item is
  // visibly waiting for a human rather than silently dropped.
  if (result.outcome !== "ok") {
    upsertComment(
      repo,
      issue,
      commentBody(
        dispatch,
        `> Headless launch did not complete (**${result.outcome}**): ${result.reason ?? "no reason reported"}\n` +
          "> This item is waiting for a human, or for the cause to be fixed. It will not retry on its own.",
      ),
    );
  }

  summarise(summaryLine({ agent, model: result.model, outcome: result.outcome, usage: result.usage }));
  console.log(`launched: state:${state} → ${agent} — ${result.outcome}`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err.message);
    process.exit(20);
  });
}
