// Gate approval validation: pure. Decides whether an issue comment constitutes
// a valid human approval for a specific gate. The CLI feeds its verdict to
// `agentflow-state apply --approved-gate <G>` — this module is the only code
// allowed to mint that flag.

export const GATES = ["G1", "G2", "G3", "G4"];

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

export function validateApproval({ author, body, authorized, expectedGate }) {
  if (!GATES.includes(expectedGate)) {
    return { ok: false, reason: `unknown expected gate "${expectedGate}"` };
  }
  const parsed = parseCommand(body);
  if (!parsed) return { ok: false, reason: "no /approve or /reject command found" };
  if (parsed.command === "invalid") return { ok: false, reason: parsed.reason };
  if (parsed.command === "reject") {
    return { ok: false, rejected: true, reason: parsed.reason };
  }
  const allowed = (authorized ?? []).map((u) => u.toLowerCase());
  if (!allowed.includes((author ?? "").toLowerCase())) {
    return { ok: false, reason: `"${author}" is not an authorized approver` };
  }
  if (parsed.gate && parsed.gate !== expectedGate) {
    return { ok: false, reason: `comment approves ${parsed.gate}, but the pending gate is ${expectedGate}` };
  }
  return { ok: true, gate: expectedGate, approver: author };
}
