import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKER, parseVerdict, latestVerdict, authorises } from "../scripts/verdict/core.js";

// Exactly the shape scripts/actions/pr-verdict.js renders.
const comment = ({ level = "low", requires = "—", blocks = "—", runs = "—", matched = "", sha = null } = {}) =>
  `${MARKER}
### agentflow risk verdict: \`${level}\` (score 2)

| requires | blocks | runs |
|---|---|---|
| ${requires} | ${blocks} | ${runs} |
${sha ? `\nverdict-sha: ${sha}\n` : ""}
${matched ? `<details><summary>1 rule(s) matched</summary>\n\n| pack | rule | obligations |\n|---|---|---|\n${matched}\n\n</details>` : "No rules matched."}`;

test("a clean low verdict parses", () => {
  const v = parseVerdict(comment());
  assert.equal(v.level, "low");
  assert.deepEqual(v.require, []);
  assert.deepEqual(v.block, []);
});

test("obligations parse out of the table", () => {
  const v = parseVerdict(comment({ level: "high", requires: "G2, human-merge", blocks: "auto-merge" }));
  assert.equal(v.level, "high");
  assert.deepEqual(v.require, ["G2", "human-merge"]);
  assert.deepEqual(v.block, ["auto-merge"]);
});

test("matched rules parse with their pack and rule ids", () => {
  const v = parseVerdict(comment({ matched: "| `baseline` | `self-mod-guard` | floor, require |" }));
  assert.deepEqual(v.matched, [{ pack: "baseline", rule: "self-mod-guard" }]);
});

// --- absence is refusal ------------------------------------------------------

test("a body that is not a verdict yields nothing", () => {
  for (const body of ["", null, undefined, "just a comment", "## Plan\nsomething"]) {
    assert.equal(parseVerdict(body), null, JSON.stringify(body));
  }
});

test("a marker with no obligations table yields nothing, not a partial verdict", () => {
  const truncated = `${MARKER}\n### agentflow risk verdict: \`low\` (score 0)\n`;
  assert.equal(parseVerdict(truncated), null);
});

test("a verdict with an unrecognised level yields nothing", () => {
  assert.equal(parseVerdict(comment({ level: "spicy" })), null);
});

test("a table whose row is missing yields nothing", () => {
  const noRow = `${MARKER}\n### agentflow risk verdict: \`low\` (score 0)\n\n| requires | blocks | runs |\n|---|---|---|\n`;
  assert.equal(parseVerdict(noRow), null);
});

test("every malformed shape refuses rather than guessing", () => {
  const shapes = [
    `${MARKER}`,
    `${MARKER}\ngarbage`,
    `${MARKER}\n### agentflow risk verdict: \`\` (score 0)\n\n| requires |\n|---|\n| — |`,
  ];
  for (const body of shapes) assert.equal(authorises("G2", parseVerdict(body)), false);
});

test("the most recent verdict wins, deterministically", () => {
  const v = latestVerdict([
    { body: comment({ level: "high", requires: "G2" }) },
    { body: "chatter" },
    { body: comment({ level: "low" }) },
  ]);
  assert.equal(v.level, "low");
  assert.deepEqual(v.require, []);
});

test("no verdict comments at all yields nothing", () => {
  assert.equal(latestVerdict([{ body: "hi" }]), null);
  assert.equal(latestVerdict([]), null);
  assert.equal(latestVerdict(undefined), null);
});

// --- authorisation -----------------------------------------------------------

test("G2 is authorised only when the engine did not require it", () => {
  assert.equal(authorises("G2", parseVerdict(comment())), true);
  assert.equal(authorises("G2", parseVerdict(comment({ requires: "G2, human-merge" }))), false);
});

test("a null verdict authorises nothing", () => {
  for (const gate of ["G1", "G2", "G3", "G4"]) {
    assert.equal(authorises(gate, null), false, gate);
  }
});

test("G1 and G4 are never auto-crossable", () => {
  const clean = parseVerdict(comment());
  assert.equal(authorises("G1", clean), false);
  assert.equal(authorises("G4", clean), false);
});

test("G3 needs no human-merge, no auto-merge block, and a matching SHA", () => {
  const sha = "abc1234def5678";
  assert.equal(authorises("G3", parseVerdict(comment({ sha })), { headSha: sha }), true);
  assert.equal(
    authorises("G3", parseVerdict(comment({ sha, requires: "human-merge" })), { headSha: sha }),
    false
  );
  assert.equal(
    authorises("G3", parseVerdict(comment({ sha, blocks: "auto-merge" })), { headSha: sha }),
    false
  );
});

test("a verdict about a different SHA does not authorise a merge", () => {
  const v = parseVerdict(comment({ sha: "aaaaaaa" }));
  assert.equal(authorises("G3", v, { headSha: "bbbbbbb" }), false);
});

test("a verdict with no recorded SHA never authorises a merge", () => {
  // pr-verdict.js does not stamp the SHA today. Until it does, G3 cannot be
  // auto-crossed — which is the correct failure direction.
  const v = parseVerdict(comment());
  assert.equal(v.sha, null);
  assert.equal(authorises("G3", v, { headSha: "abc1234" }), false);
});

test("a short SHA prefix matches its full head", () => {
  const v = parseVerdict(comment({ sha: "abc1234" }));
  assert.equal(authorises("G3", v, { headSha: "abc1234def5678901234" }), true);
});

test("obligations decide, not the claimed level", () => {
  // A caller cannot talk their way past a gate by presenting a low level: the
  // decision reads the obligations the engine emitted, and a verdict that says
  // `low` while requiring G2 is still refused.
  assert.equal(authorises("G2", { level: "high", require: [], block: [] }), true);
  assert.equal(authorises("G2", { level: "low", require: ["G2"], block: [] }), false);
});

test("a fabricated verdict cannot authorise a merge without a SHA to check", () => {
  // The closest thing to an attack: hand-build the most permissive verdict
  // possible. It still fails, because G3 additionally demands that the verdict
  // demonstrably describes the code being merged.
  const fabricated = { level: "low", require: [], block: [], matched: [], sha: null };
  assert.equal(authorises("G3", fabricated, { headSha: "abc1234" }), false);
});

// --- the G2 auto-pass decision, end to end -----------------------------------

test("the exact verdict shapes this repo produces decide G2 correctly", () => {
  // Drawn from real comments: a low verdict with no obligations auto-passes; a
  // self-mod-guard verdict does not; a medium human-merge verdict still passes
  // G2 because human-merge is a G3 obligation, not a G2 one.
  const cases = [
    { requires: "—", expect: true },
    { requires: "G2, human-merge", expect: false },
    { requires: "human-merge", expect: true },
    { requires: "G2", expect: false },
  ];
  for (const c of cases) {
    const v = parseVerdict(comment({ requires: c.requires }));
    assert.equal(authorises("G2", v), c.expect, `requires=[${c.requires}]`);
  }
});
