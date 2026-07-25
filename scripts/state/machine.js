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

export function isValidTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function gateFor(from, to) {
  return GATED_TRANSITIONS[`${from}→${to}`] ?? null;
}

// The gate (and target state) a comment-approval on this state would satisfy.
export function pendingGateFor(state) {
  for (const [key, gate] of Object.entries(GATED_TRANSITIONS)) {
    const [from, to] = key.split("→");
    if (from === state) return { gate, to };
  }
  return null;
}

// Compute the label edit for a transition, or throw if it's illegal.
export function planTransition(labels, to) {
  if (!STATES.includes(to)) throw new Error(`unknown state "${to}"`);
  const from = stateFromLabels(labels);
  if (from === null) {
    if (to !== STATES[0]) throw new Error(`unlabeled item can only enter "${STATES[0]}", not "${to}"`);
    return { from: null, to, gate: null, add: [labelFor(to)], remove: [] };
  }
  if (!isValidTransition(from, to)) {
    throw new Error(`illegal transition ${from} → ${to} (allowed: ${TRANSITIONS[from].join(", ") || "none"})`);
  }
  return { from, to, gate: gateFor(from, to), add: [labelFor(to)], remove: [labelFor(from)] };
}
