import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, validateApproval, approvalTransitions } from "../scripts/gate/validator.js";

test("parseCommand finds the command anywhere in the body", () => {
  assert.deepEqual(parseCommand("looks good!\n/approve"), { command: "approve", gate: null });
  assert.deepEqual(parseCommand("/approve g2"), { command: "approve", gate: "G2" });
  assert.deepEqual(parseCommand("/reject needs a smaller scope"), {
    command: "reject",
    reason: "needs a smaller scope",
  });
  assert.equal(parseCommand("nice work"), null);
  assert.equal(parseCommand("/retest"), null);
  assert.equal(parseCommand("/approve G9").command, "invalid");
});

const base = { author: "alice", authorized: ["alice", "bob"], expectedGate: "G1" };

test("valid approval", () => {
  const v = validateApproval({ ...base, body: "/approve" });
  assert.deepEqual(v, { ok: true, gate: "G1", approver: "alice" });
});

test("unauthorized author is refused", () => {
  const v = validateApproval({ ...base, author: "mallory", body: "/approve" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not an authorized approver/);
});

test("author check is case-insensitive", () => {
  assert.ok(validateApproval({ ...base, author: "Alice", body: "/approve" }).ok);
});

test("gate mismatch is refused", () => {
  const v = validateApproval({ ...base, body: "/approve G3" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /approves G3.*pending gate is G1/);
});

test("rejection is not ok but is flagged", () => {
  const v = validateApproval({ ...base, body: "/reject too risky" });
  assert.equal(v.ok, false);
  assert.equal(v.rejected, true);
  assert.equal(v.reason, "too risky");
});

test("plain comment is not an approval", () => {
  assert.equal(validateApproval({ ...base, body: "ship it!" }).ok, false);
});

test("G4 is refused on a repo that never releases", () => {
  const v = validateApproval({ ...base, expectedGate: "G4", body: "/approve G4", releaseKind: "none" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /G4 does not apply.*release_kind is "none"/);
});

test("G4 is accepted on repos that do release", () => {
  for (const releaseKind of ["store", "tag", null]) {
    const v = validateApproval({ ...base, expectedGate: "G4", body: "/approve G4", releaseKind });
    assert.equal(v.ok, true, String(releaseKind));
  }
});

test("release_kind none does not touch the other gates", () => {
  for (const gate of ["G1", "G2", "G3"]) {
    const v = validateApproval({ ...base, expectedGate: gate, body: `/approve ${gate}`, releaseKind: "none" });
    assert.equal(v.ok, true, gate);
  }
});

// --- which gates transition on approval --------------------------------------

test("G1, G2 and G3 approvals are themselves the act", () => {
  for (const gate of ["G1", "G2", "G3"]) {
    for (const releaseKind of ["tag", "store", "none", null]) {
      assert.equal(approvalTransitions({ gate, releaseKind }), true, `${gate}/${releaseKind}`);
    }
  }
});

test("a G4 approval on a releasing repo does NOT transition", () => {
  // It authorises a release that has not happened. Moving the label here would
  // assert a release that does not exist — and lock agentflow-release out,
  // since it requires `verified`. This is the #45 defect.
  for (const releaseKind of ["tag", "store"]) {
    assert.equal(approvalTransitions({ gate: "G4", releaseKind }), false, releaseKind);
  }
});

test("under release_kind none the question is moot", () => {
  // No G4 exists there — the validator already refuses it — so the ordinary
  // path applies and nothing special-cases a gate that cannot occur.
  assert.equal(approvalTransitions({ gate: "G4", releaseKind: "none" }), true);
});

test("the label can lag reality but never lead it", () => {
  // The invariant this encodes: for every gate, either the approval performs
  // the transition, or something that produces an artifact does. There is no
  // gate where the label moves ahead of the thing it describes.
  const releasing = ["G1", "G2", "G3", "G4"].map((gate) => approvalTransitions({ gate, releaseKind: "tag" }));
  assert.deepEqual(releasing, [true, true, true, false]);
});
