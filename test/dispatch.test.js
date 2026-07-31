import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_ARTIFACT_CHARS,
  PLAN_VERDICT_MARKER,
  SPEC_EFFECTS_MARKER,
  artifactCommentBody,
  artifactMarker,
  artifactNote,
  childBody,
  commentBody,
  createChildArgv,
  createChildren,
  dispatchAction,
  extractPlan,
  factsArgv,
  launchPrompt,
  matchingComment,
  parseCreatedIssueNumber,
  planChildrenDecision,
  planVerdictCommentBody,
  planVerdictPacks,
  policyEvaluateArgv,
  runId,
  specEffectsCommentBody,
  specTransitionPlan,
  truncateArtifact,
} from "../scripts/actions/dispatch-comment.js";
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

test("the prompt asks for the artifact back, not for the agent to post it — #157", () => {
  // The read-only allowlist (DEFAULT_ALLOWED_TOOLS in scripts/headless/core.js)
  // gives the agent no write tool at all, so "post your artifact to the issue"
  // was an instruction the sandbox made unfollowable. The prompt now asks for
  // what the agent can actually do: return the artifact, and let the workflow
  // post it.
  const prompt = launchPrompt({ repo: "o/r", issue: "42", state: "spec", who: "architect" });
  assert.match(prompt, /Return your artifact as your final message; the workflow posts it/);
  assert.equal(/Post your artifact to the issue/.test(prompt), false);
});

// --- the artifact, on a successful launch (#157) ------------------------------
//
// Before this, `outcome === "ok"` had no branch that called `upsertComment` at
// all — a successful run posted only a ledger row, and the artifact the agent
// produced was discarded. This is the test that would have failed from day
// one: it asserts the ok path reaches `upsertComment` with the artifact text,
// mirroring how headless-review.js's `reviewBody` was already tested.

test("the artifact comment carries the artifact text and the summary footer", () => {
  const note = artifactNote({
    agent: "architect",
    model: "opus",
    outcome: "ok",
    usage: { inputTokens: 10, outputTokens: 2, costUsd: 0 },
    text: "## Plan\n\nDo the thing.",
  });
  assert.match(note, /## Plan\n\nDo the thing\./);
  assert.match(note, /architect \(opus\) → ok/);
  assert.match(note, /subscription-billed/);

  const body = artifactCommentBody("spec", "architect", note);
  assert.match(body, /^<!-- agentflow-artifact:spec -->/);
  assert.match(body, /## Plan\n\nDo the thing\./);
});

test("an oversized artifact is truncated with an honest marker, not silently cut", () => {
  const huge = "x".repeat(70000);
  const truncated = truncateArtifact(huge);
  assert.ok(truncated.length < huge.length, "truncation must actually shrink the text");
  assert.match(truncated, /truncated — the artifact was 70000 characters/);
});

test("an artifact under the cap is left completely alone", () => {
  const short = "the whole artifact, untouched";
  assert.equal(truncateArtifact(short), short);
});

test("truncation never splits a UTF-16 surrogate pair — #160", () => {
  // Build text whose cut point lands exactly between the two halves of an
  // emoji (a 2-code-unit surrogate pair): MAX_ARTIFACT_CHARS - 1 filler
  // characters, then the emoji, so its high surrogate is the very last unit
  // a naive slice(0, MAX_ARTIFACT_CHARS) would keep and its low surrogate is
  // the first unit it would drop.
  const filler = "x".repeat(MAX_ARTIFACT_CHARS - 1);
  const emoji = "\u{1F600}"; // 😀 — high surrogate 0xD83D, low surrogate 0xDE00
  const text = `${filler}${emoji}${"y".repeat(100)}`;

  const truncated = truncateArtifact(text);
  const kept = truncated.split("\n\n> …truncated")[0];
  const lastUnit = kept.charCodeAt(kept.length - 1);

  assert.equal(lastUnit >= 0xd800 && lastUnit <= 0xdbff, false, "must not end on a lone high surrogate");
  assert.equal(kept, filler, "the whole emoji is dropped rather than half of it kept");
});

test("main() posts the artifact under its own state-scoped marker, not the dispatch line's — #160", () => {
  // Line-level check of the wiring `dispatchAction`/`artifactNote` alone can't
  // reach without mocking `gh` (same seam headless-review.test.js uses for its
  // own main()-level assertions): the ok branch must call `upsertComment` with
  // the unwrapped, possibly-truncated artifact, posted under `artifactMarker`
  // rather than the transient dispatch marker — the fix for the #160 review
  // finding (the artifact used to share the dispatch line's marker and got
  // overwritten by the very next state's plain dispatch-line upsert).
  const source = read("scripts/actions/dispatch-comment.js");
  const okGuard = source.slice(source.indexOf('if (result.outcome === "ok")'));
  const untilEscalation = okGuard.slice(0, okGuard.indexOf('if (result.outcome !== "ok")'));
  assert.match(untilEscalation, /upsertComment\(/, "the ok path must post");
  assert.match(untilEscalation, /artifactCommentBody\(/, "posted with the artifact + summary footer");
  assert.match(untilEscalation, /artifactMarker\(state\)/, "under its own state-scoped marker");
  assert.equal(/commentBody\(/.test(untilEscalation), false, "must not reuse the transient dispatch-line marker");
  assert.match(untilEscalation, /reviewText\(result\.stdout/, "the artifact is unwrapped from the CLI's JSON envelope");
});

// --- the artifact survives the next state's dispatch-line upsert (#160) ------
//
// The reviewer's trace: state:spec launches architect, which succeeds and (in
// the buggy version) posted its plan under the SAME marker the dispatch line
// uses. G2 later approves and the item moves to state:planned — a human
// actor, so `dispatchAction` returns "comment" and posts the plain dispatch
// line via `commentBody`/`MARKER`. Before this fix that second upsert matched
// the first comment and overwrote the plan with the bare "agentflow next"
// line — the #157 symptom, one step later. `matchingComment` is the pure seam
// both `upsertComment` calls go through, so the lifecycle is testable without
// mocking `gh`.

test("an artifact comment survives the next state's dispatch-line upsert", () => {
  const DISPATCH_MARKER = "<!-- agentflow-dispatch -->";
  const artifact = {
    id: 1,
    body: artifactCommentBody(
      "spec",
      "architect",
      artifactNote({ agent: "architect", model: "opus", outcome: "ok", usage: null, text: "## Plan" }),
    ),
  };
  const comments = [artifact];

  // The dispatch-line upsert for the NEXT state (`planned`, a human actor)
  // must not find the artifact comment at all.
  assert.equal(matchingComment(comments, DISPATCH_MARKER), undefined, "the dispatch marker must not match the artifact");
  assert.equal(matchingComment(comments, artifactMarker("spec")), artifact, "the artifact marker must match its own comment");

  // Simulate that dispatch-line upsert creating its own, separate comment —
  // neither upsert may ever touch the other's comment afterwards.
  const dispatchLine = { id: 2, body: commentBody(DISPATCH.planned) };
  comments.push(dispatchLine);

  assert.equal(matchingComment(comments, DISPATCH_MARKER), dispatchLine);
  assert.equal(matchingComment(comments, artifactMarker("spec")), artifact, "still finds the original artifact, untouched");

  // And a later re-run of the SAME state (spec) upserts only its own
  // artifact — idempotent per state, never colliding with the state after it.
  const rerun = matchingComment(comments, artifactMarker("spec"));
  assert.equal(rerun.id, artifact.id);
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

// --- #168: spec-stage structural side-effects --------------------------------
//
// Headless dispatch's `spec` launch (the architect) produces an artifact but,
// with no Bash/`gh`, cannot create the children it decomposed into, cannot
// post the plan-stage verdict, and cannot advance the label. This is the
// harness doing all three after the artifact is posted, and ONLY on full
// success — see `specTransitionPlan`'s doc comment for the design ruling.

// --- extraction: the ```json fence contract ----------------------------------

test("extractPlan finds a single ```json fence carrying a top-level files key", () => {
  const text = 'Some prose.\n\n```json\n{"files": ["a/**"]}\n```\n\nMore prose.';
  assert.deepEqual(extractPlan(text), { files: ["a/**"] });
});

test("extractPlan returns null when there is no matching fence", () => {
  assert.equal(extractPlan("no fences here at all"), null);
  assert.equal(extractPlan(""), null);
  assert.equal(extractPlan(null), null);
  // A JSON fence that parses but has no "files" key is not a plan.json.
  assert.equal(extractPlan('```json\n{"other": true}\n```'), null);
  // A fence tagged something-else-that-starts-with-json (jsonc, json5) must
  // not be treated as a `json` fence.
  assert.equal(extractPlan('```jsonc\n{"files": ["a"]}\n```'), null);
});

test("extractPlan skips a malformed fence rather than throwing — degrades, never crashes", () => {
  const text = '```json\n{not valid json at all\n```';
  assert.doesNotThrow(() => extractPlan(text));
  assert.equal(extractPlan(text), null);
});

test("extractPlan: the LAST matching fence wins", () => {
  const text = [
    '```json\n{"files": ["first/**"]}\n```',
    "some prose in between",
    '```json\n{"files": ["second/**"], "children": [{"title": "x"}]}\n```',
  ].join("\n\n");
  assert.deepEqual(extractPlan(text), { files: ["second/**"], children: [{ title: "x" }] });
});

test("extractPlan skips a malformed fence but still finds a later valid one", () => {
  const text = [
    '```json\n{broken\n```',
    '```json\n{"files": ["ok/**"]}\n```',
  ].join("\n\n");
  assert.deepEqual(extractPlan(text), { files: ["ok/**"] });
});

test("extractPlan ignores a non-plan json fence (no files key) even if it appears last", () => {
  const text = [
    '```json\n{"files": ["real/**"]}\n```',
    '```json\n{"level": "low", "obligations": {}}\n```',
  ].join("\n\n");
  assert.deepEqual(extractPlan(text), { files: ["real/**"] });
});

// --- children: body rendering, argv, and number parsing ----------------------

test("childBody appends one Blocked-by line per resolved blocker", () => {
  assert.equal(childBody("do the thing"), "do the thing");
  assert.equal(childBody("do the thing", []), "do the thing");
  assert.equal(childBody("do the thing", [12]), "do the thing\n\nBlocked by #12");
  assert.equal(childBody("do the thing", [12, 13]), "do the thing\n\nBlocked by #12\nBlocked by #13");
});

test("createChildArgv builds gh issue create with one --label per label", () => {
  const argv = createChildArgv({ repo: "o/r", title: "T", body: "B", labels: ["state:ready", "priority:p2"] });
  assert.deepEqual(argv, [
    "issue", "create", "--repo", "o/r", "--title", "T", "--body", "B",
    "--label", "state:ready", "--label", "priority:p2",
  ]);
});

test("createChildArgv with no labels emits no --label flags", () => {
  const argv = createChildArgv({ repo: "o/r", title: "T", body: "B" });
  assert.equal(argv.includes("--label"), false);
});

test("parseCreatedIssueNumber reads the number off gh issue create's URL stdout", () => {
  assert.equal(parseCreatedIssueNumber("https://github.com/o/r/issues/101\n"), 101);
  assert.equal(parseCreatedIssueNumber("https://github.com/o/r/issues/7"), 7);
});

test("parseCreatedIssueNumber throws (not silently returns NaN) on unexpected output", () => {
  assert.throws(() => parseCreatedIssueNumber("not a url"), /could not read a created issue number/);
});

// --- the idempotency guard ----------------------------------------------------

test("planChildrenDecision skips creation when the parent already has any child — idempotent", () => {
  const decision = planChildrenDecision({ existingCount: 3, plan: { files: [], children: [{ title: "x" }] } });
  assert.equal(decision.act, "skip");
  assert.match(decision.detail, /3 child issue\(s\) already linked/);
});

test("planChildrenDecision reports extraction failure when there is no plan and no existing children", () => {
  const decision = planChildrenDecision({ existingCount: 0, plan: null });
  assert.equal(decision.act, "extraction-failed");
  assert.match(decision.detail, /no plan\.json extracted/);
});

test("planChildrenDecision is a legitimate no-op when the plan declares no children", () => {
  const decision = planChildrenDecision({ existingCount: 0, plan: { files: ["a/**"] } });
  assert.equal(decision.act, "none");
});

test("planChildrenDecision hands back the specs to create when there is a fresh plan with children", () => {
  const specs = [{ title: "a" }, { title: "b" }];
  const decision = planChildrenDecision({ existingCount: 0, plan: { files: [], children: specs } });
  assert.equal(decision.act, "create");
  assert.equal(decision.specs, specs);
});

test("an existing child from a prior partial run counts as \"created\" — decide-and-document (#168)", () => {
  // Explicitly the issue's own instruction: idempotency is not "safer to
  // recreate", it's "a prior run already did this part".
  const decision = planChildrenDecision({ existingCount: 1, plan: { files: [], children: [{ title: "x" }, { title: "y" }] } });
  assert.equal(decision.act, "skip");
});

// --- creation + blockedBy resolution + sub-issue linking (mocked gh seam) ----

test("createChildren creates in array order, resolves blockedBy to real numbers, and links each as a sub-issue", () => {
  const calls = { sh: [], link: [] };
  const sh = (cmd, args) => {
    calls.sh.push({ cmd, args });
    // Issue numbers minted in creation order: 101, 102, 103…
    return `https://github.com/o/r/issues/${100 + calls.sh.length}\n`;
  };
  const link = (repo, parent, child) => calls.link.push({ repo, parent, child });

  const specs = [
    { title: "first", body: "do first", labels: ["state:ready"] },
    { title: "second", body: "do second", labels: ["state:ready"], blockedBy: [0] },
    { title: "third", body: "do third", blockedBy: [0, 1] },
  ];
  const created = createChildren({ repo: "o/r", parentIssue: "14", specs, sh, link });

  assert.deepEqual(created, [
    { number: 101, title: "first" },
    { number: 102, title: "second" },
    { number: 103, title: "third" },
  ]);

  // argv shape for each `gh issue create` call.
  assert.deepEqual(calls.sh[0].args, ["issue", "create", "--repo", "o/r", "--title", "first", "--body", "do first", "--label", "state:ready"]);
  // blockedBy [0] on the second child resolves to #101 (the first child's real number).
  assert.deepEqual(calls.sh[1].args, ["issue", "create", "--repo", "o/r", "--title", "second", "--body", "do second\n\nBlocked by #101", "--label", "state:ready"]);
  // blockedBy [0, 1] on the third resolves to both prior real numbers.
  assert.deepEqual(calls.sh[2].args, ["issue", "create", "--repo", "o/r", "--title", "third", "--body", "do third\n\nBlocked by #101\nBlocked by #102"]);

  // Every created child is linked as a native sub-issue of the parent.
  assert.deepEqual(calls.link, [
    { repo: "o/r", parent: "14", child: 101 },
    { repo: "o/r", parent: "14", child: 102 },
    { repo: "o/r", parent: "14", child: 103 },
  ]);
});

test("createChildren silently drops a forward or out-of-range blockedBy index rather than failing the run", () => {
  const sh = () => "https://github.com/o/r/issues/5\n";
  const link = () => {};
  // Index 1 does not exist yet when child 0 is created (forward reference);
  // index 99 never exists at all. Neither should throw or block creation.
  const specs = [{ title: "a", body: "b", blockedBy: [1, 99] }];
  const created = createChildren({ repo: "o/r", parentIssue: "1", specs, sh, link });
  assert.equal(created.length, 1);
});

// --- plan-stage verdict: argv builders and pack selection ---------------------

test("factsArgv shapes the agentflow-facts invocation for the plan stage", () => {
  const argv = factsArgv({ factsCli: "/toolkit/scripts/facts/cli.js", planPath: "/tmp/plan.json" });
  assert.deepEqual(argv, [
    "/toolkit/scripts/facts/cli.js", "--base", "HEAD", "--head", "HEAD",
    "--stage", "plan", "--plan", "/tmp/plan.json",
  ]);
});

test("factsArgv adds --domains and --config only when given", () => {
  const argv = factsArgv({
    factsCli: "/t/scripts/facts/cli.js",
    planPath: "/tmp/plan.json",
    domainsPath: "domains.yml",
    configPath: "agentflow.config.json",
  });
  assert.match(argv.join(" "), /--domains domains\.yml/);
  assert.match(argv.join(" "), /--config agentflow\.config\.json/);
});

test("policyEvaluateArgv shapes the agentflow-policy evaluate invocation", () => {
  const argv = policyEvaluateArgv({ policyCli: "/t/scripts/policy/cli.js", factsPath: "/tmp/facts.json", packPaths: ["a.yaml", "b.yaml"] });
  assert.deepEqual(argv, ["/t/scripts/policy/cli.js", "evaluate", "--facts", "/tmp/facts.json", "a.yaml", "b.yaml"]);
});

test("planVerdictPacks always includes the toolkit baseline pack", () => {
  const packs = planVerdictPacks({ toolkit: "/toolkit", config: {} });
  assert.ok(packs.includes("/toolkit/policies/baseline.yaml"));
});

// --- verdict comment: its own marker ------------------------------------------

test("planVerdictCommentBody is posted under its own agentflow-verdict:plan marker", () => {
  const verdict = { level: "low", obligations: { score: 0, require: [], block: [], run: [] }, matched: [], warnings: [] };
  const body = planVerdictCommentBody(verdict);
  assert.match(body, /^<!-- agentflow-verdict:plan -->/);
  assert.equal(PLAN_VERDICT_MARKER, "<!-- agentflow-verdict:plan -->");
});

test("planVerdictCommentBody renders matched rules and warnings when present", () => {
  const verdict = {
    level: "high",
    obligations: { score: 12, require: ["G2"], block: ["auto-merge"], run: [] },
    matched: [{ pack: "baseline", rule: "self-mod-guard", then: { floor: "high" } }],
    warnings: ["something to note"],
  };
  const body = planVerdictCommentBody(verdict);
  assert.match(body, /`high`/);
  assert.match(body, /self-mod-guard/);
  assert.match(body, /something to note/);
});

// --- the transition-only-on-full-success matrix (the design ruling) ----------

test("specTransitionPlan advances spec -> planned only when children AND verdict both succeeded", () => {
  const gate = specTransitionPlan({ childrenOk: true, verdictOk: true, labels: ["state:spec"] });
  assert.equal(gate.ok, true);
  assert.equal(gate.plan.from, "spec");
  assert.equal(gate.plan.to, "planned");
  assert.deepEqual(gate.plan.add, ["state:planned"]);
  assert.deepEqual(gate.plan.remove, ["state:spec"]);
});

test("specTransitionPlan withholds the transition when children failed", () => {
  const gate = specTransitionPlan({ childrenOk: false, verdictOk: true, labels: ["state:spec"] });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.failed, ["children"]);
});

test("specTransitionPlan withholds the transition when the verdict failed", () => {
  const gate = specTransitionPlan({ childrenOk: true, verdictOk: false, labels: ["state:spec"] });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.failed, ["verdict"]);
});

test("specTransitionPlan reports both failed steps, not just the first", () => {
  const gate = specTransitionPlan({ childrenOk: false, verdictOk: false, labels: ["state:spec"] });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.failed, ["children", "verdict"]);
});

test("specTransitionPlan surfaces a bad label state as a transition failure rather than throwing", () => {
  // Both prior steps succeeded but the label state itself is not `state:spec`
  // (e.g. a race with a human edit) — planTransition throws; specTransitionPlan
  // must catch it and report which step failed rather than crashing the run.
  const gate = specTransitionPlan({ childrenOk: true, verdictOk: true, labels: ["state:ready"] });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.failed, ["transition"]);
  assert.match(gate.error, /illegal transition/);
});

// --- the escalation / success comment -----------------------------------------

test("specEffectsCommentBody is posted under its own marker and names exactly which step(s) failed", () => {
  const childrenOutcome = { ok: false, detail: "child creation failed: boom" };
  const verdictOutcome = { ok: true, detail: "`low` (score 0) posted" };
  const gate = { ok: false, failed: ["children"] };
  const body = specEffectsCommentBody({ childrenOutcome, verdictOutcome, gate });
  assert.match(body, /^<!-- agentflow-spec-effects -->/);
  assert.equal(SPEC_EFFECTS_MARKER, "<!-- agentflow-spec-effects -->");
  assert.match(body, /❌ children — child creation failed: boom/);
  assert.match(body, /✅ plan-stage verdict — `low`/);
  assert.match(body, /transition withheld/);
  assert.equal(/A human should:[\s\S]*plan-stage verdict/.test(body), false, "guidance must not mention a step that succeeded");
});

test("specEffectsCommentBody reports full success plainly", () => {
  const childrenOutcome = { ok: true, detail: "created 2 child issue(s): #101, #102" };
  const verdictOutcome = { ok: true, detail: "`low` (score 0) posted" };
  const gate = { ok: true, plan: { from: "spec", to: "planned" } };
  const body = specEffectsCommentBody({ childrenOutcome, verdictOutcome, gate });
  assert.match(body, /✅ children/);
  assert.match(body, /✅ plan-stage verdict/);
  assert.match(body, /`state:spec` → `state:planned`/);
});

// --- main()'s wiring (source-slice, same style as the #160 test above) -------

test("main() runs the spec side-effects only inside the ok branch, scoped to state === \"spec\"", () => {
  const source = read("scripts/actions/dispatch-comment.js");
  const okBlock = source.slice(source.indexOf('if (result.outcome === "ok")'));
  const specBlock = okBlock.slice(okBlock.indexOf('if (state === "spec")'));
  assert.notEqual(okBlock.indexOf('if (state === "spec")'), -1, "the spec branch must live inside the ok branch");
  assert.match(specBlock, /extractPlan\(fullText\)/);
  assert.match(specBlock, /childrenOf\(/);
  assert.match(specBlock, /planChildrenDecision\(/);
  assert.match(specBlock, /createChildren\(/);
  assert.match(specBlock, /computePlanVerdict\(/);
  assert.match(specBlock, /upsertComment\(repo, issue, planVerdictCommentBody\(verdict\), PLAN_VERDICT_MARKER\)/);
  assert.match(specBlock, /specTransitionPlan\(/);
  assert.match(specBlock, /SPEC_EFFECTS_MARKER/);
});

test("main() only edits labels when the transition gate says ok", () => {
  const source = read("scripts/actions/dispatch-comment.js");
  const specBlock = source.slice(source.indexOf('if (state === "spec")'));
  const gateBlock = specBlock.slice(specBlock.indexOf("const gate = specTransitionPlan"));
  const ifGateOk = gateBlock.slice(gateBlock.indexOf("if (gate.ok)"), gateBlock.indexOf("upsertComment(repo, issue, specEffectsCommentBody"));
  assert.match(ifGateOk, /"issue", "edit"/);
  assert.match(ifGateOk, /--add-label/);
  assert.match(ifGateOk, /--remove-label/);
});
