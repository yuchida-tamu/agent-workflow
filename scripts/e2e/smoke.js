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

export const EMPTY_SUITE = "empty-suite";

// `scenariosDirExists` false (never initialised) and a directory containing no
// .feature files are the same fact: this repo has no scenario suite.
export function classifySuite({ scenariosDirExists = true, featureFiles = [] } = {}) {
  if (!scenariosDirExists) {
    return { empty: true, reason: "no scenario directory — this repo has no suite" };
  }
  if (featureFiles.length === 0) {
    return { empty: true, reason: "scenario directory contains no .feature files" };
  }
  return { empty: false, reason: `${featureFiles.length} feature file(s)`, count: featureFiles.length };
}

// `result` is the runner's outcome ({ summary, results }), or null when the
// suite was empty and nothing ran.
export function smokeOutcome({ suite, result = null, from = "merged", to = "verified" }) {
  if (suite.empty) {
    return {
      status: "passed",
      vacuous: true,
      kind: EMPTY_SUITE,
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

// The comment the dispatch layer posts. A vacuous pass must be legible as such —
// the record should never overstate what was verified.
export function renderSmokeNote(outcome) {
  const headline = outcome.vacuous
    ? "⚪ post-merge smoke: vacuous pass (empty suite)"
    : outcome.status === "passed"
      ? "✅ post-merge smoke: passed"
      : "❌ post-merge smoke: failed";
  const transition = outcome.transition
    ? `Transition: \`${outcome.transition.from}\` → \`${outcome.transition.to}\`.`
    : "Transition withheld.";
  return `${headline}\n\n${outcome.note}\n\n${transition}`;
}
