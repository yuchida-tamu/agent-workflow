#!/usr/bin/env node
// GitHub Actions entry: issue_comment.created → validate gate approval →
// apply the state transition. Thin glue over tested modules; exits 0 on
// "nothing to do" so ordinary comments never fail the workflow.
//
// Env: GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GH_TOKEN.
// The consuming repo is checked out as the working directory (for
// agentflow.config.json).

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { parseCommand, validateApproval, approvalTransitions } from "../gate/validator.js";
import { labelFor, pendingGateFor, stateFromLabels } from "../state/machine.js";
import { resolveReleaseKind } from "../../init/config-schema.js";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const repo = process.env.GITHUB_REPOSITORY;
const gh = (args) => execFileSync("gh", args, { encoding: "utf8" });
const comment = (body) =>
  gh(["issue", "comment", String(event.issue.number), "--repo", repo, "--body", body]);

const body = event.comment?.body ?? "";
const author = event.comment?.user?.login ?? "";
const parsed = parseCommand(body);
if (!parsed) process.exit(0); // not a gate command

const labels = event.issue.labels.map((l) => l.name);
const state = stateFromLabels(labels);
const pending = state && pendingGateFor(state);
if (!pending) {
  comment(`agentflow: nothing to approve — \`state:${state ?? "none"}\` has no pending gate.`);
  process.exit(0);
}

const config = existsSync("agentflow.config.json")
  ? JSON.parse(readFileSync("agentflow.config.json", "utf8"))
  : {};
const verdict = validateApproval({
  author,
  body,
  authorized: config.approvers ?? [],
  expectedGate: pending.gate,
});

if (verdict.rejected) {
  comment(`agentflow: **${pending.gate} rejected** by @${author} — ${verdict.reason}. The item stays in \`state:${state}\`; revise and re-request approval.`);
  process.exit(0);
}
if (!verdict.ok) {
  comment(`agentflow: ${pending.gate} approval not accepted — ${verdict.reason}.`);
  process.exit(0);
}

// G4 is the one gate whose approval is not itself the act. G1 and G2 approve a
// document, so the transition IS the outcome. G4 approves a *release* that has
// not happened yet — moving the label here would assert a release that does not
// exist, and would lock agentflow-release out, since it requires `verified`.
// The label follows the artifact; agentflow-release applies it once the tag and
// the GitHub release exist.
const releaseKind = resolveReleaseKind(config).kind;
if (!approvalTransitions({ gate: pending.gate, releaseKind })) {
  comment(
    `agentflow: ✅ **G4 approved** by @${author} — the release is authorised.\n\n` +
      `The label stays \`state:${state}\` until the release exists. Run:\n\n` +
      `\`\`\`sh\nagentflow-release --repo ${repo} --issue ${event.issue.number}\n\`\`\`\n\n` +
      `It will find and validate this approval, cut the tag and the GitHub release, and only then transition to \`state:released\`.`
  );
  process.exit(0);
}

gh([
  "issue", "edit", String(event.issue.number), "--repo", repo,
  "--add-label", labelFor(pending.to),
  "--remove-label", labelFor(state),
]);
comment(`agentflow: ✅ **${pending.gate} approved** by @${author} — \`state:${state}\` → \`state:${pending.to}\`.`);
