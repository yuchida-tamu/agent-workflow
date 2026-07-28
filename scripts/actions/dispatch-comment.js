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
import { TOKEN_VAR, classify, launchPlan, reviewText, summaryLine } from "../headless/core.js";
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

// A durable, per-state marker for the artifact a launch produces — deliberately
// NOT `MARKER`. #160's review traced a live bug: the ok-path artifact was first
// posted under the transient dispatch-line's own marker, so the very next state
// transition's plain `commentBody(dispatch)` upsert matched that same marker and
// overwrote the plan with the bare "agentflow next" line — the #157 symptom, one
// step later. Scoping the marker by state means successive stages' artifacts
// coexist as separate comments, and a re-run of the SAME state still upserts in
// place (idempotent per state) rather than piling up duplicates.
export function artifactMarker(state) {
  return `<!-- agentflow-artifact:${state} -->`;
}

// The prompt names the work item and stops. What the agent does with it is its
// own definition's business, reached through `--agent` — one rubric per agent
// rather than two that drift.
export function launchPrompt({ repo, issue, state, who }) {
  return [
    `You are the ${who}. Act on issue #${issue} in ${repo}, which has just entered state \`${state}\`.`,
    "Follow your definition. Return your artifact as your final message; the workflow posts it.",
    "You may not transition state labels or approve any gate — the gate workflow owns both.",
  ].join("\n");
}

// A ledger run id, unique per *attempt*.
//
// `agentflow-log start` appends a row and `end` closes the first row matching
// the id, so a repeated id leaves a row that can never be closed. That is not
// theoretical: it happened on #91 during this issue's own build, and the review
// entry point would have repeated its id on every `synchronize` event.
//
// `GITHUB_RUN_ID` + `GITHUB_RUN_ATTEMPT` are unique per attempt and make the row
// traceable back to the run that wrote it. Outside Actions they are absent, and
// the bare prefix is the honest fallback.
export function runId(prefix, env = process.env) {
  const parts = [prefix, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT].filter(Boolean);
  return parts.join("-");
}

// GitHub caps an issue comment body at ~65536 characters (undocumented but
// observed in practice). The rest of the comment — marker, heading, summary
// footer — costs a few hundred more, so the artifact itself is capped well
// under that, with an honest marker at the cut point rather than a silent
// truncation, for the rare run whose artifact is enormous. Exported so a test
// can build a boundary case without duplicating the literal.
export const MAX_ARTIFACT_CHARS = 60000;

// The code unit at `index` is a high (leading) surrogate — the first half of a
// two-unit UTF-16 pair (emoji, many CJK-extension and symbol code points). If
// it is the LAST unit a slice keeps, the low surrogate it pairs with falls
// just past the cut, leaving a lone high surrogate — not a valid character on
// its own, and exactly the kind of mid-character truncation that turns into a
// mojibake glyph or a broken comment render.
function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

// Where to actually cut so a slice never splits a surrogate pair. Backs off by
// one code unit when the character right at the boundary is a lone high
// surrogate; otherwise the boundary was already safe (either a normal
// character or a complete pair — the low surrogate can only appear at `max-1`
// if its high surrogate at `max-2` was already included).
function safeCut(text, max) {
  return max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
}

export function truncateArtifact(text) {
  if (text.length <= MAX_ARTIFACT_CHARS) return text;
  const cut = safeCut(text, MAX_ARTIFACT_CHARS);
  return (
    `${text.slice(0, cut)}\n\n` +
    `> …truncated — the artifact was ${text.length} characters; showing the first ${cut}.`
  );
}

// The note appended under the artifact's heading — the `ok` counterpart to the
// escalation note below, in parity with headless-review.js's `reviewBody`: the
// artifact text, a `---` divider, then the same `summaryLine` footer the
// workflow's own step summary carries. This is the fix for #157: a successful
// run used to post only a ledger row.
export function artifactNote({ agent, model, outcome, usage, text }) {
  return `${truncateArtifact(text)}\n\n---\n\`${summaryLine({ agent, model, outcome, usage })}\``;
}

// The full artifact comment: its own durable marker (never `MARKER` — see
// `artifactMarker`), a short heading naming who produced it and at which
// state, then the note. A separate comment from the transient dispatch line,
// on purpose — the two upsert independently and never contend for the same
// marker.
export function artifactCommentBody(state, agent, note) {
  return `${artifactMarker(state)}\n**agentflow artifact:** \`agent:${agent}\` at \`state:${state}\`\n\n${note}`;
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });

// Pure half of "which comment is this posting to" — split out because #160's
// review found the whole bug living in this decision: reusing the dispatch
// line's marker for the artifact meant one match answered both, so the next
// state's dispatch-line upsert silently matched and overwrote the previous
// state's artifact. Testable without `gh`, a token, or a network.
export function matchingComment(comments, marker) {
  return comments.find((c) => c.body.startsWith(marker));
}

function upsertComment(repo, issue, body, marker = MARKER) {
  const comments = JSON.parse(
    sh("gh", ["api", `repos/${repo}/issues/${issue}/comments`, "--jq", "[.[] | {id, body}]"]),
  );
  const existing = matchingComment(comments, marker);
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
  const run = runId(`dispatch-${issue}-${state}`);

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
    if (plan.launch) {
      const finished = await runProcess(plan);
      result = { ...classify(finished), model: plan.model, stdout: finished.stdout };
    } else {
      result = { outcome: plan.outcome, reason: plan.reason, usage: null, model: null, stdout: "" };
    }
  } catch (err) {
    result = { outcome: "failed", reason: err.message, usage: null, model: null, stdout: "" };
  }

  const ledgerOutcome = result.outcome === "ok" ? "ok" : result.outcome === "disabled" ? "abandoned" : "failed";
  log(["end", "--issue", issue, "--run", run, "--outcome", ledgerOutcome, "--repo", repo]);

  // The point of this whole stage (#157): a run that succeeded produced an
  // artifact, and the artifact is what the agent was launched for — not the
  // ledger row. Posted under its OWN state-scoped marker (#160), as a comment
  // separate from the transient dispatch line, so a later state's plain
  // dispatch-line upsert can never overwrite it.
  if (result.outcome === "ok") {
    const note = artifactNote({
      agent,
      model: result.model,
      outcome: result.outcome,
      usage: result.usage,
      text: reviewText(result.stdout ?? ""),
    });
    upsertComment(repo, issue, artifactCommentBody(state, agent, note), artifactMarker(state));
  }

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
