# pack-expo — React Native Expo platform pack

Implements the four core capability interfaces (see `../../interfaces/`) for
RN Expo apps, and contributes platform policy rules and runner requirements.

| Piece | Status | Contents |
|---|---|---|
| `policies/expo.yaml` | ✅ | Platform hard triggers (native surface, SDK bumps, native deps) + navigation scoring |
| `runners.yml` | ✅ | Declares the self-hosted macOS simulator runner |
| `adapters/run` | ✅ merged, unit-tested; ⚠️ [#156](https://github.com/yuchida-tamu/agent-workflow/issues/156) blocks a live `"running"` session | Expo dev server + iOS simulator boot → `session_id` (#133) |
| `adapters/verify` | ✅ merged, unit-tested; live-blocked by #156 (no session to drive) | agent-device primitives (`snapshot` / `act` / `read`) → evidence bundle (#134) |
| `adapters/execute-step` | ✅ merged, unit-tested; live-blocked by #156 (no session to drive) | Deterministic replay of one compiled step trace via agent-device (#135) |
| `adapters/ship` | ⬜ Phase 2, spec-only | EAS build / submit, TestFlight distribution — deferred, see #137 |
| `skills/expo-dev.md` | ✅ | Running an Expo app via the `run` adapter: dev-client reality, Metro lifecycle, real failure modes |
| `skills/mobile-verify.md` | ✅ | Recipes for driving `verify`/`execute-step` from an agent: exact adapter invocations |
| `scripts/acceptance.sh` | ✅ | Live end-to-end acceptance — **local only**, not cloud CI (see below) |

## Live acceptance

`scripts/acceptance.sh` drives the real `run` → `verify` → `execute-step` →
`stop` chain against a real booted iOS simulator, via a self-provisioned
vanilla Expo app (or `AGENTFLOW_ACCEPTANCE_APP`, pointed at an existing one).
It is a **local-only step** — run it on a macOS machine with a booted
simulator and Xcode command line tools, never in cloud CI (`runners.yml`
already declares the `simulator` self-hosted runner class for exactly this
reason; CI runs the simulator-free unit tests under `adapters/test/`).

```sh
packs/expo/scripts/acceptance.sh
```

Latest live run: **2026-07-28**, against a self-provisioned vanilla Expo
app on a real booted iOS simulator (iPhone 15 Pro, Xcode 26.2). Result:
`describe` × 3 passed, the dev-client build itself succeeded (after two
one-line, documented workarounds for an unrelated upstream `expo-modules-jsi`
/ Swift 6.2.3 compile issue — see `scripts/acceptance.js`'s
`patchKnownCompilerIssues`), but `start` could not reach a `"running"`
session: a **confirmed, deterministic adapter bug** in `lib/proc.js`'s
`spawnBackground` (filed as
[#156](https://github.com/yuchida-tamu/agent-workflow/issues/156), P0) means
no real `run start` can currently succeed, on any app or machine. `run.js`
itself behaved correctly — it caught the failure and reported a
contract-conformant `recoverable(10)`, which is why this is a bug in the
underlying capability, not a violation of the JSON contract — so
`verify`/`execute-step`/`stop` could not be exercised against a live session
as a result (their own fatal "unknown session_id" paths were separately
confirmed live and correct). A second bug ([#158](https://github.com/yuchida-tamu/agent-workflow/issues/158),
P1) means the "reuse" fast-start path never fires either, once #156 is fixed.
See the PR for #136 for the full transcript and evidence bundle. The
acceptance script itself is complete and will exercise the full chain
unmodified once #156 lands.
