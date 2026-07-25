#!/usr/bin/env node
// agentflow-e2e — replay behavioral scenarios from compiled traces.
//
//   agentflow-e2e run --scenarios e2e/scenarios --traces e2e/traces \
//     --pack packs/expo [--tags "@smoke"] [--out results.json] [--evidence dir]
//
// Adapters are resolved as <pack>/adapters/{run,execute-step}(.js). Results go
// to --out (default stdout). Exit codes: 0 all passed · 10 failures or steps
// needing derivation · 20 usage/infrastructure error.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseFeature, selectScenarios, slug } from "./gherkin.js";
import { runScenarios } from "./runner.js";

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

if (command !== "run" || !flags.scenarios || !flags.traces || !flags.pack) {
  console.error("usage: agentflow-e2e run --scenarios <dir> --traces <dir> --pack <dir> [--tags @a,@b] [--out f] [--evidence dir]");
  process.exit(20);
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
