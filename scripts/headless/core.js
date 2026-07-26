// How an agent is invoked with no human session present, and what its exit
// meant. Pure: no spawn, no `gh`, no fs, no clock — `run.js` holds all of that,
// so every decision here is testable without a token, a network, or the
// `claude` binary.
//
// Two functions, because there are exactly two decisions: build the invocation,
// and read the result. Everything else is I/O.

import { reviewEnabled, dispatchEnabled } from "./config.js";

// The model runtime is the maintainer's Claude subscription, reached with a
// token from `claude setup-token`. This is the whole point of the design: a
// headless run must cost nothing beyond the subscription already being paid
// for.
export const TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

// The metered credential this design exists to avoid. If it is present in the
// runner's environment the CLI would prefer it and bill per token — silently,
// and separately from the subscription. It is stripped from the child
// environment rather than merely not passed: inheriting the parent env is the
// default, so "not passing it" is not a thing one can do by omission.
export const METERED_VAR = "ANTHROPIC_API_KEY";

// Bounds, not preferences. A headless reviewer reads diffs and branch names
// written by whoever opened the PR, so the invocation is what limits blast
// radius — there is no human watching to interrupt it.
//
// The bound is a wall clock, enforced by `run.js` on our side of the process
// boundary. A turn cap was tried and removed: `--max-turns` does not appear in
// `claude --help`, and the CLI *accepts it silently* rather than rejecting it.
// An undocumented flag that may or may not be honoured is the worst possible
// basis for a safety property — it reads as a bound in review while possibly
// doing nothing at runtime. What actually bounds a run is this timeout, the
// read-only tool allowlist, and `--permission-mode plan`.
export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

// Read-only by construction. The agent produces an artifact; the caller posts
// it. No Edit, no Write, no arbitrary Bash — a headless agent that can write to
// the checkout is a headless agent that can change what it is reviewing.
export const DEFAULT_ALLOWED_TOOLS = ["Read", "Grep", "Glob"];

// Every flag this module is allowed to emit, each one checked by hand against
// `claude --help` and kept here so a test can assert the argv never grows a
// flag nobody verified.
//
// This list exists because the first version emitted `--max-turns`, which is
// **not** in the CLI's help — and which the CLI accepts silently rather than
// rejecting, so nothing failed and nothing warned. Unit tests could not have
// caught it: the argv was internally consistent and every assertion passed.
//
// Verifying against `claude --help` at test time was tried and abandoned: the
// help text is written to two streams and is truncated mid-word when piped
// (121 of 230 lines), so the check failed on correct code depending on how it
// was invoked. A hand-maintained allowlist is honest about being hand-checked;
// a flaky introspection test would not have been.
export const KNOWN_FLAGS = [
  "--print", // non-interactive; the whole basis of headless
  "--agent", // resolves against .claude/agents — the repo's own definitions
  "--model", // the roster's declared tier
  "--permission-mode", // "plan": no mutation without an approval that cannot come
  "--allowedTools", // read-only allowlist
  "--output-format", // "json": usage figures for the ledger
];

// Outcomes are a closed set, and three of them are *not* generic failures.
// `rate-limited` and `unauthenticated` each have a different remedy, and the
// ledger has to say which — "failed" on both would make the two indistinguishable
// in an audit, which is how an expired token looks like a broken agent.
export const OUTCOMES = ["ok", "failed", "disabled", "rate-limited", "unauthenticated"];

const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /rate[_-]limit/i,
  /usage limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota (?:exceeded|exhausted)/i,
];

const AUTH_PATTERNS = [
  /oauth token (?:has )?expired/i,
  /token (?:has )?expired/i,
  /invalid[_ ]token/i,
  /unauthori[sz]ed/i,
  /authentication (?:failed|error)/i,
  /\b401\b/,
  /please run .*(?:setup-token|login)/i,
];

const matchesAny = (patterns, text) => patterns.some((p) => p.test(text));

// Whether this stage may run unattended at all. `review` is reached through the
// `pull_request` event; every other stage is reached through a state label, so
// the two are asked differently.
export function stageEnabled(config, stage) {
  return stage === "review" ? reviewEnabled(config) : dispatchEnabled(config, stage);
}

// → { launch: true, argv, env, timeoutMs } | { launch: false, outcome, reason }
//
// A refusal is a first-class return, not a throw. This is called from Actions
// entry points where a throw is the loudest and least useful way to fail, and
// where "we deliberately did nothing" must be distinguishable from "we broke".
export function launchPlan({
  agent,
  stage,
  config = {},
  env = {},
  tiers = {},
  prompt = "",
  allowedTools = DEFAULT_ALLOWED_TOOLS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!agent) {
    return { launch: false, outcome: "failed", reason: "no agent named — nothing to launch" };
  }
  if (!stageEnabled(config, stage)) {
    return {
      launch: false,
      outcome: "disabled",
      reason: `headless is off for stage "${stage}" — set headless.${stage === "review" ? "review" : `dispatch.${stage}`} to true to enable it`,
    };
  }

  const token = env[TOKEN_VAR];
  if (typeof token !== "string" || token.trim() === "") {
    return {
      launch: false,
      outcome: "unauthenticated",
      reason:
        `headless disabled: no subscription token — set the ${TOKEN_VAR} secret from ` +
        "`claude setup-token`. See docs/headless-runbook.md (token rotation).",
    };
  }

  // The tier the roster declares, never a literal. `agentflow-log audit` checks
  // ledger rows against this same source, so a hardcoded model here would let
  // what runs drift from what is declared while the audit still passed.
  const model = tiers[agent];
  if (!model) {
    return {
      launch: false,
      outcome: "failed",
      reason: `no declared model tier for agent "${agent}" — every agent definition must carry a \`model:\` field`,
    };
  }

  // `--bare` is deliberately absent and must stay absent: its own help states
  // that under it "OAuth and keychain are never read", so it would defeat
  // subscription auth entirely and fall back to the metered key. It reads like
  // exactly what a CI invocation wants, which is what makes it dangerous.
  const argv = [
    "--print",
    "--agent",
    agent,
    "--model",
    model,
    "--permission-mode",
    "plan",
    "--allowedTools",
    allowedTools.join(" "),
    "--output-format",
    "json",
  ];
  if (prompt) argv.push(prompt);

  // Built by removal, not by construction: the child inherits the runner's
  // environment, so the metered key has to be taken away rather than left out.
  const childEnv = { ...env };
  delete childEnv[METERED_VAR];

  return { launch: true, argv, env: childEnv, model, timeoutMs };
}

// → { outcome, reason, usage } — reads a finished run.
//
// Classification order matters: auth and rate limits are checked before the
// generic non-zero branch, because both exit non-zero and both would otherwise
// be indistinguishable from a crash.
export function classify({ code = 0, stdout = "", stderr = "", timedOut = false, timeoutMs = null } = {}) {
  if (timedOut) {
    return {
      outcome: "failed",
      reason: `timed out after ${timeoutMs ?? "?"}ms — the run was killed rather than left to hang`,
      usage: null,
    };
  }

  const text = `${stderr}\n${stdout}`;

  if (matchesAny(AUTH_PATTERNS, text)) {
    return {
      outcome: "unauthenticated",
      reason:
        `the ${TOKEN_VAR} was rejected — it has most likely expired. Re-mint with ` +
        "`claude setup-token` and update the secret; see docs/headless-runbook.md (token rotation).",
      usage: null,
    };
  }

  if (matchesAny(RATE_LIMIT_PATTERNS, text)) {
    return {
      outcome: "rate-limited",
      reason:
        "the subscription's rate-limit window is spent. Headless runs share that window with the " +
        "maintainer's interactive session, so this run is abandoned rather than retried — retrying " +
        "into a spent window is how a bounded retry becomes a spin.",
      usage: null,
    };
  }

  if (code !== 0) {
    const detail = stderr.trim().split("\n").slice(-1)[0] || `exit ${code}`;
    return { outcome: "failed", reason: detail, usage: null };
  }

  return { outcome: "ok", reason: null, usage: parseUsage(stdout) };
}

// `--output-format json` gives one JSON object. Unparseable output is not a
// failure of the run — the agent may have succeeded and the wrapper still owes
// the ledger a row, so usage degrades to null rather than throwing.
export function parseUsage(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const usage = parsed?.usage ?? null;
    if (!usage) return null;
    return {
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
      // Reported so the workflow summary can say what a run cost. The figure is
      // informational: the run is billed to the subscription either way.
      costUsd: parsed?.total_cost_usd ?? null,
    };
  } catch {
    return null;
  }
}

// One line for the workflow summary. Says subscription-billed explicitly,
// because the whole reason this path exists is that the metered one was refused.
export function summaryLine({ agent, model, outcome, usage = null }) {
  const tokens = usage
    ? `${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out`
    : "usage unavailable";
  return `headless ${agent} (${model}) → ${outcome} · ${tokens} · subscription-billed (${TOKEN_VAR}), not API-metered`;
}
