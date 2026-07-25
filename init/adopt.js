// Brownfield adoption: what does this repo still need to run the loop?
// Pure. The CLI supplies the repo's current state (which files exist, which
// labels the repo already carries, the scaffolded config) and does the I/O.
//
// Adoption is additive by construction: it never rewrites a file and never
// rewrites a label, so a repo that has half of the loop already keeps its own.

// The config template ships these; until a human changes them the loop can't
// route approvals, so they belong in `remaining` rather than looking configured.
const PLACEHOLDER_APPROVER = "CHANGE_ME";
const TEMPLATE_PLATFORM = "rn-expo";

// → { create: [names], present: [names] }, both in labels.yml order.
export function labelPlan(labelsDoc, existingNames) {
  const existing = new Set(existingNames ?? []);
  const create = [];
  const present = [];
  for (const label of labelsDoc.labels) {
    (existing.has(label.name) ? present : create).push(label.name);
  }
  return { create, present };
}

// `gh` args for the named labels only. Deliberately no --force: a brownfield
// repo may already own `blocked` or `priority:p1` in a colour its humans chose,
// and adoption has no business rewriting them. (`agentflow-init labels` still
// forces — that command is for a repo the loop already owns.)
export function labelCreateCommands(labelsDoc, names, repo) {
  const wanted = new Set(names);
  const repoArgs = repo ? ["--repo", repo] : [];
  return labelsDoc.labels
    .filter((l) => wanted.has(l.name))
    .map((l) => [
      "label", "create", l.name, ...repoArgs,
      "--color", l.color, "--description", l.description,
    ]);
}

// steps: projectPlan() output ({ to } for files, { dir } for directories).
// existingPaths: the subset the CLI found on disk. → { created, present }.
export function scaffoldSummary(steps, existingPaths) {
  const existing = existingPaths instanceof Set ? existingPaths : new Set(existingPaths ?? []);
  const created = [];
  const present = [];
  for (const step of steps) {
    const path = step.dir ?? step.to;
    (existing.has(path) ? present : created).push(path);
  }
  return { created, present };
}

// What a human or the adoption-auditor still owes after adopt has run. This is
// the section that makes a half-finished adoption visible.
//   config:  parsed agentflow.config.json, or null when absent/unparseable
//   domains: parsed domains.yml — null when it is still the comments-only stub
//   extra:   run-specific items (e.g. a `gh` call that failed), appended last
export function remainingItems({ config, domains, extra = [] }) {
  const items = [];
  if (!domains || Object.keys(domains).length === 0) {
    items.push("domains.yml is still the template stub — map this repo's domains and criticalities");
  }
  if (!config?.platform || config.platform === TEMPLATE_PLATFORM) {
    items.push(`agentflow.config.json: confirm "platform" (the template ships "${TEMPLATE_PLATFORM}")`);
  }
  const approvers = config?.approvers ?? [];
  if (approvers.length === 0 || approvers.includes(PLACEHOLDER_APPROVER)) {
    items.push('agentflow.config.json: set "approvers" — nobody can pass G3/G4 until it names real logins');
  }
  items.push(
    "repo settings not configured — branch protection, toolkit Actions access and the release " +
      "environment are still applied by hand",
  );
  return [...items, ...extra];
}

// One block, three sections, always in this order — the ordering is the point.
export function renderSummary({ created, present, remaining, dryRun = false }) {
  const section = (title, items) => [
    `${title} (${items.length})`,
    ...(items.length ? items.map((i) => `  ${i}`) : ["  —"]),
  ];
  return [
    dryRun ? "adopt — dry run, nothing was written" : "adopt",
    "",
    ...section("created", created),
    "",
    ...section("present", present),
    "",
    ...section("remaining", remaining),
  ].join("\n");
}
