import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOSING_KEYWORDS, linkedIssues } from "../scripts/actions/post-merge.js";

// The full set GitHub itself acts on. If this list ever drifts, every test
// below drifts with it — that's the point of deriving the regex from it.
test("the keyword list is GitHub's full nine, no more, no less", () => {
  assert.deepEqual(
    [...CLOSING_KEYWORDS].sort(),
    ["close", "closed", "closes", "fix", "fixed", "fixes", "resolve", "resolved", "resolves"].sort()
  );
});

// One test per keyword (#119) — each of the nine forms GitHub recognizes must
// be matched, case-insensitively, on its own.
for (const keyword of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) {
  test(`"${keyword} #12" links issue 12`, () => {
    assert.deepEqual(linkedIssues(`${keyword} #12`), [12]);
  });

  test(`"${keyword} #12" links issue 12 case-insensitively`, () => {
    const shouted = keyword.toUpperCase();
    assert.deepEqual(linkedIssues(`${shouted} #12`), [12]);
  });
}

test("multiple keywords in one body link every issue, deduplicated", () => {
  const body = "Fix #1\n\nAlso closes #2 and this Resolved #1 as well.";
  assert.deepEqual(linkedIssues(body).sort(), [1, 2]);
});

test("keywords are matched inside a longer PR body", () => {
  const body = "## Summary\n\nThis change closes #42 by reworking the parser.\n\nfixed #7";
  assert.deepEqual(linkedIssues(body).sort((a, b) => a - b), [7, 42]);
});

// --- negatives ----------------------------------------------------------------

test("a bare '#N' mention with no keyword does not count", () => {
  assert.deepEqual(linkedIssues("See #12 for background."), []);
});

test("a keyword embedded inside a longer word does not fire", () => {
  // "prefix #12" contains "fix" but is not the word "fix" — the \b boundary
  // before the keyword must exclude it.
  assert.deepEqual(linkedIssues("prefix #12"), []);
  assert.deepEqual(linkedIssues("this closest #12"), []);
  assert.deepEqual(linkedIssues("refixes #12"), []);
});

test("a missing PR body links nothing rather than throwing", () => {
  assert.deepEqual(linkedIssues(null), []);
  assert.deepEqual(linkedIssues(undefined), []);
  assert.deepEqual(linkedIssues(""), []);
});
