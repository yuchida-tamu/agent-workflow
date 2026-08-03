// Post-merge smoke semantics: pure. Decides what a smoke run *means* for the
// repo it is running in, which is not the same question as whether scenarios
// passed.
//
// The loop's tail was designed for an app. On a toolkit, a library, or any repo
// that has not written scenarios yet, there is nothing to replay — and that is a
// fact about the repo, not a failure of the merge. An empty suite therefore
// passes vacuously and the item proceeds to `verified`.
//
// The distinction this module exists to hold: **no suite** passes; **a suite
// that failed** blocks. Only the first is vacuous, and the outcome always says
// which one happened, so a reader can never mistake one for the other.
//
// #182 adds a third, distinct vacuous state. `.feature` files present but zero
// compiled traces is *also* nothing-to-replay — but it is a different fact
// about the repo than "no scenarios were ever written", and conflating the two
// is what let a repo with six scenarios and zero traces look identical to one
// with no suite at all. `classifySuite` pins all three: EMPTY_SUITE (no
// scenarios), ZERO_TRACES (scenarios, nothing compiled), READY (a real,
// replayable suite).

export const EMPTY_SUITE = "empty-suite";
export const ZERO_TRACES = "zero-traces";
export const READY = "ready";
export const SKIPPED = "skipped";

// `scenariosDirExists` false (never initialised) and a directory containing no
// .feature files are the same fact: this repo has no scenario suite.
//
// `traceCount` is the number of files under the traces directory (recursive),
// or `null` when the caller never checked — callers that don't pass it get the
// old two-state behaviour (any feature file means a real suite), so this stays
// additive rather than a breaking change to existing callers.
export function classifySuite({ scenariosDirExists = true, featureFiles = [], traceCount = null } = {}) {
  if (!scenariosDirExists) {
    return { empty: true, kind: EMPTY_SUITE, reason: "no scenario directory — this repo has no suite" };
  }
  if (featureFiles.length === 0) {
    return { empty: true, kind: EMPTY_SUITE, reason: "scenario directory contains no .feature files" };
  }
  if (traceCount === 0) {
    return {
      empty: true,
      kind: ZERO_TRACES,
      reason: `${featureFiles.length} feature file(s), but 0 compiled traces — nothing to replay`,
      count: featureFiles.length,
    };
  }
  return { empty: false, kind: READY, reason: `${featureFiles.length} feature file(s)`, count: featureFiles.length };
}

// `result` is the runner's outcome ({ summary, results }), or null when the
// suite was empty and nothing ran.
export function smokeOutcome({ suite, result = null, from = "merged", to = "verified" }) {
  if (suite.empty) {
    return {
      status: "passed",
      vacuous: true,
      kind: suite.kind ?? EMPTY_SUITE,
      note: `Smoke passed vacuously: ${suite.reason}. Nothing was replayed, so nothing was verified by replay.`,
      transition: { from, to },
      summary: { passed: 0, failed: 0, "needs-derivation": 0 },
    };
  }
  const summary = result?.summary ?? { passed: 0, failed: 0, "needs-derivation": 0 };
  const blocked = Boolean(summary.failed) || Boolean(summary["needs-derivation"]);
  return {
    status: blocked ? "failed" : "passed",
    vacuous: false,
    kind: "ran",
    note: blocked
      ? `Smoke blocked the transition: ${summary.failed} failed, ${summary["needs-derivation"]} needing derivation.`
      : `Smoke passed: ${summary.passed} scenario(s) replayed.`,
    transition: blocked ? null : { from, to },
    summary,
  };
}

// A suite that is READY (feature files *and* compiled traces present) but
// could not actually be run — no pack resolvable for the platform, or the
// replay itself failed to execute. #182: this used to be `process.exit(20)`,
// above the transition loop, so the linked issue was left CLOSED but stuck at
// `state:in-review` forever. An unrunnable smoke is a REASON recorded in the
// note, never a reason to abandon the merge bookkeeping — the transition still
// applies, and the workflow stays green. Distinct from `smokeOutcome`'s
// vacuous path: there IS a suite here, execution was simply never attempted.
export function smokeSkipped({ suite, reason, from = "merged", to = "verified" }) {
  return {
    status: SKIPPED,
    vacuous: false,
    skipped: true,
    kind: SKIPPED,
    note: `Smoke did not run: ${reason}. This repo has ${suite.reason} — the transition was applied anyway; an unrunnable smoke is not a reason to abandon merge bookkeeping (#182).`,
    transition: { from, to },
    summary: { passed: 0, failed: 0, "needs-derivation": 0 },
  };
}

// The comment the dispatch layer posts. A vacuous pass must be legible as such
// — the record should never overstate what was verified — and a skipped run
// must never be mistaken for either a pass or a failure.
export function renderSmokeNote(outcome) {
  const vacuousLabel = outcome.kind === ZERO_TRACES ? "zero traces" : "empty suite";
  const headline = outcome.skipped
    ? "⚠️ post-merge smoke: skipped (could not run)"
    : outcome.vacuous
      ? `⚪ post-merge smoke: vacuous pass (${vacuousLabel})`
      : outcome.status === "passed"
        ? "✅ post-merge smoke: passed"
        : "❌ post-merge smoke: failed";
  const transition = outcome.transition
    ? `Transition: \`${outcome.transition.from}\` → \`${outcome.transition.to}\`.`
    : "Transition withheld.";
  return `${headline}\n\n${outcome.note}\n\n${transition}`;
}
