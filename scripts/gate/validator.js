// Gate approval validation: pure. Decides whether an issue comment constitutes
// a valid human approval for a specific gate. The CLI feeds its verdict to
// `agentflow-state apply --approved-gate <G>` — this module is the only code
// allowed to mint that flag.

import { botApprovalAllowed, isBotAuthor } from "../identity/identity.js";
import { reviewAuthorises } from "../review/core.js";

export const GATES = ["G1", "G2", "G3", "G4"];

// The #113 review guard, composed into G3 alongside every other condition
// already checked there — bot-verdict carve-out and human approvers-list
// membership both stay exactly as they were; this only adds a further
// AND-ed refusal that is specific to G3. Returns the refusal reason string,
// or `null` when the review authorises. `reviewAuthorises` is called with
// whatever it was handed (default `{}` reads as no artifact), so a caller
// that forgot to pass `reviewState` fails closed rather than silently
// skipping the check.
function g3ReviewRefusal({ reviewState, headSha, uiTouched }) {
  const review = reviewAuthorises(reviewState ?? {}, { headSha, uiTouched });
  return review.authorised ? null : `G3 review guard: ${review.reason}`;
}

// Parse the first command line of a comment body.
//   /approve            → approve the pending gate
//   /approve G2         → approve, naming the gate explicitly
//   /reject <reason…>   → send the item back with a reason
export function parseCommand(body) {
  for (const raw of (body ?? "").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("/")) continue;
    const [cmd, ...args] = line.split(/\s+/);
    if (cmd === "/approve") {
      const gate = args[0]?.toUpperCase() ?? null;
      if (gate && !GATES.includes(gate)) return { command: "invalid", reason: `unknown gate "${args[0]}"` };
      return { command: "approve", gate };
    }
    if (cmd === "/reject") {
      return { command: "reject", reason: args.join(" ") || "(no reason given)" };
    }
    return null; // some other slash-command; not ours
  }
  return null;
}

// Does a validated approval at this gate itself perform the transition?
//
// For G1, G2 and G3 the approval *is* the act: it approves a document or a
// merge, and moving the label is the outcome. G4 approves a **release that has
// not happened yet** — transitioning on the approval would assert a release
// that does not exist, and would lock `agentflow-release` out, since it
// requires `verified`. There the label follows the artifact instead.
//
// Under `release_kind: none` no G4 exists at all, so the question is moot and
// the ordinary path applies.
export function approvalTransitions({ gate, releaseKind = null }) {
  if (gate !== "G4") return true;
  return releaseKind === "none";
}

// `surface` is where the comment was posted — "issue" or "pr". It defaults to
// "issue" because that is the only surface the gate workflow watches, and the
// bot carve-out below must never be reachable by omission.
//
// `reviewState`/`uiTouched` compose the #81/#111 review guard into G3 — the
// second of the guard's two enforcement points, alongside `decideAutoMerge`
// (scripts/actions/auto-merge.js). It is independent of, not folded into, the
// verdict-based bot carve-out below: a clean risk verdict already authorises
// the carve-out on its own record, and a human's own approvers-list
// membership already authorises theirs — the review guard adds a THIRD,
// separately-refusable condition for G3 specifically, exactly the way
// CLAUDE.md says to keep predicates apart ("do not fold review presence into
// authorises/botApprovalAllowed"). `reviewState` is expected pre-filtered to
// a trusted reviewer and pre-collapsed to "the latest" by the caller
// (`resolveTrustedReviewState`, scripts/identity/identity.js) before it ever
// reaches here — this module has no `gh` access to do that filtering itself,
// and stays pure by construction. Absent (the default) reads as no review at
// all, which is the correct fail-closed answer for a caller that forgot to
// pass it.
export function validateApproval({
  author,
  authorType = null,
  body,
  authorized,
  expectedGate,
  releaseKind = null,
  surface = "issue",
  verdict = null,
  headSha = null,
  reviewState = null,
  uiTouched = false,
}) {
  if (!GATES.includes(expectedGate)) {
    return { ok: false, reason: `unknown expected gate "${expectedGate}"` };
  }
  // Accepting a G4 on a repo that never releases would mint an approval nothing
  // can consume — an audit artifact implying a release that cannot happen.
  if (expectedGate === "G4" && releaseKind === "none") {
    return { ok: false, reason: `G4 does not apply: this repo's release_kind is "none", so "verified" is terminal` };
  }
  const parsed = parseCommand(body);
  if (!parsed) return { ok: false, reason: "no /approve or /reject command found" };
  if (parsed.command === "invalid") return { ok: false, reason: parsed.reason };
  if (parsed.command === "reject") {
    return { ok: false, rejected: true, reason: parsed.reason };
  }
  // A property of the comment, not of its author: checked before either author
  // rule so the reason names what is actually wrong.
  if (parsed.gate && parsed.gate !== expectedGate) {
    return { ok: false, reason: `comment approves ${parsed.gate}, but the pending gate is ${expectedGate}` };
  }

  // The rule that used to live only in prompt text. A bot may not mint a gate
  // approval — with one carve-out, and the authority in it is not the bot's: a
  // PR whose recorded verdict carries no `human-merge`, no `auto-merge` block,
  // and demonstrably describes the head being merged is one `auto-merge.js`
  // would already merge unattended. There the bot transcribes an engine decision
  // into a reviewable artifact; it grants nothing.
  //
  // Checked *before* the approvers list, so a config that somehow named a bot
  // does not become an approval. `validateConfig` rejects such a config too —
  // this is the defence that does not depend on the config being read.
  if (isBotAuthor({ login: author, type: authorType })) {
    if (!botApprovalAllowed({ gate: expectedGate, surface, verdict, headSha })) {
      return {
        ok: false,
        reason:
          `"${author}" is a bot — agents may not mint gate approvals. The only exception is ` +
          `G3 on a pull request whose recorded risk verdict already authorises the merge, and ` +
          `no such verdict describes this head`,
      };
    }
    // The verdict authorises the bot's carve-out; it says nothing about
    // whether anyone reviewed the change. Independent, AND-ed condition —
    // the App transcribing an engine decision must not be able to do so over
    // a change nobody reviewed either.
    if (expectedGate === "G3") {
      const refusal = g3ReviewRefusal({ reviewState, headSha, uiTouched });
      if (refusal) return { ok: false, reason: refusal };
    }
    // Name what authorised it, or the record shows a bot approving a merge with
    // no visible reason it was permitted to.
    return {
      ok: true,
      gate: expectedGate,
      approver: author,
      authorisedBy: { verdict: verdict.level, sha: verdict.sha },
    };
  }

  const allowed = (authorized ?? []).map((u) => u.toLowerCase());
  if (!allowed.includes((author ?? "").toLowerCase())) {
    return { ok: false, reason: `"${author}" is not an authorized approver` };
  }
  // A human's presence on `approvers` authorises approving G3 in general; it
  // says nothing about whether this particular head was reviewed. Same
  // independent, AND-ed condition as the bot carve-out above.
  if (expectedGate === "G3") {
    const refusal = g3ReviewRefusal({ reviewState, headSha, uiTouched });
    if (refusal) return { ok: false, reason: refusal };
  }
  return { ok: true, gate: expectedGate, approver: author };
}
