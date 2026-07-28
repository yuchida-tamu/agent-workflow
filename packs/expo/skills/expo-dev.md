# expo-dev — running an Expo app in this loop's world

How the `run` adapter (`packs/expo/adapters/run.js`) boots and manages an
Expo app, and what to know before you invoke it. This is not general Expo
documentation — it's what's true *of this adapter, on this loop's shared
machines*, learned from #132's capability probe and the live run for #136.

## Workspace-local expo only

`assertWorkspace` (`packs/expo/adapters/lib/workspace.js`) resolves the expo
binary as `<workspace>/node_modules/.bin/expo` and refuses to start if it's
missing — it never falls back to a global `expo`. This is deliberate: on the
reference machine, `which expo` resolves a `nodenv` shim, but `expo
--version` against that shim fails outright. A global/shim expo is not a
degraded option here, it's a **dead** one. If you see:

```
no workspace-local expo: /path/node_modules/.bin/expo not found — run "npm install" in /path
```

the fix is exactly that — `npm install` in the target workspace — never
"install expo globally" or "fix the nodenv shim." The adapter's own error
message already says the right thing; don't second-guess it.

## dev-client vs Expo Go — dev-client is required

Expo Go cannot load an app with custom native modules. #132's capability
probe found the genesis app pulls in several native modules (a UI kit, a
glass-effect view, symbol icons) — for that app there is **no Expo Go path,
ever**. Any consuming app with custom native modules is in the same boat.
The `dev` profile (the adapter's default and, today, only implemented
profile) means "dev-client build + Metro," not "Expo Go" — this is true
whether or not the specific app you're running happens to need native
modules, since the adapter never attempts an Expo Go launch at all.

Concretely, `run start`'s `decideStartPath` (`run.js`) checks whether a dev
client bundle is already installed on the target simulator
(`agent-device apps`):

- **installed → "reuse"**: skip straight to `expo start` (Metro) and
  `agent-device open` against the existing build. Seconds, not minutes.
- **not installed → "build"**: run `expo run:ios --device <target>
  --no-bundler` first — a real Xcode + CocoaPods build. Budget **up to 15
  minutes** for a first build on a clean simulator
  (`BUILD_TIMEOUT_MS`, overridable via
  `AGENTFLOW_EXPO_BUILD_TIMEOUT_MS`). This is not a hang; it's Xcode.
  `spawnForeground` streams each build line to stderr as it happens
  (`onOutput` → `diagnostic`), so a live invocation shows real progress
  instead of going silent for a quarter hour.

Never target a fresh/never-built simulator and expect a fast `start` — pick
a target that already has the dev client installed when speed matters, or
plan for the build.

## Metro lifecycle: the adapter owns it, not you

Both start paths converge on the same thing: `run start` spawns `expo
start --port <port>` as **its own managed background process**
(`spawnBackground`, detached, output redirected to a log file) and treats
that as the session's bundler for as long as the session lives. You never
spawn Metro yourself, and you never `expo start` in a terminal and then
point the adapter at it — there's no attach-to-existing-Metro path.

- **Readiness** is polled against Metro's real `/status` HTTP endpoint
  (`waitForMetroReady`), not a log-line grep — a boot banner can print
  before Metro can actually serve a bundle. Default timeout 30s
  (`AGENTFLOW_EXPO_METRO_TIMEOUT_MS`).
- **State** lives in a session record (`lib/session.js`), one JSON file per
  `session_id` under `AGENTFLOW_EXPO_STATE_DIR` (default: a fixed path under
  the OS tmp dir, `agentflow-expo/sessions/`). Every op (`start`/`stop`/
  `status`, and `verify`/`execute-step` reading the same record) is a fresh
  `node run.js` process — nothing survives in memory between invocations,
  so the state file **is** the session.
- **Identity-checked liveness.** The record stores Metro's pid *and* a
  `ps`-captured identity snapshot (start time + full command line), not
  just a bare pid. `status`/`stop`/`execute-step`'s pre-flight check all
  reconfirm the identity still matches before treating a pid as "ours" —
  pids get recycled by the OS, so a stale record naming a pid that now
  belongs to something else must never be signalled. A mismatch reads as
  "not alive," never as "someone else's process, kill it anyway."
- **Cleanup on a failed start.** If Metro spawns but the session never
  makes it to `saveSession` (agent-device unreachable, a slow/failed
  `open`), `start` kills the Metro process group it just spawned before
  rethrowing. Without this, the port stays held and a bounded retry
  inherits the same doomed port — a transient failure turns into a
  guaranteed one. This is why you should never see two `run start` retries
  fail identically with a fresh `EADDRINUSE` each time; if you do, a Metro
  process leaked outside the adapter's own control (killed the node
  process directly, machine slept mid-build, etc) and needs a manual
  `kill` before retrying.
- **`stop` is best-effort on the driver, authoritative on the record.** It
  tries `agent-device close` first (diagnostic-only on failure — the daemon
  may have already lost track of the session) and always kills Metro by
  identity-checked pid, then marks the session record `stopped` regardless.

## Fixed since first found (#156, #158, #162, #164 — all confirmed live, 2026-07-28/29)

Every real bug #136's live acceptance run found has landed and been
**re-verified live** (not just merged — actually re-run against a real
booted simulator, end to end):

- **#156** — `run start` couldn't reach a `"running"` session at all
  (`spawnBackground` in `lib/proc.js` raced an unopened `createWriteStream()`
  against `spawn()`'s stdio validation). Fixed in #161.
- **#158** — the `reuse` fast-start path never fired (`decideStartPath`
  compared a bare bundle id against `agent-device`'s `"DisplayName
  (bundle.id)"` app-list strings). Fixed in #161. Re-confirmed: a start
  against an already-installed dev client reaches `"running"` via reuse in
  ~6–7 seconds, no rebuild.
- **#162** — `run.js` opened the dev client via the generic Expo Go scheme
  (`exp://host:port`), which either hit an unclearable OS disambiguation
  dialog (when Expo Go was also on the simulator) or failed outright
  otherwise. Fixed in #163: `start` now builds the bundle-scoped
  `<scheme>://expo-development-client/?url=<encoded-metro-url>` deep link
  Expo's own CLI uses, reading `scheme` from the workspace's own
  `app.json`/`app.config.js` (`schemeFromConfig`).
- **#164** — `execute-step`'s `text` assertion always read back an empty
  string regardless of the real on-screen value (`assertText` read
  `res.text` off the raw, un-enveloped `invoke()` response). Fixed in #165:
  `invoke()` itself now unwraps agent-device's `{success, data}` envelope at
  the one chokepoint every adapter call goes through, closing the whole
  defect family structurally rather than patching each call site — with a
  regression test pinned to this investigation's own `"Tapped: 2"` payload.

**Live-reconfirmed full chain, 2026-07-29:** `describe` → `start` (reuse,
~6s) → `verify` (`snapshot` finds every `acceptance-*` testID, `act`,
`read`) → `execute-step` (2 actions, a `visible` assertion, and — the one
that used to fail — a `text` assertion, all passing) → `stop`. Every stage
green, zero contract violations. See `packs/expo/README.md`'s "Live
acceptance" section for the full transcript.

If you hit any of these four symptoms again on a current checkout, it's a
regression, not a known gap — file fresh.

## Common failure modes (real, hit during this milestone)

- **Port 8081 already held.** Metro's default port is a *host* resource —
  it's shared across every simulator and every concurrent adapter
  invocation on the same machine, not scoped per-session. On a shared
  machine (several agents, several simulators booted at once) a stale or
  concurrent `expo start` can already be holding 8081 when you call `run
  start`. `waitForMetroReady` watches the log for `EADDRINUSE` and fails
  fast with a clear `recoverable(10)` — "Metro port already in use" —
  rather than waiting out the full readiness timeout. The fix is not to
  kill an unidentified process on 8081: pass a different port, either
  `env.EXPO_METRO_PORT` in the `start` request or the
  `AGENTFLOW_EXPO_METRO_PORT` env var. On a shared machine running several
  agents' sessions concurrently — real during this milestone's own
  development, with more than one Expo app under active work on the same
  box at once — never assume the default port is free, and never kill an
  unidentified process holding it: it may well belong to someone else's
  live session. Pick a different port instead.
- **Stale/ambiguous simulator target.** Simulator names are not unique
  across Xcode runtimes — `xcrun simctl list devices` on a machine with
  several iOS SDKs installed shows multiple "iPhone 15"s, one per runtime,
  and only one may be booted. `resolveTarget` defaults to the bare name
  `"iPhone 15"` (`AGENTFLOW_EXPO_TARGET` overrides it); if another session
  already has *a* same-named simulator booted and busy, prefer overriding
  the target to a device that's actually free rather than assuming the
  default resolves to the one you want.
- **Dead nodenv shims.** Covered above under "workspace-local expo only" —
  worth repeating because it's the failure mode most likely to look like a
  weird missing-command error rather than an obvious "no expo" message:
  `xcrun --find simctl` (`assertXcode`) and the workspace-local expo check
  both fail fast and fatal (20, not retryable) rather than silently trying
  a global fallback that doesn't work.
- **First-build timeout on a slow/loaded machine.** `expo run:ios` genuinely
  takes minutes on a clean simulator; a heavily loaded shared machine (many
  concurrent booted simulators, concurrent builds) can push past the
  default 15-minute budget. `AGENTFLOW_EXPO_BUILD_TIMEOUT_MS` exists for
  exactly this — raise it rather than assuming a timeout means the build is
  broken.

## Starting and stopping a session

Every adapter speaks the same contract: one JSON object on stdin, one JSON
object on stdout, exit `0`/`10`/`20` (`packs/expo/adapters/lib/contract.js`).
See `mobile-verify.md` for the full request/response shapes and exact
invocations; the shape of `start`/`stop`/`status` is documented in
`interfaces/run.md`.
