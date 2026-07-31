// Release decisions: pure. Whether this repo may cut a release, of what, and
// on whose authority.
//
// The load-bearing rule is the last one: this module never manufactures an
// approval. It is handed the approval comments found on the issue and asks the
// gate validator whether any of them is real. A release script that could pass
// `--approved-gate G4` on its own authority would make G4 decorative.

import { validateApproval } from "../gate/validator.js";

export function tagFor(version) {
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("package.json has no version to release");
  }
  return version.startsWith("v") ? version : `v${version}`;
}

// comments: [{ author, body }] — every comment on the issue, unfiltered.
// → the validated approval, or null. The first valid one wins; a rejection does
// not veto a later approval, because the human may reject then reconsider.
export function findG4Approval({ comments, authorized, releaseKind }) {
  for (const comment of comments ?? []) {
    const verdict = validateApproval({
      author: comment.author,
      body: comment.body,
      authorized,
      expectedGate: "G4",
      releaseKind,
    });
    if (verdict.ok) return { approver: verdict.approver, body: comment.body };
  }
  return null;
}

// → { ok: true, tag, approver } | { ok: false, reason }
// Refusals are ordered cheapest-first, and each names the specific thing that
// is wrong: a caller should never have to run the command twice to learn two
// separate reasons.
export function planRelease({
  releaseKind,
  state,
  version,
  existingTags = [],
  comments = [],
  authorized = [],
}) {
  if (releaseKind === "none") {
    return { ok: false, reason: `this repo's release_kind is "none" — "verified" is terminal, there is nothing to release` };
  }
  if (releaseKind === "store") {
    return {
      ok: false,
      reason: `this repo's release_kind is "store" — releasing goes through the platform pack's ship adapter, not agentflow-release`,
    };
  }
  if (releaseKind !== "tag") {
    return { ok: false, reason: `unknown release_kind "${releaseKind}"` };
  }
  if (state !== "verified") {
    return { ok: false, reason: `item is \`${state ?? "unlabelled"}\`, not \`verified\` — only a verified item can be released` };
  }

  const approval = findG4Approval({ comments, authorized, releaseKind });
  if (!approval) {
    return {
      ok: false,
      reason: "no validated G4 approval from an authorized approver on this issue",
    };
  }

  let tag;
  try {
    tag = tagFor(version);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (existingTags.includes(tag)) {
    return {
      ok: false,
      reason: `tag ${tag} already exists — re-releasing a version is a human decision, never a silent overwrite`,
    };
  }

  return { ok: true, tag, approver: approval.approver };
}

// --- the invariant ----------------------------------------------------------
//
// `state:released` should never be true of an item with no release behind it.
// That was not merely theoretical: #3 carried the label with no tag, because a
// G4 approval used to move the label directly (#45).
//
// Same family as #44's ancestry check — confirm the artifact, don't trust the
// transition. Pure: the caller supplies the labelled items and the tags that
// exist, so this is testable without git or `gh`.

export const VERIFY_NOT_APPLICABLE = "not-applicable";

// items: [{ number, version }] — those carrying `state:released`.
// tags:  the tag names that exist in the repo.
// → { applicable, findings: [{ number, expectedTag }] }
export function verifyReleased({ items = [], tags = [], releaseKind = "tag" } = {}) {
  if (releaseKind !== "tag") {
    return { applicable: false, reason: VERIFY_NOT_APPLICABLE, releaseKind, findings: [] };
  }
  const present = new Set(tags);
  const findings = [];
  for (const item of items) {
    let expectedTag;
    try {
      expectedTag = tagFor(item.version);
    } catch {
      // An item labelled released whose version cannot be resolved is itself a
      // finding — we cannot show a release exists for it.
      findings.push({ number: item.number, expectedTag: null, reason: "no resolvable version" });
      continue;
    }
    if (!present.has(expectedTag)) {
      findings.push({ number: item.number, expectedTag, reason: "no such tag" });
    }
  }
  return { applicable: true, releaseKind, findings };
}

// --- per-item version resolution --------------------------------------------
//
// `verifyReleased` above takes each item's *own* version — #121 found the CLI
// feeding it HEAD's `package.json` version for every item instead, which is
// wrong the moment two different versions have ever been released (this repo
// now carries three tags, so the bug was live, not theoretical). The fix is
// to ground resolution in what the release flow actually *records*:
// `agentflow-release` now leaves a breadcrumb comment on the issue it just
// released, naming the tag it cut — the same audit-trail shape already used
// for merges (`merge-record.js`) and postmerge smoke. `--verify` reads that
// comment back instead of trusting HEAD's version for everyone.
//
// Items released before this fix shipped carry no such breadcrumb, and
// `state:released` items stay open (they never get a close-by-merge event),
// so there is no secondary ancestry record to fall back to either. Reporting
// those "unverifiable" is the honest answer — never a guess dressed up as a
// finding, and never conflated with a genuine "no such tag" finding.

export const RELEASE_RECORD_MARKER = "<!-- agentflow-release-record -->";

// What the release CLI itself writes on an item's issue when it cuts a tag
// for it. Parsing exactly what we write keeps resolution deterministic — no
// scraping freeform comment text for something that merely looks like a
// version.
export function renderReleaseRecord({ tag }) {
  return `${RELEASE_RECORD_MARKER}\n📦 Released as \`${tag}\`.`;
}

// comments: [{ body }] — every comment on the item's issue, unfiltered.
// → the tag named in the item's own release breadcrumb, or null. The last
// match wins, consistent with the other markers in this repo, in case a
// re-release ever appends a fresher record.
export function releaseTagFromComments(comments) {
  const found = [...(comments ?? [])].reverse().find((c) => c?.body?.startsWith(RELEASE_RECORD_MARKER));
  if (!found) return null;
  const m = found.body.match(/Released as `([^`]+)`/);
  return m ? m[1] : null;
}

// → { version } | { unverifiable: reason }. Resolution order: the release
// breadcrumb on the issue, full stop — there is no second deterministic
// source (see above). An item whose own version cannot be recovered from
// recorded data is its own category, kept apart from `verifyReleased`'s
// findings so it can never surface as a false one.
export function resolveItemVersion({ comments } = {}) {
  const tag = releaseTagFromComments(comments);
  if (tag) return { version: tag };
  return {
    unverifiable:
      "no release breadcrumb recorded on the issue (released before this tracking existed, or outside agentflow-release)",
  };
}
