#!/usr/bin/env node
// agentflow-facts — extract policy-engine facts from a git range.
//
//   agentflow-facts --base main --head HEAD --stage pr \
//     [--domains domains.yml] [--plan plan.json] [--brief brief.json]
//
// Prints the facts JSON that `agentflow-policy evaluate --facts -` consumes.
// Exit codes: 0 ok · 20 usage/input error.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { assembleFacts } from "./core.js";

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
  }
  return flags;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function gitShowJson(rev, path) {
  try {
    return JSON.parse(git(["show", `${rev}:${path}`]));
  } catch {
    return null;
  }
}

function loadFile(path) {
  const text = readFileSync(path, "utf8");
  return path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
}

const flags = parseArgs(process.argv.slice(2));
const stage = flags.stage ?? "pr";
if (!flags.base || !["plan", "pr"].includes(stage)) {
  console.error("usage: agentflow-facts --base <rev> [--head <rev>] --stage <plan|pr> [--domains f] [--plan f] [--brief f]");
  process.exit(20);
}
const head = flags.head ?? "HEAD";

const numstat = git(["diff", "--numstat", `${flags.base}...${head}`])
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [adds, dels, file] = line.split("\t");
    return { file, adds: adds === "-" ? 0 : Number(adds), dels: dels === "-" ? 0 : Number(dels) };
  });

const facts = assembleFacts({
  stage,
  numstat,
  basePkg: gitShowJson(flags.base, "package.json"),
  headPkg: gitShowJson(head, "package.json"),
  domains: flags.domains ? loadFile(flags.domains) : null,
  planFiles: flags.plan ? loadFile(flags.plan).files ?? null : null,
  brief: flags.brief ? loadFile(flags.brief) : null,
  unmappedCriticality: flags.config ? loadFile(flags.config).unmapped_criticality ?? null : null,
});

console.log(JSON.stringify(facts, null, 2));
