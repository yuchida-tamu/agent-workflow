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
| `agents/` `actions/` `init/` | core | Phase 2: agent definitions, composite Actions, installer |

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

Phase 2 (walk): pack-expo adapters + skills, trace derivation agent, agent
definitions, composite GitHub Actions, gate wiring on issue comments,
installer. Then the loop runs itself.

```sh
npm install
npm test                                             # engine + machine tests
node scripts/policy/cli.js test policies/baseline.yaml packs/expo/policies/expo.yaml
node scripts/policy/cli.js evaluate --facts facts.json policies/baseline.yaml packs/expo/policies/expo.yaml
node scripts/state/cli.js plan --labels "state:in-review" --to merged
```
