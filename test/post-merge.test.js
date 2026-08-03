import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOSING_KEYWORDS, linkedIssues, combineAncestry, main } from "../scripts/actions/post-merge.js";
import { classifyDelivery, renderFinding } from "../scripts/actions/ancestry.js";
import { MARKER as MERGE_RECORD_MARKER } from "../scripts/actions/merge-record.js";

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

// --- delivery check: squash-blind ancestry (#125) -----------------------------
//
// A squash merge lands a synthetic commit on main — its merge_commit_sha is an
// ancestor, its head sha never is. A true merge lands the head sha too, so both
// are ancestors. `combineAncestry` is the piece that turns those two independent
// git answers into the single tri-state `classifyDelivery` (ancestry.js) expects,
// and these tests pin its truth table directly, without shelling out to git.

test("combineAncestry: either check landing on main is sufficient evidence", () => {
  assert.equal(combineAncestry(true, false), true, "merge commit ancestor, head sha not — squash-shaped");
  assert.equal(combineAncestry(false, true), true, "head sha ancestor, merge commit not");
  assert.equal(combineAncestry(true, true), true, "both ancestors — true-merge-shaped");
});

test("combineAncestry: only both checks explicitly saying no reads as undelivered", () => {
  assert.equal(combineAncestry(false, false), false);
});

test("combineAncestry: one indeterminate check does not manufacture a false alarm", () => {
  assert.equal(combineAncestry(null, false), null);
  assert.equal(combineAncestry(false, null), null);
  assert.equal(combineAncestry(null, null), null);
  assert.equal(combineAncestry(null, true), true, "the other check still proves delivery");
});

// End-to-end through the same classifyDelivery/renderFinding the script calls,
// exercising the exact payload shapes the plan calls out.

test("squash-shaped payload: merge_commit_sha on main, head sha absent — delivery proceeds", () => {
  const isAncestor = combineAncestry(/* mergeAncestor */ true, /* headAncestor */ false);
  const delivery = classifyDelivery({ isAncestor, headSha: "0ef9099a", defaultBranch: "main" });
  assert.equal(delivery.proceed, true);
  assert.equal(delivery.status, "delivered");
});

test("true-merge-shaped payload: both shas land on main — delivery proceeds", () => {
  const isAncestor = combineAncestry(true, true);
  const delivery = classifyDelivery({ isAncestor, headSha: "abc1234", defaultBranch: "main" });
  assert.equal(delivery.proceed, true);
  assert.equal(delivery.status, "delivered");
});

test("genuinely undelivered payload: neither sha an ancestor — still fails loudly", () => {
  const isAncestor = combineAncestry(false, false);
  const delivery = classifyDelivery({ isAncestor, headSha: "deadbee", defaultBranch: "main" });
  assert.equal(delivery.proceed, false);
  assert.match(delivery.reason, /delivered nothing/);
  const finding = renderFinding({ prNumber: 999, classified: delivery, defaultBranch: "main" });
  assert.match(finding, /did not deliver/);
});

// --- main(): the exit-before-transition fix (#182) ---------------------------
//
// The bug: post-merge used to `process.exit(20)` when a real suite had no
// resolvable pack, ABOVE the transition loop — so the linked issue was left
// CLOSED but stuck at `state:in-review` forever, and the workflow went red on
// the first PR that ever properly closed an issue on a repo with scenarios but
// no pack. `main` is now DI'd (mirrors scripts/gates/cli.js): every I/O seam is
// an injected function, defaulted to the real implementation, so the whole
// flow — labels, comments, the transition, the exit code — is exercisable
// without touching gh, git, or disk.
//
// `fakeGh` stands in for `execFileSync("gh", args)`, backed by a small mutable
// "world" of issues/comments. It answers exactly the call shapes main() makes:
// issue view (labels / labels,state), issue edit (--add-label/--remove-label),
// issue comment (create), and the api GET/PATCH pair post-merge uses to
// upsert its marker comment.
function fakeGh(world) {
  const calls = [];
  let nextCommentId = 9000;
  const sh = (args) => {
    calls.push(args);
    const [group, verb] = args;

    if (group === "issue" && verb === "view") {
      const number = Number(args[2]);
      const issue = world.issues[number];
      if (!issue) throw new Error(`fakeGh: no such issue #${number}`);
      const fields = args[args.indexOf("--json") + 1].split(",");
      const out = {};
      if (fields.includes("labels")) out.labels = issue.labels.map((name) => ({ name }));
      if (fields.includes("state")) out.state = issue.state;
      return JSON.stringify(out);
    }

    if (group === "issue" && verb === "edit") {
      const number = Number(args[2]);
      const issue = world.issues[number];
      for (let i = 3; i < args.length; i++) {
        if (args[i] === "--add-label") {
          issue.labels = [...new Set([...issue.labels, args[++i]])];
        } else if (args[i] === "--remove-label") {
          const remove = args[++i];
          issue.labels = issue.labels.filter((l) => l !== remove);
        }
      }
      return "";
    }

    if (group === "issue" && verb === "comment") {
      const number = Number(args[2]);
      const body = args[args.indexOf("--body") + 1];
      world.comments.push({ id: nextCommentId++, number, body });
      return "";
    }

    if (group === "api" && args[1] === "--method" && args[2] === "PATCH") {
      const id = Number(args[3].match(/comments\/(\d+)$/)[1]);
      const body = args[args.indexOf("-f") + 1].slice("body=".length);
      const comment = world.comments.find((c) => c.id === id);
      if (!comment) throw new Error(`fakeGh: no such comment #${id}`);
      comment.body = body;
      return "";
    }

    if (group === "api" && /\/comments$/.test(args[1])) {
      const number = Number(args[1].match(/issues\/(\d+)\/comments$/)[1]);
      return JSON.stringify(
        world.comments.filter((c) => c.number === number).map(({ id, body }) => ({ id, body })),
      );
    }

    throw new Error(`fakeGh: unhandled call ${args.join(" ")}`);
  };
  sh.calls = calls;
  return sh;
}

function makeMergeEvent({ prNumber = 501, body, headSha = "aaaa1111", mergeSha = "bbbb2222", mergedBy = "tester", defaultBranch = "main" } = {}) {
  return {
    pull_request: {
      number: prNumber,
      merged: true,
      body,
      head: { sha: headSha },
      merge_commit_sha: mergeSha,
      merged_by: { login: mergedBy },
      user: { login: mergedBy },
    },
    repository: { default_branch: defaultBranch },
  };
}

// Every scenario below stubs `checkAncestor` to prove delivery unconditionally
// (ancestry is #125's concern, already covered above) so only the smoke/pack
// decision under test is in play.
const alwaysDelivered = () => true;

// A comment marked `<!-- agentflow-postmerge -->`, if one was posted.
const postmergeNote = (world, number) =>
  world.comments.find((c) => c.number === number && c.body.startsWith("<!-- agentflow-postmerge -->"))?.body;

test("main: a ready suite with no pack resolvable degrades — transition applies, exit 0", () => {
  const world = { issues: { 42: { labels: ["state:merged"], state: "OPEN" } }, comments: [] };
  const sh = fakeGh(world);
  const code = main({
    event: makeMergeEvent({ body: "Closes #42" }),
    repo: "org/repo",
    sh,
    checkAncestor: alwaysDelivered,
    readFeatureFiles: () => ({ exists: true, files: ["login.feature", "checkout.feature"] }),
    countTraceFiles: () => 5,
    loadConfig: () => ({}),
    listDir: () => [],
    runReplay: () => {
      throw new Error("must not be called — no pack was resolved, so nothing should attempt to replay");
    },
  });
  assert.equal(code, 0, "an unrunnable smoke must never turn the workflow red");
  assert.deepEqual(world.issues[42].labels, ["state:verified"], "the transition applied despite the skip");
  const note = postmergeNote(world, 42);
  assert.match(note, /skipped \(could not run\)/);
  assert.match(note, /no pack resolvable/);
  assert.match(note, /Applied: `merged` → `verified`/);
});

test("main: feature files present, pack present, zero compiled traces — vacuous pass, distinct from an empty suite", () => {
  const world = { issues: { 43: { labels: ["state:merged"], state: "OPEN" } }, comments: [] };
  const sh = fakeGh(world);
  const code = main({
    event: makeMergeEvent({ body: "Fixes #43" }),
    repo: "org/repo",
    sh,
    checkAncestor: alwaysDelivered,
    readFeatureFiles: () => ({ exists: true, files: ["a.feature", "b.feature"] }),
    countTraceFiles: () => 0,
    loadConfig: () => ({ platform: "rn-expo" }),
    listDir: () => {
      throw new Error("must not be called — a vacuous suite (zero traces) never reaches pack resolution");
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(world.issues[43].labels, ["state:verified"]);
  const note = postmergeNote(world, 43);
  assert.match(note, /vacuous pass \(zero traces\)/);
  assert.doesNotMatch(note, /skipped/);
});

test("main: no scenario suite at all — vacuous pass, unaffected by the reorder", () => {
  const world = { issues: { 44: { labels: ["state:merged"], state: "OPEN" } }, comments: [] };
  const sh = fakeGh(world);
  const code = main({
    event: makeMergeEvent({ body: "Resolves #44" }),
    repo: "org/repo",
    sh,
    checkAncestor: alwaysDelivered,
    readFeatureFiles: () => ({ exists: false, files: [] }),
    countTraceFiles: () => 0,
    loadConfig: () => ({}),
    listDir: () => {
      throw new Error("must not be called — an empty suite never reaches pack resolution");
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(world.issues[44].labels, ["state:verified"]);
  assert.match(postmergeNote(world, 44), /vacuous pass \(empty suite\)/);
});

test("main: a real suite with a resolvable pack actually replays and passes", () => {
  const world = { issues: { 45: { labels: ["state:merged"], state: "OPEN" } }, comments: [] };
  const sh = fakeGh(world);
  const replayCalls = [];
  const code = main({
    event: makeMergeEvent({ body: "Closes #45" }),
    repo: "org/repo",
    sh,
    checkAncestor: alwaysDelivered,
    readFeatureFiles: () => ({ exists: true, files: ["checkout.feature"] }),
    countTraceFiles: () => 2,
    loadConfig: () => ({ platform: "rn-expo" }),
    listDir: () => ["expo"],
    runReplay: (args) => {
      replayCalls.push(args);
      return { summary: { passed: 3, failed: 0, "needs-derivation": 0 } };
    },
  });
  assert.equal(code, 0);
  assert.equal(replayCalls.length, 1, "a resolved pack must actually be replayed, not skipped");
  assert.match(replayCalls[0].packDir, /packs[/\\]expo$/);
  assert.deepEqual(world.issues[45].labels, ["state:verified"]);
  assert.match(postmergeNote(world, 45), /post-merge smoke: passed/);
});

test("main: a real suite whose replay throws degrades rather than crashing the run", () => {
  const world = { issues: { 47: { labels: ["state:merged"], state: "OPEN" } }, comments: [] };
  const sh = fakeGh(world);
  const code = main({
    event: makeMergeEvent({ body: "Closes #47" }),
    repo: "org/repo",
    sh,
    checkAncestor: alwaysDelivered,
    readFeatureFiles: () => ({ exists: true, files: ["a.feature"] }),
    countTraceFiles: () => 1,
    loadConfig: () => ({ platform: "rn-expo" }),
    listDir: () => ["expo"],
    runReplay: () => {
      throw new Error("adapter exited 20 (infrastructure failure)");
    },
  });
  assert.equal(code, 0, "a pack that fails to actually run is still a degrade, not a crash");
  assert.deepEqual(world.issues[47].labels, ["state:verified"]);
  assert.match(postmergeNote(world, 47), /replay could not run/);
});

// The exact #182 reproduction: six `.feature` files, no `packs/` directory, no
// compiled traces, and — because the pre-fix code never reached the transition
// loop at all — the linked issue is CLOSED (GitHub's own `Closes #N`) but still
// carries the stale `state:in-review` label, exactly like hsk-habit#24.
test("main: the exact #182 repro — closes an issue, no packs/, zero traces, six scenarios — now transitions and stays green", () => {
  const world = { issues: { 24: { labels: ["state:in-review"], state: "CLOSED" } }, comments: [] };
  const sh = fakeGh(world);
  const sixFeatureFiles = Array.from({ length: 6 }, (_, i) => `scenario-${i}.feature`);
  const code = main({
    event: makeMergeEvent({ prNumber: 27, body: "Closes #24" }),
    repo: "yuchida-tamu/hsk-habit",
    sh,
    checkAncestor: alwaysDelivered,
    readFeatureFiles: () => ({ exists: true, files: sixFeatureFiles }),
    countTraceFiles: () => 0, // `find e2e/traces -type f` → 0, per the issue
    loadConfig: () => ({}), // no platform configured, and no packs/ vendored
    listDir: () => {
      throw new Error("must not be called — zero traces is vacuous before pack resolution is ever consulted");
    },
  });
  assert.equal(code, 0, "the workflow must stay green — this is the exact regression #182 reports");

  // The smoke's own attempt at `merged → verified` fails harmlessly (the issue
  // was still labelled `in-review`, never `merged`) — but the separate
  // merge-close bookkeeping (#70) still completes the full passage because the
  // issue is CLOSED, which is what actually unsticks it.
  const note = postmergeNote(world, 24);
  assert.match(note, /vacuous pass \(zero traces\)/);

  const record = world.comments.find((c) => c.number === 24 && c.body.startsWith(MERGE_RECORD_MARKER));
  assert.ok(record, "a closed, merged issue must get a merge-record comment");
  assert.match(record.body, /Completed: `merged` → `verified`/);

  // Closed issues have their state label cleared entirely (#70) rather than
  // left on `verified` — the point here is that it is no longer stuck on
  // `in-review`, not that a particular label survives.
  assert.deepEqual(
    world.issues[24].labels.filter((l) => l.startsWith("state:")),
    [],
  );
});

test("main: a PR that closes no issue is unaffected — no gh calls beyond a log line", () => {
  const code = main({
    event: makeMergeEvent({ body: "no closing keyword here" }),
    repo: "org/repo",
    sh: () => assert.fail("must not touch gh — nothing is linked"),
    log: () => {},
  });
  assert.equal(code, 0);
});
