#!/usr/bin/env node
// agentflow-gate — check whether a comment validly approves a gate.
//
//   agentflow-gate check --author alice --body "/approve" --gate G1 \
//                        --authorized "alice,bob"
//
// Exit codes: 0 valid approval · 10 not an approval (incl. rejection) · 20 usage.
// On success, stdout JSON includes the gate — pipe into
// `agentflow-state apply --approved-gate <gate>`.

import { validateApproval } from "./validator.js";
import { releaseKindOf } from "../config/load.js";

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
  }
  return flags;
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseArgs(rest);

if (command !== "check" || !flags.author || !flags.gate || flags.body === undefined) {
  console.error('usage: agentflow-gate check --author <user> --body "<comment>" --gate <G1..G4> --authorized "a,b"');
  process.exit(20);
}

const verdict = validateApproval({
  author: flags.author,
  body: flags.body,
  expectedGate: flags.gate,
  authorized: (flags.authorized ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  releaseKind: releaseKindOf(),
});

console.log(JSON.stringify(verdict, null, 2));
process.exit(verdict.ok ? 0 : 10);
