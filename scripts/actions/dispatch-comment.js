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
import { DISPATCH } from "../next/core.js";
import { LABEL_PREFIX, planTransition } from "../state/machine.js";
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
// the text, `JSON.parse` each, and keep the ones that parse to a plain object
// carrying a top-level `"files"` key (the one field every plan.json has always
// had) — that's what distinguishes an actual plan.json fence from some other
// JSON snippet the architect happened to include (an example payload, part of
// a risk-verdict render, etc). The LAST matching fence wins, so a plan that
// evolves mid-message (an earlier draft, a corrected final block) resolves to
// what the architect meant last. A fence that fails to parse is skipped, not
// fatal — extraction degrades to "no plan found" (`null`), never a throw, so a
// malformed plan.json escalates to a human instead of crashing the workflow.
const JSON_FENCE_RE = () => /```json\b([\s\S]*?)```/gi;

export function extractPlan(text) {
  if (!text) return null;
  let winner = null;
  const re = JSON_FENCE_RE();
  let match;
  while ((match = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "files" in parsed) {
        winner = parsed;
      }
    } catch {
      // Not a plan.json fence (or a corrupted one) — keep scanning.
    }
  }
  return winner;
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
// advance. Only indices strictly before the current one can resolve (children
// are created in array order); an index that hasn't been created yet is
// silently dropped from that child's "Blocked by" lines rather than failing
// the whole run — a forward or out-of-range reference is a plan-authoring
// mistake, not grounds to abandon otherwise-good children.

// Append one "Blocked by #N" line per resolved blocker. Multiple lines rather
// than one comma-joined line so the existing "declares its parent" style of
// fallback text-scraping (`Child of #N` in hierarchy/core.js) has a matching
// convention to extend to blockers later, if that's ever needed.
export function childBody(body, blockedByNumbers = []) {
  if (!blockedByNumbers.length) return body;
  const lines = blockedByNumbers.map((n) => `Blocked by #${n}`).join("\n");
  return `${body ?? ""}\n\n${lines}`;
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

// The pure idempotency + no-op decision. `existingCount` is the parent's
// current child count (from `childrenOf`, api-or-text, already tested there);
// any existing child at all means a PRIOR run already created the set — a
// second creation pass is not "safety", it's duplicates. Re-applying `state:spec`
// must not multiply children, so that prior success counts as "created" for
// this run's purposes (and for the transition gate below).
export function planChildrenDecision({ existingCount = 0, plan }) {
  if (existingCount > 0) {
    return {
      act: "skip",
      detail: `${existingCount} child issue(s) already linked to this parent — creation skipped (idempotent)`,
    };
  }
  if (!plan) {
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
  return { act: "create", specs };
}

// The impure creation loop: one `gh issue create` + one `linkSubIssue` per
// declared child, in array order (so `blockedBy` can resolve against numbers
// already minted this run). `sh` and `link` are injected — the mock seam a
// test uses to assert argv shape and blockedBy resolution without a real `gh`.
export function createChildren({ repo, parentIssue, specs, sh: run, link = linkSubIssue }) {
  const created = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const blockedByNumbers = (spec.blockedBy ?? [])
      .map((idx) => created[idx]?.number)
      .filter((n) => typeof n === "number");
    const body = childBody(spec.body, blockedByNumbers);
    const stdout = run("gh", createChildArgv({ repo, title: spec.title, body, labels: spec.labels ?? [] }));
    const number = parseCreatedIssueNumber(stdout);
    link(repo, parentIssue, number);
    created.push({ number, title: spec.title });
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
  children:
    "Check the artifact comment for the plan the architect returned, fix the `plan.json` block (or create the " +
    "children by hand and link them as sub-issues), then re-apply `state:spec` to retry.",
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
    lines.push(`${mark(true)} transition — \`state:${gate.plan.from}\` → \`state:${gate.plan.to}\``);
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

      let existingChildren = 0;
      try {
        existingChildren = childrenOf(repo, issue).children.length;
      } catch (err) {
        // Can't tell whether children already exist — treated as "none found"
        // below, which is the conservative direction: it risks a no-op retry
        // finding nothing to skip, never a silent double-creation.
        console.error(`children lookup: ${err.message}`);
      }

      const decision = planChildrenDecision({ existingCount: existingChildren, plan });
      let childrenOutcome;
      if (decision.act === "create") {
        try {
          const created = createChildren({ repo, parentIssue: issue, specs: decision.specs, sh });
          childrenOutcome = {
            ok: true,
            detail: `created ${created.length} child issue(s): ${created.map((c) => `#${c.number}`).join(", ")}`,
          };
        } catch (err) {
          childrenOutcome = { ok: false, detail: `child creation failed: ${err.message}` };
        }
      } else {
        childrenOutcome = { ok: decision.act !== "extraction-failed", detail: decision.detail };
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
        const editArgs = ["issue", "edit", issue, "--repo", repo];
        for (const label of gate.plan.add) editArgs.push("--add-label", label);
        for (const label of gate.plan.remove) editArgs.push("--remove-label", label);
        sh("gh", editArgs);
      }
      upsertComment(repo, issue, specEffectsCommentBody({ childrenOutcome, verdictOutcome, gate }), SPEC_EFFECTS_MARKER);
      console.log(
        `spec side-effects: children=${childrenOutcome.ok} verdict=${verdictOutcome.ok} transition=${gate.ok}`,
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
