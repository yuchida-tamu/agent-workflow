// The run ledger: pure. Turns ledger rows into the markdown table that lives in
// a marker-managed comment on the work item, and reads that table back.
//
// The rendered table is the storage format on purpose — what a human reads and
// what `agentflow-log audit` parses are the same bytes, so the audit trail can
// never disagree with the audit. No clock, no id generation, no GitHub: the CLI
// supplies `run` ids and timestamps, this module only does label math on rows.

import { STATES } from "../state/machine.js";

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
// row; `end` completes the matching open row in place. A close with no matching
// open row is a bug in the caller, not something to paper over — so it throws.
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
    const index = current.findIndex((r) => r.run === entry.run);
    if (index === -1) throw new Error(`no open ledger row for run "${entry.run}"`);
    if (current[index].ended !== null) throw new Error(`run "${entry.run}" is already closed`);
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
export function audit({ rows, tiers, state = null }) {
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
      const ran = (rows ?? []).some((r) => r.phase === producer.phase && r.agent === producer.agent);
      if (!ran) findings.push({ kind: "gap", phase: producer.phase, agent: producer.agent, state });
    }
  }
  return findings;
}
