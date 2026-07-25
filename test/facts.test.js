import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assembleFacts,
  classifyChange,
  diffFacts,
  domainFacts,
  driftFacts,
  packageFacts,
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
