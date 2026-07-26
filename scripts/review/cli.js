#!/usr/bin/env node
// agentflow-review — read the review artifact recorded on a PR (native
// bot-authored review, or the `<!-- agentflow-review -->` marker comment),
// and ask whether it authorises crossing G3 without a human.
//
//   agentflow-review read  --repo owner/name --pr N
//   agentflow-review check --repo owner/name --pr N --head <sha>
//                           [--files a.js,b.js] [--ui-globs "src/ui/**,app/**"]
//
// `read` prints the canonical review state (whichever source answered) and
// exits 0 when one was found, 10 when there is none. `check` additionally
// runs reviewAuthorises and exits 0 when it authorises, 10 when it does not
// — including when there is no artifact at all. Absence is refusal, so a
// missing or unparseable review is reported as "not authorised" rather than
// as an error to work around.
//
// `--files`/`--ui-globs` are optional convenience flags for computing
// `uiTouched` locally; the composing caller (scripts/actions/auto-merge.js,
// scripts/gate/validator.js — Child #113) is expected to source the glob
// list from the platform pack and pass `--ui-globs` itself, or compute
// `uiTouched` another way and skip these flags. Neither flag is required.
//
// All I/O — the `gh` calls — lives here. scripts/review/core.js is pure.

import { execFileSync } from "node:child_process";
import { readReviewState, reviewAuthorises, uiSurfaceTouched } from "./core.js";

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

if (!["read", "check"].includes(command) || !flags.repo || !flags.pr) {
  console.error(
    "usage: agentflow-review <read|check> --repo owner/name --pr N [--head <sha>] [--files a,b] [--ui-globs g1,g2]"
  );
  process.exit(20);
}

try {
  const comments = JSON.parse(
    sh(["api", `repos/${flags.repo}/issues/${flags.pr}/comments`, "--jq", "[.[] | {body}]"])
  );
  const nativeReviews = JSON.parse(
    sh(["api", `repos/${flags.repo}/pulls/${flags.pr}/reviews`, "--jq", "[.[] | {state, commit_id, body}]"])
  );
  const reviewState = readReviewState({ nativeReviews, comments });

  if (command === "read") {
    console.log(JSON.stringify(reviewState, null, 2));
    process.exit(reviewState ? 0 : 10);
  }

  const files = flags.files ? flags.files.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const uiGlobs = flags["ui-globs"] ? flags["ui-globs"].split(",").map((s) => s.trim()).filter(Boolean) : [];
  const uiTouched = uiSurfaceTouched(files, uiGlobs);

  const result = reviewAuthorises(reviewState, { headSha: flags.head ?? null, uiTouched });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.authorised ? 0 : 10);
} catch (err) {
  console.error(err.message);
  process.exit(20);
}
