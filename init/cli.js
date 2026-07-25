#!/usr/bin/env node
// agentflow-init — bootstrap a repo for the loop.
//
//   agentflow-init labels  [--repo owner/name] [--dry-run]
//   agentflow-init project --target <dir> [--dry-run]
//
// `labels` creates/updates the label set idempotently via `gh label create
// --force`. `project` scaffolds a consuming app: config, domains map, business
// policy pack, and the e2e directories. Existing files are never overwritten.
// Exit codes: 0 ok · 20 usage/error.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") flags.dryRun = true;
    else if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
  }
  return flags;
}

export function labelCommands(labelsDoc, repo) {
  const repoArgs = repo ? ["--repo", repo] : [];
  return labelsDoc.labels.map((l) => [
    "label", "create", l.name, ...repoArgs,
    "--color", l.color, "--description", l.description, "--force",
  ]);
}

export function projectPlan(targetDir) {
  const agentsDir = join(HERE, "../agents");
  const agentSteps = readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ from: join(agentsDir, f), to: join(targetDir, ".claude/agents", f) }));
  return [
    { from: join(HERE, "templates/agentflow.config.json"), to: join(targetDir, "agentflow.config.json") },
    { from: join(HERE, "templates/domains.yml"), to: join(targetDir, "domains.yml") },
    { from: join(HERE, "templates/policies-business.yml"), to: join(targetDir, "policies/business.yml") },
    ...agentSteps,
    { dir: join(targetDir, "e2e/scenarios") },
    { dir: join(targetDir, "e2e/traces") },
  ];
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseArgs(rest);

switch (command) {
  case "labels": {
    const doc = parseYaml(readFileSync(join(HERE, "labels.yml"), "utf8"));
    const commands = labelCommands(doc, flags.repo);
    for (const args of commands) {
      if (flags.dryRun) {
        console.log(`gh ${args.join(" ")}`);
      } else {
        execFileSync("gh", args, { stdio: ["ignore", "ignore", "inherit"] });
        console.log(`label ${args[2]} ✓`);
      }
    }
    console.log(`${commands.length} label(s) ${flags.dryRun ? "planned" : "ensured"}`);
    break;
  }
  case "project": {
    if (!flags.target) {
      console.error("usage: agentflow-init project --target <dir> [--dry-run]");
      process.exit(20);
    }
    for (const step of projectPlan(flags.target)) {
      if (step.dir) {
        if (flags.dryRun) console.log(`mkdir -p ${step.dir}`);
        else mkdirSync(step.dir, { recursive: true });
        continue;
      }
      if (existsSync(step.to)) {
        console.log(`skip ${step.to} (exists)`);
        continue;
      }
      if (flags.dryRun) {
        console.log(`copy ${step.from} → ${step.to}`);
      } else {
        mkdirSync(dirname(step.to), { recursive: true });
        copyFileSync(step.from, step.to);
        console.log(`wrote ${step.to}`);
      }
    }
    break;
  }
  default:
    console.error("usage: agentflow-init <labels|project> …");
    process.exit(20);
}
