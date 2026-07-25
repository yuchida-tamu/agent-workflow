import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, validateApproval } from "../scripts/gate/validator.js";

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
