// `adopt --verify` — the answer to "which of the adoption steps did I miss?"
//
// Pure. The CLI reads the target's files, lists the repo's labels and runs the
// dispatcher; everything here is a decision over what it found. Every check
// reports, none repairs: `--verify` tells you what is missing and stops.
//
// Each check returns { name, ok, note, detail }. A `note` is a passing remark —
// something true and worth saying that is not a defect — which is why the
// roll-up counts notes separately instead of hiding them behind a ✓.

import { CRITICALITIES, validateConfig } from "./config-schema.js";
import { g3Mode } from "../scripts/identity/identity.js";
import { stageEnabled } from "../scripts/headless/core.js";

// What `projectPlan()` substitutes into every workflow stub it installs. A stub
// that still carries it was copied by hand, not scaffolded.
const TOOLKIT_PLACEHOLDER = "__TOOLKIT_REPO__";

// `uses: <owner/name>/actions/<action>@ref` — the only thing the stubs point at.
const USES_TOOLKIT = /uses:\s*(\S+?)\/actions\/[^@\s]+@/g;
const REPO_SHAPE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// Exit 1 from `agentflow-next` is its documented idle code, not a fault. Adopt
// seeds no backlog by design, so an empty queue is the designed outcome of a
// correct adoption — the assertion here is that the dispatcher *runs*, not that
// it has something to say.
export const IDLE_NOTE =
  "loop wired, no work queued yet — label an issue `state:idea` to hand it to the product-shaper.";

const pass = (name, detail, note = null) => ({ name, ok: true, note, detail });
const fail = (name, detail, note = null) => ({ name, ok: false, note, detail });

// ---------------------------------------------------------------------------
// 1. agentflow.config.json

function configCheck({ value, error }) {
  const name = "agentflow.config.json";
  if (error) return fail(name, error);

  const issues = validateConfig(value);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warn");
  const render = (list) => list.map((i) => `${i.path || "(root)"} ${i.message}`).join("; ");
  const note = warnings.length ? render(warnings) : null;

  return errors.length
    ? fail(name, `schema-invalid: ${render(errors)}`, note)
    : pass(name, "parses and is schema-valid", note);
}

// ---------------------------------------------------------------------------
// 2. labels

function labelsCheck({ names, error }, expected) {
  const name = "labels";
  if (error) return fail(name, error);

  const present = new Set(names ?? []);
  const missing = expected.filter((label) => !present.has(label));
  return missing.length
    ? fail(
        name,
        `${missing.length} of ${expected.length} missing (${missing.join(", ")}) — ` +
          "re-run `agentflow-init adopt` to create them",
      )
    : pass(name, `all ${expected.length} present`);
}

// ---------------------------------------------------------------------------
// 3. domains.yml

function domainsCheck({ value, error }) {
  const name = "domains.yml";
  if (error) return fail(name, error);

  // The template stub is comments only, so it parses to null. That is a step
  // still owed, not a healthy adoption: an empty map leaves the risk engine
  // treating the entire repo as unmapped.
  if (value === null || value === undefined) {
    return fail(name, "still the template stub — no domains mapped; run the adoption-auditor");
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return fail(name, "must be a mapping of domain name → { criticality, paths }");
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return fail(name, "parses but maps no domains; run the adoption-auditor");

  const problems = [];
  for (const [domain, entry] of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${domain} is not a mapping`);
      continue;
    }
    if (!CRITICALITIES.includes(entry.criticality)) {
      problems.push(`${domain}.criticality must be one of ${CRITICALITIES.join(", ")}`);
    }
    if (!Array.isArray(entry.paths) || entry.paths.length === 0) {
      problems.push(`${domain}.paths must list at least one glob`);
    }
  }
  return problems.length
    ? fail(name, problems.join("; "))
    : pass(name, `${entries.length} domain(s), each with a criticality and paths`);
}

// ---------------------------------------------------------------------------
// 4. workflow stubs

// Stubs that serve an opt-in capability, mapped to the config that turns it on.
// A repo may legitimately not have these installed, so their absence is a note
// rather than a failure — unless the config says the stage is enabled, in which
// case a missing stub means a flag that can never fire.
//
// This makes the check *less* strict, which is only correct because every
// headless flag ships off. If headless ever defaults on, absence must become a
// failure again. Required-ness follows the config, not the template directory
// listing — without this, adding a template silently makes it mandatory for
// every already-adopted repo (see the #83 plan amendment).
const OPTIONAL_STUBS = new Map([["agentflow-review.yml", "review"]]);

function workflowsCheck(installed, expected, config = {}) {
  const name = ".github/workflows";
  const contents = new Map((installed ?? []).map((f) => [f.name, f.content]));
  const problems = [];
  const skipped = [];

  for (const stub of expected) {
    const content = contents.get(stub);
    if (content === undefined) {
      const stage = OPTIONAL_STUBS.get(stub);
      if (stage && !stageEnabled(config, stage)) {
        skipped.push(`${stub} (headless.${stage} is off)`);
        continue;
      }
      problems.push(
        stage
          ? `${stub} is not installed, but headless.${stage} is enabled — the flag cannot fire`
          : `${stub} is not installed`,
      );
      continue;
    }
    if (content.includes(TOOLKIT_PLACEHOLDER)) {
      problems.push(`${stub} still contains ${TOOLKIT_PLACEHOLDER} — it was copied, not scaffolded`);
      continue;
    }
    const refs = [...content.matchAll(USES_TOOLKIT)].map((m) => m[1]);
    if (refs.length === 0) {
      problems.push(`${stub} references no toolkit action — the loop cannot dispatch from it`);
      continue;
    }
    for (const ref of new Set(refs)) {
      if (!REPO_SHAPE.test(ref)) problems.push(`${stub} points at "${ref}", which is not shaped owner/name`);
    }
  }
  const note = skipped.length ? `not installed, and not needed: ${skipped.join(", ")}` : null;
  const wanted = expected.length - skipped.length;
  return problems.length
    ? fail(name, problems.join("; "), note)
    : pass(name, `${wanted} stub(s) installed and pointed at the toolkit`, note);
}

// ---------------------------------------------------------------------------
// 5. agentflow-next
//
// Pass on exit 0, pass *with a note* on exit 1 (idle), fail on anything else.
// Exit 20 is the dispatcher's usage/IO code and a real defect: a loop that
// cannot run is broken, while a loop with nothing to run is merely new.

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function nextCheck({ code, stdout, error }) {
  const name = "agentflow-next";
  const unparseable = (exit) =>
    fail(name, `exited ${exit} but its --json output could not be read: ${JSON.stringify(stdout ?? "")}`);

  if (error) return fail(name, `could not run — ${error}`);

  const output = parseJson(stdout ?? "");

  if (code === 0) {
    if (!output || typeof output !== "object" || !output.dispatch) return unparseable(0);
    return pass(name, `dispatches #${output.issue} → ${output.dispatch.actor}:${output.dispatch.who}`);
  }
  if (code === 1) {
    if (!output || output.idle !== true) return unparseable(1);
    return pass(name, "the dispatcher runs; the backlog is idle", IDLE_NOTE);
  }
  if (code === 20) {
    return fail(name, "exited 20 (usage/IO error) — check `gh auth status` and that the repo is reachable");
  }
  return fail(name, `exited ${code}`);
}

// ---------------------------------------------------------------------------
// 6. G3 mode
//
// "Which G3 does this repo have, and why?" used to be answerable only by reading
// source. Never a failure: `solo-comment` is a legitimate configuration — most
// repos will never create an App — so it reports as a **note**, which the roll-up
// already counts separately from defects for exactly this kind of remark.

function g3ModeCheck({ value }, protection) {
  const { mode, enforced, why } = g3Mode({ config: value ?? {}, protection });
  const detail = `${mode}${mode === "native-review" && enforced ? ", enforced by branch protection" : ""}`;
  // A fully enforced native review owes nothing, so it says nothing beyond the
  // mode. Every other combination has something a human might want to change.
  return pass("G3 mode", detail, mode === "native-review" && enforced ? null : why);
}

// ---------------------------------------------------------------------------

// The whole report, in a fixed order. Inputs are what the CLI gathered:
//   config     { value, error } — parsed agentflow.config.json
//   labels     { names, error } — `gh label list --json name`
//   domains    { value, error } — parsed domains.yml
//   workflows  [{ name, content }] — the stubs found under .github/workflows
//   next       { code, stdout, error } — `agentflow-next --repo <r> --json`
//   protection — GET /repos/{repo}/branches/{branch}/protection: the body, null
//                when absent (404), undefined when unreadable (403) or not read
// `expectedLabels` comes from init/labels.yml and `expectedWorkflows` from the
// templates directory, so neither list can drift from what adopt installs.
export function verifyChecks({
  config = {},
  labels = {},
  domains = {},
  workflows = [],
  next = {},
  protection,
  expectedLabels = [],
  expectedWorkflows = [],
}) {
  return [
    configCheck(config),
    labelsCheck(labels, expectedLabels),
    domainsCheck(domains),
    workflowsCheck(workflows, expectedWorkflows, config.value ?? {}),
    nextCheck(next),
    g3ModeCheck(config, protection),
  ];
}

// Notes are a real outcome, so the roll-up has to show them: "5 passed (1 note)"
// and "5 passed" describe different repos, and the difference is the thing a
// human wants to see.
export function rollup(checks) {
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  const notes = checks.filter((c) => c.note).length;
  const suffix = notes ? ` (${notes} note${notes === 1 ? "" : "s"})` : "";
  return failed ? `${passed} passed, ${failed} failed${suffix}` : `${passed} passed${suffix}`;
}

// 0 every check passed (notes do not fail the run) · 1 at least one failed.
// 20 is the CLI's usage/IO code and is never decided here.
export function exitCode(checks) {
  return checks.some((c) => !c.ok) ? 1 : 0;
}

export function renderChecks(checks) {
  const lines = [];
  for (const check of checks) {
    lines.push(`${check.ok ? "✓" : "✗"} ${check.name} — ${check.detail}`);
    if (check.note) lines.push(`  ! ${check.note}`);
  }
  return [...lines, "", rollup(checks)].join("\n");
}
