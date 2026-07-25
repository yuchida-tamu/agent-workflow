# `ship` — build, distribute, submit

Operations: `build` · `distribute` · `submit`. Only ever invoked by core's
integration and release scripts — `submit` only after the G4 environment
approval has already unblocked the workflow.

```json
{ "op": "build", "workspace": "...", "profile": "dev-client|preview|production",
  "version": { "app": "1.4.0", "build": 87 } }
```

→ `{ "status": "ok", "artifact": { "kind": "ipa|apk|dev-client", "url": "..." } }`

```json
{ "op": "distribute", "artifact": { "url": "..." }, "channel": "internal" }
```

→ `{ "status": "ok", "channel_url": "https://..." }`

```json
{ "op": "submit", "artifact": { "url": "..." }, "store": "app-store|play" }
```

→ `{ "status": "ok", "submission_id": "..." }`

Long-running operations report progress on stderr (one JSON line per state
change); core treats stdout as the single final result. rn-expo implements all
three over EAS.
