// What a merge should leave behind on the issues it closes.
//
// Two gaps, one event. GitHub's `Closes #N` closes an issue directly, and
// nothing in the loop observes it — so the `state:*` label survives (#70), and
// no record of who approved the merge is written (21 of 28 merged PRs carried
// none). `parent-close --sweep` has been cleaning up after the first, but only
// when a human remembers to run it.
//
// Pure: given the issue's labels and the PR's facts, decide what to write and
// which transitions to apply. The handler performs them.

import { STATES, LABEL_PREFIX } from "../state/machine.js";

export const MARKER = "<!-- agentflow-merge-record -->";

export function stateOf(labels) {
  return (
    (labels ?? [])
      .filter((l) => l.startsWith(LABEL_PREFIX))
      .map((l) => l.slice(LABEL_PREFIX.length))
      .find((s) => STATES.includes(s)) ?? null
  );
}

// An item closed by a merge should end with a *complete* passage, not a
// truncated one: `in-review → (closed)` leaves no record of reaching `merged`
// or `verified`, and the ledger audit would rightly call that a gap.
//
// Where the item is not at `in-review`, we record what we found rather than
// forcing it through states it never occupied. A truthful gap beats an invented
// history.
export function planMergeClose({ labels, closedByMerge = true }) {
  const state = stateOf(labels);
  if (!closedByMerge) return { transitions: [], clearLabel: false, note: null };
  if (state === null) {
    return { transitions: [], clearLabel: false, note: "no state label to complete or clear" };
  }
  if (state === "in-review") {
    return { transitions: ["merged", "verified"], clearLabel: true, note: null };
  }
  if (state === "merged") {
    return { transitions: ["verified"], clearLabel: true, note: null };
  }
  return {
    transitions: [],
    clearLabel: true,
    note: `closed at \`${state}\`, which is not a state a merge completes — label cleared, passage left as it was rather than invented`,
  };
}

// The G3 observation.
//
// This is the sharpest edge in the change: it must never be shaped like
// `/approve G3`. That string is a *human's assertion* and the gate validator
// accepts it. Anything the loop writes is an *observation* — "this merged, by
// whom, at which commit" — and conflating the two would let the loop
// manufacture its own approvals, which every guard in this repo exists to
// prevent.
export function renderMergeRecord({ prNumber, mergedBy, headSha, plan }) {
  const passage = plan.transitions.length
    ? `Completed: ${plan.transitions.map((t) => `\`${t}\``).join(" → ")}.`
    : plan.note
      ? `No transition applied — ${plan.note}.`
      : "No transition applied.";
  return `${MARKER}
📦 **Merged via #${prNumber}** by @${mergedBy} at \`${headSha?.slice(0, 8) ?? "unknown"}\`.

${passage}

This is an observation of what happened, not an approval. G3 is a human's
\`/approve G3\` comment on the PR; this record neither substitutes for one nor
counts as one.`;
}
