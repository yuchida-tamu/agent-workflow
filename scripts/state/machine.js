// The work-item state machine. Pure: label math only, no GitHub I/O.
//
// States are encoded as `state:<name>` labels on GitHub issues; every label
// change is a webhook event that dispatches the matching stage.

export const LABEL_PREFIX = "state:";

export const STATES = [
  "idea",
  "spec",
  "planned",
  "ready",
  "in-progress",
  "in-review",
  "merged",
  "verified",
  "released",
];

// from → allowed targets. Backward edges are the bounded fix loops.
export const TRANSITIONS = {
  idea: ["spec"],
  spec: ["planned"],
  planned: ["ready"],
  ready: ["in-progress"],
  "in-progress": ["in-review", "ready"],
  "in-review": ["merged", "in-progress"],
  merged: ["verified"],
  verified: ["released"],
  released: [],
};

// Transitions that only a validated human approval may perform.
export const GATED_TRANSITIONS = {
  "idea→spec": "G1",
  "planned→ready": "G2",
  "in-review→merged": "G3",
  "verified→released": "G4",
};

// What `released` means depends on the repo, not on an assumption that every
// repo ships to a store:
//   store — submitted through the platform pack's ship adapter
//   tag   — an annotated tag and a GitHub release (libraries, toolkits)
//   none  — nothing to release; `verified` is the terminal state and G4 does
//           not apply
// This module stays dependency-free: callers resolve the kind from config (see
// `resolveReleaseKind` in init/config-schema.js) and pass it in. The default is
// deliberately a releasing kind, so every existing caller keeps its G4.
export const RELEASE_KINDS = ["store", "tag", "none"];
const DEFAULT_RELEASE_KIND = "store";

export function releasesAtAll(releaseKind = DEFAULT_RELEASE_KIND) {
  return releaseKind !== "none";
}

// The states reachable from `state` for this repo. Under `none`, `verified` is
// terminal — expressed here once, so no caller has to special-case it.
export function transitionsFrom(state, { releaseKind = DEFAULT_RELEASE_KIND } = {}) {
  const targets = TRANSITIONS[state] ?? [];
  if (state === "verified" && !releasesAtAll(releaseKind)) return [];
  return targets;
}

export function labelFor(state) {
  return LABEL_PREFIX + state;
}

export function stateFromLabels(labels) {
  const states = labels
    .filter((l) => l.startsWith(LABEL_PREFIX))
    .map((l) => l.slice(LABEL_PREFIX.length))
    .filter((s) => STATES.includes(s));
  if (states.length > 1) throw new Error(`conflicting state labels: ${states.join(", ")}`);
  return states[0] ?? null;
}

export function isValidTransition(from, to, options = {}) {
  return transitionsFrom(from, options).includes(to);
}

export function gateFor(from, to) {
  return GATED_TRANSITIONS[`${from}→${to}`] ?? null;
}

// The gate (and target state) a comment-approval on this state would satisfy.
// Under `release_kind: none` a `verified` item has no pending gate, so callers
// report "done" rather than inviting a G4 that could never be consumed.
export function pendingGateFor(state, options = {}) {
  for (const [key, gate] of Object.entries(GATED_TRANSITIONS)) {
    const [from, to] = key.split("→");
    if (from !== state) continue;
    if (!transitionsFrom(from, options).includes(to)) return null;
    return { gate, to };
  }
  return null;
}

// Compute the label edit for a transition, or throw if it's illegal.
export function planTransition(labels, to, options = {}) {
  if (!STATES.includes(to)) throw new Error(`unknown state "${to}"`);
  const from = stateFromLabels(labels);
  if (from === null) {
    if (to !== STATES[0]) throw new Error(`unlabeled item can only enter "${STATES[0]}", not "${to}"`);
    return { from: null, to, gate: null, add: [labelFor(to)], remove: [] };
  }
  if (!isValidTransition(from, to, options)) {
    const allowed = transitionsFrom(from, options).join(", ") || "none";
    const because =
      from === "verified" && to === "released" && !releasesAtAll(options.releaseKind)
        ? ` — this repo's release_kind is "none", so "verified" is terminal`
        : "";
    throw new Error(`illegal transition ${from} → ${to} (allowed: ${allowed})${because}`);
  }
  return { from, to, gate: gateFor(from, to), add: [labelFor(to)], remove: [labelFor(from)] };
}
