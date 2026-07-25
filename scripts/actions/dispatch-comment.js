#!/usr/bin/env node
// GitHub Actions entry: issues.labeled with a state:* label → post/update the
// dispatch line on the issue so it's always visible who (or what) acts next.
// Crawl-phase visibility; headless agent launching replaces the "agent:" rows
// in Phase 3.
//
// Env: GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GH_TOKEN.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DISPATCH } from "../next/core.js";
import { LABEL_PREFIX } from "../state/machine.js";

const MARKER = "<!-- agentflow-dispatch -->";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const label = event.label?.name ?? "";
if (!label.startsWith(LABEL_PREFIX)) process.exit(0);

const state = label.slice(LABEL_PREFIX.length);
const dispatch = DISPATCH[state];
if (!dispatch || dispatch.actor === "none") process.exit(0);

const repo = process.env.GITHUB_REPOSITORY;
const issue = String(event.issue.number);
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });

const body = `${MARKER}
**agentflow next:** \`${dispatch.actor}:${dispatch.who}\` — ${dispatch.action}`;

const existing = JSON.parse(
  sh("gh", ["api", `repos/${repo}/issues/${issue}/comments`, "--jq", "[.[] | {id, body}]"])
).find((c) => c.body.startsWith(MARKER));
if (existing) {
  sh("gh", ["api", "--method", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`]);
} else {
  sh("gh", ["issue", "comment", issue, "--repo", repo, "--body", body]);
}
console.log(`dispatched: state:${state} → ${dispatch.actor}:${dispatch.who}`);
