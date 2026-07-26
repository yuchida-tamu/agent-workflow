#!/usr/bin/env node
// agentflow-next — what should the loop do next? (crawl-phase dispatcher)
//
//   agentflow-next [--repo owner/name] [--json]
//
// Reads open issues via `gh`, picks the top actionable item by priority then
// age, and prints who acts next. Exit codes: 0 something to do · 1 backlog
// idle · 20 error.

import { execFileSync } from "node:child_process";
import { pickNext } from "./core.js";
import { childrenOf } from "../hierarchy/gh.js";
import { releaseKindOf } from "../config/load.js";

function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    if (arg === "--json") flags.json = true;
    else if (arg === "--repo") flags.repo = null;
    else if (flags.repo === null) flags.repo = arg;
  }
  return flags;
}

function repoSlug() {
  return execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { encoding: "utf8" }).trim();
}

const flags = parseArgs(process.argv.slice(2));

try {
  const repoArgs = flags.repo ? ["--repo", flags.repo] : [];
  const issues = JSON.parse(
    execFileSync(
      "gh",
      ["issue", "list", ...repoArgs, "--state", "open", "--limit", "200", "--json", "number,title,labels,createdAt"],
      { encoding: "utf8" }
    )
  ).map((i) => ({ ...i, labels: i.labels.map((l) => l.name) }));

  // Resolved here (I/O) and injected, so core.js stays pure. Called at most
  // once per `ready` candidate, and only until an actionable one is found.
  const parentFactsFor = (number) => {
    try {
      const { children } = childrenOf(flags.repo ?? repoSlug(), number);
      if (!children.length) return null;
      const open = children.filter((c) => !c.closed).map((c) => c.number);
      return { hasChildren: true, allChildrenDone: open.length === 0, openChildren: open };
    } catch {
      return null; // cannot tell — treat as an ordinary item rather than block it
    }
  };

  const next = pickNext(issues, { releaseKind: releaseKindOf(), parentFactsFor });
  if (!next) {
    console.log(flags.json ? JSON.stringify({ idle: true }) : "backlog idle — nothing actionable");
    process.exit(1);
  }
  if (flags.json) {
    console.log(JSON.stringify(next, null, 2));
  } else {
    console.log(`#${next.issue} "${next.title}" [state:${next.state}, p${next.priority}]`);
    console.log(`→ ${next.dispatch.actor}:${next.dispatch.who} — ${next.dispatch.action}`);
    console.log(`(${next.queue} actionable item(s) in queue)`);
  }
} catch (err) {
  console.error(err.message);
  process.exit(20);
}
