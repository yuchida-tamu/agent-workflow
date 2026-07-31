#!/usr/bin/env node
// GitHub Actions entry: issues.labeled with a state:* label → either post the
// dispatch line saying who acts next, or *launch* that agent headlessly.
//
// Which one happens is per state and per repo: `headless.dispatch.<state>`.
// Every flag ships false, so the default behaviour is exactly what it has always
// been — a comment. The launch path is stage 2 of #83; stage 1 (review on
// pull_request) is the stage enabled first.
//
// Env: GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GH_TOKEN,
// CLAUDE_CODE_OAUTH_TOKEN (launch path only), AGENTFLOW_TOOLKIT.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { DISPATCH } from "../next/core.js";
import { LABEL_PREFIX, planTransition, resolveApply } from "../state/machine.js";
import { dispatchEnabled } from "../headless/config.js";
import { TOKEN_VAR, classify, launchPlan, reviewText, summaryLine } from "../headless/core.js";
import { runProcess } from "../headless/run.js";
import { loadTiers } from "../log/cli.js";
import { childrenOf, linkSubIssue } from "../hierarchy/gh.js";

const TOOLKIT = process.env.AGENTFLOW_TOOLKIT ?? join(dirname(fileURLToPath(import.meta.url)), "../..");
const MARKER = "<!-- agentflow-dispatch -->";

// What this event should cause. Pure, so the branch deciding whether an agent
// runs unattended is testable without an event, a token, or a network — the
// same split `pr-verdict` and the headless launcher already keep.
//
// → { act: "ignore" | "comment" | "launch", state?, dispatch?, reason? }
export function dispatchAction({ label, config = {}, env = {} }) {
  if (!label?.startsWith(LABEL_PREFIX)) return { act: "ignore", reason: "not a state label" };

  const state = label.slice(LABEL_PREFIX.length);
  const dispatch = DISPATCH[state];
  if (!dispatch || dispatch.actor === "none") {
    return { act: "ignore", state, reason: `no actor for state "${state}"` };
  }

  // Only an agent can be launched. A state whose actor is a human or a script
  // still gets its comment: launching is an execution path for the `agent:`
  // rows, not a replacement for the dispatch line.
  if (dispatch.actor !== "agent") {
    return { act: "comment", state, dispatch, reason: `${dispatch.actor} acts here` };
  }

  if (!dispatchEnabled(config, state)) {
    return { act: "comment", state, dispatch, reason: `headless.dispatch.${state} is off` };
  }
  if (!env[TOKEN_VAR]) {
    // Flag on, credential absent. Comment rather than fail: the dispatch line is
    // what the repo had before headless existed, so falling back to it leaves
    // the loop working instead of silently dropping the event.
    return {
      act: "comment",
      state,
      dispatch,
      reason: `headless.dispatch.${state} is on but ${TOKEN_VAR} is not set — falling back to the dispatch comment`,
    };
  }
  return { act: "launch", state, dispatch };
}

export function commentBody(dispatch, note = null) {
  const line = `${MARKER}
**agentflow next:** \`${dispatch.actor}:${dispatch.who}\` — ${dispatch.action}`;
  return note ? `${line}\n\n${note}` : line;
}

// A durable, per-state marker for the artifact a launch produces — deliberately
// NOT `MARKER`. #160's review traced a live bug: the ok-path artifact was first
// posted under the transient dispatch-line's own marker, so the very next state
// transition's plain `commentBody(dispatch)` upsert matched that same marker and
// overwrote the plan with the bare "agentflow next" line — the #157 symptom, one
// step later. Scoping the marker by state means successive stages' artifacts
// coexist as separate comments, and a re-run of the SAME state still upserts in
// place (idempotent per state) rather than piling up duplicates.
export function artifactMarker(state) {
  return `<!-- agentflow-artifact:${state} -->`;
}

// The prompt names the work item and stops. What the agent does with it is its
// own definition's business, reached through `--agent` — one rubric per agent
// rather than two that drift.
export function launchPrompt({ repo, issue, state, who }) {
  return [
    `You are the ${who}. Act on issue #${issue} in ${repo}, which has just entered state \`${state}\`.`,
    "Follow your definition. Return your artifact as your final message; the workflow posts it.",
    "You may not transition state labels or approve any gate — the gate workflow owns both.",
  ].join("\n");
}

// A ledger run id, unique per *attempt*.
//
// `agentflow-log start` appends a row and `end` closes the first row matching
// the id, so a repeated id leaves a row that can never be closed. That is not
// theoretical: it happened on #91 during this issue's own build, and the review
// entry point would have repeated its id on every `synchronize` event.
//
// `GITHUB_RUN_ID` + `GITHUB_RUN_ATTEMPT` are unique per attempt and make the row
// traceable back to the run that wrote it. Outside Actions they are absent, and
// the bare prefix is the honest fallback.
export function runId(prefix, env = process.env) {
  const parts = [prefix, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT].filter(Boolean);
  return parts.join("-");
}

// GitHub caps an issue comment body at ~65536 characters (undocumented but
// observed in practice). The rest of the comment — marker, heading, summary
// footer — costs a few hundred more, so the artifact itself is capped well
// under that, with an honest marker at the cut point rather than a silent
// truncation, for the rare run whose artifact is enormous. Exported so a test
// can build a boundary case without duplicating the literal.
export const MAX_ARTIFACT_CHARS = 60000;

// The code unit at `index` is a high (leading) surrogate — the first half of a
// two-unit UTF-16 pair (emoji, many CJK-extension and symbol code points). If
// it is the LAST unit a slice keeps, the low surrogate it pairs with falls
// just past the cut, leaving a lone high surrogate — not a valid character on
// its own, and exactly the kind of mid-character truncation that turns into a
// mojibake glyph or a broken comment render.
function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

// Where to actually cut so a slice never splits a surrogate pair. Backs off by
// one code unit when the character right at the boundary is a lone high
// surrogate; otherwise the boundary was already safe (either a normal
// character or a complete pair — the low surrogate can only appear at `max-1`
// if its high surrogate at `max-2` was already included).
function safeCut(text, max) {
  return max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
}

export function truncateArtifact(text) {
  if (text.length <= MAX_ARTIFACT_CHARS) return text;
  const cut = safeCut(text, MAX_ARTIFACT_CHARS);
  return (
    `${text.slice(0, cut)}\n\n` +
    `> …truncated — the artifact was ${text.length} characters; showing the first ${cut}.`
  );
}

// The note appended under the artifact's heading — the `ok` counterpart to the
// escalation note below, in parity with headless-review.js's `reviewBody`: the
// artifact text, a `---` divider, then the same `summaryLine` footer the
// workflow's own step summary carries. This is the fix for #157: a successful
// run used to post only a ledger row.
export function artifactNote({ agent, model, outcome, usage, text }) {
  return `${truncateArtifact(text)}\n\n---\n\`${summaryLine({ agent, model, outcome, usage })}\``;
}

// The full artifact comment: its own durable marker (never `MARKER` — see
// `artifactMarker`), a short heading naming who produced it and at which
// state, then the note. A separate comment from the transient dispatch line,
// on purpose — the two upsert independently and never contend for the same
// marker.
export function artifactCommentBody(state, agent, note) {
  return `${artifactMarker(state)}\n**agentflow artifact:** \`agent:${agent}\` at \`state:${state}\`\n\n${note}`;
}

// --- spec-stage structural side-effects (#168) -------------------------------
//
// Headless dispatch's `spec` launch runs the architect, whose only output is
// its final message — no Bash, no `gh` (DEFAULT_ALLOWED_TOOLS is read-only).
// So the architect can post a plan but cannot do anything the plan implies:
// create the child issues it decomposed into, link them as sub-issues, or
// compute and post the risk engine's plan-stage verdict. All three are the
// harness's job now, run here immediately after the artifact itself is
// posted, and ONLY for `state === "spec"` — the other agent-actionable
// states (`idea`, `ready`) have no plan.json/children concept.
//
// `agents/architect.md` step 3 is mode-aware because of this: an interactive
// session (Bash + `gh` available) still creates children directly, exactly as
// before. A headless run cannot, so it DECLARES them in `plan.json`'s new
// `children[]` array and stops there; this file does the creating.

// --- extraction contract ------------------------------------------------
//
// The architect's final message is prose plus fenced code blocks; `plan.json`
// is embedded as one of them. The contract: scan every ` ```json ` fence in
// the text, `JSON.parse` each, and keep the ones that pass `isValidPlanCandidate`
// below. The LAST matching fence wins, so a plan that evolves mid-message (an
// earlier draft, a corrected final block) resolves to what the architect meant
// last. A fence that fails to parse is skipped, not fatal — extraction degrades
// to "no plan found" (`null`), never a throw, so a malformed plan.json
// escalates to a human instead of crashing the workflow.
const JSON_FENCE_RE = () => /```json\b([\s\S]*?)```/gi;

// A title consisting only of dots/ellipsis — the literal placeholder shape
// THIS REPO'S OWN `agents/architect.md` schema example uses
// (`{"title": "...", "body": "...", ...}`). Targeted rather than a general
// "looks like a TODO" heuristic: it's the exact shape the #168 review traced
// as a live hijack vector (see `isValidPlanCandidate`), so it's the exact
// shape rejected.
const PLACEHOLDER_TITLE_RE = /^(?:\.{2,}|…)$/;

function isPlaceholderTitle(title) {
  return typeof title === "string" && PLACEHOLDER_TITLE_RE.test(title.trim());
}

// Schema-strictness layered on top of the `files`-key predicate (#168 review,
// finding 3). `files` alone is too weak a discriminator: it's the one field
// GUARANTEED to appear in the schema example `agents/architect.md` step 4
// itself ships, so an architect that reproduces (or an assistant that echoes)
// that example fence AFTER the real plan would have last-wins select the
// example instead — minting a child titled `"..."` with placeholder body and
// no real labels, then locking it in via reconciliation on every retry.
//
// When `children` is present, every entry must be a real object with a
// non-empty, non-placeholder string title; a candidate that fails this is
// DISQUALIFIED as a candidate — not treated as an extraction failure — so an
// earlier, genuine plan.json fence can still win over a later hijacking one
// (last-wins only compares among the fences that qualify at all).
// `children` absent entirely is fine — a files-only plan with no
// decomposition is a legitimate shape (e.g. an interactive session's
// plan.json, which never needed to populate `children[]`).
export function isValidPlanCandidate(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  if (!("files" in parsed)) return false;
  if ("children" in parsed) {
    if (!Array.isArray(parsed.children)) return false;
    for (const child of parsed.children) {
      if (!child || typeof child !== "object") return false;
      if (typeof child.title !== "string" || child.title.trim() === "" || isPlaceholderTitle(child.title)) {
        return false;
      }
    }
  }
  return true;
}

export function extractPlan(text) {
  if (!text) return null;
  let winner = null;
  const re = JSON_FENCE_RE();
  let match;
  while ((match = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (isValidPlanCandidate(parsed)) winner = parsed;
    } catch {
      // Not a plan.json fence (or a corrupted one) — keep scanning.
    }
  }
  return winner;
}

// --- label allowlist: the control-plane boundary (#168 review, finding 1) --
//
// Model-authored `plan.json` flows into `gh issue create --label`, which can
// mint a fresh issue at ANY label that exists in the repo — including a
// `state:*` label, otherwise a primitive only the state machine and the gate
// workflow ever touch (CLAUDE.md ground rule 4: "Agents never transition
// state labels"). A plan child's `labels` field reaches that exact primitive
// through a side door: an architect that hallucinates (or copies from a
// "done" example) `labels: ["state:released"]` would mint a terminal-state
// issue with no work behind it, and nothing downstream would know it was
// never real. Treated the same way `validateApproval` treats a bot-authored
// `/approve` — untrusted model output, validated against an allowlist BEFORE
// it reaches the control-plane primitive, fail-closed.
const LEGAL_CHILD_ENTRY_LABEL = "state:ready"; // the one state a fresh, un-worked child may legally start in

export function isLegalChildLabel(label, knownLabels) {
  if (label.startsWith(LABEL_PREFIX)) return label === LEGAL_CHILD_ENTRY_LABEL;
  return knownLabels.has(label);
}

// Validates the WHOLE declared array before anything is created — an
// all-or-nothing gate, so one illegal label rejects the entire plan rather
// than creating everything up to the offending entry. Returns the first
// violation (index, title, label) so the escalation can name exactly which
// child and which label caused the rejection, or `null` when every declared
// label across every child is legal.
export function validateChildLabels(specs, knownLabels) {
  for (let i = 0; i < specs.length; i++) {
    const labels = Array.isArray(specs[i].labels) ? specs[i].labels : [];
    for (const label of labels) {
      if (!isLegalChildLabel(label, knownLabels)) {
        return { index: i, title: specs[i].title ?? `(child ${i})`, label };
      }
    }
  }
  return null;
}

// The label registry itself — `init/labels.yml`, the one place the loop's
// label families are declared (state, priority, risk, drift, blocked).
// Loaded from the TOOLKIT (the toolkit's own file, not the consuming repo's)
// rather than hand-mirrored here, so the allowlist can never silently drift
// from what `agentflow-init labels` actually creates. An unreadable or
// malformed registry fails CLOSED — an empty set legalises nothing except
// the one label that doesn't depend on it (`state:ready`, checked above).
export function loadKnownLabels(toolkit) {
  try {
    const doc = parseYaml(readFileSync(join(toolkit, "init/labels.yml"), "utf8"));
    return new Set(doc.labels.map((l) => l.name));
  } catch {
    return new Set();
  }
}

// --- children creation ---------------------------------------------------
//
// plan.json's schema (documented here and in agents/architect.md step 4):
//
//   {
//     "files": ["globs..."],
//     "children": [
//       { "title": "...", "body": "...", "labels": ["state:ready", "priority:p2"], "blockedBy": [0] }
//     ]
//   }
//
// `blockedBy` names OTHER ENTRIES OF THIS ARRAY BY INDEX, not by issue number —
// the numbers don't exist until `gh issue create` returns them, and indices
// are stable in the architect's own message while numbers are not knowable in
// advance. Only indices that resolve to a real number (created this run, or
// reconciled from an existing child) can resolve; an index that never
// resolves is silently dropped from that child's "Blocked by" lines rather
// than failing the whole run — a forward or out-of-range reference is a
// plan-authoring mistake, not grounds to abandon otherwise-good children.

// Every created child opens with "Child of #<parent>" as its literal first
// line — the exact convention `scripts/hierarchy/core.js`'s `parentFromText`
// anchors on (`^Child of #(\d+)`, start of line) and the one `agents/architect.md`
// has always documented as the interactive-session fallback. Native sub-issue
// linking (below) is the primary relation, but this text convention is what
// `childrenOf`'s fallback reads when `sub_issues` is unavailable (404/410,
// the GHES case `hierarchy/gh.js` already handles) — without this line that
// fallback finds zero children for anything created here, and a retry on
// such a host would re-create the whole set forever (#168 review, finding 4).
// "Blocked by #N" lines are appended after, one per resolved blocker.
export function childBody({ parentIssue, body, blockedByNumbers = [] }) {
  const lines = [`Child of #${parentIssue}`, "", body ?? ""];
  if (blockedByNumbers.length) {
    lines.push("", ...blockedByNumbers.map((n) => `Blocked by #${n}`));
  }
  return lines.join("\n");
}

export function createChildArgv({ repo, title, body, labels = [] }) {
  const argv = ["issue", "create", "--repo", repo, "--title", title, "--body", body];
  for (const label of labels) argv.push("--label", label);
  return argv;
}

// `gh issue create`'s stdout is the created issue's URL, not JSON — this is
// the whole output contract, so parsing it is one line rather than a second
// `gh api` round trip per child just to learn the number just assigned.
export function parseCreatedIssueNumber(stdout) {
  const match = String(stdout).trim().match(/\/issues\/(\d+)\s*$/);
  if (!match) {
    throw new Error(`could not read a created issue number from gh's output: ${JSON.stringify(String(stdout).trim())}`);
  }
  return Number(match[1]);
}

// Match already-existing children against the DECLARED set, by title — the
// fix for the #168 review's finding 2. The old guard treated "the parent has
// any child at all" as "the whole set was created", which permanently locked
// in a partial creation: a mid-loop failure (child 2 of 3 throws, transient
// `gh` or otherwise) left #A created and #B, #C missing, and a retry's
// "any child exists → skip" read that as done, forever. Reconciling by title
// instead creates ONLY what's missing, and skips the whole set only when
// every declared title is already present.
//
// Title match is a heuristic — nothing else survives a retry to key off —
// so a duplicate declared title matches the first same-titled existing
// child. Documented rather than guarded against: the architect is expected
// to give each child a distinct title, as it always has.
export function reconcileChildren({ existingChildren = [], specs = [] }) {
  const byTitle = new Map();
  for (const child of existingChildren) {
    if (child.title != null && !byTitle.has(child.title)) byTitle.set(child.title, child.number);
  }
  const existingByIndex = {};
  const missingIndices = [];
  specs.forEach((spec, i) => {
    if (byTitle.has(spec.title)) existingByIndex[i] = byTitle.get(spec.title);
    else missingIndices.push(i);
  });
  return { existingByIndex, missingIndices };
}

// The pure per-run decision: validate labels, then reconcile against what
// already exists, then decide whether there's anything left to create.
// `existingChildren` is the parent's CURRENT children (from `childrenOf`,
// api-or-text — `{number, title}` for each), not just a count, because
// `reconcileChildren` needs titles.
export function planChildrenDecision({ existingChildren = [], plan, knownLabels = new Set() }) {
  if (!plan) {
    if (existingChildren.length > 0) {
      return {
        act: "skip",
        detail:
          `${existingChildren.length} child issue(s) already exist and this run has no fresh plan.json to ` +
          "reconcile against — left as-is",
      };
    }
    return {
      act: "extraction-failed",
      detail:
        'no plan.json extracted from the artifact — expected a ```json fenced block with a top-level "files" key',
    };
  }

  const specs = plan.children ?? [];
  if (specs.length === 0) {
    return { act: "none", detail: "plan declares no children" };
  }

  // Validate the ENTIRE declared array before creating anything — see
  // `validateChildLabels`. Fail closed: one illegal label rejects the whole
  // plan, zero children created.
  const violation = validateChildLabels(specs, knownLabels);
  if (violation) {
    return {
      act: "rejected",
      detail:
        `child ${violation.index} ("${violation.title}") declares illegal label "${violation.label}" ` +
        "— the whole plan was rejected, zero children created",
    };
  }

  const { existingByIndex, missingIndices } = reconcileChildren({ existingChildren, specs });
  if (missingIndices.length === 0) {
    return {
      act: "skip",
      detail: `all ${specs.length} declared child(ren) already exist (matched by title) — creation skipped (idempotent)`,
    };
  }
  return { act: "create", specs, existingByIndex, missingCount: missingIndices.length };
}

// The impure creation loop. `existingByIndex` seeds the index→number map with
// children a reconciliation retry already found — those indices are skipped
// (not re-created), but their numbers stay available for `blockedBy`
// resolution of the entries that ARE created this pass. `sh` and `link` are
// injected — the mock seam a test uses to assert argv shape, blockedBy
// resolution, and reconciliation without a real `gh`.
export function createChildren({ repo, parentIssue, specs, existingByIndex = {}, sh: run, link = linkSubIssue }) {
  const numbers = { ...existingByIndex };
  const created = [];
  for (let i = 0; i < specs.length; i++) {
    if (numbers[i] != null) continue; // already exists — reconciled, not re-created
    const spec = specs[i];
    const blockedByNumbers = (spec.blockedBy ?? [])
      .map((idx) => numbers[idx])
      .filter((n) => typeof n === "number");
    const body = childBody({ parentIssue, body: spec.body, blockedByNumbers });
    const stdout = run("gh", createChildArgv({ repo, title: spec.title, body, labels: spec.labels ?? [] }));
    const number = parseCreatedIssueNumber(stdout);
    link(repo, parentIssue, number);
    numbers[i] = number;
    created.push({ number, title: spec.title, index: i });
  }
  return created;
}

// --- plan-stage verdict ---------------------------------------------------
//
// Same facts→policy path pr-verdict.js runs at PR time, spawned here rather
// than imported: `agentflow-facts` and `agentflow-policy` are both shipped
// CLIs (see package.json `bin`), and going through them keeps this one
// integration point instead of a second, drift-prone copy of pack-loading
// and error handling. `--base`/`--head` are both `HEAD` — there is no PR yet
// at plan time, so the diff is deliberately empty; what the plan-stage verdict
// actually evaluates is `plan.files` (the declared surface), which the
// baseline pack's `self-mod-guard` rule checks directly regardless of diff
// content. Posted under its OWN marker (`agentflow-verdict:plan`, not the
// bare `agentflow-verdict` `pr-verdict.js`/an interactive architect use) —
// same reasoning as `artifactMarker`: this file scopes every comment it posts
// by what produced it, so nothing here can collide with, or be silently
// upserted over by, a differently-shaped verdict comment. `planned → ready`
// (G2) stays a human gate regardless of this comment's content — it is a
// record for the human approving G2, not an auto-pass input.
const PLATFORM_PACKS = { "rn-expo": "packs/expo/policies/expo.yaml" };
export const PLAN_VERDICT_MARKER = "<!-- agentflow-verdict:plan -->";

export function factsArgv({ factsCli, planPath, domainsPath = null, configPath = null, base = "HEAD", head = "HEAD" }) {
  const argv = [factsCli, "--base", base, "--head", head, "--stage", "plan", "--plan", planPath];
  if (domainsPath) argv.push("--domains", domainsPath);
  if (configPath) argv.push("--config", configPath);
  return argv;
}

export function policyEvaluateArgv({ policyCli, factsPath, packPaths }) {
  return [policyCli, "evaluate", "--facts", factsPath, ...packPaths];
}

export function planVerdictPacks({ toolkit, config = {}, cwd = "." }) {
  const packs = [join(toolkit, "policies/baseline.yaml")];
  const platformPack = PLATFORM_PACKS[config?.platform];
  if (platformPack) packs.push(join(toolkit, platformPack));
  if (existsSync(join(cwd, "policies/business.yml"))) packs.push(join(cwd, "policies/business.yml"));
  return packs;
}

export function planVerdictCommentBody(verdict) {
  const rows = verdict.matched
    .map((m) => `| \`${m.pack}\` | \`${m.rule}\` | ${Object.keys(m.then).join(", ")} |`)
    .join("\n");
  return `${PLAN_VERDICT_MARKER}
### agentflow risk verdict — plan stage: \`${verdict.level}\` (score ${verdict.obligations.score})

No diff exists yet at this stage; this verdict reflects the plan's declared file surface (\`plan.files\`), not a code diff.

| requires | blocks | runs |
|---|---|---|
| ${verdict.obligations.require.join(", ") || "—"} | ${verdict.obligations.block.join(", ") || "—"} | ${verdict.obligations.run.join(", ") || "—"} |

${verdict.matched.length ? `<details><summary>${verdict.matched.length} rule(s) matched</summary>\n\n| pack | rule | obligations |\n|---|---|---|\n${rows}\n\n</details>` : "No rules matched."}
${verdict.warnings.length ? `\n⚠️ ${verdict.warnings.join(" · ")}` : ""}`;
}

// The impure spawn: writes the extracted plan to a temp file (facts CLI reads
// `--plan` as a path, never stdin), spawns `agentflow-facts`, writes ITS
// stdout to a second temp file (policy CLI's `--facts` is a path too, for the
// same reason), spawns `agentflow-policy evaluate`, and parses its stdout as
// the verdict JSON. Not itself unit tested — like `upsertComment`, it's I/O
// glue over already-tested pieces (`factsArgv`, `policyEvaluateArgv`,
// `planVerdictPacks`), exercised at the `main()` wiring level instead.
function computePlanVerdict({ toolkit, plan, config, sh: run }) {
  const dir = mkdtempSync(join(tmpdir(), "agentflow-plan-"));
  const planPath = join(dir, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan));

  const domainsPath = existsSync("domains.yml") ? "domains.yml" : null;
  const configPath = existsSync("agentflow.config.json") ? "agentflow.config.json" : null;
  const factsOut = run(
    "node",
    factsArgv({ factsCli: join(toolkit, "scripts/facts/cli.js"), planPath, domainsPath, configPath }),
  );
  const factsPath = join(dir, "facts.json");
  writeFileSync(factsPath, factsOut);

  const packs = planVerdictPacks({ toolkit, config });
  const verdictOut = run(
    "node",
    policyEvaluateArgv({ policyCli: join(toolkit, "scripts/policy/cli.js"), factsPath, packPaths: packs }),
  );
  return JSON.parse(verdictOut);
}

// --- the harness transition (the design ruling on #168) -------------------
//
// spec → planned is ungated in the machine (`GATED_TRANSITIONS` has no
// `spec→planned` entry) — precedent for a deterministic harness advancing an
// ungated transition once its preconditions are machine-verifiable already
// exists (post-merge's `merged → verified`, release's `verified → released`).
// The precondition here is three-part: the artifact posted (true by
// construction — this code only runs after that upsert succeeded), the
// children step succeeded (created, or legitimately skipped as already
// existing, or legitimately none-declared), and the verdict posted. ALL
// THREE, or no transition — partial-failure honesty over optimistic
// advancement. Agents remain forbidden from touching labels; this grants
// nothing to the model side, only to the deterministic harness code that
// already owns other ungated transitions.
export function specTransitionPlan({ childrenOk, verdictOk, labels }) {
  const failed = [];
  if (!childrenOk) failed.push("children");
  if (!verdictOk) failed.push("verdict");
  if (failed.length) return { ok: false, failed };
  try {
    return { ok: true, plan: planTransition(labels, "planned") };
  } catch (err) {
    return { ok: false, failed: ["transition"], error: err.message };
  }
}

export const SPEC_EFFECTS_MARKER = "<!-- agentflow-spec-effects -->";

const STEP_GUIDANCE = {
  // Truthful about the retry path (#168 review, finding 2): reconciliation
  // (`reconcileChildren`) means a re-apply of `state:spec` really does create
  // only what's missing — children already created (matched by title) are
  // left alone rather than the whole set being skipped or duplicated.
  children:
    "Check the detail above for why (a rejected label, a creation failure, or a missing plan.json), fix the " +
    "cause, then re-apply `state:spec` to retry — children already created (matched by title) are left alone; " +
    "only what's missing will be created.",
  verdict:
    "Check the workflow run's logs for why `agentflow-facts`/`agentflow-policy` failed, fix the cause, then " +
    "re-apply `state:spec` to retry — or post the verdict by hand in the shape `pr-verdict.js` writes.",
  transition:
    "The label edit itself failed — check the item's current `state:*` label matches what this run expected, " +
    "then apply `state:planned` by hand if the plan and children are otherwise good.",
};

// One comment, upserted in place across retries, that goes from "here's what
// failed and what to do about it" to "here's what happened" once a retry (or
// a human's manual fix) clears every step.
//
// `gate.resolution` (present only when `gate.ok`) is `resolveApply`'s CAS
// outcome (#168 review, finding 5) — apply/noop/heal/refused — so the
// comment reports what ACTUALLY happened at write time, not just that the
// precondition (children + verdict) was met.
export function specEffectsCommentBody({ childrenOutcome, verdictOutcome, gate }) {
  const mark = (ok) => (ok ? "✅" : "❌");
  const lines = [
    SPEC_EFFECTS_MARKER,
    "**spec-stage structural side-effects**",
    "",
    `${mark(childrenOutcome.ok)} children — ${childrenOutcome.detail}`,
    `${mark(verdictOutcome.ok)} plan-stage verdict — ${verdictOutcome.detail}`,
  ];
  if (gate.ok) {
    const r = gate.resolution;
    if (!r || r.action === "apply") {
      lines.push(`${mark(true)} transition — \`state:${gate.plan.from}\` → \`state:${gate.plan.to}\``);
    } else if (r.action === "heal") {
      lines.push(
        `${mark(true)} transition — \`state:${gate.plan.from}\` → \`state:${gate.plan.to}\` (healed a race: ${r.note})`,
      );
    } else if (r.action === "noop") {
      lines.push(`↔️ transition — ${r.note}`);
    } else {
      lines.push(`❌ transition — ${r.note}`);
      lines.push(
        "",
        "**A human should:** the label state changed unexpectedly between dispatch and this write. Check the " +
          `issue's current \`state:*\` label and, if the plan and children above are otherwise good, apply ` +
          "`state:planned` by hand.",
      );
    }
  } else {
    const failed = gate.failed ?? [];
    if (failed.includes("transition")) lines.push(`❌ transition — ${gate.error}`);
    else lines.push("⏸️ transition withheld — every step above must succeed first");
    lines.push("", "**A human should:**");
    for (const step of failed) lines.push(`- ${STEP_GUIDANCE[step] ?? `investigate the "${step}" step`}`);
  }
  return lines.join("\n");
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });

// Pure half of "which comment is this posting to" — split out because #160's
// review found the whole bug living in this decision: reusing the dispatch
// line's marker for the artifact meant one match answered both, so the next
// state's dispatch-line upsert silently matched and overwrote the previous
// state's artifact. Testable without `gh`, a token, or a network.
export function matchingComment(comments, marker) {
  return comments.find((c) => c.body.startsWith(marker));
}

function upsertComment(repo, issue, body, marker = MARKER) {
  const comments = JSON.parse(
    sh("gh", ["api", `repos/${repo}/issues/${issue}/comments`, "--jq", "[.[] | {id, body}]"]),
  );
  const existing = matchingComment(comments, marker);
  if (existing) {
    sh("gh", ["api", "--method", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`]);
  } else {
    sh("gh", ["issue", "comment", issue, "--repo", repo, "--body", body]);
  }
}

function summarise(line) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, `${line}\n`);
  } catch {
    // A summary is a courtesy; failing to write one must not fail the run.
  }
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const repo = process.env.GITHUB_REPOSITORY;
  const issue = String(event.issue.number);
  const config = existsSync("agentflow.config.json")
    ? JSON.parse(readFileSync("agentflow.config.json", "utf8"))
    : {};

  const decision = dispatchAction({ label: event.label?.name ?? "", config, env: process.env });

  if (decision.act === "ignore") {
    console.log(`dispatch: nothing to do — ${decision.reason}`);
    return 0;
  }

  if (decision.act === "comment") {
    upsertComment(repo, issue, commentBody(decision.dispatch));
    console.log(`dispatched: state:${decision.state} → ${decision.dispatch.actor}:${decision.dispatch.who}`);
    if (decision.reason) console.log(`            (${decision.reason})`);
    return 0;
  }

  // --- launch ---------------------------------------------------------------
  const { state, dispatch } = decision;
  const agent = dispatch.who;
  const tiers = loadTiers(join(TOOLKIT, "agents"));
  const tier = tiers[agent] ?? null;
  const run = runId(`dispatch-${issue}-${state}`);

  const log = (args) => {
    try {
      execFileSync("node", [join(TOOLKIT, "scripts/log/cli.js"), ...args], { encoding: "utf8" });
    } catch (err) {
      // The ledger is evidence, not a gate. Losing a row must not lose the work.
      console.error(`ledger: ${err.message}`);
    }
  };

  log(["start", "--issue", issue, "--run", run, "--phase", state,
       "--agent", agent, "--model", tier ?? "unknown", "--repo", repo]);

  let result;
  try {
    const plan = launchPlan({
      agent,
      stage: state,
      config,
      env: process.env,
      tiers,
      prompt: launchPrompt({ repo, issue, state, who: agent }),
    });
    if (plan.launch) {
      const finished = await runProcess(plan);
      result = { ...classify(finished), model: plan.model, stdout: finished.stdout };
    } else {
      result = { outcome: plan.outcome, reason: plan.reason, usage: null, model: null, stdout: "" };
    }
  } catch (err) {
    result = { outcome: "failed", reason: err.message, usage: null, model: null, stdout: "" };
  }

  const ledgerOutcome = result.outcome === "ok" ? "ok" : result.outcome === "disabled" ? "abandoned" : "failed";
  log(["end", "--issue", issue, "--run", run, "--outcome", ledgerOutcome, "--repo", repo]);

  // The point of this whole stage (#157): a run that succeeded produced an
  // artifact, and the artifact is what the agent was launched for — not the
  // ledger row. Posted under its OWN state-scoped marker (#160), as a comment
  // separate from the transient dispatch line, so a later state's plain
  // dispatch-line upsert can never overwrite it.
  if (result.outcome === "ok") {
    // Unwrapped once, kept full-length, and reused below for extraction — the
    // COMMENT is capped by `truncateArtifact` (`artifactNote`), but a
    // plan.json fence near the end of a long plan must not be lost to that
    // cap, so extraction always runs against the untruncated text.
    const fullText = reviewText(result.stdout ?? "");
    const note = artifactNote({ agent, model: result.model, outcome: result.outcome, usage: result.usage, text: fullText });
    upsertComment(repo, issue, artifactCommentBody(state, agent, note), artifactMarker(state));

    // --- spec-stage structural side-effects (#168) ---------------------
    // Only `spec` (the architect) declares a decomposition; `idea` and
    // `ready` have no plan.json/children concept, so this never runs for them.
    if (state === "spec") {
      const plan = extractPlan(fullText);
      const parentIssue = Number(issue); // numeric — `resolveChildren`/`parentFromText` compare by number

      let existingChildren = [];
      try {
        existingChildren = childrenOf(repo, parentIssue).children;
      } catch (err) {
        // Can't tell whether children already exist — treated as "none found"
        // below, which is the conservative direction: it risks a no-op retry
        // finding nothing to skip, never a silent double-creation.
        console.error(`children lookup: ${err.message}`);
      }

      const knownLabels = loadKnownLabels(TOOLKIT);
      const decision = planChildrenDecision({ existingChildren, plan, knownLabels });
      let childrenOutcome;
      if (decision.act === "create") {
        try {
          const created = createChildren({
            repo,
            parentIssue,
            specs: decision.specs,
            existingByIndex: decision.existingByIndex,
            sh,
          });
          const alreadyExisted = decision.specs.length - created.length;
          childrenOutcome = {
            ok: true,
            detail:
              `created ${created.length} child issue(s)` +
              (alreadyExisted ? ` (${alreadyExisted} already existed — reconciled, not recreated)` : "") +
              `: ${created.map((c) => `#${c.number}`).join(", ") || "none"}`,
          };
        } catch (err) {
          childrenOutcome = { ok: false, detail: `child creation failed: ${err.message}` };
        }
      } else {
        childrenOutcome = {
          ok: decision.act !== "extraction-failed" && decision.act !== "rejected",
          detail: decision.detail,
        };
      }

      let verdictOutcome;
      if (!plan) {
        verdictOutcome = { ok: false, detail: "no plan.json extracted — cannot compute the plan-stage verdict" };
      } else {
        try {
          const verdict = computePlanVerdict({ toolkit: TOOLKIT, plan, config, sh });
          upsertComment(repo, issue, planVerdictCommentBody(verdict), PLAN_VERDICT_MARKER);
          verdictOutcome = { ok: true, detail: `\`${verdict.level}\` (score ${verdict.obligations.score}) posted` };
        } catch (err) {
          verdictOutcome = { ok: false, detail: `verdict computation failed: ${err.message}` };
        }
      }

      const currentLabels = (event.issue.labels ?? []).map((l) => l.name);
      const gate = specTransitionPlan({ childrenOk: childrenOutcome.ok, verdictOk: verdictOutcome.ok, labels: currentLabels });
      if (gate.ok) {
        // Compare-and-swap (#172's `resolveApply`), the same pattern
        // gate-comment.js uses: `currentLabels` above is the webhook event's
        // snapshot, which by the time this write happens may be stale —
        // another driver could have moved the issue in the meantime.
        // Re-read immediately before the edit and let `resolveApply` decide
        // apply/noop/heal rather than writing the stale snapshot's edit
        // unconditionally (#168 review, finding 5).
        const freshLabels = JSON.parse(
          sh("gh", ["issue", "view", issue, "--repo", repo, "--json", "labels"]),
        ).labels.map((l) => l.name);
        let resolution;
        try {
          resolution = resolveApply(freshLabels, gate.plan);
        } catch (err) {
          resolution = { action: "refused", note: err.message };
        }
        if (resolution.action === "apply" || resolution.action === "heal") {
          const editArgs = ["issue", "edit", issue, "--repo", repo];
          for (const label of resolution.add ?? []) editArgs.push("--add-label", label);
          for (const label of resolution.remove ?? []) editArgs.push("--remove-label", label);
          sh("gh", editArgs);
        }
        gate.resolution = resolution;
      }
      upsertComment(repo, issue, specEffectsCommentBody({ childrenOutcome, verdictOutcome, gate }), SPEC_EFFECTS_MARKER);
      console.log(
        `spec side-effects: children=${childrenOutcome.ok} verdict=${verdictOutcome.ok} ` +
          `transition=${gate.ok ? gate.resolution.action : "withheld"}`,
      );
    }
  }

  // Escalate exactly once, by comment, and never retry. For a spent rate-limit
  // window a retry is a spin; for an expired token it is a spin that also looks
  // like a broken agent. The comment restores the dispatch line, so the item is
  // visibly waiting for a human rather than silently dropped.
  if (result.outcome !== "ok") {
    upsertComment(
      repo,
      issue,
      commentBody(
        dispatch,
        `> Headless launch did not complete (**${result.outcome}**): ${result.reason ?? "no reason reported"}\n` +
          "> This item is waiting for a human, or for the cause to be fixed. It will not retry on its own.",
      ),
    );
  }

  summarise(summaryLine({ agent, model: result.model, outcome: result.outcome, usage: result.usage }));
  console.log(`launched: state:${state} → ${agent} — ${result.outcome}`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err.message);
    process.exit(20);
  });
}
