# Capability interfaces — the core ↔ pack contract

A platform pack implements each interface as an **executable** in its
`adapters/` directory: JSON on stdin, JSON on stdout, diagnostics on stderr.

Shared contract for all four:

- **Exit codes:** `0` success · `10` recoverable failure (core's bounded-retry
  scripts may re-invoke) · `20` fatal (escalate, do not retry).
- **Version handshake:** every adapter answers `{"op": "describe"}` with
  `{"interface": "<name>", "interface_version": "1"}`. Core refuses a pack
  whose version it doesn't support.
- **Evidence bundle:** any evidence produced is written to the directory given
  in `evidence_dir`, with a `manifest.json` listing
  `[{type: screenshot|log|video, path, label, step_ref?}]`. The bundle format
  is core-owned; consumers (PR comments, triage, UX review) never care which
  pack produced it.

| Interface | One line | Spec |
|---|---|---|
| `run` | Launch the app in an observable environment | [run.md](run.md) |
| `verify` | Drive the running app and capture evidence | [verify.md](verify.md) |
| `execute-step` | Replay one compiled step trace deterministically | [execute-step.md](execute-step.md) |
| `ship` | Build, distribute, submit | [ship.md](ship.md) |
