# Changelog

All notable changes to `agent-workflow` are recorded here, by capability
area rather than by commit — this is written for a consumer deciding
whether to adopt, not for a contributor replaying history. See
`docs/agent-loop-architecture.html` for the design and `STATUS.md` for the
build-status ledger this summarizes.

日本語版: [`CHANGELOG.ja.md`](CHANGELOG.ja.md)

## v0.4.0 — the headless loop actually closes

(Everything below is new since v0.3.0.)

v0.3.0 shipped headless dispatch and review as switchable stages. Turning them
on in a real consumer repo (`hsk-habit`) found that each one produced its
artifact and then dropped it, refused it, or aimed it at the wrong issue — five
consumer-facing defects, all reported from that repo and all fixed here. A
consumer pinning `@v0.3.0` with `headless.*` enabled is getting a loop that
runs and does not land; this is the tag that closes it.

### Headless review — the verdict is now read, not guessed

`findingsFromText` `JSON.parse`d the agent's **entire** output. The
code-reviewer emits prose with its findings in a fenced ```json block, so the
parse always threw, `findings` was always `null`, and `verdictFromFindings`
returned `not-mergeable` by its (correct) absence-is-refusal default. Every
headless review refused, whatever it found — a clean review and a blocking one
were byte-identical (#171, fixed in #183).

It now falls back to scanning fenced blocks for the concluding `findings`
payload, so the verdict follows the agent's actual findings.

The same run submitted a native `CHANGES_REQUESTED` per invocation and never
reconciled the previous one, so PRs accumulated undismissed blocking reviews —
two apiece on the reporting repo — and the body claimed "findings are in the
review-artifact comment" even when there were none (#181, also #183). The
native review is now reconciled rather than re-added.

### post-merge — an unrunnable smoke degrades instead of abandoning the merge

The pack lookup resolved `packs/` against the **consumer's** checkout, where
nothing ever vendors one: `adopt` does not install a pack and no documentation
said to. With scenarios present the stage hit `process.exit(20)` — *above* the
loop that applies the state transition and posts the smoke note. The linked
issue was left CLOSED but stuck at its pre-merge label, and `main` went red on
every merge (#182, fixed in #191).

It stayed hidden until the first PR that actually closed an issue: earlier
merges exited higher up at `PR closes no issue — nothing to transition`, so a
repo could look healthy for many merges and break on the first one that used
the loop as intended.

`resolvePackDir` now resolves against the toolkit, where the pack actually
lives, and an unrunnable smoke degrades to `smokeSkipped` — recorded honestly
in the note, with the merge bookkeeping still applied. **A real replay failure
still blocks.**

### Dispatch — a parent no longer launches an implementer

`state:ready` on a parent issue dispatched an implementer at the parent, which
has no work of its own. `agentflow-next` had the `PARENT_WAITING` guard for
exactly this; the label-triggered dispatcher never consulted `childrenOf`
(#180, fixed in #186). It does now.

`fcd18d4` (#190) also surfaces children orphaned by a re-plan instead of
leaving them silently attached to a superseded plan.

### Known gap: the headless implementer still cannot write

Reported alongside the parent-dispatch bug and **not** fixed here.
`DEFAULT_ALLOWED_TOOLS` is `["Read", "Grep", "Glob"]` with
`--permission-mode plan`, applied to every role — correct for the architect and
code-reviewer, fatal for the implementer, whose job is to write. `launchPlan`
accepts an `allowedTools` override and nothing passes one. Nor does anything
prepare the worktree `agents/implementer.md` tells the agent to expect.

So `headless.dispatch.ready` will still burn a run and post a blocker artifact.
The agent fails safe and says exactly what it needs, but the stage cannot
succeed. Leave `ready` off until that lands.

### Also

- **State transitions are idempotent** compare-and-swap across drivers (#172),
  so a repeated apply cannot double-move an item.
- **PR verdicts count unmapped code** toward criticality and warn on map rot
  (#169) — an unmapped diff surface no longer scores as if it were harmless.
- **`agentflow-gates`** gives the approval inbox a front door (#173).
- **`release --verify`** checks per-item versions rather than `HEAD`'s (#170).
- **Lock takeover** is an inode-checked claim with no arbitration file (#184),
  and adapter residuals get lock age-out plus pid-bound readiness (#177).
- **pack-expo `ship`** has a written specification (#176); still spec-only.
- **JA house glossary** unified across the site and documents (#174).

## v0.3.0 — the platform pillar

(Everything below is new since v0.2.0; see that section for what was already
shipped.)

The repo is now public under MIT, has a docs site, and — the headline —
`pack-expo`'s `run`/`verify`/`execute-step` adapters are live-proven against
a real booted iOS simulator, not just merged and unit-tested. A consumer
pinning `@v0.2.0` was missing all three of those plus a real-world bug in
headless dispatch; this is the tag that gives them back.

### pack-expo adapters — live-proven, not just merged

`run`, `verify`, and `execute-step` were implemented (#138, #140, #141) and
then put through a four-round live acceptance campaign (#159) against a
self-provisioned, real Expo app on a real booted iOS simulator — provision →
start → verify → execute-step → stop, no mocks. Each round retired exactly
what the previous one found, and the campaign is why this pack can be called
proven rather than merged:

- **#156** (P0) — `spawnBackground` handed an unopened `WriteStream` to
  `spawn()`; every real `run start` threw immediately, deterministically, on
  every Node version tested. Fixed by opening the log fd synchronously.
- **#158** (P1) — the reuse fast-path never matched agent-device's real
  `"DisplayName (bundle.id)"` app-list format, so every `run start` paid a
  multi-minute rebuild even with the dev client already installed.
- **#162** (P0) — `run start` opened the dev client via the generic Expo Go
  scheme (`exp://…`), which either hit an OS disambiguation dialog or opened
  the wrong app entirely when Expo Go was also installed. Now builds the
  bundle-scoped `expo-development-client` deep link Expo's own CLI uses.
- **#164** (P0) — `execute-step`'s `text` assertion read the raw, un-enveloped
  agent-device response, so it always read empty. Fixed structurally: the
  unwrap now lives in `invoke()` itself, the one chokepoint every adapter
  call goes through, so no future caller can reintroduce the same class of
  bug.

All four are closed and re-verified live; the campaign's final round passed
clean end to end. The `ship` adapter (EAS build/distribute/submit) remains
spec-only (#137) — treat platform support as "run and verify a build,"
not "build and ship one," until it lands.

### Headless dispatch — artifacts survive a successful run

`headless.dispatch.<state>` had a consumer-facing bug (#157, filed by
hsk-habit): a completed run posted only its ledger row and silently
discarded the artifact it had already produced — success looked identical to
a run that made no output. Fixed in #160: successful runs now post their
artifact under a durable, per-state marker, the same append-in-place pattern
the ledger and risk verdict already use. `headless.dispatch` still ships off
in every state by default (this repo included); this closes the gap for any
consumer that turns it on.

### Repo public, MIT-licensed, with a docs site

The repo is now public and MIT-licensed (#146). A bilingual (EN/JA)
interactive docs site is live at
[yuchida-tamu.github.io/agent-workflow](https://yuchida-tamu.github.io/agent-workflow/)
(#145), including a native Japanese rewrite of the site itself rather than a
machine translation (#151). `README.ja.md`, `docs/getting-started.ja.md`,
`CHANGELOG.ja.md`, and `agent-loop-architecture.ja.html` — full Japanese
versions of the four core documents, each written as a native technical
document (#150) — join the English originals, cross-linked both ways.
Outbound doc links now resolve to their rendered Pages destinations instead
of raw source blobs (#154, with a front-matter quoting fix from that
review's own follow-up, #155).

### Known gaps at v0.3.0

- **`pack-expo`'s `ship` adapter is specified, not shipped.** `run`,
  `verify`, and `execute-step` are live-proven (above); `ship` (EAS
  build/distribute/submit) is still interface-only in `interfaces/`. This is
  the next milestone.
- `headless.dispatch.<state>` is built, tested, and now artifact-durable, but
  still ships off in every state by default, including this repo's own.
- Nightly QA (scheduled headless exploration) is deferred on cost — it needs
  a self-hosted macOS runner.

[Unreleased]: https://github.com/yuchida-tamu/agent-workflow/compare/v0.3.0...HEAD
[v0.3.0]: https://github.com/yuchida-tamu/agent-workflow/releases/tag/v0.3.0

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

[v0.2.0]: https://github.com/yuchida-tamu/agent-workflow/releases/tag/v0.2.0

## v0.1.0 — historical

Cut mid-development (2026-07-26, commit `794667b`) while building and
live-testing `agentflow-release` itself — a working but incomplete snapshot
predating the review guard, the squash-aware delivery check, and the release
docs. Kept because tags are immutable here by policy: the release CLI refuses
to re-point a published version, and we practice what it enforces.
