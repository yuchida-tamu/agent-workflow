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
  const existing = JSON.parse(
    sh(["api", `repos/${repo}/issues/${issue}/comments`, "--jq", "[.[] | {id, body}]"])
  ).find((c) => c.body.startsWith(MARKER));
  if (existing) {
    sh(["api", "--method", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`]);
  } else {
    sh(["issue", "comment", String(issue), "--repo", repo, "--body", body]);
  }
}

console.log(`post-merge: ${outcome.kind} → ${outcome.status}, ${linked.length} issue(s)`);
process.exit(outcome.status === "passed" ? 0 : 10);
