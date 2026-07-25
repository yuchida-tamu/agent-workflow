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

function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    if (arg === "--json") flags.json = true;
    else if (arg === "--repo") flags.repo = null;
    else if (flags.repo === null) flags.repo = arg;
  }
  return flags;
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

  const next = pickNext(issues);
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
