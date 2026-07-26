import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INBOX_GATES,
  buildQueue,
  selectArtifact,
  renderItem,
} from "../scripts/gates/core.js";
import { parseArgs, assertInteractive, resolveRepos, FORBIDDEN_FLAGS } from "../scripts/gates/cli.js";

const issue = (number, labels, over = {}) => ({
  number,
  title: `issue ${number}`,
  labels,
  createdAt: "2026-07-01T00:00:00Z",
  ...over,
});

test("the queue holds exactly the items waiting at an inbox gate", () => {
  const queue = buildQueue({
    issues: [
      issue(1, ["state:idea", "priority:p1"]),
      issue(2, ["state:planned", "priority:p1"]),
      issue(3, ["state:verified", "priority:p2"]),
      issue(4, ["state:ready", "priority:p1"]),
      issue(5, ["state:in-progress"]),
      issue(6, ["state:released"]),
    ],
  });
  assert.deepEqual(queue.map((i) => i.number), [1, 2, 3]);
  assert.deepEqual(queue.map((i) => i.gate), ["G1", "G2", "G4"]);
});

test("G3 is never an inbox gate — it is PR-native", () => {
  const queue = buildQueue({ issues: [issue(9, ["state:in-review", "priority:p1"])] });
  assert.deepEqual(queue, []);
  assert.ok(!INBOX_GATES.includes("G3"));
});

test("release_kind none removes G4 from the queue", () => {
  const issues = [issue(3, ["state:verified", "priority:p1"])];
  assert.equal(buildQueue({ issues, releaseKind: "tag" }).length, 1);
  assert.equal(buildQueue({ issues, releaseKind: "none" }).length, 0);
});

test("the queue inherits pendingGateFor rather than re-deriving what waiting means", () => {
  // If the state machine ever stops treating `planned` as a G2 gate, the queue
  // must follow automatically — this asserts the coupling exists.
  const queue = buildQueue({ issues: [issue(2, ["state:planned"])] });
  assert.equal(queue[0].gate, "G2");
  assert.equal(queue[0].to, "ready");
});

test("items with no state, or a conflicting one, are skipped rather than throwing", () => {
  const queue = buildQueue({
    issues: [issue(1, ["priority:p1"]), issue(2, ["state:idea", "state:planned"]), issue(3, ["state:idea"])],
  });
  assert.deepEqual(queue.map((i) => i.number), [3]);
});

test("ordering is stable: gate, then priority, then age", () => {
  const queue = buildQueue({
    issues: [
      issue(10, ["state:planned", "priority:p2"], { createdAt: "2026-07-02T00:00:00Z" }),
      issue(11, ["state:idea", "priority:p2"], { createdAt: "2026-07-03T00:00:00Z" }),
      issue(12, ["state:idea", "priority:p1"], { createdAt: "2026-07-04T00:00:00Z" }),
      issue(13, ["state:idea", "priority:p2"], { createdAt: "2026-07-01T00:00:00Z" }),
    ],
  });
  assert.deepEqual(queue.map((i) => i.number), [12, 13, 11, 10]);
  // Running twice must present the same order.
  const again = buildQueue({
    issues: [
      issue(13, ["state:idea", "priority:p2"], { createdAt: "2026-07-01T00:00:00Z" }),
      issue(12, ["state:idea", "priority:p1"], { createdAt: "2026-07-04T00:00:00Z" }),
      issue(11, ["state:idea", "priority:p2"], { createdAt: "2026-07-03T00:00:00Z" }),
      issue(10, ["state:planned", "priority:p2"], { createdAt: "2026-07-02T00:00:00Z" }),
    ],
  });
  assert.deepEqual(again.map((i) => i.number), [12, 13, 11, 10]);
});

// --- artifact selection ------------------------------------------------------

const comments = [
  { body: "## Brief\nfirst brief" },
  { body: "some chatter" },
  { body: "## Brief\nrevised brief" },
  { body: "## Plan\nthe plan" },
];

test("G1 selects the most recent brief, G2 the most recent plan", () => {
  assert.match(selectArtifact({ comments, gate: "G1" }).body, /revised brief/);
  assert.match(selectArtifact({ comments, gate: "G2" }).body, /the plan/);
});

test("an absent artifact is reported, not faked", () => {
  const found = selectArtifact({ comments: [{ body: "hello" }], gate: "G1" });
  assert.equal(found, null);
});

test("no comments at all yields no artifact", () => {
  assert.equal(selectArtifact({ comments: [], gate: "G2" }), null);
  assert.equal(selectArtifact({ comments: undefined, gate: "G2" }), null);
});

test("a heading mid-line does not count as an artifact", () => {
  const found = selectArtifact({ comments: [{ body: "see the ## Brief above" }], gate: "G1" });
  assert.equal(found, null);
});

// --- rendering ---------------------------------------------------------------

const item = { number: 7, title: "a thing", gate: "G1", state: "idea", to: "spec", priority: 1 };

test("rendering names the item, its gate, and the artifact", () => {
  const out = renderItem({ item, artifact: { body: "## Brief\nproblem: x" } });
  assert.match(out, /#7/);
  assert.match(out, /a thing/);
  assert.match(out, /G1/);
  assert.match(out, /problem: x/);
});

test("a missing artifact renders as an explicit absence", () => {
  const out = renderItem({ item, artifact: null });
  assert.match(out, /nothing to approve against/i, "the absence must be stated, not implied by an empty body");
  assert.match(out, /skip/i, "and it must steer toward skipping rather than approving");
});

test("renderItem reports whether the item is approvable", () => {
  assert.equal(renderItem.approvable({ artifact: null }), false);
  assert.equal(renderItem.approvable({ artifact: { body: "## Brief\nx" } }), true);
});

test("long artifacts truncate explicitly, never silently", () => {
  const body = "## Brief\n" + Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const out = renderItem({ item, artifact: { body }, maxLines: 10 });
  assert.match(out, /line 0/);
  assert.doesNotMatch(out, /line 199/);
  assert.match(out, /… \d+ more lines/);
  assert.match(out, /#7/, "the truncation notice must still identify the item");
});

test("a short artifact is not marked as truncated", () => {
  const out = renderItem({ item, artifact: { body: "## Brief\nshort" }, maxLines: 10 });
  assert.doesNotMatch(out, /more lines/);
});

// --- the CLI's shut door -----------------------------------------------------

test("a non-TTY stdin is refused, and the refusal is fatal", () => {
  assert.throws(
    () => assertInteractive({ isTTY: false }),
    (err) => err.code === 2 && /interactive only/.test(err.message)
  );
});

test("a TTY is accepted", () => {
  assert.doesNotThrow(() => assertInteractive({ isTTY: true }));
});

test("no bulk-approve verb exists, and adding one fails this test", () => {
  // The inbox's whole value is approving many things quickly, which is also the
  // shape of its worst misuse. Every one of these must remain unparseable.
  for (const flag of FORBIDDEN_FLAGS) {
    assert.throws(() => parseArgs([flag]), /unknown option/, `${flag} must not be accepted`);
  }
});

test("unknown options are rejected rather than ignored", () => {
  assert.throws(() => parseArgs(["--wat"]), /unknown option "--wat"/);
});

test("the legitimate surface parses", () => {
  assert.deepEqual(parseArgs([]), { repos: [] });
  assert.deepEqual(parseArgs(["--repo", "o/r"]), { repos: ["o/r"] });
  assert.equal(parseArgs(["--limit", "5"]).limit, 5);
  assert.equal(parseArgs(["--all-repos"]).allRepos, true);
});

test("--all-repos reads an explicit list, never discovery", () => {
  assert.deepEqual(
    resolveRepos({ flags: { repos: [], allRepos: true }, config: { gate_inbox_repos: ["a/b", "c/d"] } }),
    ["a/b", "c/d"]
  );
  assert.throws(
    () => resolveRepos({ flags: { repos: [], allRepos: true }, config: {} }),
    /needs a "gate_inbox_repos" list/,
    "must refuse rather than scan every repo the token can see"
  );
});

test("no --repo and no --all-repos means the current repo", () => {
  assert.deepEqual(resolveRepos({ flags: { repos: [] }, config: {} }), [null]);
});

test("explicit --repo wins over --all-repos", () => {
  assert.deepEqual(
    resolveRepos({ flags: { repos: ["x/y"], allRepos: true }, config: { gate_inbox_repos: ["a/b"] } }),
    ["x/y"]
  );
});
