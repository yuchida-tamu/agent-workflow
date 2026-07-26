#!/usr/bin/env node
// agentflow-log — the run ledger's I/O half.
//
//   agentflow-log start --issue N --run <id> --phase <p> --agent <a> --model <m> [--session <s>] [--repo owner/name]
//   agentflow-log end   --issue N --run <id> --outcome <ok|failed|abandoned> [--repo owner/name]
//   agentflow-log audit --repo owner/name [--issue N] [--since <date>]
//
// One ledger comment per work item, updated in place — the same marker pattern
// the risk verdict uses. `audit` compares each row's model against the tier its
// agent definition declares, so routing policy has one source of truth: the
// roster itself.
//
// `--since <date>` scopes the audit to issues *created* on or after that date
// (any string `Date` can parse — an ISO date or timestamp). The ledger did not
// exist before it shipped, so every item merged before then (#30–#69 in this
// repo) has zero ledger rows for phases it genuinely passed through — not a
// real gap, just history the ledger never had a chance to log. Cutoff is by
// issue creation, not by ledger row timestamp: a pre-ledger issue has no rows
// to filter *by* date, so the only way to keep it from reporting a permanent
// "gap" finding is to exclude the issue itself. An issue created before the
// cutoff is skipped entirely — from tier-violation findings as well as gap
// findings — and does not count toward the item total. Without `--since`,
// every issue is audited exactly as before.
//
// Exit codes: 0 ok (audit: no findings) · 10 findings · 20 usage/error.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKER, render, parse, upsert, audit } from "./ledger.js";
import { LABEL_PREFIX, STATES } from "../state/machine.js";
import { parentOf, childrenOf } from "../hierarchy/gh.js";
import { parentFromText } from "../hierarchy/core.js";

const TOOLKIT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUTCOMES = ["ok", "failed", "abandoned"];

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
  }
  return flags;
}

const sh = (args) => execFileSync("gh", args, { encoding: "utf8" });
const repoArgs = (repo) => (repo ? ["--repo", repo] : []);

// The declared tier of every agent, read from the definitions themselves.
export function loadTiers(agentsDir = join(TOOLKIT, "agents")) {
  const tiers = {};
  for (const file of readdirSync(agentsDir).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(agentsDir, file), "utf8");
    const name = text.match(/^name:\s*(\S+)\s*$/m)?.[1] ?? file.replace(/\.md$/, "");
    const model = text.match(/^model:\s*(\S+)\s*$/m)?.[1] ?? null;
    if (model) tiers[name] = model;
  }
  return tiers;
}

// Every issue number that at least one already-fetched issue declares itself
// a child of, via `Child of #N` (scripts/hierarchy/core.js's `parentFromText`
// — reused rather than a second regex, so this can never disagree with the
// hierarchy reader's own text convention).
//
// This only sees the text convention: a parent whose children are linked
// solely through the native sub-issues API, with no `Child of #N` fallback
// line, will not appear here. That gap is accepted deliberately for the
// whole-repo audit walk — `childrenOf` per issue would answer it fully, but
// its fallback path hits the Search API (30 req/min) once per childless
// issue, and a ~65-issue repo trips that limit and aborts the audit
// partway through (see the #101/#105 PR review). The single-issue path
// (`--issue`) only ever makes that one call, so it keeps asking `childrenOf`
// directly for the complete answer.
export function parentsWithDeclaredChildren(issues) {
  return new Set(
    (issues ?? [])
      .map((issue) => parentFromText(issue.body))
      .filter((number) => number !== null)
  );
}

function findLedger(repo, issue) {
  const comments = JSON.parse(
    sh(["api", `repos/${repo}/issues/${issue}/comments`, "--jq", "[.[] | {id, body}]"])
  );
  return comments.find((c) => c.body.startsWith(MARKER)) ?? null;
}

function writeLedger(repo, issue, existing, body) {
  if (existing) {
    sh(["api", "--method", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`]);
  } else {
    sh(["issue", "comment", String(issue), ...repoArgs(repo), "--body", body]);
  }
}

// Read-modify-write on a single comment can lose a concurrent writer's row.
// There is no compare-and-swap on the comments API, so: re-read immediately
// before writing, and if the body moved under us, re-apply to the fresh rows
// and try once more. The crawl phase is sequential, so this is a guard rather
// than a hot path — but a lost ledger row would be invisible, which is exactly
// the failure the ledger exists to prevent.
function applyEntry(repo, issue, entry) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = findLedger(repo, issue);
    const rows = upsert(parse(existing?.body ?? ""), entry);
    const body = render(rows);
    const stillThere = findLedger(repo, issue);
    if ((stillThere?.body ?? "") !== (existing?.body ?? "")) continue; // moved — retry
    writeLedger(repo, issue, existing, body);
    return rows;
  }
  throw new Error("ledger comment kept changing under concurrent writers — retry");
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function usage(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

// Parse `--since` into a Date, or `null` when the flag is absent — the
// signal `filterSince` reads as "no cutoff, audit everything" so omitting
// the flag reproduces today's behaviour exactly. Exported so the cutoff
// logic is unit-testable without shelling out to `gh`.
export function parseSince(value) {
  if (value === undefined || value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw usage(`--since must be a parseable date, got "${value}"`);
  return date;
}

// Drop issues created before the cutoff. `cutoff === null` is the identity —
// the shape `parseSince` returns for an absent `--since` — so a caller that
// always routes through both functions gets unchanged behaviour for free
// rather than needing a separate no-flag branch.
export function filterSince(issues, cutoff) {
  if (cutoff === null) return issues;
  return issues.filter((issue) => new Date(issue.createdAt) >= cutoff);
}

// `loadTiers` is imported by the tests, so the command body must not run on
// import — only when this file is the entry point.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);

  try {
    switch (command) {
      case "start": {
        if (!flags.issue || !flags.run || !flags.phase || !flags.agent || !flags.model) {
          throw usage("start needs --issue --run --phase --agent --model");
        }
        applyEntry(flags.repo, flags.issue, {
          kind: "start",
          run: flags.run,
          phase: flags.phase,
          agent: flags.agent,
          model: flags.model,
          session: flags.session ?? null,
          started: flags.started ?? now(),
        });
        console.log(`ledger #${flags.issue}: opened ${flags.run} (${flags.agent}/${flags.model} @ ${flags.phase})`);
        break;
      }
      case "end": {
        if (!flags.issue || !flags.run || !flags.outcome) throw usage("end needs --issue --run --outcome");
        if (!OUTCOMES.includes(flags.outcome)) {
          throw usage(`--outcome must be one of ${OUTCOMES.join(", ")}`);
        }
        applyEntry(flags.repo, flags.issue, {
          kind: "end",
          run: flags.run,
          ended: flags.ended ?? now(),
          outcome: flags.outcome,
        });
        console.log(`ledger #${flags.issue}: closed ${flags.run} (${flags.outcome})`);
        break;
      }
      case "audit": {
        if (!flags.repo) throw usage("audit needs --repo owner/name");
        const since = parseSince(flags.since);
        const tiers = loadTiers();
        const fields = "number,labels,body,createdAt";
        const fetched = flags.issue
          ? [JSON.parse(sh(["issue", "view", flags.issue, "--repo", flags.repo, "--json", fields]))]
          : JSON.parse(
              sh(["issue", "list", "--repo", flags.repo, "--state", "all", "--limit", "200", "--json", fields])
            );
        const issues = filterSince(fetched, since);
        // Only meaningful for the whole-repo walk — see parentsWithDeclaredChildren.
        //
        // Computed AFTER filterSince, deliberately: children are always
        // *derived from what declares the parent* (see CLAUDE.md) — the
        // architect mints a child from an already-approved parent, so a
        // child's createdAt can never precede its parent's. That means a
        // parent that survives the --since cutoff has every one of its
        // declared children survive it too, so scanning the filtered list
        // cannot miss a real parent↔child link for any issue this run
        // actually audits below. A parent that does NOT survive the cutoff
        // never reaches the loop at all — whether it would have shown up
        // here is moot, since it asks no question this audit answers.
        const declaredParents = flags.issue ? null : parentsWithDeclaredChildren(issues);

        let findings = 0;
        for (const issue of issues) {
          const labels = issue.labels.map((l) => l.name);
          const state =
            labels
              .filter((l) => l.startsWith(LABEL_PREFIX))
              .map((l) => l.slice(LABEL_PREFIX.length))
              .find((s) => STATES.includes(s)) ?? null;
          const ledger = findLedger(flags.repo, issue.number);
          const rows = parse(ledger?.body ?? "");
          // A child is born at `ready`; its shaping and planning are logged on
          // the parent, so they are not this item's gaps to answer for. Asked
          // through the hierarchy reader, which prefers the sub-issue relation
          // and falls back to the `Child of #N` declaration.
          const hasParent = parentOf(flags.repo, issue.number, { body: issue.body }).parent !== null;
          // A parent delegates ready→merged to its children and lands on
          // `verified` directly (see `PARENT_COMPLETION` in machine.js), so it
          // never logs the implementer row that phase would normally require.
          // Whole-repo walk: answered locally from bodies already in hand (see
          // parentsWithDeclaredChildren). Single issue: no other bodies are in
          // scope, so ask the hierarchy reader directly — one call either way.
          const hasChildren = declaredParents
            ? declaredParents.has(issue.number)
            : childrenOf(flags.repo, issue.number).children.length > 0;
          for (const finding of audit({ rows, tiers, state, hasParent, hasChildren })) {
            findings++;
            const detail =
              finding.kind === "violation"
                ? `${finding.agent} ran on ${finding.actual}, declared ${finding.expected} (run ${finding.run})`
                : finding.kind === "unknown-agent"
                  ? `row names "${finding.agent}", which has no definition (run ${finding.run})`
                  : `reached \`${finding.state}\` with no ${finding.agent} row for phase \`${finding.phase}\``;
            console.log(`#${issue.number} ${finding.kind}: ${detail}`);
          }
        }
        console.log(
          findings === 0
            ? `audit: ${issues.length} item(s), no findings`
            : `audit: ${findings} finding(s) across ${issues.length} item(s)`
        );
        process.exit(findings === 0 ? 0 : 10);
      }
      default:
        throw usage("usage: agentflow-log <start|end|audit> …");
    }
  } catch (err) {
    console.error(err.message);
    process.exit(20);
  }
}
