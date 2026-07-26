import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyReleased, VERIFY_NOT_APPLICABLE } from "../scripts/release/core.js";

test("an item labelled released with a matching tag is fine", () => {
  const r = verifyReleased({ items: [{ number: 3, version: "0.1.0" }], tags: ["v0.1.0"] });
  assert.equal(r.applicable, true);
  assert.deepEqual(r.findings, []);
});

test("an item labelled released with no tag is a finding", () => {
  // Exactly #3's state before the repair: the label existed, the release did not.
  const r = verifyReleased({ items: [{ number: 3, version: "0.1.0" }], tags: [] });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].number, 3);
  assert.equal(r.findings[0].expectedTag, "v0.1.0");
  assert.match(r.findings[0].reason, /no such tag/);
});

test("an unrelated tag does not satisfy the invariant", () => {
  const r = verifyReleased({ items: [{ number: 3, version: "0.2.0" }], tags: ["v0.1.0"] });
  assert.equal(r.findings.length, 1, "a tag existing is not enough — it must be the right one");
});

test("a version that cannot be resolved is itself a finding", () => {
  const r = verifyReleased({ items: [{ number: 9, version: null }], tags: ["v0.1.0"] });
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].reason, /no resolvable version/);
});

test("nothing labelled released means nothing to verify", () => {
  assert.deepEqual(verifyReleased({ items: [], tags: [] }).findings, []);
  assert.deepEqual(verifyReleased({}).findings, []);
});

test("verification is tag-specific and says so rather than inventing findings", () => {
  for (const releaseKind of ["store", "none"]) {
    const r = verifyReleased({ items: [{ number: 3, version: "0.1.0" }], tags: [], releaseKind });
    assert.equal(r.applicable, false, releaseKind);
    assert.equal(r.reason, VERIFY_NOT_APPLICABLE);
    assert.deepEqual(r.findings, [], "a store repo must not be told its tags are missing");
  }
});

test("many items report individually", () => {
  const r = verifyReleased({
    items: [{ number: 1, version: "0.1.0" }, { number: 2, version: "0.2.0" }, { number: 3, version: "0.3.0" }],
    tags: ["v0.2.0"],
  });
  assert.deepEqual(r.findings.map((f) => f.number), [1, 3]);
});
