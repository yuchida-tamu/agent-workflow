#!/usr/bin/env node
// agentflow-policy — evaluate | test | validate
//
//   agentflow-policy evaluate --facts facts.json pack1.yaml [pack2.yaml…]
//   agentflow-policy test pack1.yaml [pack2.yaml…]
//   agentflow-policy validate pack1.yaml [pack2.yaml…]
//
// Exit codes: 0 ok · 10 test/assertion failures · 20 invalid input.

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { evaluate, runPackTests, validatePack } from "./engine.js";

function loadFile(path) {
  const text = readFileSync(path, "utf8");
  return path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
}

function loadPacks(paths) {
  const packs = paths.map((p) => ({ path: p, pack: loadFile(p) }));
  let invalid = false;
  for (const { path, pack } of packs) {
    const errors = validatePack(pack);
    if (errors.length) {
      invalid = true;
      console.error(`invalid pack ${path}:`);
      for (const e of errors) console.error(`  - ${e}`);
    }
  }
  if (invalid) process.exit(20);
  return packs.map((p) => p.pack);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { flags, positional };
}

const [command, ...rest] = process.argv.slice(2);
const { flags, positional } = parseArgs(rest);
const options = flags.levels ? { levelsConfig: loadFile(flags.levels) } : {};

switch (command) {
  case "evaluate": {
    if (!flags.facts || positional.length === 0) {
      console.error("usage: agentflow-policy evaluate --facts facts.json <pack...>");
      process.exit(20);
    }
    const packs = loadPacks(positional);
    const verdict = evaluate(packs, loadFile(flags.facts), options);
    console.log(JSON.stringify(verdict, null, 2));
    for (const w of verdict.warnings) console.error(`warning: ${w}`);
    break;
  }
  case "test": {
    if (positional.length === 0) {
      console.error("usage: agentflow-policy test <pack...>");
      process.exit(20);
    }
    const packs = loadPacks(positional);
    let failed = 0;
    let total = 0;
    for (const pack of packs) {
      const results = runPackTests(packs, pack, options);
      for (const r of results) {
        total++;
        if (r.ok) {
          console.log(`ok   ${pack.pack} › ${r.name}`);
        } else {
          failed++;
          console.log(`FAIL ${pack.pack} › ${r.name}`);
          for (const f of r.failures) console.log(`       ${f}`);
        }
      }
    }
    console.log(`\n${total - failed}/${total} passed`);
    process.exit(failed ? 10 : 0);
  }
  case "validate": {
    loadPacks(positional);
    console.log("all packs valid");
    break;
  }
  default:
    console.error("usage: agentflow-policy <evaluate|test|validate> …");
    process.exit(20);
}
