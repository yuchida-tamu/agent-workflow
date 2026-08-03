#!/usr/bin/env node
// agentflow-state — status | plan | apply
//
//   agentflow-state status --labels "state:idea,bug"
//   agentflow-state plan   --labels "state:idea" --to spec
//   agentflow-state apply  --issue 42 --to spec [--repo owner/name] [--approved-gate G1]
//
// `apply` reads the issue's labels via `gh`, computes the label edit, refuses
// gated transitions unless --approved-gate names the matching gate (the gate
// validator script is what supplies that flag after checking the approver),
// re-reads labels a second time immediately before writing (#126 — the async
// gate workflow can apply the very same transition in the gap), then writes
// the labels back via `gh`. Everything else is pure and offline.
//
// Exit codes: 0 ok · 10 refused (illegal transition / missing gate / neither
// side of a compare-and-swap survived to the fresh read) · 20 usage.

import { execFileSync } from "node:child_process";
import { planTransition, stateFromLabels, transitionsFrom, resolveApply } from "./machine.js";
import { releaseKindOf, loadConfig } from "../config/load.js";
import { latestVerdict, authorises } from "../verdict/core.js";
import { trustedVerdictLogins } from "../identity/identity.js";
import { childrenOf } from "../hierarchy/gh.js";

// A parent completes when its children do. Resolved here (I/O) and handed to
// machine.js as a plain fact, so the machine stays pure.
function parentFacts(repo, issue) {
  try {
    const { children } = childrenOf(repo ?? repoSlug(repo), Number(issue));
    if (!children.length) return { hasChildren: false, allChildrenDone: false };
    const done = children.every((c) => c.closed);
    return { hasChildren: true, allChildrenDone: done, children };
  } catch {
    return { hasChildren: false, allChildrenDone: false };
  }
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
  }
  return flags;
}

function splitLabels(raw) {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// The slug the API path needs; --repo when given, else the checkout we are in.
function repoSlug(repo) {
  return repo ?? gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

// Pure: turn a CAS resolution (`resolveApply`, scripts/state/machine.js) into
// what `apply` does next — the `gh issue edit` args for a real change, or
// `null` for a no-op — and the JSON object this command prints. Kept separate
// from `resolveApply` itself because the *decision* (apply / no-op / heal) is
// shared with gate-comment.js, but *how it's reported* is this command's own:
// JSON on stdout for a script to parse, versus a markdown comment for a human
// to read (gate-comment.js's `renderApprovalComment`).
export function describeApply(resolution, { plan, issue, repoArgs, authorisedBy = null }) {
  if (resolution.action === "noop") {
    return {
      editArgs: null,
      output: { applied: null, action: "noop", note: resolution.note, authorisedBy: null },
    };
  }
  const editArgs = ["issue", "edit", issue, ...repoArgs];
  for (const l of resolution.add ?? []) editArgs.push("--add-label", l);
  for (const l of resolution.remove ?? []) editArgs.push("--remove-label", l);
  return {
    editArgs,
    output: {
      applied: plan,
      action: resolution.action,
      note: resolution.note ?? null,
      authorisedBy: authorisedBy ? { level: authorisedBy.level, auto: true } : null,
    },
  };
}

// --- I/O ----------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);

  try {
    switch (command) {
      case "status": {
        const state = stateFromLabels(splitLabels(flags.labels));
        const next = state ? transitionsFrom(state, { releaseKind: releaseKindOf() }) : ["idea"];
        console.log(JSON.stringify({ state, next }, null, 2));
        break;
      }
      case "plan": {
        if (!flags.to) throw usage("plan needs --to <state>");
        const plan = planTransition(splitLabels(flags.labels), flags.to, { releaseKind: releaseKindOf() });
        console.log(JSON.stringify(plan, null, 2));
        break;
      }
      case "apply": {
        if (!flags.issue || !flags.to) throw usage("apply needs --issue <n> --to <state>");
        const repoArgs = flags.repo ? ["--repo", flags.repo] : [];
        const readLabels = () =>
          JSON.parse(gh(["issue", "view", flags.issue, ...repoArgs, "--json", "labels"])).labels.map((l) => l.name);
        const labels = readLabels();
        const parent = flags.to === "verified" ? parentFacts(flags.repo, flags.issue) : null;
        const plan = planTransition(labels, flags.to, { releaseKind: releaseKindOf(), parent });
        // A gate can be satisfied two ways: a validated human approval, or — for
        // G2 only — a recorded risk verdict that required no gate. The second is
        // read from the item's own verdict comment here, never asserted by the
        // caller: there is deliberately no flag that says "risk was low".
        let authorisedBy = null;
        if (plan.gate && flags["approved-gate"] !== plan.gate) {
          if (plan.gate === "G2") {
            const comments = JSON.parse(
              gh([
                "api", `repos/${repoSlug(flags.repo)}/issues/${flags.issue}/comments`, "--jq",
                "[.[] | {body, author: {login: .user.login}}]",
              ])
            );
            // #188: only a verdict comment authored by the identity the
            // risk-verdict workflow actually posts as may auto-pass a gate —
            // otherwise any write-capable actor could forge `risk verdict:
            // low` on this exact issue and skip G2 with no human involved.
            const verdict = latestVerdict(comments, trustedVerdictLogins({ config: loadConfig() }).logins);
            if (authorises("G2", verdict)) {
              authorisedBy = verdict;
            }
          }
          if (!authorisedBy) {
            const why = plan.gate === "G2" ? " (and no recorded verdict authorises it)" : "";
            console.error(`refused: ${plan.from} → ${plan.to} requires gate ${plan.gate} approval${why}`);
            process.exit(10);
          }
        }

        // Re-read labels immediately before the write. Everything above (the
        // gate check, a possible verdict lookup) can take long enough for a
        // second driver — the async gate workflow, most often — to have
        // already applied this exact transition, or carried the issue further
        // still. Deciding from this fresh read, not the one `plan` was
        // computed from, is what stops this apply from stacking a second
        // state label onto whatever the other driver already wrote (#126,
        // observed live on #119: `/approve G1` and a manual CLI chain both
        // landed, leaving `state:spec` + `state:ready` on the same issue).
        const fresh = readLabels();
        const resolution = resolveApply(fresh, plan); // throws (exit 10, below) if neither side of the swap survived

        const { editArgs, output } = describeApply(resolution, { plan, issue: flags.issue, repoArgs, authorisedBy });
        if (editArgs) {
          gh(editArgs);
          // Record what authorised an auto-passed gate, so the transition is
          // auditable rather than merely permitted. Skipped on a no-op: there
          // is no new transition here to attribute one to.
          if (authorisedBy) {
            const rules = authorisedBy.matched.map((m) => `\`${m.pack}/${m.rule}\``).join(", ") || "no rules matched";
            gh([
              "issue", "comment", String(flags.issue), ...repoArgs,
              "--body",
              `<!-- agentflow-autopass -->\n⚙️ **G2 auto-passed** — \`${plan.from}\` → \`${plan.to}\`, no human required.\n\nAuthorising verdict: level \`${authorisedBy.level}\`, obligations require [${authorisedBy.require.join(", ") || "—"}], ${rules}.\n\nThe engine found nothing demanding a human look. A verdict that required G2, or the absence of any verdict, would have refused this transition.`,
            ]);
          }
        }
        console.log(JSON.stringify(output, null, 2));
        break;
      }
      default:
        throw usage("usage: agentflow-state <status|plan|apply> …");
    }
  } catch (err) {
    if (err.usage) {
      console.error(err.message);
      process.exit(20);
    }
    console.error(err.message);
    process.exit(10);
  }
}

function usage(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}
