#!/usr/bin/env node
// GitHub Actions entry: a PR merged into the default branch → run the
// post-merge smoke step, transition the linked issue `merged → verified` when
// it passes, and record on the issue what actually happened.
//
// A repo with no scenario suite passes vacuously. That is the point: the loop's
// tail must complete on a toolkit or a library, not only on an app. The comment
// says which kind of pass it was, so a vacuous one is never read as a verified
// one.
//
// Env: GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GH_TOKEN.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { classifySuite, smokeOutcome, renderSmokeNote } from "../e2e/smoke.js";
import { planTransition } from "../state/machine.js";
import { releaseKindOf } from "../config/load.js";
import { classifyDelivery, renderFinding } from "./ancestry.js";
import { planMergeClose, renderMergeRecord, MARKER as MERGE_RECORD_MARKER } from "./merge-record.js";

const MARKER = "<!-- agentflow-postmerge -->";
const SCENARIOS_DIR = "e2e/scenarios";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const pr = event.pull_request;
if (!pr?.merged) process.exit(0);

const repo = process.env.GITHUB_REPOSITORY;
const sh = (args) => execFileSync("gh", args, { encoding: "utf8" });

// "Closes #12" / "Fixes #12" — the issues GitHub itself would close.
const linked = [...new Set([...(pr.body ?? "").matchAll(/\b(?:closes|fixes|resolves)\s+#(\d+)/gi)].map((m) => Number(m[1])))];
if (linked.length === 0) {
  console.log("post-merge: PR closes no issue — nothing to transition");
  process.exit(0);
}

function readFeatureFiles(dir) {
  try {
    return { exists: true, files: readdirSync(dir).filter((f) => f.endsWith(".feature")) };
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return { exists: false, files: [] };
    throw err;
  }
}

// Did this merge actually deliver? A stacked merge can report success and land
// nothing (#44) — #38, #39 and #40 all showed MERGED with none of their code on
// main. Answer before touching any issue: a merge that delivered nothing must
// not advance the record.
const defaultBranch = event.repository?.default_branch ?? "main";
let isAncestor = null;
try {
  execFileSync("git", ["merge-base", "--is-ancestor", pr.head.sha, `origin/${defaultBranch}`], {
    stdio: "ignore",
  });
  isAncestor = true;
} catch (err) {
  // Exit 1 is a clean "not an ancestor". Anything else — a shallow clone, a
  // missing ref — means we could not tell, and must not be read as a failure.
  isAncestor = err.status === 1 ? false : null;
}

const delivery = classifyDelivery({ isAncestor, headSha: pr.head.sha, defaultBranch });
if (!delivery.proceed) {
  const finding = renderFinding({ prNumber: pr.number, classified: delivery, defaultBranch });
  for (const issue of linked) {
    sh(["issue", "comment", String(issue), "--repo", repo, "--body", finding]);
  }
  console.error(`post-merge: ${delivery.reason}`);
  process.exit(10);
}
if (delivery.reason) console.log(`post-merge: ${delivery.reason}`);

const listing = readFeatureFiles(SCENARIOS_DIR);
const suite = classifySuite({ scenariosDirExists: listing.exists, featureFiles: listing.files });

// A real suite needs a pack to replay against. Rather than guess, run it through
// the CLI, which owns adapter resolution; the vacuous case never gets here.
let result = null;
if (!suite.empty) {
  const packDir = existsSync("packs") ? readdirSync("packs").map((p) => `packs/${p}`)[0] : null;
  if (!packDir) {
    console.error("post-merge: repo has scenarios but no pack to replay them against");
    process.exit(20);
  }
  const raw = execFileSync(
    process.execPath,
    ["scripts/e2e/cli.js", "run", "--scenarios", SCENARIOS_DIR, "--traces", "e2e/traces", "--pack", packDir],
    { encoding: "utf8" }
  );
  result = JSON.parse(raw);
}

const outcome = smokeOutcome({ suite, result });
const releaseKind = releaseKindOf();

for (const issue of linked) {
  const labels = JSON.parse(sh(["issue", "view", String(issue), "--repo", repo, "--json", "labels"])).labels.map(
    (l) => l.name
  );
  let note = renderSmokeNote(outcome);
  if (outcome.transition) {
    try {
      const plan = planTransition(labels, outcome.transition.to, { releaseKind });
      const args = ["issue", "edit", String(issue), "--repo", repo];
      for (const label of plan.add) args.push("--add-label", label);
      for (const label of plan.remove) args.push("--remove-label", label);
      sh(args);
      note += `\n\nApplied: \`${plan.from}\` → \`${plan.to}\`.`;
    } catch (err) {
      // An item that isn't at `merged` is not a failure of the smoke run — say
      // so and leave the labels alone rather than forcing a transition.
      note += `\n\nNo transition applied: ${err.message}`;
    }
  }
  const body = `${MARKER}\n${note}`;
  const comments = JSON.parse(sh(["api", `repos/${repo}/issues/${issue}/comments`, "--jq", "[.[] | {id, body}]"]));
  const existing = comments.find((c) => c.body.startsWith(MARKER));
  if (existing) {
    sh(["api", "--method", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`]);
  } else {
    sh(["issue", "comment", String(issue), "--repo", repo, "--body", body]);
  }

  // GitHub's `Closes #N` closes the issue directly, so nothing in the loop
  // observes it: the state label survives and no record of the merge is written.
  // Both belong here — same event, same issue, same moment (#70).
  const fresh = JSON.parse(sh(["issue", "view", String(issue), "--repo", repo, "--json", "labels,state"]));
  const closePlan = planMergeClose({
    labels: fresh.labels.map((l) => l.name),
    closedByMerge: fresh.state === "CLOSED",
  });

  for (const target of closePlan.transitions) {
    try {
      const labels = JSON.parse(sh(["issue", "view", String(issue), "--repo", repo, "--json", "labels"])).labels.map(
        (l) => l.name
      );
      const step = planTransition(labels, target, { releaseKind });
      const args = ["issue", "edit", String(issue), "--repo", repo];
      for (const label of step.add) args.push("--add-label", label);
      for (const label of step.remove) args.push("--remove-label", label);
      sh(args);
    } catch {
      break; // the passage is as complete as it can honestly be made
    }
  }

  if (closePlan.clearLabel) {
    const labels = JSON.parse(sh(["issue", "view", String(issue), "--repo", repo, "--json", "labels"])).labels
      .map((l) => l.name)
      .filter((l) => l.startsWith("state:"));
    if (labels.length) {
      const args = ["issue", "edit", String(issue), "--repo", repo];
      for (const label of labels) args.push("--remove-label", label);
      sh(args);
    }
  }

  if (fresh.state === "CLOSED") {
    const record = renderMergeRecord({
      prNumber: pr.number,
      mergedBy: pr.merged_by?.login ?? pr.user?.login ?? "unknown",
      headSha: pr.head.sha,
      plan: closePlan,
    });
    const prior = comments.find((c) => c.body.startsWith(MERGE_RECORD_MARKER));
    if (prior) {
      sh(["api", "--method", "PATCH", `repos/${repo}/issues/comments/${prior.id}`, "-f", `body=${record}`]);
    } else {
      sh(["issue", "comment", String(issue), "--repo", repo, "--body", record]);
    }
  }
}

console.log(`post-merge: ${outcome.kind} → ${outcome.status}, ${linked.length} issue(s)`);
process.exit(outcome.status === "passed" ? 0 : 10);
