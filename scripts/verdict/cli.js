#!/usr/bin/env node
// agentflow-verdict — read the risk verdict recorded on an item, and ask whether
// it authorises crossing a gate without a human.
//
//   agentflow-verdict read  --repo owner/name --issue N
//   agentflow-verdict check --repo owner/name --issue N --gate G2|G3 [--head <sha>]
//
// `check` exits 0 when the recorded verdict authorises the gate, 10 when it does
// not — including when there is no verdict at all. Absence is refusal, so a
// missing or unparseable verdict is reported as "not authorised" rather than as
// an error to be worked around.
//
// There is no flag by which a caller may state a risk level. The authority comes
// from the record.

import { execFileSync } from "node:child_process";
import { latestVerdict, authorises } from "./core.js";
import { trustedVerdictLogins } from "../identity/identity.js";
import { loadConfig } from "../config/load.js";

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
  }
  return flags;
}

const sh = (args) => execFileSync("gh", args, { encoding: "utf8" });

const [command, ...rest] = process.argv.slice(2);
const flags = parseArgs(rest);

if (!["read", "check"].includes(command) || !flags.repo || !flags.issue) {
  console.error("usage: agentflow-verdict <read|check> --repo owner/name --issue N [--gate G2|G3] [--head <sha>]");
  process.exit(20);
}

try {
  const comments = JSON.parse(
    sh([
      "api", `repos/${flags.repo}/issues/${flags.issue}/comments`, "--jq",
      "[.[] | {body, author: {login: .user.login}}]",
    ])
  );
  // #188: authenticate the verdict comment's author against the identity the
  // risk-verdict workflow actually posts as, before trusting anything it
  // says — see scripts/identity/identity.js's trustedVerdictLogins and
  // scripts/verdict/core.js's header for why this cannot be skipped.
  const verdict = latestVerdict(comments, trustedVerdictLogins({ config: loadConfig() }).logins);

  if (command === "read") {
    console.log(JSON.stringify(verdict, null, 2));
    process.exit(verdict ? 0 : 10);
  }

  if (!flags.gate) {
    console.error("check needs --gate G2 or G3");
    process.exit(20);
  }
  const ok = authorises(flags.gate, verdict, { headSha: flags.head ?? null });
  const why = !verdict
    ? "no verdict recorded on this item"
    : ok
      ? `verdict \`${verdict.level}\` carries no obligation requiring a human`
      : `verdict \`${verdict.level}\` requires [${verdict.require.join(", ") || "-"}]` +
        (flags.gate === "G3" && !verdict.sha ? " and records no SHA, so it cannot be shown to describe this head" : "");
  console.log(JSON.stringify({ gate: flags.gate, authorised: ok, reason: why }, null, 2));
  process.exit(ok ? 0 : 10);
} catch (err) {
  console.error(err.message);
  process.exit(20);
}
