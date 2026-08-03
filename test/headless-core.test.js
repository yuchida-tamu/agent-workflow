import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_PERMISSION_MODE,
  KNOWN_FLAGS,
  METERED_VAR,
  OUTCOMES,
  TOKEN_VAR,
  classify,
  extractJsonFence,
  launchPlan,
  parseUsage,
  reviewText,
  stageEnabled,
  summaryLine,
} from "../scripts/headless/core.js";
import { launch, runProcess } from "../scripts/headless/run.js";
import { HEADLESS_KEY } from "../scripts/headless/config.js";
import { loadTiers } from "../scripts/log/cli.js";

const TIERS = { "code-reviewer": "sonnet", architect: "opus", implementer: "sonnet" };
const ON = { [HEADLESS_KEY]: { review: true, dispatch: { spec: true } } };
const TOKEN = { [TOKEN_VAR]: "sk-ant-oat01-example" };

const plan = (over = {}) =>
  launchPlan({ agent: "code-reviewer", stage: "review", config: ON, env: TOKEN, tiers: TIERS, ...over });

const argFor = (argv, flag) => argv[argv.indexOf(flag) + 1];

// --- invariant 1: the metered key never reaches the child --------------------

test("ANTHROPIC_API_KEY is removed from the child environment", () => {
  // Not "not passed" — the child inherits the runner's env, so the only way to
  // keep a metered key out is to take it away. If it survived, the CLI would
  // prefer it and bill per token, silently, which is the design this replaces.
  const result = plan({ env: { ...TOKEN, [METERED_VAR]: "sk-ant-metered", PATH: "/usr/bin" } });
  assert.equal(result.launch, true);
  assert.equal(Object.hasOwn(result.env, METERED_VAR), false);
  assert.equal(result.env.PATH, "/usr/bin", "unrelated environment is passed through");
  assert.equal(result.env[TOKEN_VAR], "sk-ant-oat01-example");
});

// --- invariant 2: --bare is never emitted ------------------------------------

test("--bare is never in the argv", () => {
  // Its own help: under --bare "OAuth and keychain are never read". It looks like
  // exactly what a CI invocation wants, and it would defeat subscription auth.
  for (const agent of Object.keys(TIERS)) {
    const result = plan({ agent, stage: agent === "architect" ? "spec" : "review" });
    assert.equal(result.launch, true, agent);
    assert.equal(result.argv.includes("--bare"), false, agent);
  }
});

// --- invariant 3: the declared tier is what runs -----------------------------

test("--model comes from the roster's declared tier, not a literal", () => {
  assert.equal(argFor(plan().argv, "--model"), "sonnet");
  assert.equal(argFor(plan({ agent: "architect", stage: "spec" }).argv, "--model"), "opus");
});

test("an agent with no declared tier refuses to launch", () => {
  // A hardcoded default here would let what runs drift from what the roster
  // declares while `agentflow-log audit` still passed.
  const result = plan({ agent: "ghost" });
  assert.equal(result.launch, false);
  assert.equal(result.outcome, "failed");
  assert.match(result.reason, /model tier/);
});

test("every agent in the real roster has a tier the launcher can use", () => {
  const tiers = loadTiers();
  for (const [agent, model] of Object.entries(tiers)) {
    const result = launchPlan({ agent, stage: "review", config: ON, env: TOKEN, tiers });
    assert.equal(result.launch, true, agent);
    assert.equal(argFor(result.argv, "--model"), model, agent);
  }
});

// --- refusals are first-class returns, not throws ----------------------------

test("a disabled stage refuses without spawning, and says how to enable it", () => {
  const result = launchPlan({ agent: "code-reviewer", stage: "review", config: {}, env: TOKEN, tiers: TIERS });
  assert.equal(result.launch, false);
  assert.equal(result.outcome, "disabled");
  assert.match(result.reason, /headless\.review/);
});

test("a stage enabled elsewhere is still off for its own stage", () => {
  const reviewOnly = { [HEADLESS_KEY]: { review: true } };
  assert.equal(stageEnabled(reviewOnly, "review"), true);
  assert.equal(stageEnabled(reviewOnly, "spec"), false);
  assert.equal(launchPlan({ agent: "architect", stage: "spec", config: reviewOnly, env: TOKEN, tiers: TIERS }).outcome, "disabled");
});

test("a missing token is `unauthenticated`, named as such, pointing at the runbook", () => {
  for (const env of [{}, { [TOKEN_VAR]: "" }, { [TOKEN_VAR]: "   " }, { [TOKEN_VAR]: null }]) {
    const result = plan({ env });
    assert.equal(result.launch, false, JSON.stringify(env));
    assert.equal(result.outcome, "unauthenticated");
    assert.match(result.reason, /headless disabled: no subscription token/);
    assert.match(result.reason, /runbook/);
  }
});

test("the disabled check runs before the token check", () => {
  // A repo that has not opted in must not be told to go get a token.
  const result = launchPlan({ agent: "code-reviewer", stage: "review", config: {}, env: {}, tiers: TIERS });
  assert.equal(result.outcome, "disabled");
});

// --- the invocation is bounded by construction -------------------------------

test("the run is bounded: wall clock, read-only tools, plan permission mode", () => {
  // A headless reviewer reads diffs and branch names written by whoever opened
  // the PR, and no human is watching to interrupt it.
  const { argv, timeoutMs } = plan();
  assert.ok(timeoutMs > 0, "the real bound is a wall clock we enforce ourselves");
  assert.equal(argFor(argv, "--permission-mode"), "plan");
  assert.equal(argFor(argv, "--allowedTools"), DEFAULT_ALLOWED_TOOLS.join(" "));
  for (const writeTool of ["Edit", "Write", "Bash", "NotebookEdit"]) {
    assert.equal(argv.join(" ").includes(writeTool), false, `${writeTool} must not be allowed`);
  }
});

test("the run is non-interactive and machine-readable", () => {
  const { argv } = plan();
  assert.equal(argv.includes("--print"), true);
  assert.equal(argFor(argv, "--output-format"), "json");
  assert.equal(argFor(argv, "--agent"), "code-reviewer");
});

// --- per-role tool policy (#180 item 1) --------------------------------------
//
// `launchPlan` itself stays role-agnostic — it does not know "implementer"
// from "reviewer" — but it must accept a write-capable allowlist and a
// permission mode that actually lets Edit/Write run when a caller
// (`scripts/actions/dispatch-comment.js`'s per-agent `loadToolPolicy`) hands
// it one, while still defaulting to the read-only reviewer/architect shape
// when nothing is passed. These tests are the seam contract; the wiring
// itself (which agent gets which policy) is asserted over
// `scripts/actions/dispatch-comment.js` in test/dispatch.test.js.

test("with no override, permission mode defaults to plan — reviewer/architect are unaffected", () => {
  assert.equal(DEFAULT_PERMISSION_MODE, "plan");
  assert.equal(argFor(plan().argv, "--permission-mode"), "plan");
});

test("a caller can grant a write-capable allowlist and permission mode — the implementer's shape", () => {
  const IMPLEMENTER_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];
  const result = launchPlan({
    agent: "implementer",
    stage: "ready",
    config: { [HEADLESS_KEY]: { dispatch: { ready: true } } },
    env: TOKEN,
    tiers: TIERS,
    allowedTools: IMPLEMENTER_TOOLS,
    permissionMode: "acceptEdits",
  });
  assert.equal(result.launch, true);
  assert.equal(argFor(result.argv, "--allowedTools"), IMPLEMENTER_TOOLS.join(" "));
  assert.equal(argFor(result.argv, "--permission-mode"), "acceptEdits");
});

test("bypassPermissions is refused even if explicitly asked for — the allowlist is the bound, never an escalated mode", () => {
  const result = launchPlan({
    agent: "implementer",
    stage: "ready",
    config: { [HEADLESS_KEY]: { dispatch: { ready: true } } },
    env: TOKEN,
    tiers: TIERS,
    allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
    permissionMode: "bypassPermissions",
  });
  assert.equal(result.launch, false);
  assert.equal(result.outcome, "failed");
  assert.match(result.reason, /forbidden/);
  assert.match(result.reason, /bypassPermissions/);
});

test("cwd flows through the plan unchanged — undefined by default, whatever was asked when given", () => {
  assert.equal(plan().cwd, undefined, "the read-only roles run in the caller's own cwd, exactly as before");
  const result = plan({ cwd: "/tmp/agentflow-worktree-issue-181" });
  assert.equal(result.cwd, "/tmp/agentflow-worktree-issue-181");
});

// --- classification: three outcomes that are not "failed" --------------------

test("a rate limit is its own outcome, and is never retried", () => {
  for (const text of ["Error: rate limit exceeded", "429 Too Many Requests", "usage limit reached"]) {
    const result = classify({ code: 1, stderr: text });
    assert.equal(result.outcome, "rate-limited", text);
    assert.match(result.reason, /shares? that window|shared/i);
  }
});

test("an expired token is `unauthenticated`, distinct from a crash", () => {
  for (const text of ["OAuth token expired", "401 Unauthorized", "invalid_token", "Please run `claude setup-token`"]) {
    const result = classify({ code: 1, stderr: text });
    assert.equal(result.outcome, "unauthenticated", text);
    assert.match(result.reason, /setup-token/);
  }
});

test("auth and rate-limit are checked before the generic non-zero branch", () => {
  // Both exit non-zero. Checked in the wrong order they collapse into `failed`,
  // and an expired token becomes indistinguishable from a broken agent.
  assert.equal(classify({ code: 1, stderr: "401 Unauthorized" }).outcome, "unauthenticated");
  assert.equal(classify({ code: 1, stderr: "rate limit" }).outcome, "rate-limited");
  assert.equal(classify({ code: 1, stderr: "TypeError: undefined" }).outcome, "failed");
});

test("a timeout is a failure that names the timeout", () => {
  const result = classify({ code: null, timedOut: true, timeoutMs: 1000 });
  assert.equal(result.outcome, "failed");
  assert.match(result.reason, /timed out after 1000ms/);
});

test("a timeout wins over whatever the partial output happened to contain", () => {
  const result = classify({ code: 1, timedOut: true, timeoutMs: 5, stderr: "rate limit" });
  assert.equal(result.outcome, "failed");
});

test("a clean exit is ok, with usage read back", () => {
  const stdout = JSON.stringify({ usage: { input_tokens: 1200, output_tokens: 340 }, total_cost_usd: 0 });
  const result = classify({ code: 0, stdout });
  assert.equal(result.outcome, "ok");
  assert.deepEqual(result.usage, { inputTokens: 1200, outputTokens: 340, costUsd: 0 });
});

test("unparseable output degrades usage to null rather than throwing", () => {
  // The agent may have succeeded; the wrapper still owes the ledger a row.
  assert.equal(parseUsage("not json"), null);
  assert.equal(parseUsage(""), null);
  assert.equal(parseUsage(JSON.stringify({ result: "ok" })), null);
  assert.equal(classify({ code: 0, stdout: "not json" }).outcome, "ok");
});

test("every classification is in the closed outcome set", () => {
  const results = [
    classify({ code: 0, stdout: "{}" }),
    classify({ code: 1, stderr: "boom" }),
    classify({ code: 1, stderr: "rate limit" }),
    classify({ code: 1, stderr: "401" }),
    classify({ timedOut: true }),
  ];
  for (const r of results) assert.ok(OUTCOMES.includes(r.outcome), r.outcome);
});

// --- the summary says how it was billed --------------------------------------

test("the summary line states subscription-billed, not API-metered", () => {
  const line = summaryLine({
    agent: "code-reviewer",
    model: "sonnet",
    outcome: "ok",
    usage: { inputTokens: 10, outputTokens: 2, costUsd: 0 },
  });
  assert.match(line, /subscription-billed/);
  assert.match(line, /not API-metered/);
  assert.match(line, /sonnet/);
});

// --- unwrapping the agent's artifact from `--output-format json` -------------
//
// Shared by both headless entry points (#157): headless-review.js used to
// carry its own copy of this function, and dispatch-comment.js needed the same
// unwrap to post a successful run's artifact instead of just closing its
// ledger row. Lifted here so there is one implementation instead of two that
// can drift, and its cases are tested once, here, rather than per caller.

test("the result field is preferred when the CLI's JSON envelope carries one", () => {
  assert.equal(reviewText('{"result":"findings here"}'), "findings here");
});

test("the text field is used when there is no result field", () => {
  assert.equal(reviewText('{"text":"the artifact, from the text field"}'), "the artifact, from the text field");
});

test("output that isn't JSON at all passes through untouched", () => {
  // A review or a dispatch artifact is already paid for by the time it is
  // parsed; losing it to a JSON.parse is the one outcome worse than an ugly
  // comment.
  assert.equal(reviewText("not json at all"), "not json at all");
});

test("valid JSON with neither field falls back to the raw stdout", () => {
  assert.equal(reviewText('{"unexpected":1}'), '{"unexpected":1}');
});

// --- extractJsonFence: the fenced-block scan, shared by two callers ---------
//
// Lifted out of scripts/actions/dispatch-comment.js's plan.json extraction
// (#175) so scripts/actions/headless-review.js's findings extraction (#171)
// can reuse the SAME scan instead of growing a second copy. dispatch.test.js
// keeps its own coverage of `extractPlan`/`isValidPlanCandidate` (the
// plan.json-specific predicate layered on top); these tests pin the generic
// scan itself: last-fence-wins, degrade-not-throw, and the `isValid`
// predicate as the seam a caller uses to keep its own payload schema local.

test("extractJsonFence finds a single fence satisfying isValid", () => {
  const text = 'prose\n```json\n{"a":1}\n```\nmore prose';
  assert.deepEqual(extractJsonFence(text, (c) => "a" in c), { a: 1 });
});

test("extractJsonFence returns null when there is no matching fence, without throwing", () => {
  assert.equal(extractJsonFence("no fences here at all"), null);
  assert.equal(extractJsonFence(""), null);
  assert.equal(extractJsonFence(null), null);
  assert.equal(extractJsonFence(undefined), null);
});

test("extractJsonFence: a malformed fence is skipped, not fatal", () => {
  const text = '```json\nnot valid json at all\n```';
  assert.doesNotThrow(() => extractJsonFence(text));
  assert.equal(extractJsonFence(text), null);
});

test("extractJsonFence: the LAST fence satisfying isValid wins, among fences that qualify", () => {
  const text = [
    "```json", '{"which":"first"}', "```",
    "some prose in between",
    "```json", '{"which":"second"}', "```",
  ].join("\n");
  assert.deepEqual(extractJsonFence(text, () => true), { which: "second" });
});

test("extractJsonFence: isValid disqualifies a candidate without losing an earlier qualifying one", () => {
  const text = [
    "```json", '{"ok":true,"n":1}', "```",
    "```json", '{"ok":false,"n":2}', "```", // fails isValid — must not win by being last
  ].join("\n");
  assert.deepEqual(extractJsonFence(text, (c) => c.ok === true), { ok: true, n: 1 });
});

test("extractJsonFence: the default isValid accepts anything that parses", () => {
  assert.deepEqual(extractJsonFence('```json\n{"x":1}\n```'), { x: 1 });
  assert.deepEqual(extractJsonFence('```json\n[1,2,3]\n```'), [1, 2, 3]);
});

// --- the shell, with an injected spawn ---------------------------------------

// Real streams, not EventEmitter stand-ins. `run.js` calls `setEncoding` on
// them, and a stub without it both hides the multi-byte bug and hangs the
// suite — a fake that cannot do what the real thing does is not a fake, it is a
// different object.
function childStub() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    child.killed = signal;
    setImmediate(() => child.emit("close", null, signal));
  };
  return child;
}

function fakeSpawn({ stdout = "", stderr = "", code = 0, hang = false } = {}) {
  const calls = [];
  const fn = (cmd, argv, opts) => {
    calls.push({ cmd, argv, opts });
    const child = childStub();
    if (!hang) {
      setImmediate(() => {
        if (stdout) child.stdout.write(stdout);
        if (stderr) child.stderr.write(stderr);
        child.emit("close", code, null);
      });
    }
    return child;
  };
  fn.calls = calls;
  return fn;
}

test("launch spawns with the planned argv and the stripped environment", async () => {
  const spawnFn = fakeSpawn({ stdout: JSON.stringify({ usage: { input_tokens: 5, output_tokens: 1 } }) });
  const result = await launch(
    { agent: "code-reviewer", stage: "review", config: ON, env: { ...TOKEN, [METERED_VAR]: "leak" } },
    { spawnFn, tiers: TIERS },
  );
  assert.equal(result.outcome, "ok");
  assert.equal(result.model, "sonnet");
  assert.equal(spawnFn.calls.length, 1);
  assert.equal(Object.hasOwn(spawnFn.calls[0].opts.env, METERED_VAR), false);
  assert.equal(spawnFn.calls[0].argv.includes("--bare"), false);
});

test("a refused launch never spawns, and returns the same shape as a run", async () => {
  const spawnFn = fakeSpawn();
  const result = await launch({ agent: "code-reviewer", stage: "review", config: {}, env: TOKEN }, { spawnFn, tiers: TIERS });
  assert.equal(spawnFn.calls.length, 0);
  assert.equal(result.outcome, "disabled");
  // Same keys either way, so the caller writes one ledger row in one place
  // instead of branching on whether anything actually ran.
  assert.deepEqual(Object.keys(result).sort(), ["argv", "model", "outcome", "reason", "usage"].sort());
});

test("a hanging process is killed, not orphaned", async () => {
  const spawnFn = fakeSpawn({ hang: true });
  const result = await runProcess({ argv: [], env: {}, timeoutMs: 20 }, spawnFn);
  assert.equal(result.timedOut, true);
  assert.equal(classify(result).outcome, "failed");
});

test("a spawn error is `failed`, never mistaken for an auth problem", async () => {
  // `claude` missing from the runner must not read as an expired token.
  const spawnFn = () => {
    const child = childStub();
    setImmediate(() => child.emit("error", new Error("spawn claude ENOENT")));
    return child;
  };
  const result = await launch({ agent: "code-reviewer", stage: "review", config: ON, env: TOKEN }, { spawnFn, tiers: TIERS });
  assert.equal(result.outcome, "failed");
  assert.match(result.reason, /ENOENT/);
});

test("no test in this file needs a token, a network, or the claude binary", () => {
  // Guard against the suite quietly acquiring a live dependency.
  assert.equal(process.env[TOKEN_VAR] ?? null, null);
});

// --- the argv never grows an unverified flag ---------------------------------

test("every flag emitted is on the hand-checked allowlist", () => {
  // The guard that would have caught `--max-turns`: it is not in `claude --help`,
  // and the CLI accepts it silently rather than rejecting it, so every unit test
  // still passed while the safety bound it claimed to provide may not have
  // existed. Checking against the live `--help` was tried and abandoned — that
  // text is split across two streams and truncates mid-word when piped, so the
  // check failed on correct code. This asserts against the reviewed list instead.
  const flags = plan().argv.filter((a) => a.startsWith("--"));
  assert.ok(flags.length > 0);
  for (const flag of flags) {
    assert.ok(KNOWN_FLAGS.includes(flag), `${flag} is not on the hand-checked allowlist`);
  }
});

test("--max-turns specifically never comes back", () => {
  assert.equal(KNOWN_FLAGS.includes("--max-turns"), false);
  assert.equal(plan().argv.includes("--max-turns"), false);
});

// --- regressions from review of PR #100 --------------------------------------

test("a signal-killed run is a failure, not a success", () => {
  // Node reports `code === null` when a process dies by signal. Coercing that
  // to 0 classified an OOM kill or a cancelled Actions job as `ok` and closed
  // its ledger row green. Our own timeout never exposed it, because `timedOut`
  // short-circuits first — which is exactly why it survived the first pass.
  const killed = classify({ code: null, signal: "SIGKILL", stdout: "" });
  assert.equal(killed.outcome, "failed");
  assert.match(killed.reason, /SIGKILL/);

  assert.equal(classify({ code: null, signal: null }).outcome, "failed");
  // A clean exit is still ok — the fix must not turn every run into a failure.
  assert.equal(classify({ code: 0, signal: null, stdout: "{}" }).outcome, "ok");
});

test("multi-byte output is decoded whole, not per chunk", async () => {
  // `+= buffer` calls toString() per chunk, so an em dash split across a chunk
  // boundary decodes as two broken halves: `verdict — approved` arrives as
  // `verdict ��� approved`. This repo's artifacts are full of em
  // dashes, and a split inside the JSON body makes parseUsage fail on a run
  // that succeeded.
  const text = JSON.stringify({ result: "verdict — approved", usage: { input_tokens: 1, output_tokens: 2 } });
  const buf = Buffer.from(text, "utf8");
  const cut = buf.indexOf(0xe2) + 1; // inside the em dash

  const spawnFn = () => {
    const child = childStub();
    setImmediate(() => {
      // Two writes, boundary inside a multi-byte sequence — what a real pipe does.
      child.stdout.write(buf.subarray(0, cut));
      child.stdout.write(buf.subarray(cut));
      child.emit("close", 0, null);
    });
    return child;
  };

  const result = await runProcess({ argv: [], env: {}, timeoutMs: 1000 }, spawnFn);
  assert.equal(result.stdout.includes("�"), false, "no replacement characters");
  assert.equal(JSON.parse(result.stdout).result, "verdict — approved");
  assert.equal(classify(result).usage.inputTokens, 1, "usage survives the split");
});
