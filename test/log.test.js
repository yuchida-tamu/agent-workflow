import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKER, COLUMNS, render, parse, upsert, audit } from "../scripts/log/ledger.js";

const row = (over = {}) => ({
  run: "a1b2c3",
  phase: "idea",
  agent: "product-shaper",
  model: "opus",
  session: "s-1",
  started: "2026-07-26T10:04:11Z",
  ended: "2026-07-26T10:12:40Z",
  outcome: "ok",
  ...over,
});

test("render produces a marked, human-readable table", () => {
  const body = render([row()]);
  assert.ok(body.startsWith(MARKER), "body must start with the marker");
  assert.match(body, /### agentflow run ledger/);
  assert.match(body, /\| run \| phase \| agent \|/);
  assert.match(body, /\| a1b2c3 \| idea \| product-shaper \| opus \|/);
});

test("render keeps rows in order, newest last", () => {
  const body = render([row({ run: "first" }), row({ run: "second" })]);
  assert.ok(body.indexOf("first") < body.indexOf("second"));
});

test("parse round-trips a full row", () => {
  const rows = [row()];
  assert.deepEqual(parse(render(rows)), rows);
});

test("parse round-trips an open row with absent ended and outcome", () => {
  const rows = [row({ ended: null, outcome: null })];
  assert.deepEqual(parse(render(rows)), rows);
});

test("parse round-trips values containing pipes and backslashes", () => {
  const rows = [row({ session: "a|b", outcome: "back\\slash", phase: "a|b\\c" })];
  assert.deepEqual(parse(render(rows)), rows);
});

test("parse round-trips an empty ledger", () => {
  assert.deepEqual(parse(render([])), []);
});

test("parse round-trips many mixed rows", () => {
  const rows = [
    row({ run: "r1" }),
    row({ run: "r2", ended: null, outcome: null }),
    row({ run: "r3", model: "haiku", agent: "triage", session: null }),
  ];
  assert.deepEqual(parse(render(rows)), rows);
});

test("parse returns no rows for a body that is not a ledger", () => {
  assert.deepEqual(parse("just a normal comment"), []);
  assert.deepEqual(parse(""), []);
  assert.deepEqual(parse(null), []);
});

test("parse ignores a table that is not preceded by the marker", () => {
  const table = render([row()]).replace(MARKER, "<!-- something-else -->");
  assert.deepEqual(parse(table), []);
});

test("COLUMNS covers every field a row carries", () => {
  assert.deepEqual([...COLUMNS].sort(), Object.keys(row()).sort());
});

// --- upsert -----------------------------------------------------------------

test("a start row is appended", () => {
  const rows = upsert([], { kind: "start", run: "n1", phase: "spec", agent: "architect", model: "opus", session: "s", started: "T0" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].run, "n1");
  assert.equal(rows[0].ended, null);
  assert.equal(rows[0].outcome, null);
});

test("start does not mutate the rows it was given", () => {
  const before = [];
  upsert(before, { kind: "start", run: "n1", phase: "spec", agent: "architect", model: "opus", started: "T0" });
  assert.deepEqual(before, []);
});

test("an end completes the matching open row in place", () => {
  let rows = upsert([], { kind: "start", run: "n1", phase: "spec", agent: "architect", model: "opus", started: "T0" });
  rows = upsert(rows, { kind: "end", run: "n1", ended: "T1", outcome: "ok" });
  assert.equal(rows.length, 1, "end must not append a second row");
  assert.equal(rows[0].ended, "T1");
  assert.equal(rows[0].outcome, "ok");
});

test("an end for an unknown run throws", () => {
  assert.throws(
    () => upsert([], { kind: "end", run: "nope", ended: "T1", outcome: "ok" }),
    /no open ledger row for run "nope"/
  );
});

test("an end for an already-closed run throws", () => {
  let rows = upsert([], { kind: "start", run: "n1", phase: "spec", agent: "architect", model: "opus", started: "T0" });
  rows = upsert(rows, { kind: "end", run: "n1", ended: "T1", outcome: "ok" });
  assert.throws(() => upsert(rows, { kind: "end", run: "n1", ended: "T2", outcome: "ok" }), /already closed/);
});

test("a start reusing an open run id throws", () => {
  const rows = upsert([], { kind: "start", run: "n1", phase: "spec", agent: "architect", model: "opus", started: "T0" });
  assert.throws(
    () => upsert(rows, { kind: "start", run: "n1", phase: "ready", agent: "implementer", model: "sonnet", started: "T2" }),
    /run "n1" is already open/
  );
});

test("upsert rejects an unknown kind", () => {
  assert.throws(() => upsert([], { kind: "sideways", run: "n1" }), /unknown ledger entry kind/);
});

// --- audit ------------------------------------------------------------------

const tiers = {
  "product-shaper": "opus",
  architect: "opus",
  implementer: "sonnet",
  triage: "haiku",
};

test("audit is silent when every row matches its declared tier", () => {
  const rows = [row({ agent: "architect", model: "opus" })];
  assert.deepEqual(audit({ rows, tiers }), []);
});

test("audit flags a row whose model is not the agent's declared tier", () => {
  const rows = [row({ run: "r1", agent: "triage", model: "opus" })];
  const findings = audit({ rows, tiers });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "violation");
  assert.equal(findings[0].run, "r1");
  assert.equal(findings[0].agent, "triage");
  assert.equal(findings[0].expected, "haiku");
  assert.equal(findings[0].actual, "opus");
});

test("audit flags a row naming an agent with no definition", () => {
  const findings = audit({ rows: [row({ agent: "ghost" })], tiers });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "unknown-agent");
  assert.equal(findings[0].agent, "ghost");
});

test("audit reports a gap when a state was reached with no producing row", () => {
  // Reaching `planned` requires both a shaping run and a planning run.
  const rows = [row({ phase: "idea", agent: "product-shaper", model: "opus" })];
  const findings = audit({ rows, tiers, state: "planned" });
  assert.deepEqual(findings, [{ kind: "gap", phase: "spec", agent: "architect", state: "planned" }]);
});

test("audit reports no gap when every producing phase has a row", () => {
  const rows = [
    row({ phase: "idea", agent: "product-shaper", model: "opus" }),
    row({ phase: "spec", agent: "architect", model: "opus" }),
  ];
  assert.deepEqual(audit({ rows, tiers, state: "planned" }), []);
});

test("audit treats an empty ledger on an advanced item as all gaps", () => {
  const findings = audit({ rows: [], tiers, state: "planned" });
  assert.equal(findings.length, 2, "silence is a finding, not a pass");
  assert.ok(findings.every((f) => f.kind === "gap"));
});

test("audit expects nothing of an item still at idea", () => {
  assert.deepEqual(audit({ rows: [], tiers, state: "idea" }), []);
});

test("audit without a state checks tiers only", () => {
  assert.deepEqual(audit({ rows: [], tiers }), []);
});

test("audit counts an open row as having run", () => {
  const rows = [row({ phase: "idea", agent: "product-shaper", model: "opus", ended: null, outcome: null })];
  assert.deepEqual(audit({ rows, tiers, state: "spec" }), []);
});
