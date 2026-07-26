// The run ledger: pure. Turns ledger rows into the markdown table that lives in
// a marker-managed comment on the work item, and reads that table back.
//
// The rendered table is the storage format on purpose — what a human reads and
// what `agentflow-log audit` parses are the same bytes, so the audit trail can
// never disagree with the audit. No clock, no id generation, no GitHub: the CLI
// supplies `run` ids and timestamps, this module only does label math on rows.

import { STATES, PARENT_COMPLETION } from "../state/machine.js";

export const MARKER = "<!-- agentflow-ledger -->";
export const HEADING = "### agentflow run ledger";

// The row's fields, in the order they appear as table columns. `issue` is not a
// column: the ledger lives on the issue, so carrying it in every row would be
// redundant. The CLI attaches it when reporting findings across items.
export const COLUMNS = ["run", "phase", "agent", "model", "session", "started", "ended", "outcome"];

// An absent value renders as an em-dash and parses back to null.
const EMPTY = "—";

// The phase each state had to pass through to be reached, and the agent that
// produces it. Reaching `planned` means shaping *and* planning both happened —
// so a missing row for either is a gap, however far the item has travelled.
export const PRODUCERS = [
  { after: "spec", phase: "idea", agent: "product-shaper" },
  { after: "planned", phase: "spec", agent: "architect" },
  { after: "in-review", phase: "ready", agent: "implementer" },
];

function escapeCell(value) {
  if (value === null || value === undefined) return EMPTY;
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function unescapeCell(text) {
  const trimmed = text.trim();
  if (trimmed === EMPTY || trimmed === "") return null;
  return trimmed;
}

// Split a table line on unescaped pipes, honouring backslash escapes.
function splitCells(line) {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      current += inner[++i];
      continue;
    }
    if (ch === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}

export function render(rows) {
  const header = `| ${COLUMNS.join(" | ")} |`;
  const separator = `|${COLUMNS.map(() => "---").join("|")}|`;
  const body = (rows ?? []).map((row) => `| ${COLUMNS.map((c) => escapeCell(row[c])).join(" | ")} |`);
  return [MARKER, "", HEADING, "", header, separator, ...body, ""].join("\n");
}

export function parse(body) {
  const text = body ?? "";
  if (!text.startsWith(MARKER)) return [];
  const rows = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = splitCells(trimmed);
    if (cells.length !== COLUMNS.length) continue;
    if (cells.every((c) => /^\s*:?-{3,}:?\s*$/.test(c))) continue; // separator row
    const values = cells.map(unescapeCell);
    if (values[0] === "run") continue; // header
    const row = {};
    COLUMNS.forEach((column, i) => {
      row[column] = values[i];
    });
    rows.push(row);
  }
  return rows;
}

// Apply one entry to a row list, returning a new list. `start` appends an open
// row and refuses only when this id already has one open; a closed id is
// reusable. `end` completes the matching open row in place. A close with no
// matching open row is a bug in the caller, not something to paper over — so
// it throws.
export function upsert(rows, entry) {
  const current = [...(rows ?? [])];
  if (entry?.kind === "start") {
    if (current.some((r) => r.run === entry.run && r.ended === null)) {
      throw new Error(`run "${entry.run}" is already open`);
    }
    const row = {};
    for (const column of COLUMNS) row[column] = entry[column] ?? null;
    row.ended = null;
    row.outcome = null;
    current.push(row);
    return current;
  }
  if (entry?.kind === "end") {
    // Match the OPEN row for this id, not the first row that ever used it. A
    // closed id is reusable (see `start` above), so after a start→end→start
    // there are two rows sharing an id — matching by id alone finds the
    // earlier, already-closed one and reports it as closed while an open row
    // for the same id sits right there. `start` guarantees at most one open
    // row per id at a time, so this match is never ambiguous.
    const index = current.findIndex((r) => r.run === entry.run && r.ended === null);
    if (index === -1) throw new Error(`no open ledger row for run "${entry.run}"`);
    current[index] = { ...current[index], ended: entry.ended ?? null, outcome: entry.outcome ?? null };
    return current;
  }
  throw new Error(`unknown ledger entry kind "${entry?.kind}"`);
}

// Findings, never a verdict: the caller decides what a finding is worth.
//   violation     — a row's model is not the tier its definition declares
//   unknown-agent — a row names an agent with no definition
//   gap           — a state was reached with no row for the phase that produces it
//
// `tiers` comes from the agent definitions themselves, so routing policy has one
// source of truth rather than a second table that can drift from the roster.
// Phases a child issue never performs itself. The architect creates children
// already at `state:ready`: their shaping and planning happened on the parent,
// and are logged there. Charging a child a gap for them would report a finding
// on every child in the repo, which is how a useful audit becomes noise nobody
// reads.
const PARENT_ONLY_PHASES = new Set(["idea", "spec"]);

// Phases a parent issue never performs itself, the mirror image of
// `PARENT_ONLY_PHASES` above. `machine.js`'s `PARENT_COMPLETION` is the one
// source of truth for where a parent's own life ends: it delegates
// `ready → in-progress → in-review → merged` to children and jumps straight
// from `ready` to `verified`, so the phase that would normally produce
// `PARENT_COMPLETION.from` is one it can never log for itself. Deriving from
// that constant rather than a fresh literal keeps the two from drifting apart.
// Charging a parent that gap would be a finding no parent could ever clear.
//
// Fragile by construction, not just by accident: deriving only `.from` is
// sufficient *because* `PRODUCERS` today charges nothing for the states in
// between (`in-progress`, `in-review`, `merged`) — there is no producer for
// them to skip. If a future `PRODUCERS` entry ever charges one of those
// states, this `.from`-only set would under-cover it and re-strand parents
// with the exact permanent gap this set exists to prevent. Widen it to every
// state between `PARENT_COMPLETION.from` and `PARENT_COMPLETION.to` if that
// happens, rather than adding a second one-off phase literal.
const CHILD_ONLY_PHASES = new Set([PARENT_COMPLETION.from]);

export function audit({ rows, tiers, state = null, hasParent = false, hasChildren = false }) {
  const findings = [];
  for (const row of rows ?? []) {
    const expected = tiers?.[row.agent];
    if (expected === undefined) {
      findings.push({ kind: "unknown-agent", run: row.run, agent: row.agent });
      continue;
    }
    if (row.model !== expected) {
      findings.push({ kind: "violation", run: row.run, agent: row.agent, expected, actual: row.model });
    }
  }
  if (state !== null) {
    const reached = STATES.indexOf(state);
    for (const producer of PRODUCERS) {
      if (reached < STATES.indexOf(producer.after)) continue;
      if (hasParent && PARENT_ONLY_PHASES.has(producer.phase)) continue;
      if (hasChildren && CHILD_ONLY_PHASES.has(producer.phase)) continue;
      const ran = (rows ?? []).some((r) => r.phase === producer.phase && r.agent === producer.agent);
      if (!ran) findings.push({ kind: "gap", phase: producer.phase, agent: producer.agent, state });
    }
  }
  return findings;
}
