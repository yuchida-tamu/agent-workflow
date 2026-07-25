// Crawl-phase dispatch: given the backlog, what should happen next?
// Pure. The CLI fetches issues via `gh`; in later phases GitHub Actions
// replaces this file's caller entirely — the dispatch table is the spec.

import { stateFromLabels } from "../state/machine.js";

export const DISPATCH = {
  idea: { actor: "agent", who: "product-shaper", action: "shape the brief, post it, then await G1 /approve" },
  spec: { actor: "agent", who: "architect", action: "produce plan + child issues; risk engine decides G2; → planned" },
  planned: { actor: "human", who: "G2", action: "approve the plan (/approve) or auto-pass per risk verdict; → ready" },
  ready: { actor: "agent", who: "implementer", action: "worktree, build, self-verify, open PR; → in-progress" },
  "in-progress": { actor: "none", who: "-", action: "implementation underway — wait or continue the open task" },
  "in-review": { actor: "agent", who: "reviewers", action: "CI must be green; code+UX review; then human G3 on the PR" },
  merged: { actor: "script", who: "e2e-smoke", action: "run post-merge smoke subset; → verified" },
  verified: { actor: "human", who: "G4", action: "release when milestone ready (workflow_dispatch → environment approval)" },
  released: { actor: "none", who: "-", action: "done" },
};

const ACTIONABLE = new Set(["idea", "spec", "planned", "ready", "in-review", "merged"]);

function priorityOf(labels) {
  const label = labels.find((l) => /^priority:p\d$/.test(l));
  return label ? Number(label.slice(-1)) : 9;
}

// issues: [{ number, title, labels: [names], createdAt }]
export function pickNext(issues) {
  const candidates = [];
  for (const issue of issues) {
    if (issue.labels.includes("blocked")) continue;
    let state;
    try {
      state = stateFromLabels(issue.labels);
    } catch {
      continue; // conflicting labels: surfaced by `triage`, not dispatchable
    }
    if (!state || !ACTIONABLE.has(state)) continue;
    candidates.push({ issue, state, priority: priorityOf(issue.labels) });
  }
  candidates.sort(
    (a, b) => a.priority - b.priority || Date.parse(a.issue.createdAt) - Date.parse(b.issue.createdAt)
  );
  const top = candidates[0];
  if (!top) return null;
  return {
    issue: top.issue.number,
    title: top.issue.title,
    state: top.state,
    priority: top.priority,
    dispatch: DISPATCH[top.state],
    queue: candidates.length,
  };
}
