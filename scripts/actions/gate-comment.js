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
import { labelFor, pendingGateFor, stateFromLabels, resolveApply } from "../state/machine.js";
import { resolveReleaseKind } from "../../init/config-schema.js";

// Pure: narrate one CAS outcome (`resolveApply`, scripts/state/machine.js)
// for the issue comment this driver posts. Kept separate from the CLI's own
// `describeApply` (scripts/state/cli.js) because the two drivers report
// differently — this one writes a sentence for a human to read on the issue,
// the CLI prints JSON for a script to parse — but the underlying
// compare-and-swap decision, `resolveApply`, is the one seam both share.
export function renderApprovalComment({ gate, plan, author, resolution }) {
  if (resolution.action === "noop") {
    return `agentflow: \`${gate}\` was already approved by another driver — \`state:${plan.to}\` is already present. No change made.`;
  }
  if (resolution.action === "heal") {
    return (
      `agentflow: ✅ **${gate} approved** by @${author} — \`state:${plan.from}\` → \`state:${plan.to}\`.\n\n` +
      `Two drivers had raced this transition: both \`state:${plan.from}\` and \`state:${plan.to}\` were present on the issue. The stale \`state:${plan.from}\` has been removed.`
    );
  }
  return `agentflow: ✅ **${gate} approved** by @${author} — \`state:${plan.from}\` → \`state:${plan.to}\`.`;
}

// --- I/O ----------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
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
    // Passed explicitly rather than left to default. This workflow is filtered to
    // issue comments, so the bot carve-out is unreachable here by construction —
    // stating that at the call site is what keeps it true after an edit.
    authorType: event.comment?.user?.type ?? null,
    surface: "issue",
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

  // Compare-and-swap. `labels`/`state`/`pending` above came from the webhook
  // event's payload — a snapshot from whenever the comment was posted. This
  // job can run well after that (queued, or slow to start), and a second
  // driver — the manual CLI, most often; scripts/state/cli.js — can have
  // already applied this exact transition, or carried the issue further
  // still, in the meantime. Re-reading labels right here, immediately before
  // the edit, and asking `resolveApply` what to do with them is what stops
  // this driver from writing a label edit computed against a state that no
  // longer holds — the exact corruption #126 observed live on #119, where
  // this workflow added `state:spec` back onto an issue the CLI had already
  // carried to `state:ready`, leaving both labels stacked.
  const plan = { from: state, to: pending.to, add: [labelFor(pending.to)], remove: [labelFor(state)] };
  const freshLabels = JSON.parse(
    gh(["issue", "view", String(event.issue.number), "--repo", repo, "--json", "labels"])
  ).labels.map((l) => l.name);

  let resolution;
  try {
    resolution = resolveApply(freshLabels, plan);
  } catch (err) {
    comment(`agentflow: could not apply ${pending.gate} — ${err.message}. Another driver appears to have already moved this issue; re-request approval if it still needs one.`);
    process.exit(0);
  }

  if (resolution.action !== "noop") {
    const editArgs = ["issue", "edit", String(event.issue.number), "--repo", repo];
    for (const l of resolution.add ?? []) editArgs.push("--add-label", l);
    for (const l of resolution.remove ?? []) editArgs.push("--remove-label", l);
    gh(editArgs);
  }
  comment(renderApprovalComment({ gate: pending.gate, plan, author, resolution }));
}
