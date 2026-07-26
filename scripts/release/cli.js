#!/usr/bin/env node
// agentflow-release — what G4 actually does on a `release_kind: tag` repo.
//
//   agentflow-release --repo owner/name --issue N [--dry-run]
//   agentflow-release --repo owner/name --verify
//
// Creates an annotated tag and a GitHub release with generated notes, then
// transitions `verified → released`. It *consumes* a G4 approval it found and
// validated on the issue; it never mints one — see scripts/release/core.js.
//
// Exit codes: 0 released · 10 refused · 20 usage/error.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { planRelease, verifyReleased } from "./core.js";
import { loadConfig } from "../config/load.js";
import { resolveReleaseKind } from "../../init/config-schema.js";
import { LABEL_PREFIX, STATES } from "../state/machine.js";

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--verify") flags.verify = true;
    else if (arg.startsWith("--")) flags[arg.slice(2)] = argv[++i];
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));

// `--verify` asserts the invariant that `state:released` is never true of an
// item with no release behind it. Read-only, and the same shape as #44's
// ancestry check: confirm the artifact rather than trusting the transition.
if (flags.verify) {
  if (!flags.repo) {
    console.error("usage: agentflow-release --repo owner/name --verify");
    process.exit(20);
  }
  const releaseKind = resolveReleaseKind(loadConfig()).kind;
  const labelled = JSON.parse(
    execFileSync(
      "gh",
      ["issue", "list", "--repo", flags.repo, "--state", "all", "--limit", "200",
       "--label", "state:released", "--json", "number"],
      { encoding: "utf8" }
    )
  );
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  const tags = execFileSync("git", ["tag", "--list"], { encoding: "utf8" })
    .split("\n").map((t) => t.trim()).filter(Boolean);

  const result = verifyReleased({
    items: labelled.map((i) => ({ number: i.number, version })),
    tags,
    releaseKind,
  });

  if (!result.applicable) {
    console.log(`verify: release_kind is "${result.releaseKind}" — tag-based verification does not apply here.`);
    process.exit(0);
  }
  for (const f of result.findings) {
    const which = f.expectedTag ? ` (${f.expectedTag})` : "";
    console.error(`#${f.number}: labelled state:released but ${f.reason}${which}`);
  }
  console.log(
    result.findings.length
      ? `verify: ${result.findings.length} item(s) claim a release that does not exist`
      : `verify: ${labelled.length} item(s) labelled released, every one backed by a tag`
  );
  process.exit(result.findings.length ? 10 : 0);
}

if (!flags.repo || !flags.issue) {
  console.error("usage: agentflow-release --repo owner/name --issue N [--dry-run]");
  process.exit(20);
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });
const gh = (args) => sh("gh", args);

try {
  const config = loadConfig();
  const releaseKind = resolveReleaseKind(config).kind;

  const issue = JSON.parse(
    gh(["issue", "view", String(flags.issue), "--repo", flags.repo, "--json", "number,labels,state"])
  );
  const state =
    issue.labels
      .map((l) => l.name)
      .filter((l) => l.startsWith(LABEL_PREFIX))
      .map((l) => l.slice(LABEL_PREFIX.length))
      .find((s) => STATES.includes(s)) ?? null;

  const comments = JSON.parse(
    gh(["api", `repos/${flags.repo}/issues/${flags.issue}/comments`, "--jq", "[.[] | {author: .user.login, body}]"])
  );

  const existingTags = sh("git", ["tag", "--list"]).split("\n").map((t) => t.trim()).filter(Boolean);
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;

  const plan = planRelease({
    releaseKind,
    state,
    version,
    existingTags,
    comments,
    authorized: config.approvers ?? [],
  });

  if (!plan.ok) {
    console.error(`refused: ${plan.reason}`);
    process.exit(10);
  }

  const say = (line) => console.log(flags.dryRun ? `would: ${line}` : line);
  say(`tag ${plan.tag} (annotated) at HEAD`);
  say(`create GitHub release ${plan.tag} with generated notes`);
  say(`transition #${flags.issue} verified → released, on ${plan.approver}'s G4`);

  if (!flags.dryRun) {
    sh("git", ["tag", "-a", plan.tag, "-m", `Release ${plan.tag}`]);
    sh("git", ["push", "origin", plan.tag]);
    gh(["release", "create", plan.tag, "--repo", flags.repo, "--title", plan.tag, "--generate-notes"]);
    sh(process.execPath, [
      new URL("../state/cli.js", import.meta.url).pathname,
      "apply",
      "--issue",
      String(flags.issue),
      "--repo",
      flags.repo,
      "--to",
      "released",
      "--approved-gate",
      "G4",
    ]);
  }
  console.log(flags.dryRun ? `dry run: ${plan.tag} would be released` : `released ${plan.tag}`);
} catch (err) {
  console.error(err.message);
  process.exit(20);
}
