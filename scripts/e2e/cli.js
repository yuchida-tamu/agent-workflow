#!/usr/bin/env node
// agentflow-e2e — replay behavioral scenarios from compiled traces.
//
//   agentflow-e2e run   --scenarios e2e/scenarios --traces e2e/traces \
//     --pack packs/expo [--tags "@smoke"] [--out results.json] [--evidence dir]
//   agentflow-e2e smoke --scenarios e2e/scenarios [--traces d] [--pack d] [--tags "@smoke"]
//
// `run` replays and reports. `smoke` is the post-merge step: it answers whether
// the merge may proceed to `verified`, which on a repo with no scenario suite is
// vacuously yes — an empty suite is a fact about the repo, not a failure. The
// outcome always names which case occurred, so a vacuous pass is never mistaken
// for a verified one.
//
// Adapters are resolved as <pack>/adapters/{run,execute-step}(.js). Results go
// to --out (default stdout). Exit codes: 0 all passed · 10 failures or steps
// needing derivation · 20 usage/infrastructure error.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseFeature, selectScenarios, slug } from "./gherkin.js";
import { runScenarios } from "./runner.js";
import { classifySuite, smokeOutcome, renderSmokeNote } from "./smoke.js";

function invokeExecutable(cmd, args, inputJson) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`adapter exited ${code} (infrastructure failure)`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`adapter returned invalid JSON: ${stdout.slice(0, 200)}`));
      }
    });
    child.stdin.end(inputJson);
  });
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
  }
  return flags;
}

function resolveAdapter(packDir, name) {
  for (const candidate of [join(packDir, "adapters", name), join(packDir, "adapters", `${name}.js`)]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`pack has no "${name}" adapter under ${join(packDir, "adapters")}`);
}

function makeInvoke(packDir, evidenceDir) {
  const adapters = {
    run: resolveAdapter(packDir, "run"),
    "execute-step": resolveAdapter(packDir, "execute-step"),
  };
  return (interfaceName, payload) => {
    const path = adapters[interfaceName];
    const [cmd, args] = path.endsWith(".js") ? [process.execPath, [path]] : [path, []];
    return invokeExecutable(cmd, args, JSON.stringify({ ...payload, evidence_dir: evidenceDir }));
  };
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseArgs(rest);

if (!["run", "smoke"].includes(command) || !flags.scenarios || (command === "run" && (!flags.traces || !flags.pack))) {
  console.error("usage: agentflow-e2e run   --scenarios <dir> --traces <dir> --pack <dir> [--tags @a,@b] [--out f] [--evidence dir]");
  console.error("       agentflow-e2e smoke --scenarios <dir> [--traces <dir>] [--pack <dir>] [--tags @a,@b] [--out f]");
  process.exit(20);
}

// A repo that never initialised a scenario directory and one whose directory is
// empty are the same fact, so neither may throw. Read the listing defensively
// rather than asking `existsSync` and racing it.
function readFeatureFiles(dir) {
  try {
    return { exists: true, files: readdirSync(dir).filter((f) => f.endsWith(".feature")) };
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return { exists: false, files: [] };
    throw err;
  }
}

// `smoke` on an empty suite must answer before touching the pack: a repo with no
// scenarios has no adapters either, so resolving them would turn a vacuous pass
// into an infrastructure error.
if (command === "smoke") {
  const listing = readFeatureFiles(flags.scenarios);
  const suite = classifySuite({ scenariosDirExists: listing.exists, featureFiles: listing.files });
  let result = null;
  if (!suite.empty) {
    if (!flags.traces || !flags.pack) {
      console.error("smoke: this repo has a scenario suite, so --traces and --pack are required");
      process.exit(20);
    }
    const features = listing.files.map((f) =>
      parseFeature(readFileSync(join(flags.scenarios, f), "utf8"), f)
    );
    const tags = (flags.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const scenarios = selectScenarios(features, tags);
    const evidenceDir = flags.evidence ?? join(flags.traces, "..", "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    result = await runScenarios(scenarios, {
      invoke: makeInvoke(flags.pack, evidenceDir),
      loadTrace: (scenario) => {
        const path = join(flags.traces, slug(scenario.feature), `${slug(scenario.name)}.trace.json`);
        return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
      },
    });
  }
  const outcome = smokeOutcome({ suite, result });
  if (flags.out) writeFileSync(flags.out, JSON.stringify(outcome, null, 2));
  console.log(renderSmokeNote(outcome));
  process.exit(outcome.status === "passed" ? 0 : 10);
}

try {
  const features = readdirSync(flags.scenarios)
    .filter((f) => f.endsWith(".feature"))
    .map((f) => parseFeature(readFileSync(join(flags.scenarios, f), "utf8"), f));
  const tags = (flags.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const scenarios = selectScenarios(features, tags);

  const loadTrace = (scenario) => {
    const path = join(flags.traces, slug(scenario.feature), `${slug(scenario.name)}.trace.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  };

  const evidenceDir = flags.evidence ?? join(flags.traces, "..", "evidence");
  mkdirSync(evidenceDir, { recursive: true });

  const outcome = await runScenarios(scenarios, {
    invoke: makeInvoke(flags.pack, evidenceDir),
    loadTrace,
  });

  const json = JSON.stringify(outcome, null, 2);
  if (flags.out) {
    writeFileSync(flags.out, json);
    console.log(`${scenarios.length} scenario(s): ${JSON.stringify(outcome.summary)} → ${flags.out}`);
  } else {
    console.log(json);
  }
  process.exit(outcome.summary.failed || outcome.summary["needs-derivation"] ? 10 : 0);
} catch (err) {
  console.error(err.message);
  process.exit(20);
}
