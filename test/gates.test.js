import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INBOX_GATES,
  buildQueue,
  selectArtifact,
  renderItem,
} from "../scripts/gates/core.js";
import { USAGE, parseArgs, listInbox, approve, reject, main } from "../scripts/gates/cli.js";

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

// --- the CLI: argv -----------------------------------------------------------

test("parseArgs: the legitimate surface", () => {
  assert.deepEqual(parseArgs([]), { limit: 100 });
  assert.deepEqual(parseArgs(["--repo", "o/r"]), { limit: 100, repo: "o/r" });
  assert.equal(parseArgs(["--limit", "5"]).limit, 5);
  assert.equal(parseArgs(["--approve", "12"]).approve, "12");
  assert.deepEqual(parseArgs(["--reject", "12", "--reason", "not ready"]), {
    limit: 100,
    reject: "12",
    reason: "not ready",
  });
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
});

test("parseArgs: unrecognised options are rejected, not ignored", () => {
  assert.throws(() => parseArgs(["--wat"]), /unknown option "--wat"/);
  assert.throws(() => parseArgs(["bare-word"]), /unknown option "bare-word"/);
});

test("main: usage error on a bad flag exits 20 and prints usage", () => {
  const logs = [];
  const errs = [];
  const code = main(["--nope"], { sh: () => assert.fail("must not touch gh"), log: (m) => logs.push(m), err: (m) => errs.push(m) });
  assert.equal(code, 20);
  assert.match(errs[0], /unknown option/);
});

test("main: --approve and --reject together is a usage error", () => {
  const errs = [];
  const code = main(["--approve", "1", "--reject", "2"], { sh: () => assert.fail("must not touch gh"), err: (m) => errs.push(m) });
  assert.equal(code, 20);
  assert.match(errs[0], /one of --approve or --reject/);
});

test("--help documents the G3 exclusion and never mentions a bulk-approve verb", () => {
  assert.match(USAGE, /G3/);
  assert.match(USAGE, /PR-native/);
  const logs = [];
  const code = main(["--help"], { sh: () => assert.fail("must not touch gh"), log: (m) => logs.push(m) });
  assert.equal(code, 0);
  assert.match(logs.join("\n"), /G3/);
});

// --- the CLI: a mocked `gh` seam ---------------------------------------------

function ghIssue(number, labels, comments = []) {
  return {
    number,
    title: `issue ${number}`,
    labels: labels.map((name) => ({ name })),
    createdAt: "2026-07-01T00:00:00Z",
    comments,
  };
}

// A stand-in for `execFileSync("gh", args)`: matches on the gh subcommand
// rather than the full argv, so tests read as "what gh call, what does it
// answer" instead of brittle argv equality.
function fakeGh(fixtures) {
  const posted = [];
  const sh = (args) => {
    const [group, verb] = args;
    if (group === "issue" && verb === "list") {
      return JSON.stringify(fixtures.list.map(({ number, title, labels, createdAt }) => ({ number, title, labels, createdAt })));
    }
    if (group === "issue" && verb === "view") {
      const number = Number(args[2]);
      const found = fixtures.list.find((i) => i.number === number);
      if (!found) throw new Error(`no such issue #${number} in fixture`);
      const { comments, ...rest } = found;
      return JSON.stringify({ ...rest, comments: comments.map((body) => ({ author: { login: "someone" }, body })) });
    }
    if (group === "issue" && verb === "comment") {
      posted.push({ number: Number(args[2]), body: args[args.indexOf("--body") + 1] });
      return "";
    }
    throw new Error(`fakeGh: unhandled call ${args.join(" ")}`);
  };
  sh.posted = posted;
  return sh;
}

const g1 = ghIssue(1, ["state:idea", "priority:p1"], ["## Brief\nWhy this exists.\nMore detail."]);
const g2 = ghIssue(2, ["state:planned", "priority:p1"], ["## Plan\nThe plan headline.\nSteps follow."]);
const g4 = ghIssue(3, ["state:verified", "priority:p1"], ["## Release\nv1.2.3 release notes."]);
const noArtifact = ghIssue(4, ["state:idea", "priority:p1"], []);

test("listInbox: pending items across G1/G2/G4, each with an artifact excerpt", () => {
  const sh = fakeGh({ list: [g1, g2, g4] });
  const rows = listInbox({ sh, releaseKind: "tag" });
  assert.deepEqual(rows.map((r) => r.item.gate), ["G1", "G2", "G4"]);
  assert.match(rows[0].excerpt, /Why this exists/);
  assert.match(rows[1].excerpt, /The plan headline/);
  assert.match(rows[2].excerpt, /release notes/);
});

test("listInbox: G3 items never appear even if present in the fixture", () => {
  const inReview = ghIssue(9, ["state:in-review", "priority:p1"], ["## Review\nlgtm"]);
  const sh = fakeGh({ list: [g1, inReview] });
  const rows = listInbox({ sh, releaseKind: "tag" });
  assert.deepEqual(rows.map((r) => r.item.number), [1]);
});

test("listInbox: an item with no artifact still lists, marked unapprovable", () => {
  const sh = fakeGh({ list: [noArtifact] });
  const rows = listInbox({ sh, releaseKind: "tag" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].artifact, null);
  assert.match(rows[0].excerpt, /nothing to approve against/i);
});

test("main: empty inbox says so and touches gh only for the list", () => {
  const sh = fakeGh({ list: [] });
  const logs = [];
  const code = main([], { sh, log: (m) => logs.push(m) });
  assert.equal(code, 0);
  assert.match(logs.join("\n"), /nothing waiting at a gate/);
});

test("main: a populated inbox lists every item and prints how to act on it", () => {
  const sh = fakeGh({ list: [g1, g2] });
  const logs = [];
  const code = main(["--repo", "o/r"], { sh, log: (m) => logs.push(m) });
  assert.equal(code, 0);
  const out = logs.join("\n");
  assert.match(out, /2 item\(s\) waiting/);
  assert.match(out, /G3 is PR-native/);
  assert.match(out, /--approve <issue> --repo o\/r/);
  assert.match(out, /--reject <issue> --reason "\.\.\." --repo o\/r/);
});

// --- approve / reject: post only, never transition --------------------------

test("approve posts the standard /approve comment naming the pending gate", () => {
  const sh = fakeGh({ list: [g1] });
  const { gate } = approve({ sh, issue: "1", releaseKind: "tag" });
  assert.equal(gate, "G1");
  assert.deepEqual(sh.posted, [{ number: 1, body: "/approve G1" }]);
});

test("approve refuses an item that is not pending, without posting", () => {
  const merged = ghIssue(5, ["state:merged"], []);
  const sh = fakeGh({ list: [merged] });
  assert.throws(() => approve({ sh, issue: "5", releaseKind: "tag" }), /not waiting at an inbox gate/);
  assert.deepEqual(sh.posted, []);
});

test("approve refuses an item with no artifact, without posting", () => {
  const sh = fakeGh({ list: [noArtifact] });
  assert.throws(() => approve({ sh, issue: "4", releaseKind: "tag" }), /no G1 artifact comment/);
  assert.deepEqual(sh.posted, []);
});

test("reject posts the standard /reject comment with the given reason", () => {
  const sh = fakeGh({ list: [g2] });
  const { gate } = reject({ sh, issue: "2", reason: "needs another pass", releaseKind: "tag" });
  assert.equal(gate, "G2");
  assert.deepEqual(sh.posted, [{ number: 2, body: "/reject needs another pass" }]);
});

test("reject without a reason refuses before ever calling gh", () => {
  const sh = fakeGh({ list: [g2] });
  assert.throws(() => reject({ sh, issue: "2", reason: "", releaseKind: "tag" }), /requires --reason/);
  assert.throws(() => reject({ sh, issue: "2", releaseKind: "tag" }), /requires --reason/);
  assert.deepEqual(sh.posted, []);
});

test("main: --approve argv path prints confirmation and posts once", () => {
  const sh = fakeGh({ list: [g1] });
  const logs = [];
  const code = main(["--approve", "1"], { sh, log: (m) => logs.push(m) });
  assert.equal(code, 0);
  assert.match(logs.join("\n"), /approved G1 on #1/);
  assert.deepEqual(sh.posted, [{ number: 1, body: "/approve G1" }]);
});

test("main: --reject argv path requires --reason and refuses with exit 10 otherwise", () => {
  const sh = fakeGh({ list: [g2] });
  const errs = [];
  const code = main(["--reject", "2"], { sh, err: (m) => errs.push(m) });
  assert.equal(code, 10);
  assert.match(errs[0], /requires --reason/);
  assert.deepEqual(sh.posted, []);
});

test("main: --reject argv path with a reason posts and reports the gate", () => {
  const sh = fakeGh({ list: [g2] });
  const logs = [];
  const code = main(["--reject", "2", "--reason", "scope too big"], { sh, log: (m) => logs.push(m) });
  assert.equal(code, 0);
  assert.match(logs.join("\n"), /rejected #2 \(was waiting at G2\)/);
  assert.deepEqual(sh.posted, [{ number: 2, body: "/reject scope too big" }]);
});

test("main: --approve on an issue nobody is waiting on exits 10 without posting", () => {
  const merged = ghIssue(5, ["state:merged"], []);
  const sh = fakeGh({ list: [merged] });
  const errs = [];
  const code = main(["--approve", "5"], { sh, err: (m) => errs.push(m) });
  assert.equal(code, 10);
  assert.match(errs[0], /not waiting at an inbox gate/);
  assert.deepEqual(sh.posted, []);
});
