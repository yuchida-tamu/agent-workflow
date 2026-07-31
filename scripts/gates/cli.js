#!/usr/bin/env node
// agentflow-gates — the approval inbox's front door.
//
//   agentflow-gates [--repo owner/name] [--limit N]
//   agentflow-gates --approve <issue> [--repo owner/name]
//   agentflow-gates --reject <issue> --reason "<why>" [--repo owner/name]
//   agentflow-gates --help
//
// Default: lists every open item waiting at G1 (brief), G2 (plan) or G4
// (release) with a compact excerpt of the artifact the decision is made
// against — the heading and headline of the brief/plan/release comment, not
// the whole thing (see `renderItem` in ./core.js, the tested module this CLI
// is a thin wrapper over).
//
// --approve / --reject post the *standard* `/approve` or `/reject` comment
// through the caller's own `gh` account. The comment IS the artifact — the
// `agentflow · gate` workflow validates it and performs the transition. This
// tool posts only; it never edits a state label itself, and it re-reads the
// issue immediately before posting so it never approves a gate that already
// moved out from under it. Posting is not approving: the workflow separately
// checks that the poster is on the target repo's `approvers` list, and
// refuses (silently, from this tool's point of view — it only knows it
// posted) if not. "posted" is the honest claim; "approved" would not be.
//
// G3 (merge) is deliberately absent from both the listing and --approve/
// --reject — see INBOX_GATES in ./core.js. G3 is PR-native (a real review, or
// in solo-comment mode a SHA-naming comment on the PR): listing it here would
// invite approving a merge from a queue that cannot show the diff.
//
// This is the flag-driven, scriptable half of gate approval — useful for
// clearing a morning's queue from one terminal command (#41). The primary UX
// per CLAUDE.md is still an agent's in-session multi-choice with the human;
// this CLI posts whatever was already decided, it does not replace that
// conversation.
//
// Exit codes: 0 ok (including "nothing waiting") · 10 refused (not pending /
// no artifact / missing reason) · 20 usage.

import { execFileSync } from "node:child_process";
import { buildQueue, selectArtifact, renderItem } from "./core.js";
import { releaseKindOf } from "../config/load.js";
import { resolveReleaseKind } from "../../init/config-schema.js";

export const USAGE = `usage:
  agentflow-gates [--repo owner/name] [--limit N]
  agentflow-gates --approve <issue> [--repo owner/name]
  agentflow-gates --reject <issue> --reason "<why>" [--repo owner/name]

Lists items waiting at G1 (brief) / G2 (plan) / G4 (release). G3 (merge) is
excluded by design — it is PR-native, not inbox-native: a real review, or in
solo-comment mode a SHA-naming comment on the PR. Approving it from a queue
that cannot show the diff is exactly the mistake this tool refuses to invite.

--approve/--reject post the standard /approve or /reject comment through your
own \`gh\` account; the gate workflow validates it and performs the transition.
This tool only posts — it never edits a state label. Posting is not the same
as approving: the workflow separately checks that you are on the target
repo's approvers list and refuses the comment if not — a non-approver's
--approve still reports "posted", because that is all this tool did.`;

// Anything unrecognised is an error, including bare positional words — a
// silently-ignored flag is how a caller believes they asked for something
// while the tool quietly does something else.
export function parseArgs(argv) {
  const flags = { limit: 100 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--repo") flags.repo = argv[++i];
    else if (arg === "--limit") flags.limit = Number(argv[++i]);
    else if (arg === "--approve") flags.approve = argv[++i];
    else if (arg === "--reject") flags.reject = argv[++i];
    else if (arg === "--reason") flags.reason = argv[++i];
    else throw new Error(`unknown option "${arg}"`);
  }
  return flags;
}

const defaultSh = (args) => execFileSync("gh", args, { encoding: "utf8" });
const repoArgs = (repo) => (repo ? ["--repo", repo] : []);

// --- gh reads, kept thin and injectable so tests never spawn `gh` ----------

export function fetchIssues(sh, repo, limit) {
  const raw = JSON.parse(
    sh(["issue", "list", ...repoArgs(repo), "--state", "open", "--limit", String(limit ?? 100), "--json", "number,title,labels,createdAt"])
  );
  return raw.map((i) => ({ ...i, labels: (i.labels ?? []).map((l) => l.name) }));
}

// One read for both "is this still pending" and "what does the artifact say"
// — a single view avoids the two questions being answered from two different
// moments in the issue's history.
export function fetchIssueWithComments(sh, repo, number) {
  const raw = JSON.parse(
    sh(["issue", "view", String(number), ...repoArgs(repo), "--json", "number,title,labels,createdAt,comments"])
  );
  const issue = { number: raw.number, title: raw.title, labels: (raw.labels ?? []).map((l) => l.name), createdAt: raw.createdAt };
  const comments = (raw.comments ?? []).map((c) => ({ body: c.body, author: c.author?.login ?? c.author ?? null }));
  return { issue, comments };
}

// The local checkout's own repo, or null if that can't be determined (not a
// GitHub repo, no `gh` auth, etc.) — used only to decide whether `--repo`
// points somewhere else, never as a fallback identity for anything else.
function localRepoSlug(sh) {
  try {
    return sh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim() || null;
  } catch {
    return null;
  }
}

const normalizeRepoSlug = (slug) => (slug ?? "").trim().toLowerCase();

// `release_kind` decides whether G4 exists at all (buildQueue). It must come
// from the repo the queue is actually *about*, not from whatever
// agentflow.config.json happens to sit in the caller's cwd — those are the
// same file only when `--repo` is omitted or names the local checkout. Read
// the target repo's own config over the API so a cross-repo `--repo` never
// borrows a release_kind that belongs to a different project.
export function resolveRemoteReleaseKind({ sh, repo }) {
  const raw = sh(["api", `repos/${repo}/contents/agentflow.config.json`, "--jq", ".content"]);
  const config = JSON.parse(Buffer.from(raw.trim(), "base64").toString("utf8"));
  return resolveReleaseKind(config).kind;
}

// Local cwd's config when `--repo` is absent or names the local checkout;
// otherwise the *target* repo's own config, with a printed note and a
// fall-back to the local file only when the remote one can't be read (repo
// has no agentflow.config.json yet, no `gh` access to it, etc.) — a silent
// fallback here would be exactly the bug this fixes, just harder to notice.
export function resolveReleaseKindFor({ sh, repo, log = () => {} }) {
  if (!repo) return releaseKindOf();
  const local = localRepoSlug(sh);
  if (local && normalizeRepoSlug(local) === normalizeRepoSlug(repo)) {
    return releaseKindOf();
  }
  try {
    return resolveRemoteReleaseKind({ sh, repo });
  } catch {
    log(
      `note: could not read agentflow.config.json from ${repo} — falling back to the local checkout's ` +
        `release_kind to decide whether G4 applies there. This may mis-queue G4 if the two repos differ.`
    );
    return releaseKindOf();
  }
}

// --- the pure-ish operations, mockable via `sh` -----------------------------

// A compact excerpt per item: `renderItem` already knows how to show a
// heading and truncate — reusing it (rather than re-deriving an excerpt) is
// what keeps this CLI thin over the tested core.
export function listInbox({ sh, repo, releaseKind, limit, excerptLines = 5 }) {
  const issues = fetchIssues(sh, repo, limit);
  const queue = buildQueue({ issues, releaseKind });
  return queue.map((item) => {
    const { comments } = fetchIssueWithComments(sh, repo, item.number);
    const artifact = selectArtifact({ comments, gate: item.gate });
    return { item, artifact, excerpt: renderItem({ item, artifact, maxLines: excerptLines }) };
  });
}

function refuse(message) {
  return Object.assign(new Error(message), { code: 10 });
}

// Re-reads the issue right before posting: the queue a human is looking at
// may be minutes old, and posting `/approve` on a gate that already moved
// would leave an artifact nothing can consume.
export function approve({ sh, repo, issue, releaseKind }) {
  const { issue: fresh, comments } = fetchIssueWithComments(sh, repo, issue);
  const [pending] = buildQueue({ issues: [fresh], releaseKind });
  if (!pending) {
    throw refuse(`#${issue} is not waiting at an inbox gate (G1/G2/G4) right now.`);
  }
  const artifact = selectArtifact({ comments, gate: pending.gate });
  if (!renderItem.approvable({ artifact })) {
    throw refuse(`#${issue}: no ${pending.gate} artifact comment found on the issue — nothing to approve against.`);
  }
  sh(["issue", "comment", String(issue), ...repoArgs(repo), "--body", `/approve ${pending.gate}`]);
  return { gate: pending.gate };
}

export function reject({ sh, repo, issue, reason, releaseKind }) {
  if (!reason || !reason.trim()) {
    throw refuse('--reject requires --reason "<why>" — a rejection without a reason is not useful.');
  }
  const { issue: fresh } = fetchIssueWithComments(sh, repo, issue);
  const [pending] = buildQueue({ issues: [fresh], releaseKind });
  if (!pending) {
    throw refuse(`#${issue} is not waiting at an inbox gate (G1/G2/G4) right now.`);
  }
  sh(["issue", "comment", String(issue), ...repoArgs(repo), "--body", `/reject ${reason}`]);
  return { gate: pending.gate };
}

// --- the entry point, injectable for tests ----------------------------------

export function main(argv, { sh = defaultSh, log = console.log, err = console.error } = {}) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (e) {
    err(e.message);
    err(USAGE);
    return 20;
  }

  if (flags.help) {
    log(USAGE);
    return 0;
  }
  if (flags.approve && flags.reject) {
    err("choose one of --approve or --reject, not both.");
    return 20;
  }

  const releaseKind = resolveReleaseKindFor({ sh, repo: flags.repo, log });

  try {
    if (flags.approve) {
      const { gate } = approve({ sh, repo: flags.repo, issue: flags.approve, releaseKind });
      log(`posted /approve ${gate} on #${flags.approve} — the gate workflow validates and applies it.`);
      return 0;
    }
    if (flags.reject) {
      const { gate } = reject({ sh, repo: flags.repo, issue: flags.reject, reason: flags.reason, releaseKind });
      log(`posted /reject on #${flags.reject} (was waiting at ${gate}).`);
      return 0;
    }

    const rows = listInbox({ sh, repo: flags.repo, releaseKind, limit: flags.limit });
    if (rows.length === 0) {
      log("nothing waiting at a gate.");
      return 0;
    }
    log(`${rows.length} item(s) waiting at a gate (G1/G2/G4 — G3 is PR-native and never listed here).\n`);
    rows.forEach((row, i) => {
      if (i > 0) log("─".repeat(72));
      log(row.excerpt);
      log("");
    });
    const repoFlag = flags.repo ? ` --repo ${flags.repo}` : "";
    log(`approve:  agentflow-gates --approve <issue>${repoFlag}`);
    log(`reject:   agentflow-gates --reject <issue> --reason "..."${repoFlag}`);
    return 0;
  } catch (e) {
    err(e.message);
    return e.code ?? 20;
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
