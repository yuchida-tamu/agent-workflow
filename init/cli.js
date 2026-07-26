#!/usr/bin/env node
// agentflow-init — bootstrap a repo for the loop.
//
//   agentflow-init labels  [--repo owner/name] [--dry-run]
//   agentflow-init project --target <dir> [--dry-run]
//   agentflow-init adopt   --target <dir> --repo owner/name [--dry-run]
//                          [--default-branch main] [--required-check <ctx>]…
//                          [--environment release] [--toolkit owner/name]
//   agentflow-init adopt --verify --target <dir> --repo owner/name
//
// `labels` creates/updates the label set idempotently via `gh label create
// --force`. `project` scaffolds a consuming app: config, domains map, business
// policy pack, and the e2e directories. Existing files are never overwritten.
// `adopt` composes both for a repo that already exists — additively, never
// forcing a label — and prints one ordered created/present/remaining summary.
//
// `adopt` also reports the three repo settings the loop needs (toolkit Actions
// access, G3 branch protection, the G4 release Environment). It reads them with
// three read-only GETs and PRINTS the `gh api` command for whatever is missing.
// It never applies them, under any flag: repo settings are a policy change on
// someone's repo, and that stays a deliberate human keystroke.
//
// `adopt --verify` re-reads an already-adopted repo and reports, per check,
// whether the step actually landed. It reports; it never repairs.
// Exit codes: 0 ok · 1 a --verify check failed · 20 usage/error.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_TOOLKIT_REPO,
  NOT_APPLICABLE,
  isApproverLogin,
  labelCreateCommands,
  labelPlan,
  remainingItems,
  renderSummary,
  scaffoldSummary,
  settingsReport,
} from "./adopt.js";
import { exitCode, renderChecks, verifyChecks } from "./verify.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// Flags that take no value. Everything else consumes the next argv entry, so a
// boolean left out of here would silently swallow the flag that follows it.
const BOOLEAN_FLAGS = { "--dry-run": "dryRun", "--verify": "verify" };

// A repeated flag accumulates (`--required-check a --required-check b`); a flag
// given once stays a scalar, so existing callers see no change.
function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] in BOOLEAN_FLAGS) flags[BOOLEAN_FLAGS[argv[i]]] = true;
    else if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value = argv[++i];
      flags[key] = key in flags ? [...[].concat(flags[key]), value] : value;
    }
  }
  return flags;
}

const asList = (v) => (v === undefined ? [] : [].concat(v));

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

// Same read, but `--verify` has to tell "absent" from "unparseable" apart: they
// are different missed steps and they get different advice.
function readParsed(path, parse) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { value: null, error: err.code === "ENOENT" ? `not found at ${path}` : err.message };
  }
  try {
    return { value: parse(text), error: null };
  } catch (err) {
    return { value: null, error: `does not parse — ${err.message}` };
  }
}

// The stubs actually on disk. An absent one is not an error here — the check
// reports it, alongside the ones that are installed but wrong.
function readWorkflows(dir, expected) {
  const files = [];
  for (const name of expected) {
    try {
      files.push({ name, content: readFileSync(join(dir, name), "utf8") });
    } catch {
      /* absent — workflowsCheck says so */
    }
  }
  return files;
}

// Run the dispatcher against the target repo the way the installed workflow
// does. `--json` is what makes "unparseable output" a decidable outcome rather
// than a judgement about prose. A non-zero exit is data, not a throw: 1 is the
// documented idle code and has to reach verifyChecks() intact.
function runNext(repo) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(HERE, "../scripts/next/cli.js"), "--repo", repo, "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return { code: 0, stdout, error: null };
  } catch (err) {
    if (typeof err.status === "number") return { code: err.status, stdout: err.stdout ?? "", error: null };
    return { code: null, stdout: "", error: err.message }; // never started
  }
}

// A read-only GET, translated into the sentinel settingsReport() expects.
// `gh api` writes the error body to stdout and its own one-liner to stderr, so
// the HTTP status is recoverable from a failed call without parsing prose.
//   200 → body · 404 → null (absent) · 422 → NOT_APPLICABLE · anything else,
//   including 403 and a gh that could not run at all → undefined (unreadable).
// A failing GET is never fatal: an unreadable setting is reported, not assumed.
function ghGet(path) {
  try {
    return JSON.parse(execFileSync("gh", ["api", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch (err) {
    let status = 0;
    try {
      status = Number(JSON.parse(err.stdout ?? "").status);
    } catch {
      /* no JSON body — gh itself failed */
    }
    if (status === 404) return null;
    if (status === 422) return NOT_APPLICABLE;
    return undefined;
  }
}

// Approver logins → numeric user ids, so the printed environment body can be
// fully literal. Resolving here rather than printing a `$(gh api /users/…)` for
// the reader's shell to run is what lets every command use an inert quoted
// heredoc; see renderCommand. An unresolvable login yields `id: null`, which the
// report turns into a "resolve this first" note rather than a broken command.
function resolveApprovers(logins) {
  return logins.map((login) => {
    if (!isApproverLogin(login)) return { login, id: null };
    const user = ghGet(`/users/${encodeURIComponent(login)}`);
    return { login, id: user && user !== NOT_APPLICABLE ? user.id : null };
  });
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
      console.error(
        "usage: agentflow-init adopt --target <dir> --repo <owner/name> [--dry-run]\n" +
          "       [--default-branch main] [--required-check <ctx>]… [--environment release]\n" +
          "       agentflow-init adopt --verify --target <dir> --repo <owner/name>",
      );
      process.exit(20);
    }

    if (flags.verify) {
      let expectedLabels;
      let expectedWorkflows;
      try {
        expectedLabels = parseYaml(readFileSync(join(HERE, "labels.yml"), "utf8")).labels.map((l) => l.name);
        expectedWorkflows = readdirSync(join(HERE, "templates/workflows"));
      } catch (err) {
        console.error(`agentflow-init: cannot read its own templates — ${err.message}`);
        process.exit(20);
      }

      let labels = { names: null, error: null };
      try {
        const listed = execFileSync(
          "gh",
          ["label", "list", "--repo", flags.repo, "--json", "name", "--limit", "200"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        labels = { names: JSON.parse(listed).map((l) => l.name), error: null };
      } catch {
        labels = { names: null, error: `\`gh label list --repo ${flags.repo}\` failed — cannot tell` };
      }

      const checks = verifyChecks({
        config: readParsed(join(flags.target, "agentflow.config.json"), JSON.parse),
        labels,
        domains: readParsed(join(flags.target, "domains.yml"), parseYaml),
        workflows: readWorkflows(join(flags.target, ".github/workflows"), expectedWorkflows),
        next: runNext(flags.repo),
        expectedLabels,
        expectedWorkflows,
      });

      console.log(`verify ${flags.target} → ${flags.repo}\n`);
      console.log(renderChecks(checks));
      process.exit(exitCode(checks));
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

    const config = readIfPresent(join(flags.target, "agentflow.config.json"), JSON.parse);

    // Repo settings: three read-only GETs, then a printed report. No flag gates
    // this, because it changes nothing — including under --dry-run.
    const toolkitRepo = flags.toolkit ?? DEFAULT_TOOLKIT_REPO;
    const defaultBranch = flags["default-branch"] ?? "main";
    const environment = flags.environment ?? "release";
    const settings = settingsReport({
      repo: flags.repo,
      toolkitRepo,
      defaultBranch,
      environment,
      approvers: resolveApprovers(config?.approvers ?? []),
      requiredChecks: asList(flags["required-check"]),
      current: {
        access: ghGet(`/repos/${toolkitRepo}/actions/permissions/access`),
        protection: ghGet(`/repos/${flags.repo}/branches/${defaultBranch}/protection`),
        environment: ghGet(`/repos/${flags.repo}/environments/${environment}`),
      },
    });

    const rel = (p) => relative(flags.target, p) || p;
    console.log(renderSummary({
      dryRun: Boolean(flags.dryRun),
      created: [...scaffold.created.map(rel), ...createdLabels.map((n) => `label ${n}`)],
      present: [...scaffold.present.map(rel), ...labels.present.map((n) => `label ${n}`)],
      remaining: remainingItems({
        config,
        domains: readIfPresent(join(flags.target, "domains.yml"), parseYaml),
        settings,
        extra,
      }),
      settings,
    }));
    break;
  }
  default:
    console.error("usage: agentflow-init <labels|project|adopt> …");
    process.exit(20);
}
