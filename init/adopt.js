// Brownfield adoption: what does this repo still need to run the loop?
// Pure. The CLI supplies the repo's current state (which files exist, which
// labels the repo already carries, the scaffolded config) and does the I/O.
//
// Adoption is additive by construction: it never rewrites a file and never
// rewrites a label, so a repo that has half of the loop already keeps its own.

// The one matcher. `domains.yml` globs mean here exactly what they mean to the
// risk engine, because it is literally the same compiler — a second, subtly
// different glob implementation would let `--coverage` disagree with the
// verdicts the engine later hands down about the same paths.
import { globToRegExp } from "../scripts/policy/engine.js";
import { g3Mode } from "../scripts/identity/identity.js";

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
//   settings: settingsReport() entries — every non-satisfied one is owed
//   extra:   run-specific items (e.g. a `gh` call that failed), appended last
export function remainingItems({ config, domains, settings = [], extra = [] }) {
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
  for (const entry of settings) {
    if (entry.status === "satisfied") continue;
    items.push(
      `repo setting ${entry.id} (${entry.status}) — ${entry.why}; ` +
        (entry.command ? "run the command printed below" : "resolve the note printed below"),
    );
  }
  return [...items, ...extra];
}

// One block, three sections, always in this order — the ordering is the point.
// The settings block trails the summary rather than nesting inside `remaining`,
// because its commands must stay flush-left to survive a copy-paste (an indented
// heredoc terminator is not a terminator).
export function renderSummary({ created, present, remaining, settings = [], dryRun = false }) {
  const section = (title, items) => [
    `${title} (${items.length})`,
    ...(items.length ? items.map((i) => `  ${i}`) : ["  —"]),
  ];
  const settingsBlock = settings.length ? ["", ...renderSettings(settings)] : [];
  return [
    dryRun ? "adopt — dry run, nothing was written" : "adopt",
    "",
    ...section("created", created),
    "",
    ...section("present", present),
    "",
    ...section("remaining", remaining),
    ...settingsBlock,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Repo settings: detect, never apply.
//
// Three settings nothing in the loop checks and nothing reminds anyone about —
// toolkit Actions access, branch protection for G3, and the G4 release
// Environment. Adopt reads their current state and prints the exact `gh api`
// command for the ones that are missing. It never runs them: repo settings are
// a policy change on someone's repo, and that is a human keystroke.
//
// The never-weaken merge is *not* an optimisation that left with the executor.
// `PUT …/branches/{branch}/protection` and `PUT …/environments/{name}` both
// replace their object wholesale, and a human pasting a printed command issues
// exactly that PUT. Printing a bare baseline at a repo that already requires two
// approvals would hand someone a downgrade with a copy button. So every printed
// body is merge(current, baseline), and where current is unreadable the command
// carries an explicit wholesale-replace warning instead.

export const DEFAULT_TOOLKIT_REPO = "yuchida-tamu/agent-workflow";

// none < user < organization < enterprise
export const ACCESS_LEVELS = ["none", "user", "organization", "enterprise"];

// `current.<key>` sentinels: null = absent (404), undefined = unreadable (403).
// `access` may also be NOT_APPLICABLE — the 422 a public toolkit repo returns,
// because the Actions access policy exists only for private/internal repos.
export const NOT_APPLICABLE = "not-applicable";

const WHOLESALE_WARNING =
  "current state unreadable — this PUT REPLACES the whole object. Reconcile the body " +
  "below with what the repo already has before running it.";

// ---------------------------------------------------------------------------
// shell rendering

// POSIX single-quote escaping, bare when the value cannot mean anything else to
// the shell. The printed command is the deliverable here, so it has to paste.
export function shellQuote(value) {
  const s = String(value);
  if (s.length > 0 && /^[A-Za-z0-9._/:@%+=-]+$/.test(s)) return s;
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// Every printed body goes inside a QUOTED heredoc. There is no unquoted form,
// and adding one would be a security regression, not a feature.
//
// Repo data reaches these bodies: a required status-check context is named by
// whoever holds commit-status write access, which is a far lower bar than repo
// admin. Two earlier attempts tried to let one field expand (the environment
// reviewer's id lookup) while keeping the rest literal, first by sniffing the
// rendered text for `$(` and then by sniffing it for a fixed sentinel. Both
// failed the same way, because the property is not per-field: an unquoted
// heredoc makes the WHOLE body live, so any single attacker-controlled string
// anywhere in it reopens the hole for every other string. No amount of better
// needle-detection fixes that shape.
//
// So nothing in a body is ever expanded, and the id lookup that wanted
// expansion is resolved by the CLI before it gets here (see `approvers`).
// The only interpolation left in a printed command is the path, which
// shellQuote handles.
//
// The terminator must sit flush-left, which is why callers never indent this.
// A body line can never itself be `JSON`: JSON.stringify escapes newlines
// inside strings, so no data can introduce a raw line break to hide one behind.
export function renderCommand({ method, path, body }) {
  return [
    `gh api --method ${method} ${shellQuote(path)} --input - <<'JSON'`,
    JSON.stringify(body, null, 2),
    "JSON",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// helpers

const ownerOf = (repo) => String(repo ?? "").split("/")[0];

// Key-order-independent, so "is the merge a no-op?" cannot turn on the order two
// object literals happen to be written in.
const stable = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
const same = (a, b) => stable(a) === stable(b);
const or = (...vals) => vals.some(Boolean);
const uniqSorted = (xs) => [...new Set(xs)].sort();

// GitHub logins are alphanumerics with single interior dashes. The CLI checks
// this before putting a login in a request path, and the report checks it before
// naming one as an approver it will configure.
const VALID_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
export const isApproverLogin = (login) =>
  login !== PLACEHOLDER_APPROVER && VALID_LOGIN.test(String(login ?? ""));

// ---------------------------------------------------------------------------
// 1. toolkit Actions access
//
// This one is set on the *toolkit* repo, not the adopted one: the adopted repo's
// workflows do `uses: <toolkit>/actions/dispatch@main`, and a private toolkit
// repo refuses that until its access policy admits the consumer.
function accessEntry({ repo, toolkitRepo, current }) {
  const id = "actions-access";
  const path = `/repos/${toolkitRepo}/actions/permissions/access`;
  const crossOwner = ownerOf(toolkitRepo) !== ownerOf(repo);
  const required = crossOwner ? "organization" : "user";
  const command = () => renderCommand({ method: "PUT", path, body: { access_level: required } });
  const crossOwnerNote = crossOwner
    ? [
        `${toolkitRepo} and ${repo} have different owners — "organization" only helps if they ` +
          `share one. Otherwise make ${toolkitRepo} public, or grant access at the enterprise level.`,
      ]
    : [];

  if (current === NOT_APPLICABLE) {
    return {
      id,
      status: "satisfied",
      why: `${toolkitRepo} is public — its actions are usable from anywhere, no access policy applies`,
      command: null,
      notes: [],
    };
  }
  if (current === undefined) {
    return {
      id,
      status: "unknown",
      why: `cannot read the Actions access policy on ${toolkitRepo} (403, or the token lacks admin)`,
      command: command(),
      notes: [
        `${WHOLESALE_WARNING} If ${toolkitRepo} already grants a broader level than ` +
          `"${required}", running this NARROWS it.`,
        ...crossOwnerNote,
      ],
    };
  }
  const level = current?.access_level ?? "none";
  if (current !== null && ACCESS_LEVELS.indexOf(level) >= ACCESS_LEVELS.indexOf(required)) {
    return {
      id,
      status: "satisfied",
      why: `${toolkitRepo} already grants Actions access at "${level}"`,
      command: null,
      notes: [],
    };
  }
  return {
    id,
    status: current === null ? "missing" : "needs-change",
    why:
      current === null
        ? `no Actions access policy on ${toolkitRepo} — ${repo}'s workflows cannot use its composite actions`
        : `${toolkitRepo} grants Actions access at "${level}", below the "${required}" ${repo} needs`,
    command: command(),
    notes: [
      ...(current === null ? [] : [`access_level ${level} → ${required}`]),
      ...crossOwnerNote,
    ],
  };
}

// ---------------------------------------------------------------------------
// 2. branch protection (G3)

// The GET and the PUT do not share a shape: GET returns `{enabled}` wrappers and
// full user objects, PUT wants bare booleans and login strings. Normalising here
// is what makes the merged body a legal PUT rather than a 422.
export function normalizeProtection(got) {
  if (!got) return null;
  const enabled = (block) => Boolean(block?.enabled);
  const logins = (block) => ({
    users: (block?.users ?? []).map((u) => u.login ?? u),
    teams: (block?.teams ?? []).map((t) => t.slug ?? t),
    apps: (block?.apps ?? []).map((a) => a.slug ?? a),
  });
  const checks = got.required_status_checks;
  const reviews = got.required_pull_request_reviews;
  return {
    required_status_checks: checks
      ? {
          strict: Boolean(checks.strict),
          contexts: uniqSorted(checks.checks?.map((c) => c.context) ?? checks.contexts ?? []),
        }
      : null,
    enforce_admins: enabled(got.enforce_admins),
    required_pull_request_reviews: reviews
      ? {
          required_approving_review_count: reviews.required_approving_review_count ?? 0,
          dismiss_stale_reviews: Boolean(reviews.dismiss_stale_reviews),
          require_code_owner_reviews: Boolean(reviews.require_code_owner_reviews),
          require_last_push_approval: Boolean(reviews.require_last_push_approval),
          ...(reviews.dismissal_restrictions
            ? { dismissal_restrictions: logins(reviews.dismissal_restrictions) }
            : {}),
        }
      : null,
    restrictions: got.restrictions ? logins(got.restrictions) : null,
    allow_force_pushes: enabled(got.allow_force_pushes),
    allow_deletions: enabled(got.allow_deletions),
    required_linear_history: enabled(got.required_linear_history),
    required_conversation_resolution: enabled(got.required_conversation_resolution),
    block_creations: enabled(got.block_creations),
    lock_branch: enabled(got.lock_branch),
    allow_fork_syncing: enabled(got.allow_fork_syncing),
  };
}

export function protectionBaseline(requiredChecks = []) {
  const contexts = uniqSorted(requiredChecks);
  return {
    // The API requires this key even when there are no checks, so it is null
    // rather than absent — "omit the block" means the block, not the key.
    required_status_checks: contexts.length ? { strict: true, contexts } : null,
    enforce_admins: false,
    required_pull_request_reviews: {
      required_approving_review_count: 1,
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      require_last_push_approval: false,
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
    required_linear_history: false,
    required_conversation_resolution: false,
    block_creations: false,
    lock_branch: false,
    allow_fork_syncing: false,
  };
}

// merge(current, baseline) — the result is never looser than `current` on any
// axis. Counts take max, context sets union, tighteners OR, looseners stay off,
// and anything the baseline has no opinion about is carried through untouched.
export function mergeProtection(current, baseline) {
  if (!current) return baseline;
  const curChecks = current.required_status_checks;
  const baseChecks = baseline.required_status_checks;
  const curReviews = current.required_pull_request_reviews;
  const baseReviews = baseline.required_pull_request_reviews;
  return {
    required_status_checks:
      curChecks || baseChecks
        ? {
            strict: or(curChecks?.strict, baseChecks?.strict),
            contexts: uniqSorted([...(curChecks?.contexts ?? []), ...(baseChecks?.contexts ?? [])]),
          }
        : null,
    enforce_admins: or(current.enforce_admins, baseline.enforce_admins),
    required_pull_request_reviews:
      curReviews || baseReviews
        ? {
            required_approving_review_count: Math.max(
              curReviews?.required_approving_review_count ?? 0,
              baseReviews?.required_approving_review_count ?? 0,
            ),
            dismiss_stale_reviews: or(curReviews?.dismiss_stale_reviews, baseReviews?.dismiss_stale_reviews),
            require_code_owner_reviews: or(
              curReviews?.require_code_owner_reviews,
              baseReviews?.require_code_owner_reviews,
            ),
            require_last_push_approval: or(
              curReviews?.require_last_push_approval,
              baseReviews?.require_last_push_approval,
            ),
            // Whoever may dismiss a review today keeps that standing.
            ...(curReviews?.dismissal_restrictions
              ? { dismissal_restrictions: curReviews.dismissal_restrictions }
              : {}),
          }
        : null,
    // A push allow-list is stricter than none, and adopt has no business
    // guessing who belongs on it — carry it through exactly as found.
    restrictions: current.restrictions ?? baseline.restrictions,
    allow_force_pushes: Boolean(current.allow_force_pushes && baseline.allow_force_pushes),
    allow_deletions: Boolean(current.allow_deletions && baseline.allow_deletions),
    required_linear_history: or(current.required_linear_history, baseline.required_linear_history),
    required_conversation_resolution: or(
      current.required_conversation_resolution,
      baseline.required_conversation_resolution,
    ),
    block_creations: or(current.block_creations, baseline.block_creations),
    lock_branch: or(current.lock_branch, baseline.lock_branch),
    allow_fork_syncing: Boolean(current.allow_fork_syncing && baseline.allow_fork_syncing),
  };
}

// One line the reader can check before pasting: what does this command add?
function protectionDiff(before, after) {
  if (!before) return [];
  const parts = [];
  const beforeCount = before.required_pull_request_reviews?.required_approving_review_count ?? 0;
  const afterCount = after.required_pull_request_reviews?.required_approving_review_count ?? 0;
  if (afterCount !== beforeCount) parts.push(`required approvals ${beforeCount} → ${afterCount}`);
  const added = (after.required_status_checks?.contexts ?? []).filter(
    (c) => !(before.required_status_checks?.contexts ?? []).includes(c),
  );
  if (added.length) parts.push(`+status check ${added.join(", ")}`);
  if (
    Boolean(before.required_pull_request_reviews?.dismiss_stale_reviews) !==
    Boolean(after.required_pull_request_reviews?.dismiss_stale_reviews)
  ) {
    parts.push("dismiss_stale_reviews false → true");
  }
  for (const key of [
    "enforce_admins",
    "required_linear_history",
    "required_conversation_resolution",
    "block_creations",
    "allow_force_pushes",
    "allow_deletions",
  ]) {
    if (after[key] !== before[key]) parts.push(`${key} ${before[key]} → ${after[key]}`);
  }
  return parts.length ? [parts.join(" · ")] : [];
}

function protectionEntry({ repo, defaultBranch, requiredChecks, current }) {
  const id = "branch-protection";
  const path = `/repos/${repo}/branches/${defaultBranch}/protection`;
  const baseline = protectionBaseline(requiredChecks);
  const noChecksNote = requiredChecks.length
    ? []
    : ["no --required-check given, so this enforces review only — no CI context gates the merge"];

  if (current === undefined) {
    return {
      id,
      status: "unknown",
      why: `cannot read branch protection on ${repo} (403 — a free private repo, or a token without admin)`,
      command: renderCommand({ method: "PUT", path, body: baseline }),
      notes: [WHOLESALE_WARNING, ...noChecksNote],
    };
  }
  const normalized = normalizeProtection(current);
  const merged = mergeProtection(normalized, baseline);
  if (normalized && same(normalized, merged)) {
    return {
      id,
      status: "satisfied",
      why: `${defaultBranch} is already protected at or above the G3 baseline`,
      command: null,
      notes: [],
    };
  }
  return {
    id,
    status: normalized ? "needs-change" : "missing",
    why: normalized
      ? `${defaultBranch} is protected but below the G3 baseline`
      : `${defaultBranch} is unprotected — G3 has nothing to enforce`,
    command: renderCommand({ method: "PUT", path, body: merged }),
    notes: [...protectionDiff(normalized, merged), ...noChecksNote],
  };
}

// ---------------------------------------------------------------------------
// 3. release Environment (G4)

// GET returns protection rules as a list; PUT takes them as flat body keys.
export function normalizeEnvironment(got) {
  if (!got) return null;
  const rules = got.protection_rules ?? [];
  const waitRule = rules.find((r) => r.type === "wait_timer");
  const reviewerRule = rules.find((r) => r.type === "required_reviewers");
  return {
    wait_timer: waitRule?.wait_timer ?? 0,
    prevent_self_review: Boolean(reviewerRule?.prevent_self_review),
    reviewers: (reviewerRule?.reviewers ?? []).map((r) => ({
      // A closed set, not whatever the API said — the value is re-sent in a PUT
      // body, so it should be one of the two things the API accepts.
      type: r.type === "Team" ? "Team" : "User",
      id: r.reviewer?.id ?? r.id,
      login: r.reviewer?.login ?? r.reviewer?.slug ?? null,
    })),
    deployment_branch_policy: got.deployment_branch_policy ?? null,
  };
}

// approvers: [{ login, id }] — the CLI resolved each login to its numeric user
// id with a read-only GET. Ids arrive here already resolved precisely so that
// nothing in the printed body has to be computed by the reader's shell.
function environmentEntry({ repo, environment, approvers, current }) {
  const id = "release-environment";
  const path = `/repos/${repo}/environments/${environment}`;
  const wanted = approvers ?? [];

  const placeholders = wanted.filter((a) => !isApproverLogin(a.login));
  const unresolvedIds = wanted.filter((a) => isApproverLogin(a.login) && !Number.isInteger(a.id));
  if (wanted.length === 0 || placeholders.length || unresolvedIds.length) {
    const why = () => {
      if (wanted.length === 0) return "no approvers configured, so a G4 environment would gate releases on nobody";
      if (placeholders.length) {
        return `approvers are still unresolved (${placeholders.map((a) => a.login).join(", ")})`;
      }
      return `no numeric user id for ${unresolvedIds.map((a) => a.login).join(", ")} — GET /users/… did not answer`;
    };
    return {
      id,
      status: "missing",
      why: why(),
      command: null,
      notes: [
        placeholders.length || wanted.length === 0
          ? 'set "approvers" in agentflow.config.json to real GitHub logins, then re-run adopt — ' +
            "printing this command now would configure a G4 gate nobody can approve"
          : "re-run adopt once `gh` can reach the API; a reviewer cannot be configured by login alone",
      ],
    };
  }

  // Existing reviewers keep their standing; the configured approvers are unioned
  // in by numeric id, which is what the API records and what survives a rename.
  const build = (existing) => {
    const known = existing?.reviewers ?? [];
    const haveIds = new Set(known.map((r) => r.id));
    const additions = wanted.filter((a) => !haveIds.has(a.id));
    return {
      additions,
      body: {
        wait_timer: existing?.wait_timer ?? 0,
        prevent_self_review: existing?.prevent_self_review ?? false,
        reviewers: [
          ...known.map((r) => ({ type: r.type, id: r.id })),
          ...additions.map((a) => ({ type: "User", id: a.id })),
        ],
        deployment_branch_policy: existing?.deployment_branch_policy ?? null,
      },
    };
  };

  if (current === undefined) {
    return {
      id,
      status: "unknown",
      why: `cannot read the "${environment}" environment on ${repo} (403, or the token lacks admin)`,
      command: renderCommand({ method: "PUT", path, body: build(null).body }),
      notes: [
        `${WHOLESALE_WARNING} Any reviewer, wait timer or branch policy already on ` +
          `"${environment}" that is absent below WILL BE REMOVED.`,
      ],
    };
  }
  const existing = normalizeEnvironment(current);
  const { body, additions } = build(existing);
  if (existing && additions.length === 0) {
    return {
      id,
      status: "satisfied",
      why: `"${environment}" already requires every configured approver`,
      command: null,
      notes: [],
    };
  }
  return {
    id,
    status: existing ? "needs-change" : "missing",
    why: existing
      ? `"${environment}" exists but does not require ${additions.map((a) => a.login).join(", ")}`
      : `no "${environment}" environment — G4 releases are ungated`,
    command: renderCommand({ method: "PUT", path, body }),
    notes: [
      `+reviewer ${additions.map((a) => a.login).join(", ")}`,
      ...(existing ? ["existing reviewers, wait timer and branch policy are preserved above"] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// 4. G3 mode — reported, never changed
//
// The only entry with no command attached, because there is nothing to run: the
// step it would name is creating a GitHub App, which is a browser action only a
// human account can perform.
//
// It is always `satisfied`, and that is a deliberate choice rather than a
// flattering one. `remainingItems` treats every non-satisfied entry as a step
// the adoption still owes — but `solo-comment` is a legitimate *final* state,
// not a half-finished one. Most repos will never create an App, and a report
// that listed "give agentflow an identity" under `remaining` forever would be
// nagging, which is how a report stops being read. The mode still prints: the
// settings block renders every entry regardless of status.

function g3ModeEntry({ config, protection }) {
  const { mode, enforced, why } = g3Mode({ config: config ?? {}, protection });
  return {
    id: "g3-mode",
    status: "satisfied",
    why: `${mode}${mode === "native-review" && enforced ? ", enforced" : ""} — ${why}`,
    command: null,
    notes:
      mode === "solo-comment"
        ? ["creating the App is a browser action only a human can take — see docs/github-app-runbook.md"]
        : [],
  };
}

// ---------------------------------------------------------------------------

// The whole report. Pure: `current` is what the CLI's three read-only GETs found.
//   current.access      — GET /repos/{toolkit}/actions/permissions/access
//   current.protection  — GET /repos/{repo}/branches/{branch}/protection
//   current.environment — GET /repos/{repo}/environments/{name}
// Each is the response body, null when absent (404), or undefined when
// unreadable (403). `access` may also be NOT_APPLICABLE (422, public toolkit).
//
// `approvers` is [{ login, id }], already resolved by the CLI. Taking ids rather
// than logins is what lets every printed body be fully literal — see
// renderCommand for why no part of a body may be left for the shell to compute.
export function settingsReport({
  repo,
  toolkitRepo = DEFAULT_TOOLKIT_REPO,
  defaultBranch = "main",
  environment = "release",
  approvers = [],
  requiredChecks = [],
  config = {},
  current = {},
}) {
  return [
    accessEntry({ repo, toolkitRepo, current: current.access }),
    protectionEntry({ repo, defaultBranch, requiredChecks, current: current.protection }),
    environmentEntry({ repo, environment, approvers, current: current.environment }),
    g3ModeEntry({ config, protection: current.protection }),
  ];
}

// Commands print flush-left and unindented: an indented heredoc terminator is
// not a terminator, and a command that does not paste is not a deliverable.
export function renderSettings(entries) {
  const lines = [
    "repo settings — detected, never applied",
    "  adopt changes nothing here. Read each command, then run the ones you agree with.",
  ];
  for (const entry of entries) {
    lines.push("", `  ${entry.id} · ${entry.status} — ${entry.why}`);
    for (const note of entry.notes ?? []) lines.push(`    ! ${note}`);
    if (entry.command) lines.push("", entry.command);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 4. coverage — how much of this repo does domains.yml actually classify?
//
// Repo-scoped, and deliberately not the same number as
// `domainFacts().unmapped_fraction` in scripts/facts/core.js, which is
// diff-scoped (the share of a *change* the map cannot classify). This one
// answers "how far has the map been grown?" over every tracked file. Both use
// the same glob compiler, so the two agree file-for-file; only the population
// differs.
//
// It exists so the adoption-auditor never eyeballs the number: coverage is
// counting, and counting is a script's job.

// The template's value, and the fallback when a target has no config yet.
export const DEFAULT_WARN_FRACTION = 0.2;

const CRITICALITY_ORDER = ["low", "medium", "high", "critical"];

// Never checked in by hand, so never a thing a human assigns criticality to.
const GENERATED_DIR =
  /(^|\/)(node_modules|vendor|dist|build|out|coverage|\.next|\.expo|\.turbo|__snapshots__|Pods|Carthage)\//;
const LOCKFILE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json|Gemfile\.lock|Podfile\.lock|poetry\.lock|Cargo\.lock|composer\.lock|go\.sum)$/;
// Binaries and assets: real content, but nobody writes a `paths:` glob for a PNG.
const ASSET_EXT =
  /\.(png|jpe?g|gif|svg|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|mp[34]|mov|webm|wav|ttf|otf|woff2?|eot|xcf|psd|keystore|jks|p12|snap)$/i;

// Docs, JSON and YAML deliberately COUNT as source. The toolkit's own map gives
// `*.md` and `policies/**` a criticality, so filtering them out would bake a
// judgement — "docs don't matter" — into a script whose whole job is to count
// without judging. What is filtered out is only what a human never authors.
export function isTrackedSource(path) {
  return !GENERATED_DIR.test(path) && !LOCKFILE.test(path) && !ASSET_EXT.test(path);
}

export function trackedSourceFiles(paths) {
  return (paths ?? []).filter((p) => typeof p === "string" && p.length > 0).filter(isTrackedSource);
}

// The directory a human would add to `paths:` to fix this, i.e. the immediate
// parent — a top-level segment is too coarse to act on in a deep tree.
const parentDir = (path) => {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "." : path.slice(0, cut);
};

// domains: parsed domains.yml — { name: { criticality, paths: [glob…] } }.
// files:   already filtered through trackedSourceFiles() by the caller.
// warnFraction: null means "no threshold configured", never a warning.
export function coverage(domains, files, { warnFraction = null, topDirs = 5 } = {}) {
  const compiled = Object.entries(domains ?? {}).map(([name, d]) => ({
    name,
    criticality: d?.criticality ?? "medium",
    regexps: (d?.paths ?? []).map(globToRegExp),
  }));

  const counts = new Map(compiled.map((d) => [d.name, 0]));
  const unmappedFiles = [];
  for (const file of files) {
    let hit = false;
    for (const domain of compiled) {
      if (!domain.regexps.some((r) => r.test(file))) continue;
      counts.set(domain.name, counts.get(domain.name) + 1);
      hit = true;
    }
    if (!hit) unmappedFiles.push(file);
  }

  const dirCounts = new Map();
  for (const file of unmappedFiles) {
    const dir = parentDir(file);
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }

  const total = files.length;
  const unmappedFraction = total === 0 ? 0 : unmappedFiles.length / total;
  return {
    total,
    mapped: total - unmappedFiles.length,
    unmapped: unmappedFiles.length,
    unmapped_fraction: unmappedFraction,
    warn_fraction: warnFraction,
    // Strictly above: a repo sitting exactly on its configured threshold is
    // within the budget it set, not over it.
    warn: warnFraction !== null && unmappedFraction > warnFraction,
    unmapped_files: unmappedFiles,
    top_unmapped_dirs: [...dirCounts.entries()]
      .map(([dir, count]) => ({ dir, count }))
      .sort((a, b) => b.count - a.count || (a.dir < b.dir ? -1 : 1))
      .slice(0, topDirs),
    domains: compiled
      .map((d) => ({ name: d.name, criticality: d.criticality, files: counts.get(d.name) }))
      .sort(
        (a, b) =>
          CRITICALITY_ORDER.indexOf(b.criticality) - CRITICALITY_ORDER.indexOf(a.criticality) ||
          (a.name < b.name ? -1 : 1),
      ),
  };
}

const pct = (fraction) => `${(fraction * 100).toFixed(1)}%`;

// `unmappedCriticality` comes from the target's config: it is the criticality
// the engine already assigns to unmapped changes, so it is also the honest
// default for a catch-all domain.
export function renderCoverage(report, { unmappedCriticality = "medium" } = {}) {
  const lines = [
    `coverage — ${report.total} tracked source file(s), ` +
      `${report.unmapped} unmapped (${pct(report.unmapped_fraction)})`,
  ];

  if (report.domains.length === 0) {
    lines.push("", "  domains.yml maps nothing — it is still the template stub");
  }
  if (report.warn) {
    lines.push(
      "",
      `  ! ${pct(report.unmapped_fraction)} exceeds unmapped_warn_fraction ` +
        `${pct(report.warn_fraction)} — extend domains.yml, or add a catch-all ` +
        `domain at criticality "${unmappedCriticality}"`,
    );
  }

  if (report.top_unmapped_dirs.length) {
    lines.push("", "  top unmapped directories");
    for (const { dir, count } of report.top_unmapped_dirs) lines.push(`    ${count}  ${dir}`);
  }
  if (report.domains.length) {
    lines.push("", "  mapped by domain");
    for (const d of report.domains) lines.push(`    ${d.files}  ${d.name} (${d.criticality})`);
  }
  return lines.join("\n");
}
