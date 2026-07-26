import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE,
  parentFromText,
  childrenFromCandidates,
  resolveChildren,
  resolveParent,
  isUnavailable,
} from "../scripts/hierarchy/core.js";

// --- the API path ------------------------------------------------------------

test("linked sub-issues answer, carrying completion state", () => {
  const r = resolveChildren({
    api: [
      { number: 62, state: "open", title: "reader" },
      { number: 63, state: "closed", title: "consumers" },
    ],
    body: "irrelevant #999",
  });
  assert.equal(r.source, SOURCE.api);
  assert.deepEqual(r.children.map((c) => [c.number, c.closed]), [[62, false], [63, true]]);
});

const candidates = [
  { number: 24, body: "Child of #18 — see the plan", state: "CLOSED" },
  { number: 25, body: "Child of #18", state: "CLOSED" },
  { number: 62, body: "Child of #50", state: "OPEN" },
  { number: 99, body: "relates to #18 somehow", state: "OPEN" },
];

test("an empty relation is NOT authoritative during a forward-only migration", () => {
  // Found by running this against the real repo: #18 has four children created
  // before sub-issues existed, and its relation is empty. Treating [] as "no
  // children" made every pre-existing parent read as childless, which would stop
  // parent-close from ever closing one.
  const r = resolveChildren({ api: [], candidates, parentNumber: 18 });
  assert.equal(r.source, SOURCE.text);
  assert.deepEqual(r.children.map((c) => c.number), [24, 25]);
});

test("children are those that DECLARE the parent, not those the parent mentions", () => {
  // The reverse — scraping #N from a parent body — is what parent-close does
  // today, and it is wrong: #18 mentions #3, #1 and #2 while its children are
  // #24-#27. #99 below mentions #18 and is not its child.
  const r = resolveChildren({ api: [], candidates, parentNumber: 18 });
  assert.ok(!r.children.some((c) => c.number === 99), "a mention is not a declaration");
});

test("the fallback carries completion state, because candidates do", () => {
  const r = resolveChildren({ api: [], candidates, parentNumber: 18 });
  assert.deepEqual(r.children.map((c) => c.closed), [true, true]);
});

test("a genuinely childless parent reports none", () => {
  assert.deepEqual(resolveChildren({ api: [], candidates, parentNumber: 777 }).children, []);
});

test("a non-empty relation wins outright", () => {
  const r = resolveChildren({ api: [{ number: 62, state: "open" }], candidates, parentNumber: 18 });
  assert.equal(r.source, SOURCE.api);
  assert.deepEqual(r.children.map((c) => c.number), [62]);
});

test("a linked parent answers over any prose", () => {
  const r = resolveParent({ api: { number: 50 }, body: "Child of #999" });
  assert.equal(r.source, SOURCE.api);
  assert.equal(r.parent, 50);
});

// --- the text fallback -------------------------------------------------------

test("`Child of #N` is anchored — a mid-body mention is a reference, not a parent", () => {
  assert.equal(parentFromText("Child of #50 — see the plan"), 50);
  assert.equal(parentFromText("preamble\nChild of #50"), 50);
  assert.equal(parentFromText("this relates to #50 somehow"), null);
  assert.equal(parentFromText("see Child of #50 mentioned above"), null);
});

test("no signal at all yields no answer, never a guess", () => {
  assert.equal(parentFromText(""), null);
  assert.equal(parentFromText(null), null);
  assert.deepEqual(childrenFromCandidates([], 1), []);
  assert.deepEqual(childrenFromCandidates(undefined, 1), []);
  assert.deepEqual(resolveChildren({ api: null }).children, []);
  assert.equal(resolveParent({ api: null, body: null }).parent, null);
});

// --- unavailable vs broken ---------------------------------------------------

test("only 404 and 410 mean the feature is absent", () => {
  assert.equal(isUnavailable(404), true);
  assert.equal(isUnavailable(410), true);
  for (const status of [401, 403, 422, 500, 502, undefined, NaN]) {
    assert.equal(isUnavailable(status), false, String(status));
  }
});

test("every result names its source, so a repo on the fallback is visible", () => {
  const cases = [
    resolveChildren({ api: [], body: "" }),
    resolveChildren({ api: null, body: "" }),
    resolveParent({ api: { number: 1 }, body: "" }),
    resolveParent({ api: null, body: "" }),
  ];
  for (const r of cases) assert.ok([SOURCE.api, SOURCE.text].includes(r.source));
});
