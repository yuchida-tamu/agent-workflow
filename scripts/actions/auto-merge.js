#!/usr/bin/env node
// GitHub Actions entry: a PR whose recorded verdict demands no human may merge
// itself — and must leave a record saying what authorised it.
//
// In solo mode the human's SHA-naming `/approve G3` comment is the only G3
// artifact there is. Automating the merge has to *replace* that artifact, not
// delete it: an auto-merged PR with no record would be a gate crossing nobody
// can audit, which is worse than the keystroke it saved.
//
// Env: GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GH_TOKEN.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { latestVerdict, authorises } from "../verdict/core.js";

export const MARKER = "<!-- agentflow-automerge -->";

// Pure. Every "no" names itself, because an auto-merge that silently declines is
// indistinguishable from one that never ran.
export function decideAutoMerge({ verdict, headSha, checksPassing, draft = false, mergeable = true }) {
  if (draft) return { merge: false, reason: "PR is a draft" };
  if (!mergeable) return { merge: false, reason: "PR is not mergeable (conflicts or unknown state)" };
  if (!checksPassing) return { merge: false, reason: "CI is not green" };
  if (!verdict) return { merge: false, reason: "no risk verdict recorded on this PR" };
  if (!authorises("G3", verdict, { headSha })) {
    if (!verdict.sha) {
      return { merge: false, reason: "verdict records no SHA, so it cannot be shown to describe this head" };
    }
    if (verdict.require.includes("human-merge") || verdict.block.includes("auto-merge")) {
      return {
        merge: false,
        reason: `verdict \`${verdict.level}\` requires a human merge (${verdict.require.join(", ") || "auto-merge blocked"})`,
      };
    }
    return { merge: false, reason: "verdict does not describe this head — it predates the current commit" };
  }
  return { merge: true, reason: `verdict \`${verdict.level}\` carries no obligation requiring a human` };
}

export function renderRecord({ verdict, headSha }) {
  const rules = verdict.matched.map((m) => `\`${m.pack}/${m.rule}\``).join(", ") || "no rules matched";
  return `${MARKER}
⚙️ **G3 auto-merged** — no human approval was required for this change.

| authorising verdict | |
|---|---|
| level | \`${verdict.level}\` |
| requires | ${verdict.require.join(", ") || "—"} |
| blocks | ${verdict.block.join(", ") || "—"} |
| rules | ${rules} |
| head | \`${headSha}\` |

The verdict above was computed over this exact commit. Had it required
\`human-merge\`, blocked \`auto-merge\`, described a different SHA, or been absent,
this PR would have waited for a person.`;
}

// --- I/O --------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = event.pull_request ?? event.check_suite?.pull_requests?.[0];
  if (!pr) {
    console.log("auto-merge: no pull request in this event");
    process.exit(0);
  }

  const sh = (args) => execFileSync("gh", args, { encoding: "utf8" });
  const number = pr.number;

  const view = JSON.parse(
    sh(["pr", "view", String(number), "--repo", repo, "--json", "headRefOid,isDraft,mergeable,state,statusCheckRollup"])
  );
  if (view.state !== "OPEN") {
    console.log(`auto-merge: #${number} is ${view.state}`);
    process.exit(0);
  }

  const checks = view.statusCheckRollup ?? [];
  const checksPassing =
    checks.length > 0 && checks.every((c) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion ?? c.state));

  const comments = JSON.parse(sh(["api", `repos/${repo}/issues/${number}/comments`, "--jq", "[.[] | {body}]"]));
  const verdict = latestVerdict(comments);

  const decision = decideAutoMerge({
    verdict,
    headSha: view.headRefOid,
    checksPassing,
    draft: view.isDraft,
    mergeable: view.mergeable === "MERGEABLE",
  });

  if (!decision.merge) {
    console.log(`auto-merge: #${number} left for a human — ${decision.reason}`);
    process.exit(0);
  }

  // Record first, merge second. If the merge fails the record is a harmless
  // extra comment; if the merge succeeded and the record failed, a gate would
  // have been crossed with no artifact at all.
  sh(["pr", "comment", String(number), "--repo", repo, "--body", renderRecord({ verdict, headSha: view.headRefOid })]);

  try {
    sh(["pr", "merge", String(number), "--repo", repo, "--merge", "--delete-branch"]);
  } catch {
    // A concurrent run may have merged it already. Losing that race is fine;
    // reporting a false outcome is not.
    console.log(`auto-merge: #${number} could not be merged (already merged, or raced) — no false success reported`);
    process.exit(0);
  }
  console.log(`auto-merge: #${number} merged on verdict \`${verdict.level}\``);
}
