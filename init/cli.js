#!/usr/bin/env node
// agentflow-init — bootstrap a repo for the loop.
//
//   agentflow-init labels  [--repo owner/name] [--dry-run]
//   agentflow-init project --target <dir> [--dry-run]
//   agentflow-init adopt   --target <dir> --repo owner/name [--dry-run]
//                          [--default-branch main] [--required-check <ctx>]…
//                          [--environment release] [--toolkit owner/name]
//   agentflow-init adopt --verify --target <dir> --repo owner/name
//   agentflow-init adopt --coverage --target <dir> [--json] [--strict]
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
//
// `adopt --coverage` reports how much of the target's tracked source
// `domains.yml` leaves unmapped, against the `unmapped_warn_fraction` its
// config sets. It needs no repo — it reads git and two files. Exceeding the
// threshold is a warning, not a failure: an under-grown map is a backlog item,
// not a broken adoption, so the exit code stays 0 and the `!` line does the
// talking.
//
// Exit codes: 0 ok · 1 a --verify check failed · 20 usage/error.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_TOOLKIT_REPO,
  DEFAULT_WARN_FRACTION,
  NOT_APPLICABLE,
  coverage,
  isApproverLogin,
  labelCreateCommands,
  labelPlan,
  remainingItems,
  renderCoverage,
  renderSummary,
  scaffoldSummary,
  settingsReport,
  trackedSourceFiles,
} from "./adopt.js";
import { exitCode, renderChecks, verifyChecks } from "./verify.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// Flags that take no value. Everything else consumes the next argv entry, so a
// boolean left out of here would silently swallow the flag that follows it.
const BOOLEAN_FLAGS = {
  "--dry-run": "dryRun",
  "--verify": "verify",
  "--coverage": "coverage",
  "--strict": "strict",
  "--json": "json",
};

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

// `.feature` files directly under `dir` — an absent directory is "none", not
// an error, the same convention `post-merge.js` and `scripts/e2e/cli.js` use.
function readFeatureFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".feature"));
  } catch {
    return [];
  }
}

// Files under `dir`, recursively — what "0 compiled traces" (#182) counts.
function countTraceFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    count += entry.isDirectory() ? countTraceFiles(join(dir, entry.name)) : 1;
  }
  return count;
}

// A plain directory listing, empty (never an error) when `dir` is absent.
function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
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

// Every path git tracks in the target, NUL-separated so a filename containing a
// space or a newline survives the round trip. Throws when the target is not a
// repo — coverage over an untracked directory would be a made-up number.
function gitTrackedFiles(target) {
  const stdout = execFileSync("git", ["-C", target, "ls-files", "-z"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\0").filter(Boolean);
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
    // Coverage reads git and two files in the target; it never touches the
    // repo, so it is the one adopt mode that does not need --repo.
    if (flags.coverage) {
      if (!flags.target) {
        console.error("usage: agentflow-init adopt --coverage --target <dir> [--json] [--strict]");
        process.exit(20);
      }
      let files;
      try {
        files = trackedSourceFiles(gitTrackedFiles(flags.target));
      } catch (err) {
        console.error(`agentflow-init: cannot list tracked files in ${flags.target} — ${err.message}`);
        process.exit(20);
      }
      const config = readIfPresent(join(flags.target, "agentflow.config.json"), JSON.parse);
      const warnFraction =
        typeof config?.unmapped_warn_fraction === "number"
          ? config.unmapped_warn_fraction
          : DEFAULT_WARN_FRACTION;
      const unmappedCriticality = config?.unmapped_criticality ?? "medium";
      const report = coverage(
        readIfPresent(join(flags.target, "domains.yml"), parseYaml),
        files,
        { warnFraction },
      );
      console.log(
        flags.json
          ? JSON.stringify({ ...report, unmapped_criticality: unmappedCriticality }, null, 2)
          : renderCoverage(report, { unmappedCriticality }),
      );
      // `--strict` turns the warning into a failure, so the map cannot rot
      // silently. It matters more since #46: verdicts now read criticality, so
      // an unmapped file is not merely undocumented — it is unguarded. The
      // report has printed the breach for a while and nothing acted on it.
      if (flags.strict && report.warn_fraction !== null && report.unmapped_fraction > report.warn_fraction) {
        console.error(
          `agentflow-init: ${report.unmapped} of ${report.total} tracked file(s) are unmapped, ` +
            `above the configured ${report.warn_fraction} threshold — extend domains.yml`,
        );
        process.exit(10);
      }
      break;
    }

    if (!flags.target || !flags.repo) {
      console.error(
        "usage: agentflow-init adopt --target <dir> --repo <owner/name> [--dry-run]\n" +
          "       [--default-branch main] [--required-check <ctx>]… [--environment release]\n" +
          "       agentflow-init adopt --verify --target <dir> --repo <owner/name>\n" +
          "       agentflow-init adopt --coverage --target <dir> [--json]",
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

      // The same read-only GET `adopt` makes, for the same reason: whether a
      // native G3 review is *enforced* is a fact about the branch, not about the
      // config. `ghGet` returns undefined when it cannot be read, and `g3Mode`
      // reports that as unknown rather than guessing either way.
      const verifyBranch = flags["default-branch"] ?? "main";
      const checks = verifyChecks({
        config: readParsed(join(flags.target, "agentflow.config.json"), JSON.parse),
        labels,
        domains: readParsed(join(flags.target, "domains.yml"), parseYaml),
        workflows: readWorkflows(join(flags.target, ".github/workflows"), expectedWorkflows),
        next: runNext(flags.repo),
        protection: ghGet(`/repos/${flags.repo}/branches/${verifyBranch}/protection`),
        expectedLabels,
        expectedWorkflows,
        e2e: {
          featureFiles: readFeatureFiles(join(flags.target, "e2e/scenarios")),
          traceCount: countTraceFiles(join(flags.target, "e2e/traces")),
          toolkitPacks: listDir(join(HERE, "..", "packs")),
          consumerPacks: listDir(join(flags.target, "packs")),
        },
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
      config: config ?? {},
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
