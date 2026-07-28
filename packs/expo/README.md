# pack-expo — React Native Expo platform pack

Implements the four core capability interfaces (see `../../interfaces/`) for
RN Expo apps, and contributes platform policy rules and runner requirements.

| Piece | Status | Contents |
|---|---|---|
| `policies/expo.yaml` | ✅ | Platform hard triggers (native surface, SDK bumps, native deps) + navigation scoring |
| `runners.yml` | ✅ | Declares the self-hosted macOS simulator runner |
| `adapters/run` | ✅ `start`/`stop` confirmed live (2026-07-28, #156/#158 fixed); ⚠️ [#162](https://github.com/yuchida-tamu/agent-workflow/issues/162) — the opened app is often not interactable | Expo dev server + iOS simulator boot → `session_id` (#133) |
| `adapters/verify` | ✅ merged, unit-tested; live-blocked by #162 (app not interactable once opened) | agent-device primitives (`snapshot` / `act` / `read`) → evidence bundle (#134) |
| `adapters/execute-step` | ✅ merged, unit-tested; live-blocked by #162 (app not interactable once opened) | Deterministic replay of one compiled step trace via agent-device (#135) |
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

Latest live run: **2026-07-28** (two passes), against a self-provisioned
vanilla Expo app on real booted iOS simulators, Xcode 26.2.

**Pass 1** found two adapter bugs and filed them: `spawnBackground`
(`lib/proc.js`) raced an unopened `createWriteStream()` against
`child_process.spawn`'s stdio validation, so no real `run start` could ever
reach `"running"` ([#156](https://github.com/yuchida-tamu/agent-workflow/issues/156),
P0); and `decideStartPath` never matched agent-device's `"Name (bundle.id)"`
app-list format, so the reuse fast-path never fired
([#158](https://github.com/yuchida-tamu/agent-workflow/issues/158), P1).
Both landed the same day (#161).

**Pass 2** (after rebasing onto that fix) re-verified #156/#158 live:
`start` now reaches `"running"` via the reuse path in ~7 seconds (no
rebuild), and `stop` tears it down cleanly — confirmed, not assumed. It
also found a third bug: `run.js` opens the dev client via the generic Expo
Go scheme (`exp://host:port`), which either triggers an OS-level "Open
in…" disambiguation dialog that nothing can clear (when Expo Go is also on
the simulator — the common case) or fails outright (when it isn't). The app
renders correctly underneath (screenshot-confirmed) but is unreachable by
`verify:act`/`execute-step`. Filed as
[#162](https://github.com/yuchida-tamu/agent-workflow/issues/162), P0.

Net: `start`/`stop` are live-proven; `verify`/`execute-step`'s happy path
is not yet, blocked by #162. See the PR for #136 for both full transcripts
and evidence bundles. The acceptance script itself is complete and will
exercise the full chain unmodified once #162 lands.
