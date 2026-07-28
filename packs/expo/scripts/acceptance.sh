#!/usr/bin/env bash
# packs/expo/scripts/acceptance.sh — live end-to-end acceptance for the
# pack-expo adapters (#136). Thin entrypoint: real logic lives in
# acceptance.js (Node ESM, this repo's only runtime dependency) so the
# adapter contract can be checked structurally (JSON shapes, exit codes)
# instead of shell string-matching.
#
# LOCAL ONLY — never run in cloud CI. This drives a real iOS simulator via
# the `agent-device` CLI (packs/expo/runners.yml declares the `simulator`
# self-hosted runner class for exactly this; CI gets the simulator-free unit
# tests under packs/expo/adapters/test/).
#
# Usage:
#   packs/expo/scripts/acceptance.sh
#
# Env (all optional):
#   AGENTFLOW_ACCEPTANCE_APP           Use this existing Expo app instead of
#                                       self-provisioning one. Must already
#                                       render the acceptance-* testIDs this
#                                       script's trace targets (see
#                                       acceptance.js's injectScreen for the
#                                       exact shape) or the execute-step stage
#                                       will fail on a real selector miss.
#   AGENTFLOW_ACCEPTANCE_APP_CACHE     Where to scaffold/reuse the
#                                       self-provisioned app across runs.
#                                       Default: an OS-tmp-dir path that
#                                       persists between invocations, so a
#                                       repeat run skips the ~15s scaffold +
#                                       npm install and goes straight to the
#                                       (still real) dev-client build.
#   AGENTFLOW_ACCEPTANCE_TARGET        Simulator name. Default "iPhone 15".
#   AGENTFLOW_ACCEPTANCE_METRO_PORT    Metro port. Default 8081 — override on
#                                       a shared machine where the default is
#                                       already held by an unrelated session
#                                       (see skills/expo-dev.md).
#   AGENTFLOW_ACCEPTANCE_EVIDENCE_DIR  Where the evidence bundle + results.json
#                                       land. Default: a fresh timestamped dir
#                                       under the OS tmp dir.
#
# Exit codes: 0 = every stage passed and no contract was violated.
#             1 = a contract violation (adapter response didn't match its
#                 documented shape/exit code) — an adapter bug, not a scenario
#                 failure. File it; don't paper over it here.
#             2 = every adapter behaved correctly (contract-conformant), but
#                 the run didn't fully complete — either a trace step's own
#                 verdict was "failed" (an app-level failure, not the
#                 adapter's), or `start`/`execute-step` correctly reported a
#                 recoverable(10)/fatal(20) failure per their own documented
#                 contract (a real build/environment problem, not a bug in
#                 the adapter that reported it).
#             3 = environment unavailable (no network for scaffolding, no
#                 Xcode, no simulator) — printed as a clear skip, not a
#                 failure of the adapters under test.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/acceptance.js" "$@"
