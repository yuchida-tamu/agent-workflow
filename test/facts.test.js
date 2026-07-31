import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assembleFacts,
  classifyChange,
  diffFacts,
  domainFacts,
  driftFacts,
  packageFacts,
  rotWarning,
} from "../scripts/facts/core.js";

const DOMAINS = {
  checkout: { criticality: "critical", paths: ["src/features/checkout/**"] },
  onboarding: { criticality: "high", paths: ["src/features/onboarding/**"] },
  settings: { criticality: "low", paths: ["src/features/settings/**"] },
};

test("classifyChange", () => {
  assert.equal(classifyChange(["README.md", "docs/a.md"]), "docs");
  assert.equal(classifyChange(["src/a.test.ts", "__tests__/b.js"]), "tests");
  assert.equal(classifyChange(["src/a.ts", "README.md"]), "code");
});

test("diffFacts computes loc, tests/logic flags", () => {
  const facts = diffFacts({
    numstat: [
      { file: "src/a.ts", adds: 100, dels: 20 },
      { file: "src/a.test.ts", adds: 30, dels: 0 },
    ],
  });
  assert.equal(facts.loc, 150);
  assert.equal(facts.files_count, 2);
  assert.equal(facts.tests_changed, true);
  assert.equal(facts.logic_changed, true);
});

test("packageFacts detects new deps and sdk bumps", () => {
  const facts = packageFacts(
    { dependencies: { expo: "51.0.0", left: "1.0.0" } },
    { dependencies: { expo: "52.0.0", left: "1.0.0", zustand: "4.0.0" } }
  );
  assert.deepEqual(facts.new_dependencies, ["zustand"]);
  assert.equal(facts.new_dependency_count, 1);
  assert.equal(facts.sdk_bump, true);
});

test("domainFacts maps files to domains and tracks unmapped", () => {
  const facts = domainFacts(DOMAINS, [
    "src/features/checkout/Pay.tsx",
    "src/features/settings/Theme.tsx",
    "src/lib/util.ts",
    "src/lib/http.ts",
  ]);
  assert.deepEqual(facts.touched, ["checkout", "settings"]);
  assert.equal(facts.max_criticality, "critical");
  assert.equal(facts.unmapped_fraction, 0.5);
});

test("driftFacts: scope drift against declared plan globs", () => {
  const drift = driftFacts({
    planFiles: ["src/features/checkout/**"],
    diffFiles: ["src/features/checkout/Pay.tsx", "src/lib/http.ts"],
  });
  assert.equal(drift.scope, true);
  const clean = driftFacts({
    planFiles: ["src/features/checkout/**"],
    diffFiles: ["src/features/checkout/Pay.tsx"],
  });
  assert.equal(clean.scope, false);
});

test("driftFacts: undeclared high-criticality domain contradicts the brief", () => {
  const drift = driftFacts({
    brief: { impact_domains: ["settings"] },
    domains: DOMAINS,
    domainsTouched: ["checkout", "settings"],
  });
  assert.equal(drift.brief_domain, true);
  const honest = driftFacts({
    brief: { impact_domains: ["checkout"] },
    domains: DOMAINS,
    domainsTouched: ["checkout"],
  });
  assert.equal(honest.brief_domain, false);
});

test("assembleFacts produces the full namespace layout", () => {
  const facts = assembleFacts({
    stage: "pr",
    numstat: [{ file: "src/features/checkout/Pay.tsx", adds: 10, dels: 2 }],
    domains: DOMAINS,
    planFiles: ["src/features/checkout/**"],
    brief: { impact_domains: ["checkout"] },
  });
  assert.equal(facts.meta.stage, "pr");
  assert.deepEqual(facts.domains.touched, ["checkout"]);
  assert.equal(facts.drift.scope, false);
  assert.equal(facts.drift.brief_domain, false);
  assert.deepEqual(facts.plan.files, ["src/features/checkout/**"]);
});

// --- the integration PR's diff range is load-bearing --------------------------
//
// `scripts/actions/pr-verdict.js` extracts facts over `base.sha...head.sha` —
// three dots, i.e. `merge-base(base, head)..head`. On an integration branch
// carrying a stack of child merges, that is what makes the verdict see the
// whole stack rather than only the final merge commit. Nothing recorded that
// the third dot mattered, so a plausible "simplification" to two dots would
// quietly under-report risk at G3. This is the test that forbids it.

function buildStackedRepo() {
  const dir = mkdtempSync(join(tmpdir(), "agentflow-range-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const commit = (file, message) => {
    writeFileSync(join(dir, file), `${file}\n`);
    git("add", file);
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", message);
  };

  git("init", "-q", "-b", "main");
  commit("base.txt", "base");

  // Two dependent children, each merged into the integration branch.
  git("checkout", "-q", "-b", "integrate/stack");
  git("checkout", "-q", "-b", "child-one");
  commit("one.txt", "child one");
  git("checkout", "-q", "integrate/stack");
  git("-c", "user.email=t@t", "-c", "user.name=t", "merge", "--no-ff", "-q", "child-one", "-m", "merge child one");

  git("checkout", "-q", "-b", "child-two");
  commit("two.txt", "child two");
  git("checkout", "-q", "integrate/stack");
  git("-c", "user.email=t@t", "-c", "user.name=t", "merge", "--no-ff", "-q", "child-two", "-m", "merge child two");

  const filesIn = (...range) =>
    git("diff", "--name-only", ...range).split("\n").filter(Boolean).sort();
  return { dir, filesIn };
}

test("three-dot range sees the whole stack; the final merge commit alone does not", () => {
  const { dir, filesIn } = buildStackedRepo();
  try {
    const threeDot = filesIn("main...integrate/stack");
    const lastMergeOnly = filesIn("integrate/stack^1", "integrate/stack");

    assert.deepEqual(threeDot, ["one.txt", "two.txt"], "three-dot must see every file in the stack");
    assert.ok(
      !lastMergeOnly.includes("one.txt"),
      "the final merge commit alone misses the earlier child — which is the under-report this guards"
    );
    assert.ok(threeDot.length > lastMergeOnly.length, "the ranges must genuinely differ, or this test proves nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("facts extracted over the three-dot range cover the whole stack", () => {
  const { dir, filesIn } = buildStackedRepo();
  try {
    const numstat = filesIn("main...integrate/stack").map((file) => ({ file, adds: 1, dels: 0 }));
    const facts = assembleFacts({ stage: "pr", numstat, domains: null });
    assert.equal(facts.diff.files_count, 2, "a stacked integration PR must be scored on its full diff");
    assert.deepEqual(facts.diff.files.sort(), ["one.txt", "two.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- unmapped code contributes the configured default -------------------------

const MAP = {
  core: { criticality: "high", paths: ["scripts/facts/**"] },
  docs: { criticality: "low", paths: ["*.md"] },
};

test("unmapped files contribute unmapped_criticality", () => {
  // The config key existed since the template shipped and nothing read it, so
  // unmapped code scored as harmless. #34 added agentflow-release with 80% of
  // its diff unmapped and scored as a docs change.
  const f = domainFacts(MAP, ["scripts/release/cli.js", "README.md"], { unmappedCriticality: "medium" });
  assert.equal(f.max_criticality, "medium");
  assert.equal(f.unmapped_fraction, 0.5);
});

test("a mapped domain still wins when it is higher", () => {
  const f = domainFacts(MAP, ["scripts/facts/core.js", "scripts/release/cli.js"], { unmappedCriticality: "medium" });
  assert.equal(f.max_criticality, "high");
});

test("omitting the option preserves the previous behaviour exactly", () => {
  const f = domainFacts(MAP, ["scripts/release/cli.js"]);
  assert.equal(f.max_criticality, null, "no caller that skips config is affected");
});

test("a repo with no domain map is not given an invented criticality", () => {
  // Otherwise every file in a repo that never opted in would score `medium`.
  const f = domainFacts({}, ["anything.js"], { unmappedCriticality: "medium" });
  assert.equal(f.max_criticality, null);
  const g = domainFacts(null, ["anything.js"], { unmappedCriticality: "critical" });
  assert.equal(g.max_criticality, null);
});

test("fully mapped diffs are unaffected", () => {
  const f = domainFacts(MAP, ["scripts/facts/core.js"], { unmappedCriticality: "critical" });
  assert.equal(f.max_criticality, "high", "nothing unmapped, so the default never applies");
  assert.equal(f.unmapped_fraction, 0);
});

test("assembleFacts threads the configured value through", () => {
  const facts = assembleFacts({
    stage: "pr",
    numstat: [{ file: "scripts/release/cli.js", adds: 10, dels: 0 }],
    domains: MAP,
    unmappedCriticality: "medium",
  });
  assert.equal(facts.domains.max_criticality, "medium");
});

// --- rot warning: the diff-scoped counterpart to `adopt --coverage`'s budget --

test("no warning when there is no domains fact to have rotted", () => {
  // Mirrors domainFacts: a repo with no domains.yml has nothing to warn about.
  assert.equal(rotWarning(null, 0.2), null);
  assert.equal(rotWarning(undefined, 0.2), null);
});

test("no warning when the project never configured a budget", () => {
  assert.equal(rotWarning({ unmapped_fraction: 0.9 }, undefined), null);
  assert.equal(rotWarning({ unmapped_fraction: 0.9 }, null), null);
  // A stringly-typed config value (e.g. unvalidated YAML) is not a number.
  assert.equal(rotWarning({ unmapped_fraction: 0.9 }, "0.2"), null);
});

test("renders once the diff's unmapped share exceeds its budget", () => {
  const msg = rotWarning({ unmapped_fraction: 0.3 }, 0.2);
  assert.equal(msg, "⚠ 30.0% of this diff is unmapped by domains.yml (budget 20.0%) — the map may be rotting");
});

test("does not render exactly at the budget", () => {
  // Same boundary as adopt --coverage's `warn` flag: strictly greater than.
  assert.equal(rotWarning({ unmapped_fraction: 0.2 }, 0.2), null);
});

test("does not render below the budget", () => {
  assert.equal(rotWarning({ unmapped_fraction: 0.1 }, 0.2), null);
});

test("end to end: assembleFacts' domain fact feeds the warning directly", () => {
  const facts = assembleFacts({
    stage: "pr",
    numstat: [
      { file: "scripts/release/cli.js", adds: 1, dels: 0 },
      { file: "scripts/other/cli.js", adds: 1, dels: 0 },
      { file: "scripts/facts/core.js", adds: 1, dels: 0 },
    ],
    domains: MAP,
    unmappedCriticality: "medium",
  });
  assert.equal(facts.domains.unmapped_fraction, 2 / 3);
  assert.match(rotWarning(facts.domains, 0.2), /the map may be rotting/);
});
