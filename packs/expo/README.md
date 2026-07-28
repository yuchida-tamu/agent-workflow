# pack-expo — React Native Expo platform pack

Implements the four core capability interfaces (see `../../interfaces/`) for
RN Expo apps, and contributes platform policy rules and runner requirements.

| Piece | Status | Contents |
|---|---|---|
| `policies/expo.yaml` | ✅ | Platform hard triggers (native surface, SDK bumps, native deps) + navigation scoring |
| `runners.yml` | ✅ | Declares the self-hosted macOS simulator runner |
| `adapters/run` | ✅ live-proven end to end (2026-07-29) | Expo dev server + iOS simulator boot → `session_id` (#133) |
| `adapters/verify` | ✅ live-proven end to end (2026-07-29) | agent-device primitives (`snapshot` / `act` / `read`) → evidence bundle (#134) |
| `adapters/execute-step` | ✅ live-proven end to end (2026-07-29) | Deterministic replay of one compiled step trace via agent-device (#135) |
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

### Result: PASS — 2026-07-29

```
describe(run) describe(verify) describe(execute-step)  ✅ ✅ ✅
provision  (self-provisioned vanilla Expo app + expo-dev-client)  ✅
start      (reuse path, "running" in ~6s)                        ✅
verify     (snapshot finds every testID · act · read)             ✅
execute-step (2 actions · visible assertion · text assertion)     ✅
stop       (clean teardown)                                       ✅

exit 0 · contract_violations=0 · assertion_misses=0
```

Every stage of the real `run` → `verify` → `execute-step` → `stop` chain
now passes against a real booted iOS simulator (Xcode 26.2), including the
`text` assertion that was the very last thing blocking a full pass. This
took **four rounds** of live investigation to get here, each retiring
exactly the bug the previous round's real run surfaced:

- **#156** (P0) — `spawnBackground` (`lib/proc.js`) raced an unopened
  `createWriteStream()` against `child_process.spawn`'s stdio validation, so
  no real `run start` could ever reach `"running"`. Fixed in #161.
- **#158** (P1) — `decideStartPath` never matched agent-device's `"Name
  (bundle.id)"` app-list format, so the reuse fast-path never fired. Fixed
  in #161.
- **#162** (P0) — `run.js` opened the dev client via the generic Expo Go
  scheme (`exp://host:port`), which either hit an unclearable OS
  disambiguation dialog (Expo Go also on the simulator — the common case)
  or failed outright otherwise. Fixed in #163 (the bundle-scoped
  `expo-development-client` deep link, byte-matched to `@expo/cli`'s own
  format) plus this pack's own acceptance provisioner adding a `scheme` to
  its scaffold's `app.json` and installing `expo-dev-client` (the native
  listener for that deep link — without it the scheme fix alone still
  can't connect).
- **#164** (P0) — `execute-step`'s `text` assertion always read back an
  empty string regardless of the real on-screen value (`assertText` never
  unwrapped agent-device's `{success, data}` envelope). Fixed in #165,
  which closed the whole defect family structurally: `invoke()` itself now
  unwraps at the one chokepoint every adapter call goes through, with a
  regression test pinned to this investigation's own `"Tapped: 2"` payload.

[#156](https://github.com/yuchida-tamu/agent-workflow/issues/156) ·
[#158](https://github.com/yuchida-tamu/agent-workflow/issues/158) ·
[#162](https://github.com/yuchida-tamu/agent-workflow/issues/162) ·
[#164](https://github.com/yuchida-tamu/agent-workflow/issues/164) — all
closed, all **re-verified live**, not just merged. See the PR for #136 for
the full transcripts and evidence bundles from every round.
