// Fact extraction: pure functions that turn raw change data into the fact
// namespaces the policy engine consumes (see the fact catalog in the
// architecture doc). Git/gh gathering lives in the CLI, never here.

import { globToRegExp } from "../policy/engine.js";

const TEST_FILE = /(\.|_)(test|spec)\.[jt]sx?$|(^|\/)__tests__\/|^e2e\//;
const DOCS_FILE = /\.(md|mdx|txt)$|(^|\/)docs\//;
const CODE_FILE = /\.[jt]sx?$|\.(mjs|cjs|vue|svelte)$/;

export const CRITICALITY = ["low", "medium", "high", "critical"];

export function classifyChange(files) {
  if (files.length === 0) return "empty";
  if (files.every((f) => DOCS_FILE.test(f))) return "docs";
  if (files.every((f) => TEST_FILE.test(f))) return "tests";
  return "code";
}

function depsOf(pkg) {
  return { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
}

export function packageFacts(basePkg, headPkg) {
  const base = depsOf(basePkg);
  const head = depsOf(headPkg);
  const added = Object.keys(head).filter((d) => !(d in base));
  const sdkBump = ["expo", "react-native"].some((d) => d in base && d in head && base[d] !== head[d]);
  return { new_dependency_count: added.length, new_dependencies: added, sdk_bump: sdkBump };
}

// numstat: [{ file, adds, dels }] from `git diff --numstat` (binary files → 0/0).
export function diffFacts({ numstat, basePkg = null, headPkg = null }) {
  const files = numstat.map((n) => n.file);
  const loc = numstat.reduce((sum, n) => sum + n.adds + n.dels, 0);
  const testsChanged = files.some((f) => TEST_FILE.test(f));
  const logicChanged = files.some((f) => CODE_FILE.test(f) && !TEST_FILE.test(f));
  return {
    files,
    files_count: files.length,
    loc,
    tests_changed: testsChanged,
    logic_changed: logicChanged,
    ...packageFacts(basePkg, headPkg),
  };
}

// domains: parsed domains.yml — { name: { criticality, paths: [glob…] } }.
export function domainFacts(domains, files) {
  const compiled = Object.entries(domains ?? {}).map(([name, d]) => ({
    name,
    criticality: d.criticality ?? "medium",
    regexps: (d.paths ?? []).map(globToRegExp),
  }));
  const touched = new Set();
  let unmapped = 0;
  for (const file of files) {
    const hits = compiled.filter((d) => d.regexps.some((r) => r.test(file)));
    if (hits.length === 0) unmapped++;
    for (const d of hits) touched.add(d.name);
  }
  let max = null;
  for (const d of compiled) {
    if (!touched.has(d.name)) continue;
    if (max === null || CRITICALITY.indexOf(d.criticality) > CRITICALITY.indexOf(max)) {
      max = d.criticality;
    }
  }
  return {
    touched: [...touched].sort(),
    max_criticality: max,
    unmapped_fraction: files.length === 0 ? 0 : unmapped / files.length,
  };
}

// plan.files may be globs. Drift facts only activate at PR time.
export function driftFacts({ planFiles = null, diffFiles = [], brief = null, domains = null, domainsTouched = [] }) {
  const facts = {};
  if (planFiles != null) {
    const regexps = planFiles.map(globToRegExp);
    facts.scope = diffFiles.some((f) => !regexps.some((r) => r.test(f)));
  }
  if (brief != null && domains != null) {
    const declared = new Set(brief.impact_domains ?? []);
    facts.brief_domain = domainsTouched.some((name) => {
      const crit = domains[name]?.criticality ?? "medium";
      return CRITICALITY.indexOf(crit) >= CRITICALITY.indexOf("high") && !declared.has(name);
    });
  }
  return facts;
}

export function assembleFacts({ stage, numstat, basePkg, headPkg, domains, planFiles, brief }) {
  const diff = diffFacts({ numstat, basePkg, headPkg });
  const facts = {
    meta: { stage, change_class: classifyChange(diff.files) },
    diff,
  };
  if (domains != null) facts.domains = domainFacts(domains, diff.files);
  const drift = driftFacts({
    planFiles,
    diffFiles: diff.files,
    brief,
    domains,
    domainsTouched: facts.domains?.touched ?? [],
  });
  if (Object.keys(drift).length) facts.drift = drift;
  if (brief != null) facts.brief = brief;
  if (planFiles != null) facts.plan = { files: planFiles };
  return facts;
}
