// Did this merged PR actually deliver?
//
// A stacked merge can report complete success and land nothing. On 2026-07-26
// #38, #39 and #40 all showed MERGED with none of their code on main: they had
// merged into base branches that were themselves already integrated, because
// `--delete-branch=false` suppressed GitHub's retarget. CI was green, the issues
// transitioned, the dispatcher moved on. "Merged" was true of every PR and false
// of the repository.
//
// One `git merge-base --is-ancestor` answers it. This module holds the decision
// so it is testable without git.

export const DELIVERED = "delivered";
export const NOT_DELIVERED = "not-delivered";
export const INCONCLUSIVE = "inconclusive";

// `isAncestor` is true / false / null, where null means the question could not
// be answered — a git error, or a shallow clone with no history to compare.
//
// Note the asymmetry with the gates: there, absence of evidence means refuse.
// Here it means proceed. A false "not delivered" would block a legitimate merge
// and halt the loop, while a missed stranding is rare and recoverable — this is
// a safety net, not a gate, and it should fail toward letting work through.
export function classifyDelivery({ isAncestor, headSha = null, defaultBranch = "main" }) {
  if (isAncestor === true) {
    return { status: DELIVERED, proceed: true };
  }
  if (isAncestor === false) {
    return {
      status: NOT_DELIVERED,
      proceed: false,
      reason:
        `merged, but ${headSha ? `\`${headSha.slice(0, 8)}\`` : "its head"} is not an ancestor of \`${defaultBranch}\` — ` +
        `the commits landed on a branch that is not on any path to the default branch, so this PR delivered nothing`,
    };
  }
  return {
    status: INCONCLUSIVE,
    proceed: true,
    reason: `could not determine whether \`${headSha?.slice(0, 8) ?? "head"}\` reached \`${defaultBranch}\` — proceeding rather than blocking on an unanswerable check`,
  };
}

export function renderFinding({ prNumber, classified, defaultBranch = "main" }) {
  // Guarded rather than assumed: a finding rendered for a delivered PR would
  // post an alarming comment with an empty reason, which is worse than no
  // comment at all. Callers should check `proceed` first; this makes the
  // mistake loud instead of publishing `undefined` to an issue.
  if (classified?.status === DELIVERED || !classified?.reason) {
    throw new Error(`renderFinding called for a ${classified?.status ?? "missing"} classification — there is no finding to report`);
  }
  return `<!-- agentflow-delivery -->
⚠️ **PR #${prNumber} merged but did not deliver.**

${classified.reason}

This item has **not** been transitioned. A merge that landed nothing must not
advance the record — that is the defect this check exists to catch (#44).

Likely cause: a stacked merge where the base branch was integrated before its
children, and \`--delete-branch=false\` suppressed GitHub's retarget. Check which
branch the commits are on, and open a recovery PR into \`${defaultBranch}\`.`;
}
