import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  reviewBody,
  reviewPrompt,
  reviewText,
  findingsFromText,
  verdictFromFindings,
  reviewVerdict,
  decideNativeReview,
  renderNativeReview,
} from "../scripts/actions/headless-review.js";
import { verifyChecks } from "../init/verify.js";
import { HEADLESS_KEY } from "../scripts/headless/config.js";
// The real contract test: round-trip what headless-review.js emits through
// the MERGED reader (#111) it is written for. A hand-rolled regex here would
// only prove this file agrees with itself.
import { MARKER as REVIEW_MARKER, parseReviewComment } from "../scripts/review/core.js";

const sha = "64665f52b6cfd4f688deda8677b27dc008e49009"; // full 40 hex chars, on purpose

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
    const body = reviewBody({ outcome, reason: "because", text: "", model: null, usage: null, headSha: sha });
    assert.match(body, new RegExp(`^${REVIEW_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
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
    headSha: sha,
  });
  assert.match(body, /"findings"/);
  assert.match(body, /subscription-billed/);
  assert.match(body, /not API-metered/);
});

test("the comment marker is stable, so reviews update in place", () => {
  const a = reviewBody({ outcome: "ok", text: "x", model: "opus", usage: null, headSha: sha });
  const b = reviewBody({ outcome: "failed", reason: "y", text: "", model: null, usage: null, headSha: sha });
  assert.equal(a.startsWith(REVIEW_MARKER) && b.startsWith(REVIEW_MARKER), true);
});

// --- the review artifact contract (#111's reader, #112's writer) -------------
//
// The real contract test: what headless-review.js emits has to round-trip
// through the MERGED `scripts/review/core.js` reader, not just match a regex
// this file invented independently.

test("a mergeable review round-trips through the merged reader", () => {
  const body = reviewBody({
    outcome: "ok",
    text: JSON.stringify({ findings: [{ file: "a.js", line: 1, claim: "nit", scenario: "-", severity: "low" }] }),
    model: "opus",
    usage: null,
    headSha: sha,
  });
  const parsed = parseReviewComment(body);
  assert.ok(parsed, "the emitted comment must parse as a review artifact");
  assert.equal(parsed.verdict, "mergeable", "a low-severity finding alone does not block");
  assert.equal(parsed.sha, sha);
  assert.equal(parsed.sha.length, 40, "the full head sha, never abbreviated");
  assert.equal(parsed.ux, "n/a", "headless mode only ever runs code-reviewer");
  assert.equal(parsed.source, "comment");
});

test("a high-severity finding round-trips as not-mergeable", () => {
  const body = reviewBody({
    outcome: "ok",
    text: JSON.stringify({
      findings: [{ file: "a.js", line: 1, claim: "bug", scenario: "crashes on empty input", severity: "high" }],
    }),
    model: "opus",
    usage: null,
    headSha: sha,
  });
  const parsed = parseReviewComment(body);
  assert.equal(parsed.verdict, "not-mergeable");
  assert.equal(parsed.sha, sha);
});

test("every non-ok outcome round-trips as a fresh not-mergeable veto", () => {
  // Fresh, not merely "not-mergeable": a stale artifact has no veto power
  // (scripts/review/core.js's isHeadFresh), so a failed run must still name
  // the real head — otherwise the failure silently loses its refusal power.
  for (const outcome of ["disabled", "unauthenticated", "rate-limited", "failed"]) {
    const body = reviewBody({ outcome, reason: "x", text: "", model: null, usage: null, headSha: sha });
    const parsed = parseReviewComment(body);
    assert.ok(parsed, outcome);
    assert.equal(parsed.verdict, "not-mergeable", outcome);
    assert.equal(parsed.sha, sha, outcome);
  }
});

test("unparseable agent output is not trusted as a pass", () => {
  // An empty findings list is a valid pass; output that fails to parse as
  // `{ findings: [...] }` at all is not the same thing and must not be read
  // as one — "absence is refusal" applies to the writer, not only the reader.
  const body = reviewBody({ outcome: "ok", text: "not json at all", model: "opus", usage: null, headSha: sha });
  const parsed = parseReviewComment(body);
  assert.equal(parsed.verdict, "not-mergeable");
});

// --- the deterministic verdict, unit-tested at its own seam -------------------

test("verdictFromFindings blocks only on the high severity", () => {
  assert.equal(verdictFromFindings([]), "mergeable");
  assert.equal(verdictFromFindings([{ severity: "low" }, { severity: "medium" }]), "mergeable");
  assert.equal(verdictFromFindings([{ severity: "medium" }, { severity: "high" }]), "not-mergeable");
  assert.equal(verdictFromFindings(null), "not-mergeable", "not an array — cannot be trusted as a pass");
  assert.equal(verdictFromFindings(undefined), "not-mergeable");
});

test("findingsFromText degrades to null rather than throwing", () => {
  assert.deepEqual(findingsFromText('{"findings":[{"severity":"low"}]}'), [{ severity: "low" }]);
  assert.equal(findingsFromText("not json"), null);
  assert.equal(findingsFromText('{"findings":"not an array"}'), null);
  assert.equal(findingsFromText('{"no findings key":true}'), null);
});

test("reviewVerdict refuses unconditionally on any non-ok outcome", () => {
  for (const outcome of ["disabled", "unauthenticated", "rate-limited", "failed"]) {
    assert.equal(reviewVerdict({ outcome, text: '{"findings":[]}' }), "not-mergeable", outcome);
  }
  assert.equal(reviewVerdict({ outcome: "ok", text: '{"findings":[]}' }), "mergeable");
  assert.equal(reviewVerdict({ outcome: "ok", text: '{"findings":[{"severity":"high"}]}' }), "not-mergeable");
});

// --- native-mode: submitting a review as the App, alongside the comment ------
//
// Mirrors test/auto-merge.test.js's coverage of decideBotReview — same shape,
// deliberately: an unconfigured repo attempts nothing, a self-review is
// refused (GitHub forbids it), an unknown acting login still tries, and every
// refusal names itself. Unlike decideBotReview there is no risk-verdict gate:
// the authority for this review is this run's own verdict.

const identity = { configured: true, slug: "agentflow-bot", appId: null, source: "config" };

test("a configured identity submits a native review", () => {
  const d = decideNativeReview({ identity, prAuthor: "yuchida-tamu", actingLogin: "agentflow-bot[bot]" });
  assert.equal(d.review, true);
  assert.match(d.reason, /agent_identity/i);
});

test("no identity configured means no native review — the comment stands alone", () => {
  const d = decideNativeReview({ identity: { configured: false, slug: null }, prAuthor: "yuchida-tamu" });
  assert.equal(d.review, false);
  assert.match(d.reason, /agent_identity|not configured/i);
});

test("the acting identity never tries to approve its own PR", () => {
  // The ordinary case once agent PRs are authored by the App: the reviewer
  // and the PR author are the same bot.
  const d = decideNativeReview({
    identity,
    prAuthor: "agentflow-bot[bot]",
    actingLogin: "agentflow-bot[bot]",
  });
  assert.equal(d.review, false);
  assert.match(d.reason, /own pull request/i);
});

test("a different acting login may review an App-authored PR", () => {
  const d = decideNativeReview({ identity, prAuthor: "agentflow-bot[bot]", actingLogin: "github-actions[bot]" });
  assert.equal(d.review, true);
});

test("an unknown acting login still attempts the review", () => {
  // Better to try and let GitHub refuse than to silently skip the artifact on
  // a guess — the comment artifact is the record either way.
  const d = decideNativeReview({ identity, prAuthor: "agentflow-bot[bot]", actingLogin: null });
  assert.equal(d.review, true);
});

test("every native-review refusal names itself", () => {
  const refusals = [
    { identity: { configured: false }, prAuthor: "x" },
    { identity, prAuthor: "agentflow-bot[bot]", actingLogin: "agentflow-bot[bot]" },
  ];
  for (const input of refusals) {
    const d = decideNativeReview(input);
    assert.equal(d.review, false);
    assert.ok(d.reason && d.reason.length > 10, JSON.stringify(d));
  }
});

test("the native review's own event matches the verdict — approve vs request-changes", () => {
  // decideNativeReview only decides WHETHER to review; the caller (main())
  // picks --approve/--request-changes from the same reviewVerdict() this file
  // already pins above. This test locks the two literal review bodies so a
  // refactor can't silently swap which verdict maps to which GitHub review
  // event without a test noticing.
  assert.match(renderNativeReview({ verdict: "mergeable", headSha: sha }), /`mergeable`/);
  assert.match(renderNativeReview({ verdict: "not-mergeable", headSha: sha }), /`not-mergeable`/);
  assert.match(renderNativeReview({ verdict: "mergeable", headSha: sha }), new RegExp(sha));
});

test("main() picks --approve for mergeable and --request-changes for not-mergeable", () => {
  // Line-level check of the seam this file's other tests can't reach without
  // mocking `gh`: the ternary that turns a verdict into a `gh pr review` flag.
  const source = read("scripts/actions/headless-review.js");
  assert.match(source, /verdict === MERGEABLE \? "--approve" : "--request-changes"/);
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
