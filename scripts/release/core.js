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
