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
//
// `unmappedCriticality` is what a file matching no domain contributes. The
// config key has existed since the template shipped and nothing read it: this
// function summed only *mapped* domains, so unmapped code contributed nothing
// and scored as if it were harmless.
//
// That was free while criticality only mattered to a project's own `critical`
// rule. #36 added a baseline rule keyed on `high`, which turned every gap in the
// map into a gap in the guard — PR #34 added `agentflow-release`, the code that
// cuts releases, with `unmapped_fraction: 0.8`, and scored as a docs change.
//
// Passing `null` preserves the old behaviour, so a caller that does not resolve
// config is unaffected.
export function domainFacts(domains, files, { unmappedCriticality = null } = {}) {
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
  // Unmapped files contribute the configured default. Only when there is a map
  // to be unmapped *from*: a repo with no domains.yml has no domain facts to
  // speak of, and inventing a criticality for every file there would score
  // everything `medium` on repos that never opted in.
  if (unmapped > 0 && unmappedCriticality && compiled.length > 0) {
    if (max === null || CRITICALITY.indexOf(unmappedCriticality) > CRITICALITY.indexOf(max)) {
      max = unmappedCriticality;
    }
  }
  return {
    touched: [...touched].sort(),
    max_criticality: max,
    unmapped_fraction: files.length === 0 ? 0 : unmapped / files.length,
  };
}

// A rot-warning line for a PR verdict comment: the same budget
// `agentflow-init adopt --coverage` enforces against the whole repo
// (`unmapped_warn_fraction`), applied here to a single diff's
// `domains.unmapped_fraction`. `domainFacts` above scores unmapped code by
// contributing `unmapped_criticality` — this is the honesty check that the map
// producing that score is not itself decaying. Two guards, same shape as
// `domainFacts`'s: no `domains` fact means no map to have grown stale, and a
// missing/non-numeric budget means the project never configured one.
//
// Strictly greater than, matching `adopt --coverage`'s `warn` flag exactly —
// a diff sitting right at its own budget is not yet over it.
export function rotWarning(domains, unmappedWarnFraction) {
  if (!domains || typeof unmappedWarnFraction !== "number") return null;
  if (!(domains.unmapped_fraction > unmappedWarnFraction)) return null;
  const pct = (fraction) => `${(fraction * 100).toFixed(1)}%`;
  return (
    `⚠ ${pct(domains.unmapped_fraction)} of this diff is unmapped by domains.yml ` +
    `(budget ${pct(unmappedWarnFraction)}) — the map may be rotting`
  );
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

export function assembleFacts({ stage, numstat, basePkg, headPkg, domains, planFiles, brief, unmappedCriticality = null }) {
  const diff = diffFacts({ numstat, basePkg, headPkg });
  const facts = {
    meta: { stage, change_class: classifyChange(diff.files) },
    diff,
  };
  if (domains != null) facts.domains = domainFacts(domains, diff.files, { unmappedCriticality });
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
