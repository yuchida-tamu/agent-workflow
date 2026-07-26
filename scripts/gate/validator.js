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

export function validateApproval({ author, body, authorized, expectedGate, releaseKind = null }) {
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
  const allowed = (authorized ?? []).map((u) => u.toLowerCase());
  if (!allowed.includes((author ?? "").toLowerCase())) {
    return { ok: false, reason: `"${author}" is not an authorized approver` };
  }
  if (parsed.gate && parsed.gate !== expectedGate) {
    return { ok: false, reason: `comment approves ${parsed.gate}, but the pending gate is ${expectedGate}` };
  }
  return { ok: true, gate: expectedGate, approver: author };
}
