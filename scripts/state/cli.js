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
// then writes the labels back via `gh`. Everything else is pure and offline.
//
// Exit codes: 0 ok · 10 refused (illegal transition / missing gate) · 20 usage.

import { execFileSync } from "node:child_process";
import { planTransition, stateFromLabels, transitionsFrom } from "./machine.js";
import { releaseKindOf } from "../config/load.js";
import { latestVerdict, authorises } from "../verdict/core.js";

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
      const issue = JSON.parse(
        gh(["issue", "view", flags.issue, ...repoArgs, "--json", "labels"])
      );
      const labels = issue.labels.map((l) => l.name);
      const plan = planTransition(labels, flags.to, { releaseKind: releaseKindOf() });
      // A gate can be satisfied two ways: a validated human approval, or — for
      // G2 only — a recorded risk verdict that required no gate. The second is
      // read from the item's own verdict comment here, never asserted by the
      // caller: there is deliberately no flag that says "risk was low".
      let authorisedBy = null;
      if (plan.gate && flags["approved-gate"] !== plan.gate) {
        if (plan.gate === "G2") {
          const verdict = latestVerdict(
            JSON.parse(
              gh(["api", `repos/${repoSlug(flags.repo)}/issues/${flags.issue}/comments`, "--jq", "[.[] | {body}]"])
            )
          );
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
      const editArgs = ["issue", "edit", flags.issue, ...repoArgs];
      for (const l of plan.add) editArgs.push("--add-label", l);
      for (const l of plan.remove) editArgs.push("--remove-label", l);
      gh(editArgs);
      // Record what authorised an auto-passed gate, so the transition is
      // auditable rather than merely permitted.
      if (authorisedBy) {
        const rules = authorisedBy.matched.map((m) => `\`${m.pack}/${m.rule}\``).join(", ") || "no rules matched";
        gh([
          "issue", "comment", String(flags.issue), ...repoArgs,
          "--body",
          `<!-- agentflow-autopass -->\n⚙️ **G2 auto-passed** — \`${plan.from}\` → \`${plan.to}\`, no human required.\n\nAuthorising verdict: level \`${authorisedBy.level}\`, obligations require [${authorisedBy.require.join(", ") || "—"}], ${rules}.\n\nThe engine found nothing demanding a human look. A verdict that required G2, or the absence of any verdict, would have refused this transition.`,
        ]);
      }
      console.log(JSON.stringify({ applied: plan, authorisedBy: authorisedBy ? { level: authorisedBy.level, auto: true } : null }, null, 2));
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

function usage(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}
