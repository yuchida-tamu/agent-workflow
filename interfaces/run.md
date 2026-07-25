# `run` — launch the app in an observable environment

Operations: `start` · `stop` · `status`.

## start

```json
{ "op": "start", "workspace": "/path/to/checkout", "profile": "dev",
  "target": "iPhone 16", "env": {"API_URL": "http://localhost:3000"},
  "evidence_dir": "/path/to/evidence" }
```

→ `0` with:

```json
{ "session_id": "sess-abc123", "entry_point": "exp://127.0.0.1:8081",
  "log_stream": "/path/to/evidence/app.log" }
```

`session_id` is the handle `verify` and `execute-step` consume. `profile` is
pack-defined (rn-expo: `dev` = dev client + Metro; `release` = release build).

## stop / status

```json
{ "op": "stop", "session_id": "sess-abc123" }
{ "op": "status", "session_id": "sess-abc123" }
```

`status` → `{ "session_id": "...", "state": "running|stopped|crashed" }`.
A crashed session is a recoverable failure (`10`) from `start`'s perspective:
core may retry once with a clean workspace before escalating.
