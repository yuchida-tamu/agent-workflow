# Behavioral E2E — scenario grammar, compiled traces, runner semantics

The model: **compile once, replay forever.** Humans (and the Product Shaper's
acceptance criteria) write behavioral Gherkin. An agent interprets each step
once and emits a compiled trace. The runner replays traces deterministically —
no model in the loop — and escalates exactly one rung when replay breaks.

## Scenario files (`e2e/scenarios/*.feature`)

Gherkin subset: `Feature`, `Scenario`, `Given/When/Then/And`, tags.

```gherkin
@checkout @smoke
Feature: Checkout

  Scenario: Buyer completes a purchase
    Given a signed-in user with an item in the cart
    When the user taps "Checkout"
    And the user confirms payment
    Then the order confirmation screen is shown
```

Tags are load-bearing:

- `@<domain>` binds the scenario to `domains.yml` — this is how the policy
  obligation `run: [domain-scenarios]` resolves to concrete scenarios.
- `@smoke` marks the post-merge subset; everything runs nightly.

## Compiled traces (`e2e/traces/<feature>/<scenario>.trace.json`)

One trace file per scenario; per step, the primitive actions + assertions in
the `execute-step` format (see `../interfaces/execute-step.md`):

```json
{
  "scenario": "Buyer completes a purchase",
  "feature": "Checkout",
  "derived_by": { "model": "sonnet", "at": "2026-07-26T…", "app_commit": "abc123" },
  "steps": [
    { "keyword": "when", "text": "the user taps \"Checkout\"",
      "trace": { "actions": [ … ], "assertions": [ … ] } }
  ]
}
```

Traces are **committed code**: derived and updated only via PR, so a trace
that weakens an assertion still passes a human at G3, and the baseline policy
pack blocks auto-merge on `e2e/traces/**`. Selector resolution order inside
traces is fixed (`test_id` → a11y label → text); the conventions skill
requires agents to add `testID`s to interactive elements they create.

## Runner semantics

For each selected scenario (by tag set), the runner:

1. `run start` → session.
2. Per step: valid trace present → `execute-step` (L0 replay).
3. Missing/failed trace → **derive**: an agent re-interprets the step via
   `verify` primitives (L2, logged escalation).
   - Agent succeeds → UI changed, behavior holds: emit updated trace as a PR;
     step counts as `passed (trace-updated)`.
   - Agent fails → behavior broke: step is `failed`; evidence bundle attached;
     failure flows to triage → structured issue → intake.
4. Results per run (`results.json`): one entry per scenario —
   `{ scenario, feature, tags, status: passed|failed|trace-updated,
      steps: [{text, status, duration_ms, evidence}], evidence_dir }`.
   This is the exact input the failure-triage micro-agent clusters.

A trace is *valid* for replay when its `app_commit` ancestor chain contains no
merge that touched the scenario's domain paths — cheap to compute from git,
and it keeps stale traces from producing false passes.

## Economics invariant

Tokens are spent only on: (a) new scenarios, (b) steps whose replay failed.
A nightly run of an unchanged app costs zero tokens. If a change to this spec
would break that invariant, it's the wrong change.
