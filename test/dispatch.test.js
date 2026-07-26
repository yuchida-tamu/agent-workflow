import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { commentBody, dispatchAction, launchPrompt, runId } from "../scripts/actions/dispatch-comment.js";
import { DISPATCH } from "../scripts/next/core.js";
import { HEADLESS_KEY } from "../scripts/headless/config.js";
import { TOKEN_VAR } from "../scripts/headless/core.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const TOKEN = { [TOKEN_VAR]: "sk-ant-oat01-example" };
const on = (state) => ({ [HEADLESS_KEY]: { dispatch: { [state]: true } } });

// --- today's behaviour is the default ----------------------------------------

test("with no headless config, every agent state still just comments", () => {
  // The compatibility promise. An installed stub in a repo that sets nothing
  // must behave byte-identically to before stage 2 existed.
  for (const [state, dispatch] of Object.entries(DISPATCH)) {
    if (dispatch.actor === "none") continue;
    const result = dispatchAction({ label: `state:${state}`, config: {}, env: TOKEN });
    assert.equal(result.act, "comment", state);
    assert.equal(result.dispatch.who, dispatch.who, state);
  }
});

test("a non-state label is ignored", () => {
  for (const label of ["priority:p1", "blocked", "", undefined]) {
    assert.equal(dispatchAction({ label, config: {}, env: TOKEN }).act, "ignore", String(label));
  }
});

test("a state with no actor is ignored, flag or no flag", () => {
  // `in-progress` and `released` have actor "none" — nothing to launch and
  // nothing to say.
  for (const state of ["in-progress", "released"]) {
    assert.equal(dispatchAction({ label: `state:${state}`, config: {}, env: TOKEN }).act, "ignore", state);
    assert.equal(
      dispatchAction({ label: `state:${state}`, config: on(state), env: TOKEN }).act,
      "ignore",
      `${state} with the flag on`,
    );
  }
});

// --- the launch path ----------------------------------------------------------

test("an enabled agent state launches", () => {
  const result = dispatchAction({ label: "state:spec", config: on("spec"), env: TOKEN });
  assert.equal(result.act, "launch");
  assert.equal(result.dispatch.who, "architect");
});

test("enabling one state does not enable another", () => {
  const config = on("spec");
  assert.equal(dispatchAction({ label: "state:spec", config, env: TOKEN }).act, "launch");
  assert.equal(dispatchAction({ label: "state:ready", config, env: TOKEN }).act, "comment");
  assert.equal(dispatchAction({ label: "state:idea", config, env: TOKEN }).act, "comment");
});

test("a human or script state never launches, even with a flag set", () => {
  // `planned` is a human gate, `merged` is a script. Launching is an execution
  // path for the `agent:` rows only — it does not replace the dispatch line.
  for (const state of ["planned", "merged", "verified"]) {
    const result = dispatchAction({ label: `state:${state}`, config: on(state), env: TOKEN });
    assert.equal(result.act, "comment", state);
    assert.match(result.reason, /acts here/);
  }
});

test("flag on but no token falls back to the comment, not to a failure", () => {
  // The dispatch line is what the repo had before headless existed. Falling
  // back to it leaves the loop working; failing would silently drop the event.
  const result = dispatchAction({ label: "state:spec", config: on("spec"), env: {} });
  assert.equal(result.act, "comment");
  assert.match(result.reason, new RegExp(TOKEN_VAR));
  assert.match(result.reason, /falling back/);
});

// --- the comment is unchanged -------------------------------------------------

test("the comment body is byte-identical to what it always was", () => {
  // Pinned deliberately: the marker and shape are what `upsert` matches on, and
  // what a human reads on every issue.
  const body = commentBody(DISPATCH.spec);
  assert.equal(
    body,
    "<!-- agentflow-dispatch -->\n**agentflow next:** `agent:architect` — " +
      "produce plan + child issues; risk engine decides G2; → planned",
  );
});

test("an escalation note is appended, never substituted", () => {
  // A failed launch must still leave the dispatch line, so the item reads as
  // waiting for a human rather than as having been handled.
  const body = commentBody(DISPATCH.spec, "> Headless launch did not complete (**rate-limited**): spent");
  assert.match(body, /agentflow next:/);
  assert.match(body, /did not complete/);
  assert.match(body, /rate-limited/);
});

// --- the prompt names the work, not the rubric --------------------------------

test("the prompt defers to the agent definition and forbids gate actions", () => {
  const prompt = launchPrompt({ repo: "o/r", issue: "42", state: "spec", who: "architect" });
  assert.match(prompt, /#42/);
  assert.match(prompt, /state `spec`/);
  assert.match(prompt, /Follow your definition/);
  assert.match(prompt, /may not transition state labels or approve any gate/);
});

// --- what actually ships ------------------------------------------------------

test("the shipped dispatch config leaves every stage off", () => {
  const config = JSON.parse(read("agentflow.config.json"));
  for (const [state, value] of Object.entries(config[HEADLESS_KEY].dispatch)) {
    assert.equal(value, false, state);
    assert.equal(dispatchAction({ label: `state:${state}`, config, env: TOKEN }).act, "comment", state);
  }
});

test("the workflow passes the token through and is concurrency-guarded per issue", () => {
  for (const p of [".github/workflows/agentflow-dispatch.yml", "init/templates/workflows/agentflow-dispatch.yml"]) {
    const text = read(p);
    assert.match(text, /claude-oauth-token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/, p);
    assert.match(text, /group: agentflow-dispatch-\$\{\{ github\.event\.issue\.number \}\}/, p);
  }
});

test("this repo runs the dispatch stub it ships", () => {
  const ours = read(".github/workflows/agentflow-dispatch.yml");
  const stub = read("init/templates/workflows/agentflow-dispatch.yml");
  assert.equal(stub.replace(/__TOOLKIT_REPO__/g, "yuchida-tamu/agent-workflow"), ours);
});

test("no metered API key is wired anywhere in the dispatch path", () => {
  const binding = /^\s*ANTHROPIC_API_KEY\s*:/m;
  for (const p of [
    "actions/dispatch/action.yml",
    ".github/workflows/agentflow-dispatch.yml",
    "init/templates/workflows/agentflow-dispatch.yml",
    "scripts/actions/dispatch-comment.js",
  ]) {
    assert.equal(binding.test(read(p)), false, p);
  }
});

// --- regression from review of PR #104 ---------------------------------------

test("run ids are unique per attempt, not per work item", () => {
  // `agentflow-log start` appends and `end` closes the FIRST row matching the
  // id, so a repeated id leaves a row that can never be closed. Reproduced on
  // #91 during this issue's own build:
  //
  //   | review-91-a | … | ok |
  //   | review-91-a | … | —  |   ← permanently open
  //
  // The review entry point would have repeated its id on every `synchronize`
  // event, so any PR pushed to twice corrupted its own ledger.
  const first = runId("dispatch-5-spec", { GITHUB_RUN_ID: "111", GITHUB_RUN_ATTEMPT: "1" });
  const retry = runId("dispatch-5-spec", { GITHUB_RUN_ID: "111", GITHUB_RUN_ATTEMPT: "2" });
  const later = runId("dispatch-5-spec", { GITHUB_RUN_ID: "222", GITHUB_RUN_ATTEMPT: "1" });

  assert.notEqual(first, retry, "a re-run must not reuse the id");
  assert.notEqual(first, later, "a later run must not reuse the id");
  assert.match(first, /^dispatch-5-spec-111-1$/);
});

test("outside Actions the run id degrades to the bare prefix", () => {
  // Honest rather than inventing entropy: locally there is no attempt to be
  // unique across.
  assert.equal(runId("dispatch-5-spec", {}), "dispatch-5-spec");
});

test("both headless entry points derive their run id the same way", () => {
  // Fixing only the dispatch half would leave the bug in the stage that is
  // actually enabled.
  for (const p of ["scripts/actions/dispatch-comment.js", "scripts/actions/headless-review.js"]) {
    const source = read(p);
    assert.match(source, /const run = runId\(/, p);
    assert.equal(/const run = `[^`]*`;/.test(source), false, `${p} still builds a raw run id`);
  }
});
