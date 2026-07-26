#!/usr/bin/env node
// agentflow-init — bootstrap a repo for the loop.
//
//   agentflow-init labels  [--repo owner/name] [--dry-run]
//   agentflow-init project --target <dir> [--dry-run]
//   agentflow-init adopt   --target <dir> --repo owner/name [--dry-run]
//
// `labels` creates/updates the label set idempotently via `gh label create
// --force`. `project` scaffolds a consuming app: config, domains map, business
// policy pack, and the e2e directories. Existing files are never overwritten.
// `adopt` composes both for a repo that already exists — additively, never
// forcing a label — and prints one ordered created/present/remaining summary.
// Exit codes: 0 ok · 20 usage/error.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { labelCreateCommands, labelPlan, remainingItems, renderSummary, scaffoldSummary } from "./adopt.js";

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

export function projectPlan(targetDir, toolkitRepo = "yuchida-tamu/agent-workflow") {
  const agentsDir = join(HERE, "../agents");
  const agentSteps = readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ from: join(agentsDir, f), to: join(targetDir, ".claude/agents", f) }));
  const workflowsDir = join(HERE, "templates/workflows");
  const workflowSteps = readdirSync(workflowsDir).map((f) => ({
    from: join(workflowsDir, f),
    to: join(targetDir, ".github/workflows", f),
    subst: { __TOOLKIT_REPO__: toolkitRepo },
  }));
  return [
    { from: join(HERE, "templates/agentflow.config.json"), to: join(targetDir, "agentflow.config.json") },
    { from: join(HERE, "templates/domains.yml"), to: join(targetDir, "domains.yml") },
    { from: join(HERE, "templates/policies-business.yml"), to: join(targetDir, "policies/business.yml") },
    ...agentSteps,
    ...workflowSteps,
    { dir: join(targetDir, "e2e/scenarios") },
    { dir: join(targetDir, "e2e/traces") },
  ];
}

// One projectPlan() step → disk. `verbose` is what separates `project` (narrates
// every step) from `adopt` (the ordered summary does the narrating instead).
function applyStep(step, { dryRun = false, verbose = true } = {}) {
  const log = (line) => { if (verbose) console.log(line); };
  if (step.dir) {
    if (dryRun) log(`mkdir -p ${step.dir}`);
    else mkdirSync(step.dir, { recursive: true });
    return;
  }
  if (existsSync(step.to)) {
    log(`skip ${step.to} (exists)`);
    return;
  }
  if (dryRun) {
    log(`copy ${step.from} → ${step.to}`);
    return;
  }
  mkdirSync(dirname(step.to), { recursive: true });
  if (step.subst) {
    let content = readFileSync(step.from, "utf8");
    for (const [key, value] of Object.entries(step.subst)) {
      content = content.replaceAll(key, value);
    }
    writeFileSync(step.to, content);
  } else {
    copyFileSync(step.from, step.to);
  }
  log(`wrote ${step.to}`);
}

function readIfPresent(path, parse) {
  try {
    return parse(readFileSync(path, "utf8")) ?? null;
  } catch {
    return null; // absent or unparseable — `remaining` says what that costs
  }
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
    for (const step of projectPlan(flags.target, flags.toolkit)) {
      applyStep(step, { dryRun: flags.dryRun });
    }
    break;
  }
  case "adopt": {
    if (!flags.target || !flags.repo) {
      console.error("usage: agentflow-init adopt --target <dir> --repo <owner/name> [--dry-run]");
      process.exit(20);
    }
    const steps = projectPlan(flags.target, flags.toolkit);
    const onDisk = steps.map((s) => s.dir ?? s.to).filter((p) => existsSync(p));
    const scaffold = scaffoldSummary(steps, onDisk);
    for (const step of steps) {
      applyStep(step, { dryRun: flags.dryRun, verbose: Boolean(flags.dryRun) });
    }

    // Labels are additive here: only the missing ones, never --force.
    const doc = parseYaml(readFileSync(join(HERE, "labels.yml"), "utf8"));
    const extra = [];
    let labels = { create: [], present: [] };
    const createdLabels = [];
    try {
      const listed = execFileSync(
        "gh",
        ["label", "list", "--repo", flags.repo, "--json", "name", "--limit", "200"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
      labels = labelPlan(doc, JSON.parse(listed).map((l) => l.name));
      for (const args of labelCreateCommands(doc, labels.create, flags.repo)) {
        if (flags.dryRun) {
          console.log(`gh ${args.join(" ")}`);
          createdLabels.push(args[2]);
          continue;
        }
        try {
          execFileSync("gh", args, { stdio: ["ignore", "ignore", "inherit"] });
          createdLabels.push(args[2]);
        } catch {
          process.exitCode = 20;
          extra.push(`label ${args[2]} could not be created — create it by hand, then re-run adopt`);
        }
      }
    } catch {
      process.exitCode = 20;
      extra.push(`labels unknown — \`gh label list --repo ${flags.repo}\` failed; re-run adopt once gh can reach the repo`);
    }

    const rel = (p) => relative(flags.target, p) || p;
    console.log(renderSummary({
      dryRun: Boolean(flags.dryRun),
      created: [...scaffold.created.map(rel), ...createdLabels.map((n) => `label ${n}`)],
      present: [...scaffold.present.map(rel), ...labels.present.map((n) => `label ${n}`)],
      remaining: remainingItems({
        config: readIfPresent(join(flags.target, "agentflow.config.json"), JSON.parse),
        domains: readIfPresent(join(flags.target, "domains.yml"), parseYaml),
        extra,
      }),
    }));
    break;
  }
  default:
    console.error("usage: agentflow-init <labels|project|adopt> …");
    process.exit(20);
}
