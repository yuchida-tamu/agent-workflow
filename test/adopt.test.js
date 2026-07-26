import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { domainFacts } from "../scripts/facts/core.js";
import {
  DEFAULT_WARN_FRACTION,
  NOT_APPLICABLE,
  coverage,
  isTrackedSource,
  labelCreateCommands,
  labelPlan,
  mergeProtection,
  normalizeProtection,
  protectionBaseline,
  remainingItems,
  renderCommand,
  renderCoverage,
  renderSummary,
  scaffoldSummary,
  settingsReport,
  shellQuote,
  trackedSourceFiles,
} from "../init/adopt.js";

const labelsDoc = {
  labels: [
    { name: "state:idea", color: "E8E5FB", description: "Intake: awaiting shaping" },
    { name: "priority:p1", color: "D93F0B", description: "Next up" },
    { name: "blocked", color: "000000", description: "Not dispatchable; see comments" },
  ],
};

const steps = [
  { from: "/tk/templates/agentflow.config.json", to: "/app/agentflow.config.json" },
  { from: "/tk/templates/domains.yml", to: "/app/domains.yml" },
  { dir: "/app/e2e/scenarios" },
];

test("labelPlan: every label missing → all created", () => {
  const plan = labelPlan(labelsDoc, []);
  assert.deepEqual(plan.create, ["state:idea", "priority:p1", "blocked"]);
  assert.deepEqual(plan.present, []);
});

test("labelPlan: every label already on the repo → none created", () => {
  const plan = labelPlan(labelsDoc, ["blocked", "state:idea", "bug", "priority:p1"]);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.present, ["state:idea", "priority:p1", "blocked"], "doc order, not repo order");
});

test("labelPlan: mixed → only the missing ones are created", () => {
  const plan = labelPlan(labelsDoc, ["blocked"]);
  assert.deepEqual(plan.create, ["state:idea", "priority:p1"]);
  assert.deepEqual(plan.present, ["blocked"]);
});

test("labelCreateCommands: additive — never --force, and only for the named labels", () => {
  const commands = labelCreateCommands(labelsDoc, ["priority:p1"], "o/r");
  assert.deepEqual(commands, [
    ["label", "create", "priority:p1", "--repo", "o/r", "--color", "D93F0B", "--description", "Next up"],
  ]);
  assert.ok(!commands.flat().includes("--force"), "adoption never rewrites a brownfield repo's labels");
});

test("labelCreateCommands: no --repo when none given", () => {
  assert.deepEqual(labelCreateCommands(labelsDoc, ["blocked"], undefined), [
    ["label", "create", "blocked", "--color", "000000", "--description", "Not dispatchable; see comments"],
  ]);
});

test("scaffoldSummary: nothing exists yet → every step is created", () => {
  const summary = scaffoldSummary(steps, []);
  assert.deepEqual(summary.created, ["/app/agentflow.config.json", "/app/domains.yml", "/app/e2e/scenarios"]);
  assert.deepEqual(summary.present, []);
});

test("scaffoldSummary: partially present → existing paths are present, never rewritten", () => {
  const summary = scaffoldSummary(steps, ["/app/domains.yml", "/app/e2e/scenarios"]);
  assert.deepEqual(summary.created, ["/app/agentflow.config.json"]);
  assert.deepEqual(summary.present, ["/app/domains.yml", "/app/e2e/scenarios"]);
});

test("scaffoldSummary: accepts a Set and keeps step order", () => {
  const summary = scaffoldSummary(steps, new Set(["/app/agentflow.config.json"]));
  assert.deepEqual(summary.created, ["/app/domains.yml", "/app/e2e/scenarios"]);
  assert.deepEqual(summary.present, ["/app/agentflow.config.json"]);
});

test("remainingItems: a fresh scaffold owes the domain map, platform, approvers, settings", () => {
  const items = remainingItems({
    config: { platform: "rn-expo", approvers: ["CHANGE_ME"] },
    domains: null,
    settings: [{ id: "branch-protection", status: "missing", why: "main is unprotected", command: "gh …" }],
  });
  assert.equal(items.length, 4);
  assert.match(items[0], /domains\.yml/);
  assert.match(items[1], /platform/);
  assert.match(items[2], /approvers/);
  assert.match(items[3], /repo setting branch-protection \(missing\)/);
});

test("remainingItems: a fully configured repo owes nothing", () => {
  const items = remainingItems({
    config: { platform: "web-next", approvers: ["yuchida-tamu"] },
    domains: { checkout: { criticality: "critical", paths: ["src/checkout/**"] } },
    settings: [{ id: "branch-protection", status: "satisfied", why: "already at baseline", command: null }],
  });
  assert.deepEqual(items, [], "a satisfied setting is not owed");
});

test("remainingItems: a setting with no command tells the reader to resolve the note", () => {
  const [item] = remainingItems({
    config: { platform: "web", approvers: ["ok"] },
    domains: { a: {} },
    settings: [{ id: "release-environment", status: "missing", why: "approvers unresolved", command: null }],
  });
  assert.match(item, /resolve the note printed below/);
});

test("remainingItems: an empty approver list is as unset as CHANGE_ME", () => {
  const of = (config) => remainingItems({ config, domains: { a: {} } }).join("\n");
  assert.match(of({ platform: "web", approvers: [] }), /approvers/);
  assert.match(of({ platform: "web" }), /approvers/);
  assert.match(of({ platform: "web", approvers: ["ok", "CHANGE_ME"] }), /approvers/);
  assert.doesNotMatch(of({ platform: "web", approvers: ["ok"] }), /approvers/);
});

test("remainingItems: an unreadable config owes everything it can't confirm", () => {
  const items = remainingItems({ config: null, domains: null });
  assert.match(items.join("\n"), /platform/);
  assert.match(items.join("\n"), /approvers/);
});

test("remainingItems: extra items are appended after the standing ones", () => {
  const items = remainingItems({
    config: { platform: "web", approvers: ["ok"] },
    domains: { a: {} },
    settings: [{ id: "actions-access", status: "missing", why: "no policy", command: "gh …" }],
    extra: ["labels not verified — gh label list failed"],
  });
  assert.equal(items.length, 2);
  assert.match(items[0], /repo setting actions-access/);
  assert.match(items[1], /labels not verified/, "extra items land after the standing ones");
});

test("renderSummary: sections print created · present · remaining, whatever the key order", () => {
  const out = renderSummary({
    remaining: ["repo settings not configured"],
    present: ["domains.yml"],
    created: ["agentflow.config.json", "label state:idea"],
  });
  const headings = out.split("\n").filter((l) => /^(created|present|remaining)\b/.test(l));
  assert.deepEqual(headings, ["created (2)", "present (1)", "remaining (1)"]);
  assert.ok(out.indexOf("agentflow.config.json") < out.indexOf("domains.yml"));
  assert.ok(out.indexOf("domains.yml") < out.indexOf("repo settings"));
});

test("renderSummary: empty sections still print, so a half-finished adoption is legible", () => {
  const out = renderSummary({ created: [], present: [], remaining: [] });
  assert.match(out, /created \(0\)/);
  assert.match(out, /present \(0\)/);
  assert.match(out, /remaining \(0\)/);
});

test("renderSummary: dry run says nothing was written", () => {
  assert.match(renderSummary({ created: ["a"], present: [], remaining: [], dryRun: true }), /dry run/);
  assert.doesNotMatch(renderSummary({ created: ["a"], present: [], remaining: [] }), /dry run/);
});

// ---------------------------------------------------------------------------
// Repo settings — detect and print, never apply.
//
// Every case here runs against the pure settingsReport() with a hand-built
// `current`: no network, no `gh`, no repo touched. The one test that does shell
// out runs /bin/sh against a `gh` shim, because "the printed command actually
// pastes" is not a claim a string assertion can make.

const REPO = "yuchida-tamu/app";
const TOOLKIT = "yuchida-tamu/agent-workflow";

const byId = (entries) => Object.fromEntries(entries.map((e) => [e.id, e]));

// The GET shapes GitHub really returns: `{enabled}` wrappers, full user objects,
// protection rules as a list. Normalising these is half the work.
const protectionGet = (over = {}) => ({
  required_pull_request_reviews: {
    required_approving_review_count: 1,
    dismiss_stale_reviews: true,
    require_code_owner_reviews: false,
    require_last_push_approval: false,
  },
  enforce_admins: { enabled: false },
  restrictions: null,
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  required_linear_history: { enabled: false },
  required_conversation_resolution: { enabled: false },
  block_creations: { enabled: false },
  lock_branch: { enabled: false },
  allow_fork_syncing: { enabled: false },
  ...over,
});

const environmentGet = (reviewers, over = {}) => ({
  name: "release",
  protection_rules: [
    {
      id: 1,
      type: "required_reviewers",
      prevent_self_review: false,
      reviewers: reviewers.map(([login, id]) => ({ type: "User", reviewer: { login, id } })),
    },
  ],
  deployment_branch_policy: null,
  ...over,
});

// The body a printed command would send, recovered from the heredoc.
function bodyOf(command) {
  const lines = command.split("\n");
  return JSON.parse(lines.slice(1, -1).join("\n").replaceAll(/\$\([^)]*\)/g, "0"));
}

const report = (over = {}) =>
  settingsReport({
    repo: REPO,
    toolkitRepo: TOOLKIT,
    defaultBranch: "main",
    environment: "release",
    approverLogins: ["yuchida-tamu"],
    requiredChecks: [],
    ...over,
  });

// --- AC1: a virgin repo -----------------------------------------------------

test("settingsReport: nothing configured → all three missing, each with a runnable command", () => {
  const entries = report({ current: { access: null, protection: null, environment: null } });
  assert.deepEqual(entries.map((e) => e.id), [
    "actions-access",
    "branch-protection",
    "release-environment",
  ]);
  assert.deepEqual(entries.map((e) => e.status), ["missing", "missing", "missing"]);
  for (const entry of entries) {
    assert.match(entry.command, /^gh api --method PUT /, `${entry.id} prints a command`);
    assert.ok(bodyOf(entry.command), `${entry.id} body is valid JSON`);
  }
});

test("settingsReport: the printed commands target the right endpoints", () => {
  const { "actions-access": access, "branch-protection": prot, "release-environment": env } = byId(
    report({ current: { access: null, protection: null, environment: null } }),
  );
  // Actions access is set on the TOOLKIT repo — the adopted repo's workflows do
  // `uses: <toolkit>/actions/…`, and it is the toolkit that must admit them.
  assert.match(access.command, new RegExp(`/repos/${TOOLKIT}/actions/permissions/access`));
  assert.match(prot.command, new RegExp(`/repos/${REPO}/branches/main/protection`));
  assert.match(env.command, new RegExp(`/repos/${REPO}/environments/release`));
});

test("settingsReport: is pure — it returns commands and never executes anything", () => {
  const entries = report({ current: { access: null, protection: null, environment: null } });
  for (const entry of entries) {
    assert.equal(typeof entry.command, "string");
    assert.ok(Array.isArray(entry.notes));
  }
});

test("settingsReport: the G3 baseline is one approval, dismiss-stale, no force-push", () => {
  const { "branch-protection": prot } = byId(
    report({ current: { access: null, protection: null, environment: null } }),
  );
  const body = bodyOf(prot.command);
  assert.equal(body.required_pull_request_reviews.required_approving_review_count, 1);
  assert.equal(body.required_pull_request_reviews.dismiss_stale_reviews, true);
  assert.equal(body.allow_force_pushes, false);
  assert.equal(body.allow_deletions, false);
  // The API requires the key even with no checks — null, not absent.
  assert.ok("required_status_checks" in body);
  assert.equal(body.required_status_checks, null);
  assert.equal(body.restrictions, null);
});

test("settingsReport: --required-check contexts land in the printed body, strict", () => {
  const { "branch-protection": prot } = byId(
    report({ requiredChecks: ["ci", "lint"], current: { protection: null } }),
  );
  assert.deepEqual(bodyOf(prot.command).required_status_checks, {
    strict: true,
    contexts: ["ci", "lint"],
  });
});

test("settingsReport: with no --required-check, the note says review-only", () => {
  const { "branch-protection": prot } = byId(report({ current: { protection: null } }));
  assert.match(prot.notes.join("\n"), /no --required-check given/);
});

// --- AC2: already satisfying the baseline -----------------------------------

test("settingsReport: everything already at baseline → satisfied, nothing printed", () => {
  const entries = report({
    current: {
      access: { access_level: "user" },
      protection: protectionGet(),
      environment: environmentGet([["yuchida-tamu", 4242]]),
    },
  });
  assert.deepEqual(entries.map((e) => e.status), ["satisfied", "satisfied", "satisfied"]);
  assert.deepEqual(entries.map((e) => e.command), [null, null, null]);
});

test("settingsReport: a stricter access level than needed is satisfied, not rewritten", () => {
  for (const level of ["user", "organization", "enterprise"]) {
    const { "actions-access": access } = byId(report({ current: { access: { access_level: level } } }));
    assert.equal(access.status, "satisfied", level);
    assert.equal(access.command, null, `${level} is never narrowed back to "user"`);
  }
});

test("settingsReport: access below the needed level is raised, and the diff says so", () => {
  const { "actions-access": access } = byId(report({ current: { access: { access_level: "none" } } }));
  assert.equal(access.status, "needs-change");
  assert.equal(bodyOf(access.command).access_level, "user");
  assert.match(access.notes.join("\n"), /access_level none → user/);
});

test("settingsReport: a public toolkit repo needs no access policy at all", () => {
  const { "actions-access": access } = byId(report({ current: { access: NOT_APPLICABLE } }));
  assert.equal(access.status, "satisfied");
  assert.equal(access.command, null);
});

// --- AC3: the repo is already stricter than baseline ------------------------

test("settingsReport: pasting the protection command cannot weaken a stricter repo", () => {
  const current = protectionGet({
    required_pull_request_reviews: {
      required_approving_review_count: 2,
      dismiss_stale_reviews: false,
      require_code_owner_reviews: true,
      require_last_push_approval: true,
      dismissal_restrictions: { users: [{ login: "lead" }], teams: [], apps: [] },
    },
    enforce_admins: { enabled: true },
    required_linear_history: { enabled: true },
    required_conversation_resolution: { enabled: true },
    required_status_checks: { strict: true, contexts: ["e2e"] },
    restrictions: { users: [{ login: "release-bot" }], teams: [{ slug: "core" }], apps: [] },
  });
  const { "branch-protection": prot } = byId(report({ requiredChecks: ["ci"], current: { protection: current } }));
  assert.equal(prot.status, "needs-change");
  const body = bodyOf(prot.command);

  assert.equal(body.required_pull_request_reviews.required_approving_review_count, 2, "max, not the baseline 1");
  assert.deepEqual(body.required_status_checks.contexts, ["ci", "e2e"], "union, not replacement");
  assert.equal(body.enforce_admins, true, "a tightener the baseline does not want stays on");
  assert.equal(body.required_linear_history, true);
  assert.equal(body.required_conversation_resolution, true);
  assert.equal(body.required_pull_request_reviews.require_code_owner_reviews, true);
  assert.equal(body.required_pull_request_reviews.require_last_push_approval, true);
  assert.deepEqual(body.restrictions, { users: ["release-bot"], teams: ["core"], apps: [] },
    "an existing push allow-list is carried through, in PUT shape");
  assert.deepEqual(body.required_pull_request_reviews.dismissal_restrictions,
    { users: ["lead"], teams: [], apps: [] });
  // The one thing it does add:
  assert.equal(body.required_pull_request_reviews.dismiss_stale_reviews, true);
  assert.match(prot.notes.join("\n"), /dismiss_stale_reviews false → true/);
  assert.match(prot.notes.join("\n"), /\+status check ci/);
});

test("mergeProtection: the merge is monotonic — no axis ever comes back looser", () => {
  const baseline = protectionBaseline(["ci"]);
  const strict = normalizeProtection(
    protectionGet({
      required_pull_request_reviews: {
        required_approving_review_count: 5,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
        require_last_push_approval: true,
      },
      enforce_admins: { enabled: true },
      block_creations: { enabled: true },
      lock_branch: { enabled: true },
      required_status_checks: { strict: true, contexts: ["a", "b"] },
    }),
  );
  const merged = mergeProtection(strict, baseline);
  assert.ok(
    merged.required_pull_request_reviews.required_approving_review_count >=
      strict.required_pull_request_reviews.required_approving_review_count,
  );
  for (const key of ["enforce_admins", "required_linear_history", "required_conversation_resolution", "block_creations", "lock_branch"]) {
    assert.ok(merged[key] >= strict[key], `${key} never turns off`);
  }
  for (const key of ["allow_force_pushes", "allow_deletions"]) {
    assert.ok(merged[key] <= strict[key], `${key} never turns on`);
  }
  for (const ctx of strict.required_status_checks.contexts) {
    assert.ok(merged.required_status_checks.contexts.includes(ctx), `${ctx} survives`);
  }
});

test("mergeProtection: a looser current is tightened to the baseline", () => {
  const current = normalizeProtection(
    protectionGet({
      required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: false },
      allow_force_pushes: { enabled: true },
      allow_deletions: { enabled: true },
    }),
  );
  const merged = mergeProtection(current, protectionBaseline([]));
  assert.equal(merged.required_pull_request_reviews.required_approving_review_count, 1);
  assert.equal(merged.allow_force_pushes, false, "force-push is closed, not preserved");
  assert.equal(merged.allow_deletions, false);
});

test("normalizeProtection: reads the modern `checks` array as well as `contexts`", () => {
  const normalized = normalizeProtection(
    protectionGet({ required_status_checks: { strict: false, contexts: ["stale"], checks: [{ context: "ci", app_id: null }] } }),
  );
  assert.deepEqual(normalized.required_status_checks.contexts, ["ci"], "checks wins over deprecated contexts");
});

test("settingsReport: an existing environment reviewer is unioned, never replaced", () => {
  const { "release-environment": env } = byId(
    report({
      approverLogins: ["yuchida-tamu"],
      current: {
        environment: environmentGet([["existing-approver", 999]], {
          protection_rules: [
            { id: 0, type: "wait_timer", wait_timer: 30 },
            {
              id: 1,
              type: "required_reviewers",
              prevent_self_review: true,
              reviewers: [{ type: "User", reviewer: { login: "existing-approver", id: 999 } }],
            },
          ],
          deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
        }),
      },
    }),
  );
  assert.equal(env.status, "needs-change");
  const body = bodyOf(env.command);
  assert.deepEqual(body.reviewers[0], { type: "User", id: 999 }, "the existing reviewer keeps their standing");
  assert.equal(body.reviewers.length, 2, "the configured approver is added, not swapped in");
  assert.equal(body.wait_timer, 30, "an existing wait timer survives the wholesale PUT");
  assert.equal(body.prevent_self_review, true);
  assert.deepEqual(body.deployment_branch_policy, { protected_branches: true, custom_branch_policies: false });
  assert.match(env.notes.join("\n"), /\+reviewer yuchida-tamu/);
});

test("settingsReport: an approver already on the environment needs no lookup", () => {
  const { "release-environment": env } = byId(
    report({ approverLogins: ["a"], current: { environment: environmentGet([["a", 1], ["b", 2]]) } }),
  );
  assert.equal(env.status, "satisfied", "a superset of the configured approvers is satisfied");
  assert.equal(env.command, null);
});

// --- AC4: the state cannot be read ------------------------------------------

test("settingsReport: a 403 on protection reports unknown and warns about wholesale replace", () => {
  const { "branch-protection": prot } = byId(report({ current: { protection: undefined } }));
  assert.equal(prot.status, "unknown");
  assert.match(prot.why, /403/);
  assert.match(prot.notes.join("\n"), /REPLACES the whole object/);
  assert.match(prot.command, /^gh api --method PUT /, "the command is still printed, with the warning");
});

test("settingsReport: unreadable access warns that the PUT could narrow a broader grant", () => {
  const { "actions-access": access } = byId(report({ current: { access: undefined } }));
  assert.equal(access.status, "unknown");
  assert.match(access.notes.join("\n"), /NARROWS it/);
});

test("settingsReport: an unreadable environment warns that existing reviewers would be removed", () => {
  const { "release-environment": env } = byId(report({ current: { environment: undefined } }));
  assert.equal(env.status, "unknown");
  assert.match(env.notes.join("\n"), /WILL BE REMOVED/);
});

test("settingsReport: a 404 is absent, not unreadable — no wholesale warning on a bare repo", () => {
  const entries = report({ current: { access: null, protection: null, environment: null } });
  for (const entry of entries) {
    assert.doesNotMatch(entry.notes.join("\n"), /REPLACES the whole object/, entry.id);
  }
});

// --- AC5: approvers not yet resolved ----------------------------------------

test("settingsReport: CHANGE_ME approvers report the placeholder instead of printing a command", () => {
  const { "release-environment": env } = byId(
    report({ approverLogins: ["CHANGE_ME"], current: { environment: null } }),
  );
  assert.equal(env.status, "missing");
  assert.equal(env.command, null, "a G4 gate nobody can approve is worse than no gate");
  assert.match(env.why, /unresolved \(CHANGE_ME\)/);
  assert.match(env.notes.join("\n"), /agentflow\.config\.json/);
});

test("settingsReport: no approvers at all is as unresolved as CHANGE_ME", () => {
  const { "release-environment": env } = byId(report({ approverLogins: [], current: { environment: null } }));
  assert.equal(env.command, null);
  assert.match(env.why, /gate releases on nobody/);
});

test("settingsReport: a login that is not shell-safe is never interpolated into a command", () => {
  const { "release-environment": env } = byId(
    report({ approverLogins: ["a;rm -rf /"], current: { environment: null } }),
  );
  assert.equal(env.command, null, "an unparseable login is reported, not pasted into a subshell");
  assert.match(env.why, /unresolved/);
});

// --- printed commands must actually paste -----------------------------------

test("shellQuote: leaves plain values bare and quotes anything the shell would read", () => {
  assert.equal(shellQuote("/repos/o/r/branches/main/protection"), "/repos/o/r/branches/main/protection");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote("$(x)"), "'$(x)'");
});

test("renderCommand: a body with no substitution uses a quoted heredoc", () => {
  const command = renderCommand({ method: "PUT", path: "/x", body: { a: 1 } });
  assert.match(command, /<<'JSON'\n/, "nothing to expand, so nothing is left expandable");
  assert.ok(command.endsWith("\nJSON"));
});

test("renderCommand: a branch name the shell would mangle is quoted", () => {
  const command = renderCommand({ method: "PUT", path: "/repos/o/r/branches/re lease/protection", body: {} });
  assert.match(command, /'\/repos\/o\/r\/branches\/re lease\/protection'/);
});

test("renderCommand: the heredoc terminator is flush-left in the rendered summary", () => {
  const entries = report({ current: { access: null, protection: null, environment: null } });
  const out = renderSummary({ created: [], present: [], remaining: [], settings: entries });
  const terminators = out.split("\n").filter((l) => l.trimEnd() === "JSON");
  assert.ok(terminators.length >= 3, "one terminator per printed command");
  assert.ok(terminators.every((l) => l === "JSON"), "an indented terminator would not terminate the heredoc");
});

test("the printed environment command parses in a real shell and resolves the reviewer id", () => {
  const { "release-environment": env } = byId(
    report({ approverLogins: ["yuchida-tamu"], current: { environment: null } }),
  );
  assert.match(env.command, /\$\(gh api \/users\/yuchida-tamu --jq \.id\)/, "self-contained, no <ID> to fill in");

  // `gh` is shimmed: the /users lookup answers 4242, the PUT dumps its argv and
  // body. Nothing leaves the process — this proves quoting, not connectivity.
  const script = [
    "gh() {",
    '  if [ "$2" = "/users/yuchida-tamu" ]; then printf %s 4242; return 0; fi',
    '  for a in "$@"; do printf "ARG[%s]\\n" "$a"; done',
    "  printf 'BODY\\n'; cat",
    "}",
    env.command,
  ].join("\n");
  const out = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });

  const args = [...out.matchAll(/^ARG\[(.*)\]$/gm)].map((m) => m[1]);
  assert.deepEqual(args, [
    "api", "--method", "PUT", `/repos/${REPO}/environments/release`, "--input", "-",
  ], "every argument arrives as one word — the command genuinely pastes");
  const body = JSON.parse(out.slice(out.indexOf("\nBODY\n") + 6));
  assert.deepEqual(body.reviewers, [{ type: "User", id: 4242 }], "the substitution resolved to a number");
});

test("the printed protection command parses in a real shell with its JSON body intact", () => {
  const { "branch-protection": prot } = byId(
    report({ requiredChecks: ["ci"], current: { protection: null } }),
  );
  const script = [
    'gh() { for a in "$@"; do printf "ARG[%s]\\n" "$a"; done; printf "BODY\\n"; cat; }',
    prot.command,
  ].join("\n");
  const out = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });
  const args = [...out.matchAll(/^ARG\[(.*)\]$/gm)].map((m) => m[1]);
  assert.deepEqual(args, [
    "api", "--method", "PUT", `/repos/${REPO}/branches/main/protection`, "--input", "-",
  ]);
  const body = JSON.parse(out.slice(out.indexOf("\nBODY\n") + 6));
  assert.deepEqual(body.required_status_checks, { strict: true, contexts: ["ci"] });
});

// --- the report inside the summary ------------------------------------------

test("renderSummary: non-satisfied settings appear in `remaining` and print below it", () => {
  const settings = report({ current: { access: null, protection: null, environment: null } });
  const out = renderSummary({
    created: [],
    present: [],
    remaining: remainingItems({ config: { platform: "web", approvers: ["yuchida-tamu"] }, domains: { a: {} }, settings }),
    settings,
  });
  assert.match(out, /remaining \(3\)/);
  assert.ok(out.indexOf("remaining (3)") < out.indexOf("repo settings — detected, never applied"));
  assert.match(out, /adopt changes nothing here/);
});

test("renderSummary: a fully satisfied repo prints the section with no commands", () => {
  const settings = report({
    current: {
      access: { access_level: "user" },
      protection: protectionGet(),
      environment: environmentGet([["yuchida-tamu", 4242]]),
    },
  });
  const out = renderSummary({ created: [], present: [], remaining: [], settings });
  assert.doesNotMatch(out, /gh api --method PUT/, "nothing to run means nothing printed to run");
  assert.match(out, /branch-protection · satisfied/);
});

// --- the decision this issue encodes ----------------------------------------

test("adopt has no apply path: neither module offers one, under any flag", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of ["../init/adopt.js", "../init/cli.js"]) {
    const source = readFileSync(join(here, file), "utf8");
    assert.doesNotMatch(source, /--apply/, `${file} must not reintroduce --apply`);
  }
  // The only `gh api` the CLI runs is a read. A --method anywhere near it would
  // mean adopt had grown the executor this issue deliberately does not have.
  const cli = readFileSync(join(here, "../init/cli.js"), "utf8");
  const invocations = [...cli.matchAll(/execFileSync\("gh",\s*\[([^\]]*)\]/g)].map((m) => m[1]);
  assert.ok(invocations.length > 0, "the CLI does call gh");
  for (const args of invocations) {
    assert.doesNotMatch(args, /--method/, `adopt never issues a mutating gh api call: ${args}`);
  }
});

// --- coverage ---------------------------------------------------------------

const map = {
  checkout: { criticality: "critical", paths: ["src/checkout/**"] },
  ui: { criticality: "low", paths: ["src/ui/**", "*.css"] },
};

const mapped = [
  "src/checkout/cart.ts",
  "src/checkout/pay.ts",
  "src/checkout/total.ts",
  "src/ui/Button.tsx",
  "src/ui/Modal.tsx",
  "src/ui/Text.tsx",
  "main.css",
];

test("coverage: every tracked file mapped → nothing unmapped, nothing to warn about", () => {
  const report = coverage(map, mapped, { warnFraction: DEFAULT_WARN_FRACTION });
  assert.equal(report.total, 7);
  assert.equal(report.mapped, 7);
  assert.equal(report.unmapped, 0);
  assert.equal(report.unmapped_fraction, 0);
  assert.equal(report.warn, false);
  assert.deepEqual(report.unmapped_files, []);
  assert.deepEqual(report.top_unmapped_dirs, []);
  assert.deepEqual(report.domains, [
    { name: "checkout", criticality: "critical", files: 3 },
    { name: "ui", criticality: "low", files: 4 },
  ]);
});

test("coverage: the template stub maps nothing → every file unmapped", () => {
  // `domains.yml` fresh from `agentflow-init` is comments only, so `yaml`
  // parses it to null — the exact value the CLI hands in for an unadopted map.
  const report = coverage(null, mapped, { warnFraction: DEFAULT_WARN_FRACTION });
  assert.equal(report.mapped, 0);
  assert.equal(report.unmapped, 7);
  assert.equal(report.unmapped_fraction, 1);
  assert.equal(report.warn, true);
  assert.deepEqual(report.domains, []);
  assert.deepEqual(report.top_unmapped_dirs, [
    { dir: "src/checkout", count: 3 },
    { dir: "src/ui", count: 3 },
    { dir: ".", count: 1 },
  ]);
});

test("coverage: partial, above the configured threshold → warn", () => {
  const files = [...mapped, "scripts/deploy.sh", "scripts/build.sh", "README.md"];
  const report = coverage(map, files, { warnFraction: 0.2 });
  assert.equal(report.total, 10);
  assert.equal(report.mapped, 7);
  assert.equal(report.unmapped_fraction, 0.3);
  assert.equal(report.warn, true);
  assert.deepEqual(report.unmapped_files, ["scripts/deploy.sh", "scripts/build.sh", "README.md"]);
  assert.deepEqual(report.top_unmapped_dirs, [
    { dir: "scripts", count: 2 },
    { dir: ".", count: 1 },
  ]);
});

test("coverage: partial, below the configured threshold → no warn", () => {
  const files = [...mapped, "src/checkout/tax.ts", "src/ui/Card.tsx", "scripts/deploy.sh"];
  const report = coverage(map, files, { warnFraction: 0.2 });
  assert.equal(report.total, 10);
  assert.equal(report.unmapped, 1);
  assert.equal(report.unmapped_fraction, 0.1);
  assert.equal(report.warn, false);
});

test("coverage: exactly at the threshold is inside the budget the repo set", () => {
  const files = ["src/ui/A.tsx", "src/ui/B.tsx", "src/ui/C.tsx", "src/ui/D.tsx", "scripts/x.sh"];
  const report = coverage(map, files, { warnFraction: 0.2 });
  assert.equal(report.unmapped_fraction, 0.2);
  assert.equal(report.warn, false, "strictly above, so 20% of 20% is not over budget");
});

test("coverage: no configured threshold never warns, however bad the number is", () => {
  const report = coverage(null, mapped);
  assert.equal(report.unmapped_fraction, 1);
  assert.equal(report.warn_fraction, null);
  assert.equal(report.warn, false);
});

test("coverage: an empty repo is 0% unmapped, not NaN", () => {
  const report = coverage(map, [], { warnFraction: 0 });
  assert.equal(report.total, 0);
  assert.equal(report.unmapped_fraction, 0);
  assert.equal(report.warn, false);
});

test("coverage: overlapping domains both claim the file; a dead domain reports 0", () => {
  const overlapping = {
    ...map,
    payments: { criticality: "high", paths: ["src/checkout/pay.ts"] },
    legacy: { criticality: "medium", paths: ["app/legacy/**"] },
  };
  const report = coverage(overlapping, ["src/checkout/pay.ts"], { warnFraction: 0.2 });
  assert.equal(report.unmapped, 0, "a file counted twice is still one file");
  assert.equal(report.total, 1);
  assert.deepEqual(report.domains, [
    { name: "checkout", criticality: "critical", files: 1 },
    { name: "payments", criticality: "high", files: 1 },
    { name: "legacy", criticality: "medium", files: 0 },
    { name: "ui", criticality: "low", files: 0 },
  ]);
});

test("coverage: a domain with no criticality gets the engine's own default", () => {
  const report = coverage({ odd: { paths: ["src/**"] } }, ["src/a.ts"], { warnFraction: 0.2 });
  assert.deepEqual(report.domains, [{ name: "odd", criticality: "medium", files: 1 }]);
});

// The one number that must not drift: `--coverage` is repo-scoped and
// `domainFacts()` is diff-scoped, but over the same file list they are the same
// question, and they answer it with the same glob compiler.
test("coverage: agrees file-for-file with the risk engine's unmapped_fraction", () => {
  const files = [...mapped, "scripts/deploy.sh", "scripts/build.sh", "README.md"];
  assert.equal(coverage(map, files).unmapped_fraction, domainFacts(map, files).unmapped_fraction);
  assert.equal(coverage(map, files).unmapped_fraction, 0.3, "and it is the number both mean");
});

test("isTrackedSource: keeps what humans author, drops what they never assign criticality to", () => {
  for (const path of ["src/a.ts", "README.md", "policies/business.yml", "package.json", "bin/run.sh"]) {
    assert.equal(isTrackedSource(path), true, path);
  }
  for (const path of [
    "node_modules/left-pad/index.js",
    "ios/Pods/Firebase/x.m",
    "dist/bundle.js",
    "coverage/lcov-report/index.html",
    "package-lock.json",
    "ios/Podfile.lock",
    "assets/logo.png",
    "assets/Inter.woff2",
    "test/__snapshots__/a.js.snap",
  ]) {
    assert.equal(isTrackedSource(path), false, path);
  }
});

test("trackedSourceFiles: filters a `git ls-files` listing and drops empty entries", () => {
  const listed = ["src/a.ts", "", "node_modules/x/index.js", "docs/guide.md", "yarn.lock"];
  assert.deepEqual(trackedSourceFiles(listed), ["src/a.ts", "docs/guide.md"]);
  assert.deepEqual(trackedSourceFiles(undefined), []);
});

test("renderCoverage: over budget names the threshold and the catch-all criticality", () => {
  const files = [...mapped, "scripts/deploy.sh", "scripts/build.sh", "README.md"];
  const out = renderCoverage(coverage(map, files, { warnFraction: 0.2 }), {
    unmappedCriticality: "high",
  });
  assert.match(out, /coverage — 10 tracked source file\(s\), 3 unmapped \(30\.0%\)/);
  assert.match(out, /! 30\.0% exceeds unmapped_warn_fraction 20\.0%/);
  assert.match(out, /catch-all domain at criticality "high"/);
  assert.match(out, /^ {4}2 {2}scripts$/m);
  assert.match(out, /^ {4}3 {2}checkout \(critical\)$/m);
});

test("renderCoverage: within budget says nothing about a threshold", () => {
  const out = renderCoverage(coverage(map, mapped, { warnFraction: 0.2 }));
  assert.doesNotMatch(out, /exceeds/);
  assert.doesNotMatch(out, /top unmapped directories/);
  assert.match(out, /coverage — 7 tracked source file\(s\), 0 unmapped \(0\.0%\)/);
});

test("renderCoverage: an unmapped repo is told its map is still the stub", () => {
  const out = renderCoverage(coverage(null, mapped, { warnFraction: 0.2 }));
  assert.match(out, /domains\.yml maps nothing — it is still the template stub/);
  assert.doesNotMatch(out, /mapped by domain/);
});

test("DEFAULT_WARN_FRACTION is the value the config template actually ships", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const template = JSON.parse(
    readFileSync(join(here, "../init/templates/agentflow.config.json"), "utf8"),
  );
  assert.equal(DEFAULT_WARN_FRACTION, template.unmapped_warn_fraction);
});
