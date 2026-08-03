// Reading a posted risk verdict back out of its comment, and deciding whether it
// authorises crossing a gate without a human.
//
// One rule governs everything here: **absence is refusal.** No verdict, an
// unparseable verdict, a verdict about different code — each means a human is
// needed. A permissive parse is the entire risk surface of automating a gate, so
// every ambiguity resolves the same way.
//
// There is deliberately no parameter, flag, or field by which a caller can state
// a risk level. The authority comes from the record; an agent must not be able
// to auto-pass its own plan by asserting it was low.
//
// --- authorship is NOT enforced here — read this before wiring a caller ------
// (#188 — the same obligation scripts/review/core.js's header documents for the
// review artifact, and the same defect this module shipped with until #188:
// `latestVerdict` used to parse whatever comment it was handed with no opinion
// on who posted it. Any write-capable actor could append a forged
// `<!-- agentflow-verdict -->` comment claiming `risk verdict: low` and it
// would be trusted — laundering the self-mod-guard's high floor (the very
// obligation that exists to force a human merge on workflow/policy changes)
// into an unattended auto-merge. PR #186's guard-grade review found this live.
//
// `latestVerdict` now takes `trustedLogins` and refuses to consider any
// comment not authored by one of them — but it still does not decide WHO is
// trusted, the same way this module has never decided WHO may approve a gate.
// The composing caller resolves that from config (see
// scripts/identity/identity.js's `trustedVerdictLogins`, #188) and passes the
// result in. No trusted logins → `filterByAuthor` below filters out
// everything → no verdict is ever trusted: fail-closed, exactly the "absence
// is refusal" posture this whole module already keeps for a missing or
// unparseable verdict.
//
// **Filtering happens BEFORE the latest-wins collapse, never after** — same
// ordering discipline scripts/review/core.js's header documents at length,
// for the identical reason: collapsing first and only then checking the
// single winner's author lets a newer *untrusted* comment (the forged
// low-verdict append) shadow an older *trusted* one before authorship is ever
// considered. `authoritativeMarkerComment` below does the filter-then-collapse
// in one place so a caller cannot get the order wrong.
//
// This is also where the first/last marker mismatch (#188, the other half of
// the same defect) is closed: `scripts/actions/pr-verdict.js` used to upsert
// the FIRST marker comment it found while this module read the LAST — so an
// appended second marker comment (forged or otherwise) was invisible to the
// write path but authoritative to the read path. `authoritativeMarkerComment`
// is now the ONE selection rule both sides share: the most recent comment,
// among those authored by a trusted login, carrying the marker. pr-verdict.js
// calls it to decide which comment to PATCH; `latestVerdict` calls it to
// decide which comment's content is the verdict. Sharing the function makes
// "read == write" structural rather than two independently-written filters
// that merely happen to agree today.

import { filterByAuthor } from "../review/core.js";

export const MARKER = "<!-- agentflow-verdict -->";
export const LEVELS = ["low", "medium", "high", "critical"];

// pr-verdict.js renders `| requires | blocks | runs |` with an em-dash for empty.
const EMPTY_CELL = "—";

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function cellToList(cell) {
  if (!cell || cell === EMPTY_CELL) return [];
  return cell
    .split(",")
    .map((s) => s.trim().replace(/^`|`$/g, ""))
    .filter(Boolean);
}

// → { level, require, block, run, matched, sha } | null
export function parseVerdict(body) {
  const text = body ?? "";
  if (!text.startsWith(MARKER)) return null;

  const level = text.match(/risk verdict:\s*`([a-z]+)`/)?.[1] ?? null;
  if (!LEVELS.includes(level)) return null;

  const lines = text.split("\n");
  const headerIndex = lines.findIndex((l) => /^\|\s*requires\s*\|/i.test(l.trim()));
  if (headerIndex === -1) return null;
  // header, separator, then the single obligations row
  const row = lines[headerIndex + 2];
  if (!row || !row.trim().startsWith("|")) return null;
  const cells = splitRow(row);
  if (cells.length < 3) return null;

  const matched = [];
  for (const line of lines) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/);
    if (m) matched.push({ pack: m[1], rule: m[2] });
  }

  // The SHA the verdict was computed over. `pr-verdict.js` records it (see the
  // `verdict-sha:` line it renders), but the field stays optional and
  // `authorises` treats its absence as refusal for G3 rather than assuming the
  // verdict still describes the current head — a verdict written by anything
  // that forgets the SHA must not authorise a merge.
  //
  // This comment previously said the SHA was not recorded yet. It was stale, and
  // it cost something: the plan for #82 asserted a safety property the code did
  // not have, on the strength of these three lines.
  const sha = text.match(/verdict-sha:\s*([0-9a-f]{7,40})/i)?.[1] ?? null;

  return {
    level,
    require: cellToList(cells[0]),
    block: cellToList(cells[1]),
    run: cellToList(cells[2]),
    matched,
    sha,
  };
}

// The single comment BOTH the write path (pr-verdict.js, deciding which
// comment to upsert-in-place) and the read path (`latestVerdict`, below)
// treat as authoritative: the most recent comment, among the ones authored by
// a trusted login, whose body carries the marker. `trustedLogins` is caller-
// supplied — see this module's header — so this stays pure: no config, no
// `gh`, no clock. No trusted logins (or none given) filters out every
// comment via `filterByAuthor`, the same fail-closed posture described above.
export function authoritativeMarkerComment(comments, trustedLogins) {
  const trusted = filterByAuthor(comments, trustedLogins).filter((c) => (c?.body ?? "").startsWith(MARKER));
  return trusted.length ? trusted[trusted.length - 1] : null;
}

// The most recent verdict wins, deterministically — but only a verdict posted
// by a trusted login, and only from the ONE comment `authoritativeMarkerComment`
// and pr-verdict.js's upsert agree is authoritative. See this module's header
// for why both of those are load-bearing (#188).
export function latestVerdict(comments, trustedLogins) {
  return parseVerdict(authoritativeMarkerComment(comments, trustedLogins)?.body ?? null);
}

// Does this verdict authorise crossing `gate` with no human?
//   G2 — only if the engine did not require G2
//   G3 — only if nothing requires a human merge, nothing blocks auto-merge, and
//        the verdict demonstrably describes the code being merged
// G1 and G4 are never auto-crossable: a brief and a release are human calls by
// design, not risk-scored ones.
export function authorises(gate, verdict, { headSha = null } = {}) {
  if (!verdict) return false;
  if (gate === "G2") return !verdict.require.includes("G2");
  if (gate === "G3") {
    if (verdict.require.includes("human-merge")) return false;
    if (verdict.block.includes("auto-merge")) return false;
    // A verdict describes the code it was computed over. Without a recorded SHA
    // there is no way to know it still does — so it does not authorise.
    if (!verdict.sha || !headSha) return false;
    return headSha.startsWith(verdict.sha) || verdict.sha.startsWith(headSha);
  }
  return false;
}
