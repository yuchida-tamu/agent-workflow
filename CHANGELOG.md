# Changelog

All notable changes to `agent-workflow` are recorded here, by capability
area rather than by commit — this is written for a consumer deciding
whether to adopt, not for a contributor replaying history. See
`agent-loop-architecture.html` for the design and `STATUS.md` for the
build-status ledger this summarizes.

日本語版: [`CHANGELOG.ja.md`](CHANGELOG.ja.md)

## v0.2.0 — first complete release

(Everything below describes the toolkit as of this tag.)

The first version a consuming repo can pin instead of riding `@main`. The
deterministic core, the agent roster, App identity, and headless review are
shipped and run this repo's own backlog; the platform pack (pack-expo
adapters) is specified but not implemented, and stays experimental until a
real pack ships against the interfaces.

### Loop core — state machine, gates, dispatch

The work-item lifecycle (`idea → spec → planned → ready → in-progress →
in-review → merged → verified → released`) is enforced as `state:*` labels,
with gated transitions at G1 (brief), G2 (plan, risk-based), G3 (merge), and
G4 (release). `agentflow-state` owns the machine; `agentflow-gate` validates
`/approve [gate]` and `/reject` issue comments against the authorized
approvers list before any transition applies. `agentflow-next` is the
crawl-phase dispatcher — given a repo, it names who acts next and why, so
the loop can be driven one command at a time or wired to events.
Parent↔child structure rides native GitHub sub-issues where available, with
a `Child of #N` body line as fallback; dependent children can stack on an
`integrate/<topic>` branch and land through one integration PR.

### Risk policy engine + packs

A pure rules engine (`agentflow-policy`) turns diff/domain/business facts
into a verdict — score, level, and a set of consequences (require a gate,
block auto-merge, run extra scenarios, notify someone) — posted as an
auditable, factor-by-factor comment. Hard triggers, additive score factors,
and business rules share one rule shape, so a project's own
`policies/business.yml` composes with the platform-neutral
`policies/baseline.yaml` without special-casing. Policy packs carry embedded
fixture tests, runnable with `agentflow-policy test`.

### Fact extraction + drift detection

`agentflow-facts` turns a git range into the facts the policy engine reads:
`diff.*` (size, file types), `domains.*` (business criticality, via
`domains.yml`), and `drift.*` (scope vs. the approved plan, brief vs. domain
footprint). Unmapped code carries no hardcoded threshold in core —
`unmapped_criticality` is an opt-in per-project config value — but the
installer ships a starting point: `unmapped_warn_fraction` (template
default `0.2`) is a config value `agentflow-init adopt --coverage` already
enforces, warning when a repo's unmapped fraction exceeds its own budget.

### Run ledger + audit

Every work item gets one marker-managed ledger comment (`agentflow-log
start` / `end`), whose human-readable table is its own storage — what a
human reads and what `agentflow-log audit` parses are the same bytes.
`audit` compares each row's model against the tier its agent definition
declares, flags phase gaps and unknown agents, and takes `--since` to
exclude issues that predate the ledger rather than reporting a permanent
false gap for them.

### Review guard — mechanically unskippable review

Independent review is now enforced in code, not by convention. A review
artifact reader, an emission step (the reviewer posts a marker-managed
comment identifying the exact head SHA it reviewed, in both G3 modes), and
a composition layer that filters to a trusted reviewer identity before
collapsing to "the latest" verdict, feed a single guard —
`reviewAuthorises` — composed into both places the machine can mint a G3
outcome: `validateApproval` and auto-merge's decision. A PR without a
fresh, mergeable review of its current head fails closed at both paths, and
the same guard defends against a stale review being replayed as approval
of a later, unreviewed commit.

### App identity + G3 modes

Agents can act as a GitHub App rather than the maintainer's own account —
`agentflow-identity` mints installation tokens from zero dependencies
(`node:crypto` + `fetch`), and every composite Action threads App
credentials through with a loud fallback to `GITHUB_TOKEN`. This decides
which of two legitimate G3 modes a repo is in, reported by `adopt
--verify`: `native-review` (App-authored agent PRs, a real approving
review) or `solo-comment` (the human's own PRs, a SHA-naming `/approve`
comment then merge — GitHub forbids self-review any other way).
Bot-authored gate approvals are refused in code before the approvers list
is even consulted, with one narrow, audited exception: G3 on a PR whose
recorded risk verdict already authorizes an unattended merge, where the App
transcribes an engine decision rather than minting one. `/approve G3`
posted as an *issue* comment always refuses, by construction — G3 lives on
the PR; the issue advances once the PR merges, via post-merge automation.

### Headless stages

GitHub events can launch agents on a runner with no interactive session,
one stage at a time, every flag shipped off by default. `headless.review`
is live: a `pull_request` launches the code-reviewer headlessly, authored
by the App. `headless.dispatch.<state>` (launching the named agent per
state label) is built and tested but not yet enabled for any state.
Headless runs bill to a Claude subscription via `CLAUDE_CODE_OAUTH_TOKEN`
only — `ANTHROPIC_API_KEY` is stripped from the child environment by
design, never merely unused. Setup and token rotation: see
`docs/headless-runbook.md`.

### Entry paths — genesis, adopt, init tooling

Two ways into the loop. `project-genesis` (Opus) is the brand-new-project
path: it interviews you once and scaffolds the repo, `CLAUDE.md`, and a
seeded milestone-1 backlog in one pass. `agentflow-init adopt` is the
existing-repo path: additive and idempotent, it creates whichever of the
18-label set is missing, scaffolds config/`domains.yml`/a starter business
pack/`e2e/` dirs, installs the agent roster into `.claude/agents/`, and
prints (never applies) the `gh api` commands for the repo settings the loop
needs. `--verify` re-reads what actually landed, check by check; `--coverage`
reports how much of the tracked source `domains.yml` classifies.

### E2E runner core + compile-and-replay spec

A Gherkin parser and trace-replay runner (`agentflow-e2e run` / `smoke`)
compile `.feature` scenarios once and replay the compiled trace against a
platform's `execute-step` adapter, tag-selectable and exit-code-driven (0
ok · 10 recoverable · 20 fatal) for the bounded-retry scripts above it. The
grammar and trace format are specified in `scenarios/SPEC.md`. Post-merge
runs `agentflow-e2e smoke` against a repo's own suite and passes vacuously
on an empty one — a fact about that repo's coverage, not a runner failure —
so the loop's tail completes on a toolkit or library, not only an app.

### Known gaps at v0.2.0

- **`pack-expo` adapters are specified, not shipped.** The four
  interfaces (`run`, `verify`, `execute-step`, `ship`) are locked in
  `interfaces/`, and `packs/expo/policies/expo.yaml` ships with fixture
  tests, but no adapter implementation exists yet — treat platform support
  as experimental until a pack lands against those interfaces. This is the
  next milestone.
- Nightly QA (scheduled headless exploration) is deferred on cost — it
  needs a self-hosted macOS runner.
- No consuming-app has yet run the full loop end to end; this repo is its
  own only production user so far.

[Unreleased]: https://github.com/yuchida-tamu/agent-workflow/compare/v0.2.0...HEAD
[v0.2.0]: https://github.com/yuchida-tamu/agent-workflow/releases/tag/v0.2.0

## v0.1.0 — historical

Cut mid-development (2026-07-26, commit `794667b`) while building and
live-testing `agentflow-release` itself — a working but incomplete snapshot
predating the review guard, the squash-aware delivery check, and the release
docs. Kept because tags are immutable here by policy: the release CLI refuses
to re-point a published version, and we practice what it enforces.
