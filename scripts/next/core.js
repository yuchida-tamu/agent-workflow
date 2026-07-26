// Crawl-phase dispatch: given the backlog, what should happen next?
// Pure. The CLI fetches issues via `gh`; in later phases GitHub Actions
// replaces this file's caller entirely — the dispatch table is the spec.

import { stateFromLabels } from "../state/machine.js";

export const DISPATCH = {
  idea: { actor: "agent", who: "product-shaper", action: "shape the brief, post it, then await G1 /approve" },
  spec: { actor: "agent", who: "architect", action: "produce plan + child issues; risk engine decides G2; → planned" },
  planned: { actor: "human", who: "G2", action: "approve the plan (/approve); → ready" },
  ready: { actor: "agent", who: "implementer", action: "worktree, build, self-verify, open PR; → in-progress" },
  "in-progress": { actor: "none", who: "-", action: "implementation underway — wait or continue the open task" },
  "in-review": { actor: "agent", who: "reviewers", action: "CI must be green; code+UX review; then human G3 on the PR" },
  merged: { actor: "script", who: "e2e-smoke", action: "run post-merge smoke subset; → verified" },
  verified: { actor: "human", who: "G4", action: "release when milestone ready (workflow_dispatch → environment approval)" },
  released: { actor: "none", who: "-", action: "done" },
};

// `verified` means something different per repo, so the dispatch line has to say
// what will actually happen — otherwise `agentflow-next` tells a toolkit to wait
// for a store submission that is never coming.
const VERIFIED_BY_RELEASE_KIND = {
  store: DISPATCH.verified,
  tag: { actor: "human", who: "G4", action: "approve the release; agentflow-release tags and publishes a GitHub release; → released" },
  none: { actor: "none", who: "-", action: "done — this repo has no release step (release_kind: none)" },
};

// `planned` means different things depending on what the engine said about the
// plan: a human is needed, or the transition will pass on the verdict alone.
// The dispatch line must say which, or it sends someone to a gate that isn't
// there — the table claimed "or auto-pass per risk verdict" for a long time
// while no such path existed.
const PLANNED_AUTOPASS = {
  actor: "script",
  who: "agentflow-state",
  action: "verdict requires no gate — apply `--to ready` to auto-pass; → ready",
};

export function dispatchFor(state, { releaseKind = "store", g2Authorised = null } = {}) {
  if (state === "verified") return VERIFIED_BY_RELEASE_KIND[releaseKind] ?? DISPATCH.verified;
  if (state === "planned" && g2Authorised === true) return PLANNED_AUTOPASS;
  return DISPATCH[state];
}

const ACTIONABLE = new Set(["idea", "spec", "planned", "ready", "in-review", "merged"]);

function priorityOf(labels) {
  const label = labels.find((l) => /^priority:p\d$/.test(l));
  return label ? Number(label.slice(-1)) : 9;
}

// issues: [{ number, title, labels: [names], createdAt }]
export function pickNext(issues, options = {}) {
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
    dispatch: dispatchFor(top.state, options),
    queue: candidates.length,
  };
}
