import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAutoMerge, renderRecord, MARKER } from "../scripts/actions/auto-merge.js";

const sha = "09d673d1a2b3c4d5e6f70819";
const clean = { level: "low", require: [], block: [], matched: [], sha };
const base = { verdict: clean, headSha: sha, checksPassing: true };

test("a clean verdict on a green PR merges", () => {
  const d = decideAutoMerge(base);
  assert.equal(d.merge, true);
  assert.match(d.reason, /no obligation requiring a human/);
});

test("every refusal names itself", () => {
  const cases = [
    [{ ...base, draft: true }, /draft/],
    [{ ...base, mergeable: false }, /not mergeable/],
    [{ ...base, checksPassing: false }, /CI is not green/],
    [{ ...base, verdict: null }, /no risk verdict/],
    [{ ...base, verdict: { ...clean, sha: null } }, /records no SHA/],
    [{ ...base, verdict: { ...clean, require: ["human-merge"] } }, /requires a human merge/],
    [{ ...base, verdict: { ...clean, block: ["auto-merge"] } }, /requires a human merge/],
    [{ ...base, headSha: "deadbeef1234" }, /does not describe this head/],
  ];
  for (const [input, pattern] of cases) {
    const d = decideAutoMerge(input);
    assert.equal(d.merge, false, JSON.stringify(input.verdict));
    assert.match(d.reason, pattern);
  }
});

test("CI with no checks at all is not treated as green", () => {
  // `checksPassing` is computed by the caller, but the decision must refuse a
  // false value rather than treat absence of failure as success.
  assert.equal(decideAutoMerge({ ...base, checksPassing: false }).merge, false);
});

test("a verdict requiring G2 but not human-merge still merges", () => {
  // G2 is a plan-stage obligation. It has no bearing on whether a merged diff
  // needs a human — conflating them would block every plan-gated feature's PRs.
  const d = decideAutoMerge({ ...base, verdict: { ...clean, require: ["G2"] } });
  assert.equal(d.merge, true);
});

test("a stale verdict never merges, however clean it looks", () => {
  const stale = { ...clean, sha: "aaaaaaaaaaaa" };
  assert.equal(decideAutoMerge({ ...base, verdict: stale }).merge, false);
});

test("the most permissive fabricated verdict still cannot merge without a SHA", () => {
  const fabricated = { level: "low", require: [], block: [], matched: [], sha: null };
  assert.equal(decideAutoMerge({ ...base, verdict: fabricated }).merge, false);
});

// --- the record --------------------------------------------------------------

test("the record names the verdict, its obligations, and the exact head", () => {
  const body = renderRecord({
    verdict: { ...clean, matched: [{ pack: "baseline", rule: "medium-diff" }] },
    headSha: sha,
  });
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /G3 auto-merged/);
  assert.match(body, /`low`/);
  assert.match(body, /baseline\/medium-diff/);
  assert.match(body, new RegExp(sha));
});

test("the record says what would have stopped it", () => {
  // In solo mode this comment replaces the human's SHA-naming /approve — so it
  // has to carry the same information a reader would have gone looking for.
  const body = renderRecord({ verdict: clean, headSha: sha });
  assert.match(body, /human-merge/);
  assert.match(body, /different SHA|absent/);
  assert.match(body, /would have waited for a person/);
});

test("a record is distinguishable from a human approval", () => {
  const body = renderRecord({ verdict: clean, headSha: sha });
  assert.ok(body.startsWith(MARKER), "its own marker, not the /approve grammar");
  assert.doesNotMatch(body, /^\/approve/m, "must never look like a human's artifact");
});
