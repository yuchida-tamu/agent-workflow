# pack-expo — React Native Expo platform pack

Implements the four core capability interfaces (see `../../interfaces/`) for
RN Expo apps, and contributes platform policy rules and runner requirements.

| Piece | Status | Contents |
|---|---|---|
| `policies/expo.yaml` | ✅ | Platform hard triggers (native surface, SDK bumps, native deps) + navigation scoring |
| `runners.yml` | ✅ | Declares the self-hosted macOS simulator runner |
| `adapters/run` | ✅ `start`/`stop` confirmed live (2026-07-28, #156/#158/#162 all fixed) | Expo dev server + iOS simulator boot → `session_id` (#133) |
| `adapters/verify` | ✅ `snapshot`/`act`/`read` all confirmed live (2026-07-28) | agent-device primitives (`snapshot` / `act` / `read`) → evidence bundle (#134) |
| `adapters/execute-step` | ✅ actions + `visible` assertions confirmed live; ⚠️ [#164](https://github.com/yuchida-tamu/agent-workflow/issues/164) — `text` assertions always read empty | Deterministic replay of one compiled step trace via agent-device (#135) |
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

Latest live run: **2026-07-28** (three rounds), against a self-provisioned
vanilla Expo app + `expo-dev-client` on real booted iOS simulators, Xcode
26.2. Each round retired exactly the bugs the previous one surfaced:

**Round 1** found and filed `spawnBackground` (`lib/proc.js`) racing an
unopened `createWriteStream()` against `child_process.spawn`'s stdio
validation — no real `run start` could ever reach `"running"`
([#156](https://github.com/yuchida-tamu/agent-workflow/issues/156), P0) —
and `decideStartPath` never matching agent-device's `"Name (bundle.id)"`
app-list format, so the reuse fast-path never fired
([#158](https://github.com/yuchida-tamu/agent-workflow/issues/158), P1).
Both fixed in #161, **re-verified live**: `start` now reaches `"running"`
via reuse in ~7 seconds, `stop` tears down cleanly.

**Round 2** found `run.js` opening the dev client via the generic Expo Go
scheme (`exp://host:port`), which either hit an unclearable OS
disambiguation dialog (Expo Go also on the simulator — the common case) or
failed outright otherwise — the app rendered correctly underneath
(screenshot-confirmed) but was unreachable by `verify`/`execute-step`.
Filed as [#162](https://github.com/yuchida-tamu/agent-workflow/issues/162),
P0; fixed in #163 (the bundle-scoped `expo-development-client` deep link,
byte-matched to `@expo/cli`'s own format) plus this pack's own acceptance
provisioner adding a `scheme` to its scaffold's `app.json` and installing
`expo-dev-client` (the native listener for that deep link — without it the
scheme fix alone still can't connect). **Re-verified live: the entire
`verify` stage now passes reliably** — `snapshot` finds every injected
testID on the first try, `act` and `read` both pass.

**Round 3** found the one remaining gap: `execute-step`'s `text` assertion
always reads back an empty string, regardless of the real on-screen value —
confirmed via a screenshot taken at the exact failure moment showing the
correct text on screen while the assertion reported empty. Root cause:
`assertText` never unwraps agent-device's `{success, data}` envelope (same
defect class as #156/#158, different function — `verify.js` already does
this correctly). Filed as
[#164](https://github.com/yuchida-tamu/agent-workflow/issues/164), P0 — not
fixed here, outside this pack's own declared surface.

Net as of this PR: `start`, `stop`, and all of `verify` (`snapshot`/`act`/
`read`) are live-proven end to end. `execute-step`'s actions and
`visible`/`not_visible` assertions are live-proven; its `text` assertion is
not, blocked by #164. See the PR for #136 for the full transcripts and
evidence bundles from all three rounds. The acceptance script itself is
complete and will exercise the full chain, including the `text` assertion,
unmodified once #164 lands.
