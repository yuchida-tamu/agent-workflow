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

  // Optional: the SHA the verdict was computed over. pr-verdict.js does not
  // record it yet, and `authorises` treats its absence as refusal for G3 rather
  // than assuming the verdict still describes the current head.
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

// The most recent verdict comment wins, deterministically.
export function latestVerdict(comments) {
  const parsed = (comments ?? [])
    .map((c) => parseVerdict(c?.body))
    .filter(Boolean);
  return parsed.length ? parsed[parsed.length - 1] : null;
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
