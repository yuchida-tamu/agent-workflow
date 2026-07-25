# agent-workflow

A platform-agnostic agentic development loop on GitHub: ideas in, shipped and
tested features out, humans only at deliberate gates. **Deterministic by
default** — scripts wherever possible, agents only for judgment, every agent
call routed to the cheapest capable model.

📐 **Architecture:** [`agent-loop-architecture.html`](agent-loop-architecture.html)
(published artifact with the interactive wiring graph). Design ground rules
live there; this README tracks what's built.

## Layout

| Path | Layer | What |
|---|---|---|
| `scripts/policy/` | core | Risk policy engine (pure) + `agentflow-policy` CLI |
| `scripts/state/` | core | Work-item state machine (pure) + `agentflow-state` CLI |
| `scripts/gate/` | core | `/approve` comment validation + `agentflow-gate` CLI |
| `scripts/facts/` | core | Diff/domain/drift fact extraction + `agentflow-facts` CLI |
| `scripts/e2e/` | core | Gherkin parser, trace replay runner + `agentflow-e2e` CLI |
| `scripts/next/` | core | Crawl-phase dispatcher + `agentflow-next` CLI |
| `policies/baseline.yaml` | core | Platform-neutral baseline pack (locked guards + scoring) |
| `interfaces/` | core | The four core↔pack contracts: `run` · `verify` · `execute-step` · `ship` |
| `scenarios/SPEC.md` | core | Gherkin grammar, compiled-trace format, runner semantics |
| `packs/expo/` | pack | RN Expo: platform policies ✅, runners ✅, adapters/skills (Phase 2) |
| `agents/` | core | The nine agent definitions with model tiers (installed into consuming repos' `.claude/agents/`) |
| `init/` | core | `agentflow-init labels` (18-label set) · `agentflow-init project` (config, domains, business pack, agents, e2e dirs) |
| `actions/` | core | Composite Actions: `gate-check` · `risk-verdict` · `dispatch` (thin YAML over `scripts/actions/*.js`) |

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

- [x] Agent definitions: product-shaper · architect · project-genesis (opus) ·
      implementer · code-reviewer · ux-reviewer · build-sentinel ·
      qa-explorer · trace-deriver (sonnet) · triage (haiku)
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
- [ ] Brief sweep in practice + headless agent execution (Phase 3, with
      GitHub App identity)

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
