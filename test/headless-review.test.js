import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { reviewBody, reviewPrompt, reviewText } from "../scripts/actions/headless-review.js";
import { verifyChecks } from "../init/verify.js";
import { HEADLESS_KEY } from "../scripts/headless/config.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// --- the prompt carries the task, never the rubric ---------------------------

test("the prompt states the task and defers the rubric to the agent definition", () => {
  // The rubric reaches the run through `--agent`, so the headless reviewer and
  // the session reviewer follow one definition instead of two that drift.
  const prompt = reviewPrompt({ repo: "o/r", prNumber: 7, baseSha: "aaa", headSha: "bbb" });
  assert.match(prompt, /#7/);
  assert.match(prompt, /aaa\.\.\.bbb/, "three dots — the merge-base form");
  assert.equal(/severity|correctness|convention/i.test(prompt), false, "no rubric in the prompt");
});

test("the diff range is the merge-base form, matching pr-verdict", () => {
  // Two dots would under-report on an integration branch carrying a stack.
  const prompt = reviewPrompt({ repo: "o/r", prNumber: 1, baseSha: "b", headSha: "h" });
  assert.equal(prompt.includes("b...h"), true);
  assert.equal(prompt.includes("b..h "), false);
});

// --- a review that did not happen is always visible --------------------------

test("every non-ok outcome still produces a comment", () => {
  // A stage that fails silently is exactly how review disappeared across
  // #30–#69. Absence has to be as visible as a finding.
  for (const outcome of ["disabled", "unauthenticated", "rate-limited", "failed"]) {
    const body = reviewBody({ outcome, reason: "because", text: "", model: null, usage: null });
    assert.match(body, /^<!-- agentflow-headless-review -->/);
    assert.match(body, new RegExp(`\\*\\*${outcome}\\*\\*`));
    assert.match(body, /because/);
    assert.match(body, /absence of a review is visible/);
  }
});

test("a successful review posts the findings and how it was billed", () => {
  const body = reviewBody({
    outcome: "ok",
    text: '{ "findings": [] }',
    model: "opus",
    usage: { inputTokens: 10, outputTokens: 3, costUsd: 0 },
  });
  assert.match(body, /"findings"/);
  assert.match(body, /subscription-billed/);
  assert.match(body, /not API-metered/);
});

test("the comment marker is stable, so reviews update in place", () => {
  const a = reviewBody({ outcome: "ok", text: "x", model: "opus", usage: null });
  const b = reviewBody({ outcome: "failed", reason: "y", text: "", model: null, usage: null });
  const marker = "<!-- agentflow-headless-review -->";
  assert.equal(a.startsWith(marker) && b.startsWith(marker), true);
});

test("a shape change in the CLI output degrades to posting what we got", () => {
  // A review is already paid for by the time it is parsed; losing it to a
  // JSON.parse is the one outcome worse than an ugly comment.
  assert.equal(reviewText('{"result":"findings here"}'), "findings here");
  assert.equal(reviewText("not json at all"), "not json at all");
  assert.equal(reviewText('{"unexpected":1}'), '{"unexpected":1}');
});

// --- the stub is optional to install -----------------------------------------

const baseInputs = {
  config: { value: { [HEADLESS_KEY]: { review: false } }, error: null },
  labels: { names: [], error: null },
  domains: { value: { d: { criticality: "low", paths: ["x"] } }, error: null },
  next: { code: 0, stdout: JSON.stringify({ issue: 1 }), error: null },
  expectedLabels: [],
  protection: null,
};

const workflowsResult = (over) =>
  verifyChecks({ ...baseInputs, ...over }).find((c) => c.name === ".github/workflows");

const installed = [{ name: "agentflow-review.yml", content: "uses: o/r/actions/headless-review@main" }];

test("a repo without the review stub passes when headless.review is off", () => {
  // The compatibility promise: adding a template must not make it mandatory.
  // `expectedWorkflows` is the template directory listing, so without this every
  // already-adopted repo would start failing for an opt-in feature shipped off.
  const result = workflowsResult({ workflows: [], expectedWorkflows: ["agentflow-review.yml"] });
  assert.equal(result.ok, true);
  assert.match(result.note, /not needed/);
  assert.match(result.note, /headless\.review is off/);
});

test("a repo without the review stub FAILS when headless.review is on", () => {
  // The flag would be configured autonomy that can never fire.
  const result = workflowsResult({
    config: { value: { [HEADLESS_KEY]: { review: true } }, error: null },
    workflows: [],
    expectedWorkflows: ["agentflow-review.yml"],
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /the flag cannot fire/);
});

test("a non-optional stub is still required regardless of headless config", () => {
  const result = workflowsResult({ workflows: [], expectedWorkflows: ["agentflow-gate.yml"] });
  assert.equal(result.ok, false);
  assert.match(result.detail, /agentflow-gate\.yml is not installed/);
});

test("an installed review stub is validated like any other", () => {
  const ok = workflowsResult({ workflows: installed, expectedWorkflows: ["agentflow-review.yml"] });
  assert.equal(ok.ok, true);
  assert.equal(ok.note, null, "installed means nothing to remark on");

  const placeholder = workflowsResult({
    workflows: [{ name: "agentflow-review.yml", content: "uses: __TOOLKIT_REPO__/actions/headless-review@main" }],
    expectedWorkflows: ["agentflow-review.yml"],
  });
  assert.equal(placeholder.ok, false, "copied, not scaffolded");
});

// --- what actually ships ------------------------------------------------------

test("the shipped stub carries the placeholder and points at the toolkit", () => {
  const stub = read("init/templates/workflows/agentflow-review.yml");
  assert.match(stub, /__TOOLKIT_REPO__\/actions\/headless-review@/);
  assert.equal(stub.includes("yuchida-tamu"), false, "a template must not hardcode this repo");
});

test("this repo runs what it ships", () => {
  // The toolkit is its own first consumer; a template that drifted from the
  // workflow here would ship untested.
  const ours = read(".github/workflows/agentflow-review.yml");
  const stub = read("init/templates/workflows/agentflow-review.yml");
  assert.equal(stub.replace(/__TOOLKIT_REPO__/g, "yuchida-tamu/agent-workflow"), ours);
});

test("the workflow is concurrency-guarded per pull request", () => {
  const ours = read(".github/workflows/agentflow-review.yml");
  assert.match(ours, /concurrency:/);
  assert.match(ours, /group: agentflow-review-\$\{\{ github\.event\.pull_request\.number \}\}/);
});

test("no workflow or action ever wires a metered API key", () => {
  // The rejection this issue exists to honour. Naming the key in a comment is
  // fine and useful — what must never appear is a *binding*: `ANTHROPIC_API_KEY:
  // <something>` in an `env:` or `with:` block, which is how metered billing
  // would return through the back door. Asserting on prose would only check that
  // someone wrote a reassuring sentence; this checks the wiring.
  const binding = /^\s*ANTHROPIC_API_KEY\s*:/m;
  for (const dir of [".github/workflows", "actions/headless-review", "init/templates/workflows"]) {
    for (const file of readdirSync(new URL(`../${dir}`, import.meta.url))) {
      assert.equal(binding.test(read(`${dir}/${file}`)), false, `${dir}/${file} binds ANTHROPIC_API_KEY`);
    }
  }
});

test("the action names both credentials in the log, and neither is secret", () => {
  const action = read("actions/headless-review/action.yml");
  assert.match(action, /identity: acting as/);
  assert.match(action, /billing:  subscription/);
  // Conditions are computed from inputs, never from a token value.
  assert.match(action, /HAS_SUBSCRIPTION_TOKEN: \$\{\{ inputs\.claude-oauth-token != '' \}\}/);
  assert.equal(/\$\{\{ *secrets\./.test(action), false, "an action reads inputs, not secrets");
});

// --- regressions from review of PR #102 --------------------------------------

test("the ledger tier is read from the roster, never written as a literal", () => {
  // The row and the invocation must name the same model. A literal would let
  // them disagree the moment the roster changes tier — which is not
  // hypothetical: that exact drift produced two `agentflow-log audit`
  // violations while this issue was being built.
  const source = read("scripts/actions/headless-review.js");
  assert.equal(/"--model",\s*"(opus|sonnet|haiku)"/.test(source), false, "no hardcoded tier");
  assert.match(source, /"--model", tier/);
  assert.match(source, /loadTiers\(/);
});

test("an enabled repo with no token still gets a comment", () => {
  // Line-level check of the flow, not just of reviewBody: the early return for
  // a missing token used to skip posting entirely, so a repo that had asked for
  // review by enabling the flag got silence — the exact failure mode this
  // stage exists to remove.
  const source = read("scripts/actions/headless-review.js");
  const tokenGuard = source.slice(source.indexOf("if (!process.env[TOKEN_VAR])"));
  const untilReturn = tokenGuard.slice(0, tokenGuard.indexOf("return 0;"));
  assert.match(untilReturn, /upsertComment\(/, "the missing-token path must post");
});

test("an opted-out repo stays silent", () => {
  // The other half of the same decision, and deliberately different: a repo that
  // never asked for headless review should not get a comment on every PR.
  const source = read("scripts/actions/headless-review.js");
  const offGuard = source.slice(source.indexOf("if (!reviewEnabled(config))"));
  const untilReturn = offGuard.slice(0, offGuard.indexOf("return 0;"));
  assert.equal(untilReturn.includes("upsertComment("), false, "no comment when never asked for");
});
