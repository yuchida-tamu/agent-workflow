# Build status

What's actually built, phase by phase. For what this is and how to use it,
start at [`README.md`](README.md); for the design, see
[`agent-loop-architecture.html`](docs/agent-loop-architecture.html).

`npm test` — 518 tests, all passing.

## Layout

| Path | Layer | What |
|---|---|---|
| `scripts/policy/` | core | Risk policy engine (pure) + `agentflow-policy` CLI |
| `scripts/state/` | core | Work-item state machine (pure) + `agentflow-state` CLI |
| `scripts/gate/` | core | `/approve` comment validation + `agentflow-gate` CLI |
| `scripts/identity/` | core | Who is acting: the agent's GitHub App identity, what a bot may approve, and `agentflow-identity` (`token` · `exec` · `whoami` · `doctor`) |
| `scripts/facts/` | core | Diff/domain/drift fact extraction + `agentflow-facts` CLI |
| `scripts/e2e/` | core | Gherkin parser, trace replay runner + `agentflow-e2e` CLI |
| `scripts/next/` | core | Crawl-phase dispatcher + `agentflow-next` CLI |
| `scripts/log/` | core | Run ledger (pure) + `agentflow-log` CLI: `start` · `end` · `audit` |
| `scripts/release/` | core | G4 release: tag + GitHub release + `agentflow-release` CLI (`--verify` asserts no `state:released` without a tag) |
| `policies/baseline.yaml` | core | Platform-neutral baseline pack (locked guards + scoring) |
| `interfaces/` | core | The four core↔pack contracts: `run` · `verify` · `execute-step` · `ship` |
| `scenarios/SPEC.md` | core | Gherkin grammar, compiled-trace format, runner semantics |
| `packs/expo/` | pack | RN Expo: platform policies ✅, runners ✅, adapters/skills (Phase 2) |
| `agents/` | core | The eleven agent definitions with model tiers (installed into consuming repos' `.claude/agents/`) |
| `init/` | core | `agentflow-init labels` (18-label set) · `agentflow-init project` (config, domains, business pack, agents, e2e dirs) · `agentflow-init adopt` (scaffold + labels + printed settings commands · `--verify` · `--coverage`) |
| `actions/` | core | Composite Actions: `gate-check` · `risk-verdict` · `dispatch` · `post-merge` · `auto-merge` (thin YAML over `scripts/actions/*.js`) |

## Phase 1 status (crawl)

- [x] Policy engine: fact/operator conditions, monotonic obligation union,
      locked rules, levels, embedded fixture tests (`agentflow-policy test`)
- [x] Baseline + expo policy packs, with fixtures
- [x] State machine: `state:*` labels, gated transitions (G1–G4), `gh`-backed
      `apply` that refuses ungated gate crossings
- [x] Interface signatures + scenario/trace spec
- [x] Gate validator: `/approve [gate]` · `/reject`, authorized-approver check,
      feeds `agentflow-state apply --approved-gate`
- [x] Fact extractors: git range → `diff.*`, `domains.*` (via domains.yml),
      `drift.*` (scope + brief-vs-domain) → pipes into `agentflow-policy evaluate`
- [x] E2E runner core: Gherkin parser, tag selection, trace replay over the
      `execute-step` adapter, `needs-derivation` emission (derivation itself is
      an agent task — Phase 2)
- [x] `agentflow-next`: crawl-phase dispatcher — top actionable issue by
      priority/age → who acts next per the dispatch table

## Phase 2 status (walk)

- [x] Agent definitions: product-shaper · architect · project-genesis ·
      adoption-auditor · code-reviewer · ux-reviewer (opus) · implementer ·
      build-sentinel · qa-explorer · trace-deriver (sonnet) · triage (haiku)
- [x] Entry paths: genesis (one-shot bootstrap → seeded backlog handoff),
      adoption (init + audit), steady state; `maturity: genesis|steady` in
      config surfaces as `meta.maturity` for policy softening
- [x] Installer: `agentflow-init labels` + `agentflow-init project`
      (idempotent, dry-run capable, installs agents into `.claude/agents/`)
- [x] GitHub remote (`yuchida-tamu/agent-workflow`) + 18 labels applied;
      live smoke test passed: dispatch → gate refusal → `/approve` →
      G1-validated transition → re-dispatch to architect
- [ ] pack-expo adapters (`run` / `verify` / `execute-step` / `ship`) + skills
- [x] Composite GitHub Actions: `gate-check` (issue comments → validated
      transitions), `risk-verdict` (PR diff → facts → policy → labels +
      verdict comment), `dispatch` (state label → who-acts-next comment);
      workflow stubs installed by `agentflow-init project` with the toolkit
      repo substituted in. Gate + dispatch scripts verified live with
      synthetic event payloads; `risk-verdict` awaits the first consuming-app
      PR.
- [ ] First real loop run on a consuming app (also first live `risk-verdict`)
- [ ] Brief sweep in practice + headless agent execution (Phase 3)
- [x] **agentflow has its own identity.** Agents author *work* as a GitHub App;
      humans keep their own identity for *decisions*. `agent_identity` in config,
      installation tokens minted with zero dependencies (`node:crypto` + `fetch`),
      App credentials plumbed through every composite action with a **loud**
      `GITHUB_TOKEN` fallback. `approvers` is now validated as human logins only.
      Optional everywhere: a repo that never creates an App is unaffected.
      Setup: [`docs/github-app-runbook.md`](docs/github-app-runbook.md).
- [x] Automated brownfield adoption — `agentflow-init adopt` scaffolds an
      existing repo (never overwriting), creates only the missing labels, and
      prints one ordered created/present/remaining summary; `--verify` re-reads
      an adopted repo check by check and `--coverage` reports how much of it
      `domains.yml` classifies. The `adoption-auditor` agent supplies the
      judgment half: it drafts the domain map, has a human confirm every
      criticality, and extends the repo's own conventions doc.
      **Repo settings are printed, not applied** — adopt detects which of
      toolkit Actions access, branch protection and the G4 release Environment
      are missing and prints the exact `gh api` command for each, merged
      against the repo's current state so a paste can never weaken it. It
      never runs them, under any flag, and neither does `project-genesis`:
      a policy change on someone's repo is a human keystroke.

## Which stages run headless

Phase 3 lets GitHub events launch agents on a runner, so the loop is not capped
by the maintainer's attention. It arrives one stage at a time, and **every stage
ships off**:

| stage | trigger | flag | status |
|---|---|---|---|
| review | `pull_request` | `headless.review` | shipped |
| dispatch (`idea`, `spec`, `ready`) | `state:*` label | `headless.dispatch.<state>` | not yet |
| nightly QA | schedule | — | deferred (needs a self-hosted macOS runner) |

A repo that sets nothing behaves exactly as it did before: the workflow runs,
reports that headless review is off, and exits green.

**Headless runs are billed to a Claude subscription, never to metered API
credits.** `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) is the only
supported credential; `ANTHROPIC_API_KEY` is actively stripped from the child
environment rather than merely unused. Setup, cost, and token rotation:
[docs/headless-runbook.md](docs/headless-runbook.md).

Gates never go headless. A headless run authenticates as the App identity, and
bot-authored approvals are refused in code — see below.

## G3 has two modes

Which one a repo is in is a fact about *who authors its agent PRs*, and
`agentflow-init adopt --verify` reports it with the reason:

| mode | when | what G3 is |
|---|---|---|
| `native-review` | `agent_identity` is set — agent PRs are authored by the App | a real GitHub approving review; `enforced` when branch protection requires it |
| `solo-comment` | no `agent_identity` — agent PRs are authored by you | a `/approve` comment naming the head SHA, then a merge |

`solo-comment` is a legitimate final state, not a half-finished adoption: GitHub
forbids approving your own PR, so a solo maintainer without an App has no other
option. This repo is in `solo-comment` mode today.

**Bot-authored approvals are refused in code, not by convention.** The one
exception is G3 on a pull request whose recorded risk verdict carries no
`human-merge`, no `auto-merge` block, and demonstrably describes the head being
merged — precisely the condition under which `auto-merge` already merges the PR
unattended. There the App transcribes an engine decision into a reviewable
artifact rather than minting authority of its own. Every other gate, and every
issue comment, refuses a bot outright.

> Consuming private repos must be allowed to use this repo's actions:
> Settings → Actions → General → Access → "Accessible from repositories
> owned by yuchida-tamu".

```sh
npm install
npm test                                             # engine + machine tests
node scripts/policy/cli.js test policies/baseline.yaml packs/expo/policies/expo.yaml
node scripts/policy/cli.js evaluate --facts facts.json policies/baseline.yaml packs/expo/policies/expo.yaml
node scripts/state/cli.js plan --labels "state:in-review" --to merged
```
