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
- [ ] Gate validator (authorized `/approve` comments → `--approved-gate`)
- [ ] Fact extractors (diff → `diff.*` facts; domains.yml → `domains.*`)
- [ ] E2E runner core (feature parser, trace validity check, replay loop)
- [ ] `/next` local dispatch command

```sh
npm install
npm test                                             # engine + machine tests
node scripts/policy/cli.js test policies/baseline.yaml packs/expo/policies/expo.yaml
node scripts/policy/cli.js evaluate --facts facts.json policies/baseline.yaml packs/expo/policies/expo.yaml
node scripts/state/cli.js plan --labels "state:in-review" --to merged
```
