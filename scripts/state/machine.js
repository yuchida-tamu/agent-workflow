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
// A parent delegates all its work to children and never opens a PR of its own,
// so `ready → in-progress → in-review → merged` are states it can never
// legitimately occupy. Before this edge existed a parent sat at `ready` forever
// and the dispatcher kept nominating an implementer to build work that had
// already shipped.
//
// `verified` is the right landing point rather than a shortcut: each child was
// merged under its own G3 and smoke-verified on the way to `verified`. A parent
// asserting `verified` summarises verification that happened, it does not claim
// verification it skipped. The transition comment should say so — on a parent,
// `verified` means "my children were", not "I was".
//
// Ungated deliberately: every child already cost a human a G3. Requiring a fifth
// approval to acknowledge four already given is the interrupt #16 exists to
// remove. It is guarded instead — children must exist and all be done.
export const PARENT_COMPLETION = { from: "ready", to: "verified" };

export function parentMayComplete({ hasChildren = false, allChildrenDone = false } = {}) {
  return Boolean(hasChildren && allChildrenDone);
}

// The states reachable from `state` for this repo. Under `none`, `verified` is
// terminal — expressed here once, so no caller has to special-case it.
export function transitionsFrom(state, { releaseKind = DEFAULT_RELEASE_KIND, parent = null } = {}) {
  const targets = TRANSITIONS[state] ?? [];
  if (state === "verified" && !releasesAtAll(releaseKind)) return [];
  if (state === PARENT_COMPLETION.from && parentMayComplete(parent ?? {})) {
    return [...targets, PARENT_COMPLETION.to];
  }
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

// Compare-and-swap: resolve what to do when applying a previously computed
// transition against a freshly re-read set of labels, taken immediately
// before the write. Two independent drivers — the manual CLI
// (scripts/state/cli.js) and the async gate workflow
// (scripts/actions/gate-comment.js) — can each decide to apply the very same
// transition; by the time either issues its edit, the other may already have
// won. Re-reading labels right before the write and asking this function
// what to do is what stops that race from stacking conflicting state labels
// on the issue — observed live on #119 (`state:spec` + `state:ready`
// simultaneously, which then makes `stateFromLabels` throw "conflicting" for
// every reader from then on).
//
// `plan` carries `{ from, to, add, remove }` — the shape `planTransition`
// returns, or an equivalent literal a caller builds itself (gate-comment.js
// does, since it derives its transition from `pendingGateFor` rather than
// calling `planTransition`). `currentLabels` is the fresh read. Four shapes:
//
//   from present, to absent   → apply — nothing has moved; do the edit.
//   from absent,  to present  → noop  — another driver already won this
//                                        exact transition. Re-applying would
//                                        be a same-op retry with nothing new
//                                        to write.
//   from present, to present  → heal  — the corruption this function exists
//                                        to prevent has already happened:
//                                        both labels are live, which is
//                                        exactly the #119 shape. There is one
//                                        correct resolution — `to` is the
//                                        transition's outcome and is kept,
//                                        `from` is stale and is dropped — and
//                                        it can only be reached via the very
//                                        race this seam closes, so healing it
//                                        here (rather than merely refusing
//                                        and leaving the conflict for a human
//                                        to fix by hand) is the right call:
//                                        left alone, `stateFromLabels` throws
//                                        for every subsequent reader of this
//                                        issue, forever, until someone edits
//                                        labels manually.
//   from absent,  to absent   → refuse (throws) — neither label survived to
//                                        this read: a third transition beat
//                                        both drivers, or labels were cleared
//                                        entirely. Guessing which is worse
//                                        than naming exactly what was found
//                                        and stopping.
export function resolveApply(currentLabels, plan) {
  const { from, to } = plan;
  const hasTo = currentLabels.includes(labelFor(to));
  if (from === null) {
    // The unlabeled-entry case (`planTransition([], "idea")`): there is no
    // `from` label to compare against, only the target itself.
    return hasTo
      ? { action: "noop", note: `already applied by another driver — state:${to} is already present` }
      : { action: "apply", add: plan.add, remove: plan.remove };
  }
  const hasFrom = currentLabels.includes(labelFor(from));
  if (hasFrom && !hasTo) return { action: "apply", add: plan.add, remove: plan.remove };
  if (!hasFrom && hasTo) {
    return {
      action: "noop",
      note: `already applied by another driver — state:${from} is gone and state:${to} is already present`,
    };
  }
  if (hasFrom && hasTo) {
    return {
      action: "heal",
      remove: [labelFor(from)],
      note: `both state:${from} and state:${to} were present — two drivers raced this transition; removed the stale state:${from} and kept state:${to}`,
    };
  }
  const found = currentLabels.filter((l) => l.startsWith(LABEL_PREFIX));
  throw new Error(
    `cannot apply ${from} → ${to}: neither state:${from} nor state:${to} is present (found: ${found.join(", ") || "none"})`
  );
}
