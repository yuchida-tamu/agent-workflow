#!/usr/bin/env node
// agentflow parent-close — close finished parents, and stop closed issues from
// advertising a live state.
//
//   node scripts/actions/parent-close.js --repo owner/name [--parent N] [--sweep] [--dry-run]
//
// Two behaviours, one notion of "this item is finished":
//   · closing an issue clears its `state:*` label
//   · a parent that reached `verified` and whose children are all done is closed
//
// `--sweep` strips stale state labels from issues that are *already* closed —
// the accumulated debt, as opposed to the ongoing hygiene.
//
// Exit codes: 0 ok · 20 usage/error.
//
// The decision functions below are pure and exported for testing; every `gh`
// call lives under main().

import { execFileSync } from "node:child_process";
import { LABEL_PREFIX, STATES } from "../state/machine.js";

// A child no longer holds its parent open once its own work has landed. Closed
// counts too: an issue can be dropped rather than merged, and a parent should
// not wait forever on a decision already taken.
const DONE_STATES = new Set(["merged", "verified", "released"]);

// Only a parent that finished its *own* passage counts as closeable. Children
// being done is necessary, not sufficient — the parent still has to have been
// verified, or closing it would skip the tail it exists to track.
const CLOSEABLE_PARENT_STATES = new Set(["verified", "released"]);

export function stateLabelsOn(labels) {
  return (labels ?? []).filter(
    (l) => l.startsWith(LABEL_PREFIX) && STATES.includes(l.slice(LABEL_PREFIX.length))
  );
}

export function childIsDone(child) {
  if (child?.closed) return true;
  return DONE_STATES.has(child?.state);
}

// → { close: boolean, reason: string }. The reason is always populated: a
// caller reporting "left alone" should be able to say why without guessing.
export function shouldCloseParent({ state, closed = false, children = [] }) {
  if (closed) return { close: false, reason: "already closed" };
  if (!CLOSEABLE_PARENT_STATES.has(state)) {
    return { close: false, reason: `parent is \`${state ?? "unlabelled"}\`, not verified` };
  }
  if (children.length === 0) {
    return { close: false, reason: "no children — not a parent" };
  }
  const open = children.filter((c) => !childIsDone(c));
  if (open.length > 0) {
    return { close: false, reason: `${open.length} child(ren) still open: ${open.map((c) => `#${c.number}`).join(", ")}` };
  }
  return { close: true, reason: `verified, and all ${children.length} child(ren) are done` };
}

// The label edits a sweep would make: every closed issue that still carries a
// state label. Returns only issues needing work, so an empty result means clean.
export function planSweep(issues) {
  return (issues ?? [])
    .filter((i) => i.closed)
    .map((i) => ({ number: i.number, remove: stateLabelsOn(i.labels) }))
    .filter((plan) => plan.remove.length > 0);
}

// --- I/O --------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sweep") flags.sweep = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg.startsWith("--")) flags[arg.slice(2)] = argv[++i];
  }
  return flags;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags.repo || (!flags.sweep && !flags.parent)) {
    console.error("usage: parent-close --repo owner/name [--parent N] [--sweep] [--dry-run]");
    process.exit(20);
  }

  const sh = (args) => execFileSync("gh", args, { encoding: "utf8" });
  const say = (line) => console.log(flags.dryRun ? `would: ${line}` : line);

  try {
    if (flags.sweep) {
      const issues = JSON.parse(
        sh(["issue", "list", "--repo", flags.repo, "--state", "closed", "--limit", "500", "--json", "number,labels,state"])
      ).map((i) => ({ number: i.number, closed: true, labels: i.labels.map((l) => l.name) }));
      const plans = planSweep(issues);
      if (plans.length === 0) console.log("sweep: no closed issue carries a state label");
      for (const plan of plans) {
        say(`clear ${plan.remove.join(", ")} from #${plan.number}`);
        if (!flags.dryRun) {
          const args = ["issue", "edit", String(plan.number), "--repo", flags.repo];
          for (const label of plan.remove) args.push("--remove-label", label);
          sh(args);
        }
      }
    }

    if (flags.parent) {
      const parent = JSON.parse(
        sh(["issue", "view", String(flags.parent), "--repo", flags.repo, "--json", "number,labels,state,body"])
      );
      const childNumbers = [...(parent.body ?? "").matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
      const children = [...new Set(childNumbers)]
        .filter((n) => n !== parent.number)
        .map((n) => {
          const child = JSON.parse(
            sh(["issue", "view", String(n), "--repo", flags.repo, "--json", "number,labels,state"])
          );
          const labels = child.labels.map((l) => l.name);
          return {
            number: child.number,
            closed: child.state === "CLOSED",
            state: stateLabelsOn(labels)[0]?.slice(LABEL_PREFIX.length) ?? null,
          };
        });

      const parentLabels = parent.labels.map((l) => l.name);
      const verdict = shouldCloseParent({
        state: stateLabelsOn(parentLabels)[0]?.slice(LABEL_PREFIX.length) ?? null,
        closed: parent.state === "CLOSED",
        children,
      });
      console.log(`#${parent.number}: ${verdict.close ? "close" : "leave open"} — ${verdict.reason}`);
      if (verdict.close && !flags.dryRun) {
        const stale = stateLabelsOn(parentLabels);
        const args = ["issue", "edit", String(parent.number), "--repo", flags.repo];
        for (const label of stale) args.push("--remove-label", label);
        if (stale.length) sh(args);
        sh(["issue", "close", String(parent.number), "--repo", flags.repo, "--reason", "completed"]);
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exit(20);
  }
}
