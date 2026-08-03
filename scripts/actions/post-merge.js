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
// #182: the transition loop below ALWAYS runs, regardless of whether the smoke
// itself could run. It used to be possible to `process.exit(20)` *above* the
// loop when no pack was resolvable — which left the linked issue CLOSED but
// stuck at `state:in-review` forever, and turned the workflow red on the first
// PR that ever properly closed an issue on a repo with scenarios but no pack.
// An unrunnable or vacuous smoke is a reason recorded in the note; it is never
// a reason to abandon the merge bookkeeping. See scripts/e2e/smoke.js.
//
// Env: GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GH_TOKEN.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifySuite, smokeOutcome, smokeSkipped, renderSmokeNote } from "../e2e/smoke.js";
import { resolvePackDir } from "../e2e/pack.js";
import { planTransition } from "../state/machine.js";
import { loadConfig } from "../config/load.js";
import { resolveReleaseKind } from "../../init/config-schema.js";
import { classifyDelivery, renderFinding } from "./ancestry.js";
import { planMergeClose, renderMergeRecord, MARKER as MERGE_RECORD_MARKER } from "./merge-record.js";

const MARKER = "<!-- agentflow-postmerge -->";
const SCENARIOS_DIR = "e2e/scenarios";
const TRACES_DIR = "e2e/traces";

// The toolkit's own root, however this file is checked out — resolved from
// this module's own location rather than $GITHUB_ACTION_PATH or cwd. Same
// distance the composite actions already cross with `$GITHUB_ACTION_PATH/../..`
// to find `scripts/actions/post-merge.js` itself; this is that seam applied to
// the pack lookup that used to resolve against the *consumer's* checkout
// instead, where nothing ever vendors a pack (#182).
const TOOLKIT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const E2E_CLI_PATH = join(TOOLKIT_ROOT, "scripts", "e2e", "cli.js");

// GitHub's full closing-keyword set — all nine forms it acts on when a PR
// merges: https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue
// Kept as a list, not a regex literal, so every keyword the parser recognizes
// is visible and auditable in one place, and the regex can't silently drift
// out of sync with GitHub's own set again (#119 — six of nine were missing).
export const CLOSING_KEYWORDS = [
  "close", "closes", "closed",
  "fix", "fixes", "fixed",
  "resolve", "resolves", "resolved",
];

const CLOSING_KEYWORD_RE = new RegExp(`\\b(?:${CLOSING_KEYWORDS.join("|")})\\s+#(\\d+)`, "gi");

// "Closes #12" / "Fix #12" / "Resolved #12" / ... — the issues GitHub itself
// would close on merge. A bare "#12" with no keyword does not count, and
// neither does a keyword appearing mid-word ("prefix #12") — the `\b` boundary
// before the keyword excludes both.
export function linkedIssues(body) {
  return [...new Set([...(body ?? "").matchAll(CLOSING_KEYWORD_RE)].map((m) => Number(m[1])))];
}

// `scenariosDirExists` false (never initialised) and a directory containing no
// .feature files are the same fact for `classifySuite` — this just tells them
// apart from a real read error.
export function readFeatureFiles(dir) {
  try {
    return { exists: true, files: readdirSync(dir).filter((f) => f.endsWith(".feature")) };
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return { exists: false, files: [] };
    throw err;
  }
}

// Files under `dir`, recursively — what "0 compiled traces" (#182) actually
// counts. An absent directory is 0 traces, not an error: a repo that has
// written scenarios but never compiled anything against them has not done
// anything wrong yet.
export function countTraceFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return 0;
    throw err;
  }
  let count = 0;
  for (const entry of entries) {
    count += entry.isDirectory() ? countTraceFiles(join(dir, entry.name)) : 1;
  }
  return count;
}

// A plain directory listing, empty (never an error) when `dir` is absent —
// what `resolvePackDir` needs to know what's actually vendored under `packs/`.
export function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return [];
    throw err;
  }
}

// `sha` is null (unmerged, absent) or a commit — resolved to true / false /
// null, where null means the question could not be answered (a shallow
// clone, a missing ref) and must not be read as a failure. Mirrors the
// tri-state `classifyDelivery` (ancestry.js) already expects.
export function gitCheckAncestor(sha, defaultBranch) {
  if (!sha) return null;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, `origin/${defaultBranch}`], {
      stdio: "ignore",
    });
    return true;
  } catch (err) {
    return err.status === 1 ? false : null;
  }
}

// Actually replays the suite through the e2e CLI, which owns adapter
// resolution. Invoked by absolute path (via TOOLKIT_ROOT) rather than the
// cwd-relative `scripts/e2e/cli.js` the pre-#182 code used — cwd here is the
// *consumer's* checkout, which never has a `scripts/` directory of its own.
export function runReplayViaCli({ scenariosDir, tracesDir, packDir }) {
  const raw = execFileSync(
    process.execPath,
    [E2E_CLI_PATH, "run", "--scenarios", scenariosDir, "--traces", tracesDir, "--pack", packDir],
    { encoding: "utf8" }
  );
  return JSON.parse(raw);
}

// Primary (merge-commit) and secondary (head-sha) ancestry evidence, combined
// into the single tri-state `classifyDelivery` expects. Either check landing
// on the default branch is sufficient proof of delivery — a squash merge only
// satisfies the primary, a true merge satisfies both. Only both checks
// explicitly saying "no" reads as genuinely undelivered; one indeterminate
// result must not manufacture a false alarm (ancestry.js's proceed-on-doubt
// asymmetry applies here too).
export function combineAncestry(mergeAncestor, headAncestor) {
  if (mergeAncestor === true || headAncestor === true) return true;
  if (mergeAncestor === false && headAncestor === false) return false;
  return null;
}

// The whole run, as a function of its I/O — every default is the real
// implementation; tests override the seams they need (typically `sh` and
// whatever answers the suite/pack/replay questions) without touching disk,
// git, or the network. Returns the exit code rather than calling
// `process.exit` itself, matching `scripts/gates/cli.js`'s `main`.
export function main({
  event,
  repo = process.env.GITHUB_REPOSITORY,
  sh = (args) => execFileSync("gh", args, { encoding: "utf8" }),
  log = console.log,
  err = console.error,
  checkAncestor = gitCheckAncestor,
  readFeatureFiles: readFeatureFilesFn = readFeatureFiles,
  countTraceFiles: countTraceFilesFn = countTraceFiles,
  loadConfig: loadConfigFn = loadConfig,
  listDir: listDirFn = listDir,
  runReplay = runReplayViaCli,
} = {}) {
  const pr = event.pull_request;
  if (!pr?.merged) return 0;

  const linked = linkedIssues(pr.body);
  if (linked.length === 0) {
    log("post-merge: PR closes no issue — nothing to transition");
    return 0;
  }

  // Did this merge actually deliver? A stacked merge can report success and land
  // nothing (#44) — #38, #39 and #40 all showed MERGED with none of their code on
  // main. Answer before touching any issue: a merge that delivered nothing must
  // not advance the record.
  //
  // Head-sha ancestry alone is squash-blind: a squash merge lands a synthetic
  // commit on main and the PR's own head sha never appears there at all (#125,
  // observed live on #124 — `0ef9099a` was read as "did not deliver" while
  // `87a4d6a`, the squash commit, was sitting on main the whole time). GitHub
  // sets `merge_commit_sha` correctly for every strategy (merge, squash,
  // rebase), so it is the primary evidence; head-sha ancestry stays as a
  // secondary "or" — a true merge commit satisfies both.
  const defaultBranch = event.repository?.default_branch ?? "main";
  const mergeAncestor = checkAncestor(pr.merge_commit_sha, defaultBranch);
  const headAncestor = checkAncestor(pr.head.sha, defaultBranch);
  const isAncestor = combineAncestry(mergeAncestor, headAncestor);

  const delivery = classifyDelivery({ isAncestor, headSha: pr.head.sha, defaultBranch });
  if (!delivery.proceed) {
    const finding = renderFinding({ prNumber: pr.number, classified: delivery, defaultBranch });
    for (const issue of linked) {
      sh(["issue", "comment", String(issue), "--repo", repo, "--body", finding]);
    }
    err(`post-merge: ${delivery.reason}`);
    return 10;
  }
  if (delivery.reason) log(`post-merge: ${delivery.reason}`);

  const listing = readFeatureFilesFn(SCENARIOS_DIR);
  const traceCount = countTraceFilesFn(TRACES_DIR);
  const suite = classifySuite({ scenariosDirExists: listing.exists, featureFiles: listing.files, traceCount });
  const config = loadConfigFn();

  // A vacuous suite (no scenarios, or scenarios with nothing compiled) never
  // touches pack resolution — there is nothing to replay either way, so
  // guessing at a pack would be infrastructure work in service of nothing.
  let outcome;
  if (suite.empty) {
    outcome = smokeOutcome({ suite });
  } else {
    const resolved = resolvePackDir({
      platform: config.platform,
      toolkitRoot: TOOLKIT_ROOT,
      toolkitPacks: listDirFn(join(TOOLKIT_ROOT, "packs")),
      consumerPacks: listDirFn("packs"),
    });
    if (!resolved) {
      outcome = smokeSkipped({
        suite,
        reason: `no pack resolvable for platform ${config.platform ? `"${config.platform}"` : "(none configured)"}`,
      });
    } else {
      try {
        const result = runReplay({ scenariosDir: SCENARIOS_DIR, tracesDir: TRACES_DIR, packDir: resolved.dir });
        outcome = smokeOutcome({ suite, result });
      } catch (replayErr) {
        outcome = smokeSkipped({
          suite,
          reason: `pack resolved (${resolved.dir}) but the replay could not run — ${replayErr.message}`,
        });
      }
    }
  }

  const releaseKind = resolveReleaseKind(config).kind;

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
      } catch (planErr) {
        // An item that isn't at `merged` is not a failure of the smoke run — say
        // so and leave the labels alone rather than forcing a transition.
        note += `\n\nNo transition applied: ${planErr.message}`;
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
        const stepLabels = JSON.parse(
          sh(["issue", "view", String(issue), "--repo", repo, "--json", "labels"])
        ).labels.map((l) => l.name);
        const step = planTransition(stepLabels, target, { releaseKind });
        const args = ["issue", "edit", String(issue), "--repo", repo];
        for (const label of step.add) args.push("--add-label", label);
        for (const label of step.remove) args.push("--remove-label", label);
        sh(args);
      } catch {
        break; // the passage is as complete as it can honestly be made
      }
    }

    if (closePlan.clearLabel) {
      const staleLabels = JSON.parse(sh(["issue", "view", String(issue), "--repo", repo, "--json", "labels"])).labels
        .map((l) => l.name)
        .filter((l) => l.startsWith("state:"));
      if (staleLabels.length) {
        const args = ["issue", "edit", String(issue), "--repo", repo];
        for (const label of staleLabels) args.push("--remove-label", label);
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

  log(`post-merge: ${outcome.kind} → ${outcome.status}, ${linked.length} issue(s)`);
  return outcome.status === "failed" ? 10 : 0;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  process.exit(main({ event }));
}
