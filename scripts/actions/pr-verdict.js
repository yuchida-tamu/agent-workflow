#!/usr/bin/env node
// GitHub Actions entry: pull_request opened/synchronize → extract facts from
// the diff, evaluate all active policy packs, apply risk/obligation labels,
// and post (or update) the verdict comment.
//
// Env: GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GH_TOKEN, AGENTFLOW_TOOLKIT
// (toolkit root; defaults to this script's ../..). Consuming repo checked out
// with fetch-depth: 0.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { assembleFacts } from "../facts/core.js";
import { evaluate, validatePack } from "../policy/engine.js";

const TOOLKIT = process.env.AGENTFLOW_TOOLKIT ?? join(dirname(fileURLToPath(import.meta.url)), "../..");
const PLATFORM_PACKS = { "rn-expo": "packs/expo/policies/expo.yaml" };
const MARKER = "<!-- agentflow-verdict -->";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const repo = process.env.GITHUB_REPOSITORY;
const prNumber = event.pull_request.number;
const baseSha = event.pull_request.base.sha;
const headSha = event.pull_request.head.sha;

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });
const loadYaml = (path) => parseYaml(readFileSync(path, "utf8"));

// --- facts from the real diff ---
// Three dots, deliberately: `base...head` is `merge-base(base, head)..head`.
// On an integration branch carrying a stack of child merges, that is what makes
// the verdict see the whole stack rather than only the final merge commit —
// measured on PR #15, three-dot saw all 11 files where the merge commit alone
// saw 8. Changing this to two dots would silently under-report risk at G3.
// test/facts.test.js pins the difference.
const numstat = sh("git", ["diff", "--numstat", `${baseSha}...${headSha}`])
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [adds, dels, file] = line.split("\t");
    return { file, adds: adds === "-" ? 0 : Number(adds), dels: dels === "-" ? 0 : Number(dels) };
  });

const showJson = (rev, path) => {
  try {
    return JSON.parse(sh("git", ["show", `${rev}:${path}`]));
  } catch {
    return null;
  }
};

const config = existsSync("agentflow.config.json")
  ? JSON.parse(readFileSync("agentflow.config.json", "utf8"))
  : {};

const facts = assembleFacts({
  stage: "pr",
  numstat,
  basePkg: showJson(baseSha, "package.json"),
  headPkg: showJson(headSha, "package.json"),
  domains: existsSync("domains.yml") ? loadYaml("domains.yml") : null,
  // The configured default for files no domain claims. Without this the map
  // is inert for anything it does not classify — see #46.
  unmappedCriticality: config.unmapped_criticality ?? null,
  planFiles: null, // plan linkage lands with the architect wiring
  brief: null,
});
facts.meta.maturity = config.maturity ?? "steady";

// --- packs: toolkit baseline + platform + this repo's business pack ---
const packPaths = [join(TOOLKIT, "policies/baseline.yaml")];
const platformPack = PLATFORM_PACKS[config.platform];
if (platformPack) packPaths.push(join(TOOLKIT, platformPack));
if (existsSync("policies/business.yml")) packPaths.push("policies/business.yml");

const packs = packPaths.map((p) => {
  const pack = loadYaml(p);
  const errors = validatePack(pack);
  if (errors.length) throw new Error(`invalid pack ${p}: ${errors.join("; ")}`);
  return pack;
});

const verdict = evaluate(packs, facts);

// --- labels: replace risk:*, add obligation labels ---
const currentLabels = event.pull_request.labels?.map((l) => l.name) ?? [];
const editArgs = ["pr", "edit", String(prNumber), "--repo", repo, "--add-label", `risk:${verdict.level}`];
for (const l of currentLabels.filter((l) => l.startsWith("risk:") && l !== `risk:${verdict.level}`)) {
  editArgs.push("--remove-label", l);
}
for (const l of verdict.obligations.label) editArgs.push("--add-label", l);
sh("gh", editArgs);

// --- verdict comment, updated in place ---
const rows = verdict.matched
  .map((m) => `| \`${m.pack}\` | \`${m.rule}\` | ${Object.keys(m.then).join(", ")} |`)
  .join("\n");
// The SHA is what makes the verdict checkable later. A verdict describes the
// code it was computed over; without recording which code that was, nothing
// downstream can tell a current verdict from one that predates three pushes.
// `authorises("G3", …)` refuses when it is absent, so this line is the whole
// difference between auto-merge being possible and being permanently closed.
const body = `${MARKER}
### agentflow risk verdict: \`${verdict.level}\` (score ${verdict.obligations.score})

verdict-sha: ${headSha}

| requires | blocks | runs |
|---|---|---|
| ${verdict.obligations.require.join(", ") || "—"} | ${verdict.obligations.block.join(", ") || "—"} | ${verdict.obligations.run.join(", ") || "—"} |

${verdict.matched.length ? `<details><summary>${verdict.matched.length} rule(s) matched</summary>\n\n| pack | rule | obligations |\n|---|---|---|\n${rows}\n\n</details>` : "No rules matched."}
${verdict.warnings.length ? `\n⚠️ ${verdict.warnings.join(" · ")}` : ""}`;

const existing = JSON.parse(
  sh("gh", ["api", `repos/${repo}/issues/${prNumber}/comments`, "--jq", "[.[] | {id, body}]"])
).find((c) => c.body.startsWith(MARKER));
if (existing) {
  sh("gh", ["api", "--method", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`]);
} else {
  sh("gh", ["pr", "comment", String(prNumber), "--repo", repo, "--body", body]);
}
console.log(`verdict: ${verdict.level}, ${verdict.matched.length} rule(s) matched`);
