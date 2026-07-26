// The approval inbox's pure half: what is waiting, what artifact belongs to it,
// and how one item reads in a terminal. No `gh`, no prompting, no TTY.
//
// The inbox is an interface, not a gate. It must be deletable without changing
// what an approval is — so nothing here decides authority, and nothing here
// transitions anything.

import { pendingGateFor, stateFromLabels } from "../state/machine.js";

// G3 is absent deliberately: it is PR-native (native review, or in solo mode a
// SHA-naming comment on the PR plus the merge). Listing it here would invite
// approving a merge from a queue that cannot see the diff.
export const INBOX_GATES = ["G1", "G2", "G4"];

// Which artifact a human should be looking at when they answer each gate.
const ARTIFACT_HEADING = {
  G1: "## Brief",
  G2: "## Plan",
  G4: "## Release",
};

const GATE_ORDER = new Map(INBOX_GATES.map((g, i) => [g, i]));

function priorityOf(labels) {
  const label = (labels ?? []).find((l) => /^priority:p\d$/.test(l));
  return label ? Number(label.slice(-1)) : 9;
}

// issues: [{ number, title, labels: [names], createdAt }]
// `pendingGateFor` is the single source of truth for "waiting at a gate" — the
// inbox inherits it rather than re-deriving it, so the two cannot disagree.
export function buildQueue({ issues, releaseKind = "store" } = {}) {
  const items = [];
  for (const issue of issues ?? []) {
    let state;
    try {
      state = stateFromLabels(issue.labels ?? []);
    } catch {
      continue; // conflicting labels: triage's problem, not the inbox's
    }
    if (!state) continue;
    const pending = pendingGateFor(state, { releaseKind });
    if (!pending || !INBOX_GATES.includes(pending.gate)) continue;
    items.push({
      number: issue.number,
      title: issue.title,
      state,
      gate: pending.gate,
      to: pending.to,
      priority: priorityOf(issue.labels),
      createdAt: issue.createdAt,
    });
  }
  items.sort(
    (a, b) =>
      GATE_ORDER.get(a.gate) - GATE_ORDER.get(b.gate) ||
      a.priority - b.priority ||
      Date.parse(a.createdAt ?? 0) - Date.parse(b.createdAt ?? 0) ||
      a.number - b.number
  );
  return items;
}

// The most recent comment whose body *starts* with the gate's heading. Matching
// mid-line would let a comment that merely mentions "## Brief" masquerade as one.
export function selectArtifact({ comments, gate }) {
  const heading = ARTIFACT_HEADING[gate];
  if (!heading) return null;
  const matches = (comments ?? []).filter((c) => (c?.body ?? "").trimStart().startsWith(heading));
  return matches.length ? matches[matches.length - 1] : null;
}

// An item with no artifact must never be presented as approvable: approving a
// brief nobody wrote is the failure an inbox would otherwise industrialise.
function approvable({ artifact }) {
  return Boolean(artifact);
}

export function renderItem({ item, artifact, maxLines = 60 }) {
  const header = `#${item.number} · ${item.title}\n${item.gate} — \`${item.state}\` → \`${item.to}\` (p${item.priority})`;
  if (!artifact) {
    return `${header}\n\n  ⚠ no ${ARTIFACT_HEADING[item.gate] ?? "artifact"} comment on this issue — nothing to approve against; skip it and find out why.`;
  }
  const lines = artifact.body.split("\n");
  if (lines.length <= maxLines) return `${header}\n\n${artifact.body}`;
  const shown = lines.slice(0, maxLines).join("\n");
  const rest = lines.length - maxLines;
  return `${header}\n\n${shown}\n\n  … ${rest} more lines — open #${item.number} to read the rest before deciding.`;
}

renderItem.approvable = approvable;
