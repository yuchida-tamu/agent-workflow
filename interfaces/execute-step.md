# `execute-step` — replay one compiled step trace deterministically

The deterministic half of the E2E model (see `../scenarios/SPEC.md`). No model
is in the loop: the adapter mechanically executes the trace's actions and
assertions against the driver.

```json
{ "op": "execute", "session_id": "sess-abc123",
  "step": { "keyword": "when", "text": "the user taps \"Checkout\"" },
  "trace": {
    "actions": [
      { "kind": "wait", "until": { "selector": { "test_id": "checkout-cta" } }, "timeout_ms": 5000 },
      { "kind": "tap", "selector": { "test_id": "checkout-cta" } }
    ],
    "assertions": [
      { "kind": "visible", "selector": { "test_id": "order-summary" }, "timeout_ms": 5000 }
    ]
  },
  "evidence_dir": "..." }
```

→ `0` with:

```json
{ "status": "passed", "duration_ms": 1240,
  "evidence": ["evidence/0009.png"] }
```

On failure → still exit `0` (the *adapter* worked; the *step* failed):

```json
{ "status": "failed",
  "failure": { "phase": "action|assertion", "index": 1,
               "reason": "selector test_id=checkout-cta not found within 5000ms",
               "screenshot": "evidence/0010.png", "log_tail": ["..."] },
  "evidence": ["evidence/0010.png"] }
```

Exit `10`/`20` are reserved for adapter/driver problems (simulator died),
which the runner treats as infrastructure — not as a scenario verdict.

Selector resolution order is fixed: `test_id` → accessibility label →
visible text (see `verify.md`). Assertion kinds: `visible` · `not_visible` ·
`text` (`{selector, equals|contains}`) · `log_contains`.
