#!/usr/bin/env node
// agentflow-gates — the approval inbox. Clear a morning's pending gates from one
// terminal command.
//
//   agentflow-gates [--repo owner/name] [--all-repos] [--limit N]
//
// Lists every item waiting at G1, G2 or G4, renders the artifact the decision
// should be made against, and takes one choice per item. On approve it posts the
// standard `/approve` comment through the human's own `gh` account; the existing
// gate workflow performs the transition. **This tool never edits a state label.**
//
// Exit codes: 0 done (or nothing waiting) · 2 refused (non-interactive) · 20 usage/error.
//
// ── Why this is built shut ──────────────────────────────────────────────────
// The inbox posts approvals on a human's behalf, so its command line never
// contains "/approve". Any guard watching for minted approvals is blind to it,
// which would make this a complete bypass. So:
//
//   · it refuses when stdin is not a TTY, with no flag to override;
//   · it has no --approve/--yes/--all verb, and must never grow one;
//   · every approval costs one deliberate keystroke against one rendered
//     artifact, and an item with no artifact cannot be approved at all.
//
// The value of this tool and the shape of its worst misuse are the same motion.
// The limit has to live here.

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { buildQueue, selectArtifact, renderItem } from "./core.js";
import { loadConfig, releaseKindOf } from "../config/load.js";

// Anything unrecognised is an error, including short forms and bare words.
// Silently ignoring an unknown argument is how `-y` would appear to work: the
// caller believes they asked for something, and the tool proceeds anyway.
export function parseArgs(argv) {
  const flags = { repos: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all-repos") flags.allRepos = true;
    else if (arg === "--repo") flags.repos.push(argv[++i]);
    else if (arg === "--limit") flags.limit = Number(argv[++i]);
    else throw new Error(`unknown option "${arg}"`);
  }
  return flags;
}

// Exported so a test can assert the surface stays shut. Adding a bulk-approve
// verb should fail a test, not merely violate a comment.
export const FORBIDDEN_FLAGS = ["--approve", "--yes", "-y", "--all", "--auto", "--force", "--non-interactive"];

export function assertInteractive({ isTTY }) {
  if (isTTY) return;
  throw Object.assign(
    new Error(
      "agentflow-gates is interactive only: stdin is not a TTY.\n" +
        "Approvals must be made by a human against a rendered artifact — there is no non-interactive mode, and no flag to add one."
    ),
    { code: 2 }
  );
}

// An explicit list, never discovery. Scanning every repo a token can see is how
// an approval queue starts showing someone another team's items.
export function resolveRepos({ flags, config }) {
  if (flags.repos.length) return flags.repos;
  if (flags.allRepos) {
    const configured = config?.gate_inbox_repos ?? [];
    if (!configured.length) {
      throw new Error('--all-repos needs a "gate_inbox_repos" list in agentflow.config.json');
    }
    return configured;
  }
  return [null]; // current repo
}

const sh = (args) => execFileSync("gh", args, { encoding: "utf8" });
const repoArgs = (repo) => (repo ? ["--repo", repo] : []);

function fetchIssues(repo, limit) {
  return JSON.parse(
    sh(["issue", "list", ...repoArgs(repo), "--state", "open", "--limit", String(limit ?? 100), "--json", "number,title,labels,createdAt"])
  ).map((i) => ({ ...i, labels: i.labels.map((l) => l.name) }));
}

function fetchComments(repo, number) {
  const slug = repo ?? sh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  return JSON.parse(sh(["api", `repos/${slug}/issues/${number}/comments`, "--jq", "[.[] | {body}]"]));
}

// The state may have moved between building the queue and deciding. Approving a
// gate that is no longer pending would post an artifact nothing can consume.
function stillPending(repo, item, releaseKind) {
  const labels = JSON.parse(sh(["issue", "view", String(item.number), ...repoArgs(repo), "--json", "labels"])).labels.map(
    (l) => l.name
  );
  const [fresh] = buildQueue({ issues: [{ ...item, labels }], releaseKind });
  return fresh?.gate === item.gate;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  let rl;
  try {
    const flags = parseArgs(process.argv.slice(2));
    assertInteractive({ isTTY: process.stdin.isTTY });

    const config = loadConfig();
    const releaseKind = releaseKindOf();
    const repos = resolveRepos({ flags, config });

    const queue = [];
    for (const repo of repos) {
      for (const item of buildQueue({ issues: fetchIssues(repo, flags.limit), releaseKind })) {
        queue.push({ ...item, repo });
      }
    }

    if (queue.length === 0) {
      console.log("nothing waiting at a gate.");
      process.exit(0);
    }

    rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`${queue.length} item(s) waiting at a gate.\n`);
    let approved = 0;
    let rejected = 0;
    let skipped = 0;

    for (const item of queue) {
      const artifact = selectArtifact({ comments: fetchComments(item.repo, item.number), gate: item.gate });
      console.log("─".repeat(72));
      console.log(renderItem({ item, artifact }));
      console.log();

      if (!renderItem.approvable({ artifact })) {
        console.log("  (skip-only — there is no artifact to approve against)\n");
        skipped++;
        continue;
      }

      const answer = (await rl.question(`  ${item.gate} on #${item.number} — [a]pprove / [r]eject / [s]kip? `)).trim().toLowerCase();

      if (answer === "a") {
        if (!stillPending(item.repo, item, releaseKind)) {
          console.log(`  ⚠ #${item.number} moved since the queue was built — skipped without approving.\n`);
          skipped++;
          continue;
        }
        sh(["issue", "comment", String(item.number), ...repoArgs(item.repo), "--body", `/approve ${item.gate}`]);
        console.log(`  ✅ ${item.gate} approved on #${item.number}\n`);
        approved++;
      } else if (answer === "r") {
        let reason = "";
        while (reason === "") {
          reason = (await rl.question("  reason (required): ")).trim();
          if (reason === "") console.log("  a rejection without a reason is not useful — say what is wrong.");
        }
        sh(["issue", "comment", String(item.number), ...repoArgs(item.repo), "--body", `/reject ${reason}`]);
        console.log(`  ↩︎ rejected #${item.number}\n`);
        rejected++;
      } else {
        skipped++;
        console.log();
      }
    }

    console.log("─".repeat(72));
    console.log(`${approved} approved · ${rejected} rejected · ${skipped} skipped`);
  } catch (err) {
    console.error(err.message);
    process.exit(err.code === 2 ? 2 : 20);
  } finally {
    rl?.close();
  }
}
