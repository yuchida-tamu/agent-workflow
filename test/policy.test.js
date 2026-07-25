import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  evaluate,
  evalCondition,
  globToRegExp,
  runPackTests,
  validatePack,
} from "../scripts/policy/engine.js";

const baseline = parseYaml(
  readFileSync(fileURLToPath(new URL("../policies/baseline.yaml", import.meta.url)), "utf8")
);

test("baseline pack is valid", () => {
  assert.deepEqual(validatePack(baseline), []);
});

test("baseline pack fixture tests all pass", () => {
  const results = runPackTests([baseline], baseline);
  assert.equal(results.length, baseline.tests.length);
  for (const r of results) assert.ok(r.ok, `${r.name}: ${r.failures.join("; ")}`);
});

test("glob matching handles ** and *", () => {
  assert.ok(globToRegExp(".github/workflows/**").test(".github/workflows/a/b.yml"));
  assert.ok(globToRegExp("ios/**").test("ios/Podfile"));
  assert.ok(globToRegExp("app.config.*").test("app.config.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/nested/a.ts"));
  assert.ok(globToRegExp("**/*.test.js").test("a.test.js"), "** matches zero directories");
});

test("conditions: combinators and operators", () => {
  const facts = { diff: { loc: 500, files: ["src/a.ts"] }, meta: { stage: "pr" } };
  assert.ok(evalCondition({ fact: "diff.loc", gte: 300, lte: 799 }, facts));
  assert.ok(evalCondition({ not: { fact: "diff.loc", gte: 800 } }, facts));
  assert.ok(evalCondition({ any: [{ fact: "diff.loc", gte: 800 }, { fact: "meta.stage", is: "pr" }] }, facts));
  assert.ok(evalCondition({ fact: "missing.path", exists: false }, facts));
  assert.ok(!evalCondition({ fact: "missing.path", gte: 1 }, facts), "missing fact never satisfies gte");
});

test("obligations union monotonically across packs", () => {
  const packA = {
    pack: "a",
    rules: [{ id: "r1", when: { fact: "x", is: 1 }, then: { require: ["G2"], score: 2 } }],
  };
  const packB = {
    pack: "b",
    rules: [{ id: "r2", when: { fact: "x", is: 1 }, then: { require: ["G2", "human-merge"], block: ["auto-merge"] } }],
  };
  const verdict = evaluate([packA, packB], { x: 1 });
  assert.deepEqual(verdict.obligations.require, ["G2", "human-merge"]);
  assert.deepEqual(verdict.obligations.block, ["auto-merge"]);
  assert.equal(verdict.obligations.score, 2);
});

test("locked rules cannot be disabled; unlocked ones can", () => {
  const base = {
    pack: "base",
    rules: [
      { id: "guard", locked: true, when: { fact: "x", is: 1 }, then: { floor: "high" } },
      { id: "soft", when: { fact: "x", is: 1 }, then: { score: 3 } },
    ],
  };
  const project = { pack: "proj", rules: [], disable: ["guard", "soft"] };
  const verdict = evaluate([base, project], { x: 1 });
  assert.equal(verdict.level, "high", "locked rule still applied");
  assert.equal(verdict.obligations.score, 0, "unlocked rule disabled");
  assert.equal(verdict.warnings.length, 1);
  assert.match(verdict.warnings[0], /locked rule "guard"/);
});

test("floor overrides a lower score level, never lowers a higher one", () => {
  const mk = (floor, score) => ({
    pack: "p",
    rules: [{ id: "r", then: { floor, score } }],
  });
  assert.equal(evaluate([mk("high", 0)], {}).level, "high");
  assert.equal(evaluate([mk("low", 9)], {}).level, "high");
});

test("level obligations apply from config", () => {
  const pack = { pack: "p", rules: [{ id: "r", then: { score: 5 } }] };
  const verdict = evaluate([pack], {});
  assert.equal(verdict.level, "medium");
  assert.deepEqual(verdict.obligations.require, ["human-merge"]);
});

test("stage filtering", () => {
  const pack = {
    pack: "p",
    rules: [
      { id: "pr-only", stage: "pr", then: { score: 1 } },
      { id: "plan-only", stage: "plan", then: { score: 10 } },
    ],
  };
  const verdict = evaluate([pack], { meta: { stage: "pr" } });
  assert.equal(verdict.obligations.score, 1);
});

test("validatePack rejects malformed rules", () => {
  const errors = validatePack({
    pack: "bad",
    rules: [
      { id: "a", then: { explode: true } },
      { id: "a", when: { fact: "x" }, then: { score: "3" } },
      { when: { all: [] }, then: {} },
    ],
  });
  assert.ok(errors.some((e) => e.includes('unknown obligation "explode"')));
  assert.ok(errors.some((e) => e.includes("duplicate id")));
  assert.ok(errors.some((e) => e.includes("needs at least one operator")));
  assert.ok(errors.some((e) => e.includes("score: must be a number")));
  assert.ok(errors.some((e) => e.includes("must be a non-empty array")));
  assert.ok(errors.some((e) => e.includes("missing id")));
});
