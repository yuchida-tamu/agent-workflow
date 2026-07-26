import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, resolveReleaseKind } from "../init/config-schema.js";
import { IDLE_NOTE, exitCode, renderChecks, rollup, verifyChecks } from "../init/verify.js";

// ---------------------------------------------------------------------------
// fixtures: a repo where every adoption step landed. Each test spoils exactly
// one input, so a failure names the check that broke rather than the fixture.

const validConfig = {
  platform: null,
  maturity: "steady",
  approvers: ["yuchida-tamu"],
  intake_questions: ["Does this change gate or approval semantics?"],
  unmapped_criticality: "medium",
  unmapped_warn_fraction: 0.2,
  model_overrides: {},
};

const EXPECTED_LABELS = ["state:idea", "state:ready", "priority:p1", "blocked"];
const EXPECTED_WORKFLOWS = ["agentflow-dispatch.yml", "agentflow-gate.yml", "agentflow-verdict.yml"];

const stub = (action, toolkit = "yuchida-tamu/agent-workflow") =>
  `jobs:\n  run:\n    steps:\n      - uses: ${toolkit}/actions/${action}@main\n`;

const adopted = {
  config: { value: validConfig, error: null },
  labels: { names: [...EXPECTED_LABELS, "bug"], error: null },
  domains: {
    value: { engine: { criticality: "critical", paths: ["scripts/**"] } },
    error: null,
  },
  workflows: [
    { name: "agentflow-dispatch.yml", content: stub("dispatch") },
    { name: "agentflow-gate.yml", content: stub("gate-check") },
    { name: "agentflow-verdict.yml", content: stub("risk-verdict") },
  ],
  next: {
    code: 0,
    stdout: JSON.stringify({ issue: 6, dispatch: { actor: "agent", who: "implementer" } }),
    error: null,
  },
  expectedLabels: EXPECTED_LABELS,
  expectedWorkflows: EXPECTED_WORKFLOWS,
};

// One spoiled input, everything else healthy.
const run = (overrides = {}) => verifyChecks({ ...adopted, ...overrides });
const check = (checks, name) => checks.find((c) => c.name === name);

// ---------------------------------------------------------------------------
// the schema validator

test("validateConfig: today's config is valid, with nothing to say about it", () => {
  assert.deepEqual(validateConfig(validConfig), []);
});

test("validateConfig: the shipped template fails on its CHANGE_ME approver", () => {
  const issues = validateConfig({ ...validConfig, approvers: ["CHANGE_ME"] });
  assert.deepEqual(issues, [
    {
      path: "approvers[0]",
      message: 'is still the template placeholder "CHANGE_ME"',
      level: "error",
    },
  ]);
});

test("validateConfig: an out-of-range warn fraction names the offending path", () => {
  const issues = validateConfig({ ...validConfig, unmapped_warn_fraction: 1.5 });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, "unmapped_warn_fraction");
  assert.equal(issues[0].level, "error");
  assert.match(issues[0].message, /between 0 and 1 \(got 1.5\)/);
});

test("validateConfig: 0 and 1 are inside the range", () => {
  assert.deepEqual(validateConfig({ ...validConfig, unmapped_warn_fraction: 0 }), []);
  assert.deepEqual(validateConfig({ ...validConfig, unmapped_warn_fraction: 1 }), []);
});

test("validateConfig: an unrecognised key warns and never fails", () => {
  const issues = validateConfig({ ...validConfig, favourite_colour: "blue" });
  assert.deepEqual(issues, [
    { path: "favourite_colour", message: "is not a key the loop reads — ignored", level: "warn" },
  ]);
  assert.equal(
    issues.filter((i) => i.level === "error").length,
    0,
    "the config is extensible; an extra key is not a defect",
  );
});

test("validateConfig: platform is a string or null, and nothing else", () => {
  assert.deepEqual(validateConfig({ ...validConfig, platform: "rn-expo" }), []);
  const issues = validateConfig({ ...validConfig, platform: 7 });
  assert.deepEqual(issues, [
    { path: "platform", message: "must be a string or null (got number)", level: "error" },
  ]);
});

test("validateConfig: every value constraint reports its own path", () => {
  const issues = validateConfig({
    platform: null,
    maturity: "shipped",
    approvers: [],
    intake_questions: ["ok", 3],
    unmapped_criticality: "urgent",
    unmapped_warn_fraction: "0.2",
    model_overrides: [],
  });
  assert.deepEqual(
    issues.map((i) => i.path),
    ["maturity", "approvers", "intake_questions[1]", "unmapped_criticality", "unmapped_warn_fraction", "model_overrides"],
  );
  assert.equal(issues.every((i) => i.level === "error"), true);
  assert.equal(issues[0].message, 'must be one of "genesis", "steady"');
  assert.equal(issues[3].message, 'must be one of "low", "medium", "high", "critical"');
});

test("validateConfig: a missing key is a missed adoption step, reported by name", () => {
  const { approvers, ...withoutApprovers } = validConfig;
  assert.deepEqual(approvers, ["yuchida-tamu"], "the fixture really did carry approvers");
  assert.deepEqual(validateConfig(withoutApprovers), [
    { path: "approvers", message: "is missing", level: "error" },
  ]);
});

test("validateConfig: a non-object config is a single rooted error", () => {
  assert.deepEqual(validateConfig(["a"]), [
    { path: "", message: "must be a JSON object (got array)", level: "error" },
  ]);
  assert.deepEqual(validateConfig(null), [
    { path: "", message: "must be a JSON object (got null)", level: "error" },
  ]);
});

// ---------------------------------------------------------------------------
// check 1 — agentflow.config.json

test("check 1: a schema-valid config passes", () => {
  const row = check(run(), "agentflow.config.json");
  assert.equal(row.ok, true);
  assert.equal(row.detail, "parses and is schema-valid");
  assert.equal(row.note, null);
});

test("check 1: an unparseable config fails with the read error, not a schema complaint", () => {
  const row = check(
    run({ config: { value: null, error: "does not parse — Unexpected end of JSON input" } }),
    "agentflow.config.json",
  );
  assert.equal(row.ok, false);
  assert.equal(row.detail, "does not parse — Unexpected end of JSON input");
});

test("check 1: CHANGE_ME approvers fail the check and the path reaches the detail", () => {
  const row = check(
    run({ config: { value: { ...validConfig, approvers: ["CHANGE_ME"] }, error: null } }),
    "agentflow.config.json",
  );
  assert.equal(row.ok, false);
  assert.equal(
    row.detail,
    'schema-invalid: approvers[0] is still the template placeholder "CHANGE_ME"',
  );
});

test("check 1: an unknown key passes with a note", () => {
  const row = check(
    run({ config: { value: { ...validConfig, extra_key: 1 }, error: null } }),
    "agentflow.config.json",
  );
  assert.equal(row.ok, true);
  assert.equal(row.note, "extra_key is not a key the loop reads — ignored");
});

// ---------------------------------------------------------------------------
// check 2 — labels

test("check 2: every expected label present passes, extra repo labels ignored", () => {
  const row = check(run(), "labels");
  assert.equal(row.ok, true);
  assert.equal(row.detail, "all 4 present");
});

test("check 2: a missing label fails and names it", () => {
  const row = check(run({ labels: { names: ["state:idea", "priority:p1"], error: null } }), "labels");
  assert.equal(row.ok, false);
  assert.equal(
    row.detail,
    "2 of 4 missing (state:ready, blocked) — re-run `agentflow-init adopt` to create them",
  );
});

test("check 2: an unlistable repo fails rather than reporting 18 missing labels", () => {
  const row = check(run({ labels: { names: null, error: "`gh label list` failed" } }), "labels");
  assert.equal(row.ok, false);
  assert.equal(row.detail, "`gh label list` failed");
});

// ---------------------------------------------------------------------------
// check 3 — domains.yml

test("check 3: a mapped domain map passes", () => {
  const row = check(run(), "domains.yml");
  assert.equal(row.ok, true);
  assert.equal(row.detail, "1 domain(s), each with a criticality and paths");
});

test("check 3: the comments-only template stub parses to null and fails", () => {
  const row = check(run({ domains: { value: null, error: null } }), "domains.yml");
  assert.equal(row.ok, false);
  assert.equal(row.detail, "still the template stub — no domains mapped; run the adoption-auditor");
});

test("check 3: an entry missing criticality or paths fails, one problem per entry", () => {
  const row = check(
    run({
      domains: {
        value: {
          engine: { paths: ["scripts/**"] },
          ui: { criticality: "high", paths: [] },
          docs: { criticality: "sometimes", paths: ["docs/**"] },
        },
        error: null,
      },
    }),
    "domains.yml",
  );
  assert.equal(row.ok, false);
  assert.equal(
    row.detail,
    "engine.criticality must be one of low, medium, high, critical; " +
      "ui.paths must list at least one glob; " +
      "docs.criticality must be one of low, medium, high, critical",
  );
});

test("check 3: unparseable YAML fails with the parse error", () => {
  const row = check(
    run({ domains: { value: null, error: "does not parse — bad indentation" } }),
    "domains.yml",
  );
  assert.equal(row.ok, false);
  assert.equal(row.detail, "does not parse — bad indentation");
});

// ---------------------------------------------------------------------------
// check 4 — workflow stubs

test("check 4: three substituted stubs pass", () => {
  const row = check(run(), ".github/workflows");
  assert.equal(row.ok, true);
  assert.equal(row.detail, "3 stub(s) installed and pointed at the toolkit");
});

test("check 4: a residual __TOOLKIT_REPO__ fails and says the stub was copied by hand", () => {
  const row = check(
    run({
      workflows: [
        { name: "agentflow-dispatch.yml", content: stub("dispatch", "__TOOLKIT_REPO__") },
        { name: "agentflow-gate.yml", content: stub("gate-check") },
        { name: "agentflow-verdict.yml", content: stub("risk-verdict") },
      ],
    }),
    ".github/workflows",
  );
  assert.equal(row.ok, false);
  assert.equal(
    row.detail,
    "agentflow-dispatch.yml still contains __TOOLKIT_REPO__ — it was copied, not scaffolded",
  );
});

test("check 4: an uninstalled stub fails and names the file", () => {
  const row = check(
    run({ workflows: [{ name: "agentflow-gate.yml", content: stub("gate-check") }] }),
    ".github/workflows",
  );
  assert.equal(row.ok, false);
  assert.equal(
    row.detail,
    "agentflow-dispatch.yml is not installed; agentflow-verdict.yml is not installed",
  );
});

test("check 4: a substituted value that is not owner/name fails", () => {
  const row = check(
    run({
      workflows: [
        { name: "agentflow-dispatch.yml", content: stub("dispatch", "agent-workflow") },
        { name: "agentflow-gate.yml", content: stub("gate-check") },
        { name: "agentflow-verdict.yml", content: stub("risk-verdict") },
      ],
    }),
    ".github/workflows",
  );
  assert.equal(row.ok, false);
  assert.equal(
    row.detail,
    'agentflow-dispatch.yml points at "agent-workflow", which is not shaped owner/name',
  );
});

test("check 4: a stub that references no toolkit action fails", () => {
  const row = check(
    run({
      workflows: [
        { name: "agentflow-dispatch.yml", content: "jobs:\n  run:\n    steps:\n      - run: true\n" },
        { name: "agentflow-gate.yml", content: stub("gate-check") },
        { name: "agentflow-verdict.yml", content: stub("risk-verdict") },
      ],
    }),
    ".github/workflows",
  );
  assert.equal(row.ok, false);
  assert.equal(
    row.detail,
    "agentflow-dispatch.yml references no toolkit action — the loop cannot dispatch from it",
  );
});

// ---------------------------------------------------------------------------
// check 5 — agentflow-next. Exit 1 is idle, not broken.

test("check 5: exit 0 passes and reports who the loop would dispatch to", () => {
  const row = check(run(), "agentflow-next");
  assert.equal(row.ok, true);
  assert.equal(row.detail, "dispatches #6 → agent:implementer");
  assert.equal(row.note, null);
});

test("check 5: exit 1 is idle — it passes, with the one-label fix as a note", () => {
  const checks = run({ next: { code: 1, stdout: '{"idle":true}', error: null } });
  const row = check(checks, "agentflow-next");
  assert.equal(row.ok, true, "a correctly adopted repo seeds no backlog; that is not a defect");
  assert.equal(row.detail, "the dispatcher runs; the backlog is idle");
  assert.equal(row.note, IDLE_NOTE);
  assert.match(row.note, /state:idea/);
  assert.equal(exitCode(checks), 0, "a note must not fail the run");
});

test("check 5: exit 20 fails — a dispatcher that cannot run is a real defect", () => {
  const checks = run({ next: { code: 20, stdout: "", error: null } });
  const row = check(checks, "agentflow-next");
  assert.equal(row.ok, false);
  assert.equal(
    row.detail,
    "exited 20 (usage/IO error) — check `gh auth status` and that the repo is reachable",
  );
  assert.equal(exitCode(checks), 1);
});

test("check 5: any other non-zero exit fails", () => {
  const row = check(run({ next: { code: 137, stdout: "", error: null } }), "agentflow-next");
  assert.equal(row.ok, false);
  assert.equal(row.detail, "exited 137");
});

test("check 5: a dispatcher that never started fails", () => {
  const row = check(
    run({ next: { code: null, stdout: "", error: "spawn node ENOENT" } }),
    "agentflow-next",
  );
  assert.equal(row.ok, false);
  assert.equal(row.detail, "could not run — spawn node ENOENT");
});

test("check 5: unparseable output fails on either exit code", () => {
  const idle = check(run({ next: { code: 1, stdout: "backlog idle", error: null } }), "agentflow-next");
  assert.equal(idle.ok, false);
  assert.equal(idle.detail, 'exited 1 but its --json output could not be read: "backlog idle"');

  const busy = check(run({ next: { code: 0, stdout: "#6 ready", error: null } }), "agentflow-next");
  assert.equal(busy.ok, false);
  assert.equal(busy.detail, 'exited 0 but its --json output could not be read: "#6 ready"');
});

// ---------------------------------------------------------------------------
// roll-up, exit code, rendering

test("verifyChecks: six checks, always in the same order", () => {
  assert.deepEqual(
    run().map((c) => c.name),
    ["agentflow.config.json", "labels", "domains.yml", ".github/workflows", "agentflow-next", "G3 mode"],
  );
});

test("a fully adopted repo with a labelled backlog: every check passes, exit 0", () => {
  // The fixture carries no `agent_identity`, which is the common case — so the
  // clean report now carries one note saying the repo is in solo-comment G3.
  // A note is not a defect: the exit code is still 0.
  const checks = run();
  assert.equal(checks.every((c) => c.ok), true);
  assert.equal(rollup(checks), "6 passed (1 note)");
  assert.equal(exitCode(checks), 0);
});

test("rollup: a note is visible in the roll-up, and plural when there are two", () => {
  assert.equal(rollup(run({ next: { code: 1, stdout: '{"idle":true}', error: null } })), "6 passed (2 notes)");
  assert.equal(
    rollup(
      run({
        next: { code: 1, stdout: '{"idle":true}', error: null },
        config: { value: { ...validConfig, extra_key: 1 }, error: null },
      }),
    ),
    "6 passed (3 notes)",
  );
});

test("rollup: failures are counted, and every other row still reports", () => {
  const checks = run({ domains: { value: null, error: null } });
  assert.equal(rollup(checks), "5 passed, 1 failed (1 note)");
  assert.equal(exitCode(checks), 1);
  assert.equal(checks.length, 6, "one failing check never suppresses the others");
});

test("renderChecks: ✓/✗ per row, notes indented under theirs, roll-up last", () => {
  const lines = renderChecks(run({ next: { code: 1, stdout: '{"idle":true}', error: null } })).split("\n");
  assert.equal(lines[0], "✓ agentflow.config.json — parses and is schema-valid");
  assert.equal(lines[1], "✓ labels — all 4 present");
  assert.equal(lines[4], "✓ agentflow-next — the dispatcher runs; the backlog is idle");
  assert.equal(lines[5], `  ! ${IDLE_NOTE}`);
  assert.equal(lines[6], "✓ G3 mode — solo-comment");
  assert.equal(lines[8], "");
  assert.equal(lines.at(-1), "6 passed (2 notes)");
});

test("renderChecks: a failed row is marked ✗ and keeps its detail", () => {
  const lines = renderChecks(run({ next: { code: 20, stdout: "", error: null } })).split("\n");
  assert.equal(
    lines[4],
    "✗ agentflow-next — exited 20 (usage/IO error) — check `gh auth status` and that the repo is reachable",
  );
  assert.equal(lines.at(-1), "5 passed, 1 failed (1 note)");
});

// --- release_kind ------------------------------------------------------------

test("resolveReleaseKind: explicit config always wins over the platform", () => {
  assert.equal(resolveReleaseKind({ release_kind: "tag", platform: "rn-expo" }).kind, "tag");
  assert.equal(resolveReleaseKind({ release_kind: "none", platform: "rn-expo" }).kind, "none");
  assert.equal(resolveReleaseKind({ release_kind: "tag" }).source, "config");
});

test("resolveReleaseKind: a store platform infers store", () => {
  for (const platform of ["rn-expo", "expo", "react-native", "ios", "android"]) {
    const resolved = resolveReleaseKind({ platform });
    assert.equal(resolved.kind, "store", platform);
    assert.equal(resolved.source, "inferred");
  }
});

test("resolveReleaseKind: anything else, including no platform, infers tag", () => {
  assert.equal(resolveReleaseKind({ platform: null }).kind, "tag");
  assert.equal(resolveReleaseKind({ platform: "node-lib" }).kind, "tag");
  assert.equal(resolveReleaseKind({}).kind, "tag");
  assert.equal(resolveReleaseKind(undefined).kind, "tag");
});

test("resolveReleaseKind explains itself", () => {
  assert.match(resolveReleaseKind({ platform: null }).from, /no platform/);
  assert.match(resolveReleaseKind({ platform: "rn-expo" }).from, /rn-expo/);
});

test("a config with no release_kind is still valid — the key postdates the template", () => {
  assert.ok(!Object.hasOwn(validConfig, "release_kind"), "fixture predates the key");
  assert.deepEqual(validateConfig(validConfig).filter((i) => i.level === "error"), []);
});

test("a release_kind typo is an error, never a silent inference", () => {
  const issues = validateConfig({ ...validConfig, release_kind: "tags" });
  const found = issues.find((i) => i.path === "release_kind");
  assert.equal(found.level, "error");
  assert.match(found.message, /must be one of "store", "tag", "none"/);
});

test("release_kind is a known key, so it draws no unknown-key warning", () => {
  const issues = validateConfig({ ...validConfig, release_kind: "tag" });
  assert.equal(issues.find((i) => i.path === "release_kind"), undefined);
});

// --- agent_identity ----------------------------------------------------------
//
// The App is optional everywhere, so an absent key is a complete config, not a
// half-finished adoption. `approvers` is the list that decides *authority*, and
// it stays human-only: the whole point of giving agentflow its own identity is
// that work and decisions have different authors.

test("a config with no agent_identity is still valid — the App is optional everywhere", () => {
  assert.ok(!Object.hasOwn(validConfig, "agent_identity"), "fixture carries no identity");
  assert.deepEqual(validateConfig(validConfig).filter((i) => i.level === "error"), []);
});

test("agent_identity is a known key, so it draws no unknown-key warning", () => {
  for (const value of [null, "agentflow-bot", { slug: "agentflow-bot", app_id: 12345 }]) {
    const issues = validateConfig({ ...validConfig, agent_identity: value });
    assert.deepEqual(issues, [], JSON.stringify(value));
  }
});

test("a malformed agent_identity is an error, never a silent 'unconfigured'", () => {
  // resolveIdentity() deliberately falls back to unconfigured rather than
  // throwing on a gate path. That makes reporting the typo *here* the only way
  // a human ever learns their App was quietly ignored.
  for (const bad of [42, [], "", { app_id: 1 }]) {
    const found = validateConfig({ ...validConfig, agent_identity: bad }).find(
      (i) => i.path === "agent_identity",
    );
    assert.equal(found?.level, "error", JSON.stringify(bad));
  }
});

test("approvers is human logins only: a bot-shaped login is refused by name", () => {
  const issues = validateConfig({ ...validConfig, approvers: ["yuchida-tamu", "dependabot[bot]"] });
  const found = issues.find((i) => i.path === "approvers[1]");
  assert.equal(found.level, "error");
  assert.match(found.message, /dependabot\[bot\]/);
  assert.match(found.message, /human/i);
});

test("approvers may not name the agent identity, in either spelling", () => {
  for (const login of ["agentflow-bot", "agentflow-bot[bot]"]) {
    const issues = validateConfig({
      ...validConfig,
      agent_identity: "agentflow-bot",
      approvers: [login],
    });
    const found = issues.find((i) => i.path === "approvers[0]");
    assert.equal(found?.level, "error", login);
    assert.match(found.message, /agentflow-bot/);
  }
});

test("a human approver is unaffected by any of this", () => {
  const issues = validateConfig({
    ...validConfig,
    agent_identity: "agentflow-bot",
    approvers: ["yuchida-tamu"],
  });
  assert.deepEqual(issues, []);
});

// --- check 6: G3 mode --------------------------------------------------------
//
// "Which G3 does this repo have, and why?" was answerable only by reading
// source. Two independent facts decide it: whether agent PRs are authored by
// somebody other than the approver (so a native review is *possible*), and
// whether branch protection requires that review (so it is *enforced*).

const g3Check = (checks) => checks.find((c) => c.name === "G3 mode");

test("check 6: no agent_identity reports solo-comment, as a note rather than a failure", () => {
  // A solo-comment repo is a legitimate configuration, not a broken adoption.
  // `rollup` counts notes separately for exactly this kind of true-but-fine remark.
  const checks = run({});
  const check = g3Check(checks);
  assert.equal(check.ok, true);
  assert.match(check.detail, /solo-comment/);
  assert.match(check.note, /agent_identity/);
  assert.equal(exitCode(checks), 0, "a solo-comment repo still exits 0");
});

test("check 6: a configured identity on a protected branch is native-review, enforced", () => {
  const check = g3Check(
    run({
      config: { value: { ...validConfig, agent_identity: "agentflow-bot" }, error: null },
      protection: { required_pull_request_reviews: { required_approving_review_count: 1 } },
    }),
  );
  assert.equal(check.ok, true);
  assert.match(check.detail, /native-review/);
  assert.equal(check.note, null, "nothing is owed, so there is nothing to note");
});

test("check 6: a configured identity on an unprotected branch says the review is not enforced", () => {
  const checks = run({
    config: { value: { ...validConfig, agent_identity: "agentflow-bot" }, error: null },
    protection: null,
  });
  const check = g3Check(checks);
  assert.equal(check.ok, true);
  assert.match(check.detail, /native-review/);
  assert.match(check.note, /not enforced|unprotected/i);
  assert.equal(exitCode(checks), 0);
});

test("check 6: unreadable protection is never reported as protected", () => {
  const check = g3Check(
    run({
      config: { value: { ...validConfig, agent_identity: "agentflow-bot" }, error: null },
      protection: undefined,
    }),
  );
  assert.match(check.note, /could not be read|not looked up/i);
});

test("check 6: an unreadable config does not crash the check", () => {
  // Check 1 already reports the broken config; this one must not throw on top of
  // it, or one bad file takes the whole report down.
  const check = g3Check(run({ config: { value: null, error: "ENOENT" } }));
  assert.equal(check.ok, true);
  assert.match(check.detail, /solo-comment/);
});
