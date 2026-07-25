# `verify` — drive the running app and capture evidence

Used by *agents* (Implementer self-verify, UX Reviewer, trace derivation), one
primitive per invocation. Every invocation may add files to the evidence
bundle.

## snapshot — observe UI state

```json
{ "op": "snapshot", "session_id": "sess-abc123", "evidence_dir": "..." }
```

→ `{ "screenshot": "evidence/0007.png", "elements": [
      { "ref": "e12", "role": "button", "label": "Checkout",
        "test_id": "checkout-cta", "text": "Checkout", "bounds": [x,y,w,h] } ] }`

`elements` is the accessibility/UI tree flattened to actionable nodes. `ref`
values are valid until the next `act`.

## act — perform one action

```json
{ "op": "act", "session_id": "sess-abc123",
  "action": { "kind": "tap", "ref": "e12" }, "evidence_dir": "..." }
```

Action kinds: `tap` · `type` (`{kind, ref, text}`) · `scroll`
(`{kind, direction, ref?}`) · `navigate` (`{kind, url}`) · `wait`
(`{kind, until: {selector}, timeout_ms}`) · `press` (`{kind, key}`).

→ `{ "ok": true, "screenshot": "evidence/0008.png" }` — a post-action
screenshot is always captured.

## read — pull logs

```json
{ "op": "read", "session_id": "sess-abc123", "source": "app|device", "tail": 200 }
```

→ `{ "lines": ["..."] }`

## Selector contract

Where an action targets an element by selector instead of `ref`
(`{ "selector": { "test_id": "checkout-cta" } }`), resolution order is fixed
and pack-independent: **`test_id` → accessibility label → visible text**.
This order is the determinism guarantee compiled traces rely on.
