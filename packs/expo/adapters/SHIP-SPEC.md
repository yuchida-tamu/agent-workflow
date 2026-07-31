# `ship` adapter — specification (implementation deferred)

Status: **spec only, no executable adapter**. Per the #132 brief, `ship` is
deferred until a real release target (Apple/EAS account, bundle id,
distribution channel) exists for the genesis app — none of that exists today.
This document is what a future implementer builds against instead of
re-deriving the design from scratch. It maps `interfaces/ship.md`'s three ops
onto the real EAS CLI, grounded in a live probe of `eas-cli@16.10.1` on this
machine (2026-07-31) — every command/flag/error string quoted below was run,
not guessed, except where explicitly marked "documented, not reproduced live"
in section 3.

Reuses the same shared scaffolding `run`/`verify`/`execute-step` already
built in `adapters/lib/` (#133–#135): `contract.js` (stdin/stdout/exit-code
contract), `session.js` (atomic state-file persistence), `evidence.js`
(manifest bundle), `proc.js` (injectable process runner). `ship` adds no new
library beyond what's described in §6/§7 — everything it needs already
exists.

## Contents

1. [Ops recap](#1-ops-recap-from-interfacesshipmd)
2. [EAS CLI ground truth (live-probed)](#2-eas-cli-ground-truth-live-probed-2026-07-31)
3. [Op mapping: build / distribute / submit](#3-op-mapping-build--distribute--submit)
4. [Credentials & prerequisite contract](#4-credentials--prerequisite-contract-fail-closed)
5. [Long-run handling](#5-long-run-handling-15-40-minute-cloud-jobs)
6. [Evidence](#6-evidence-build-urlsartifacts-into-the-manifest)
7. [State-file reuse](#7-state-file-reuse-lib session js)
8. [Out of scope for v1](#8-out-of-scope-for-v1)
9. [Acceptance test shape](#9-acceptance-test-shape)
10. [Open questions flagged for core](#10-open-questions-flagged-for-core)

---

## 1. Ops recap (from `interfaces/ship.md`)

```json
{ "op": "build", "workspace": "...", "profile": "dev-client|preview|production",
  "version": { "app": "1.4.0", "build": 87 } }
→ { "status": "ok", "artifact": { "kind": "ipa|apk|dev-client", "url": "..." } }

{ "op": "distribute", "artifact": { "url": "..." }, "channel": "internal" }
→ { "status": "ok", "channel_url": "https://..." }

{ "op": "submit", "artifact": { "url": "..." }, "store": "app-store|play" }
→ { "status": "ok", "submission_id": "..." }
```

`submit` only runs after G4 (environment/release approval) has unblocked the
workflow — the adapter has no way to *verify* that itself (it has no access
to issue state); this is a contract restated from ship.md, enforced by core
never invoking `submit` before G4, not by anything in this adapter.

The version-handshake op every interface answers (`interfaces/README.md`) is
mandatory here too, explicitly:

```json
{ "op": "describe" }
→ { "interface": "ship", "interface_version": "1" }
```

`adapters/lib/contract.js#runMain` already answers `describe` automatically
for any adapter wired through it (see `describeResponse`, called before a
handler map is even consulted) — `ship`'s own `main()` needs no `describe`
handler, only `runMain({ interfaceName: "ship", handlers: { build,
distribute, submit } })`, the same wiring `run.js`'s own `main()` uses. Stated
explicitly here anyway, since a spec that only says "it's automatic" without
ever writing down the literal response a future implementer should expect
is exactly the kind of thing worth pinning down rather than leaving implicit.

## 2. EAS CLI ground truth (live-probed 2026-07-31)

Machine detail: the global/shim `eas` under the ambient Node version
(24.15.0, set by `.node-version`) is **not resolvable** — `nodenv` only has
`eas-cli` installed under Node 21.6.1 and 22.13.0. A future implementer must
invoke `eas` the same way this investigation did:

```sh
NODENV_VERSION=22.13.0 nodenv exec eas <args>   # eas-cli/16.10.1 darwin-arm64 node-v22.13.0
```

...or pin a workspace-local `eas-cli` devDependency and invoke `./node_modules/.bin/eas`
(the same "never trust the global/shim binary" rule `workspace.js`'s
`assertWorkspace` already enforces for `expo` itself — apply it here too).

Confirmed live facts that shape the design below:

- `eas whoami`: prints the logged-in username and exits `0` when
  authenticated; prints exactly `Not logged in` (stdout) and exits `1` when
  not. Cheap (<1s, no project required) — the adapter's pre-flight login
  check.
- `eas build --platform ios --profile production --non-interactive --json`
  run with **no** logged-in account fails with exit `1` and this exact text
  on stdout (not JSON, despite `--json` being passed):
  ```
  An Expo user account is required to proceed.
  Either log in with eas login or set the EXPO_TOKEN environment variable if you're using EAS CLI on CI (Learn more: https://docs.expo.dev/accounts/programmatic-access/)
      Error: build command failed.
  ```
  This is the **real** CI auth path: `EXPO_TOKEN` env var, no interactive
  login required. The adapter's credential contract (§4) is built around it.
- **`--json` does not guarantee JSON on stdout.** The flag's own help text
  (`build`, `build:list`, `build:view`, `config` all carry it verbatim) says
  *"Enable JSON output, non-JSON messages will be printed to stderr"* — that
  promise holds for the **success** path. On a pre-flight failure (not
  logged in, no project dir, no git repo, no EAS project id — all
  reproduced live, see below) the CLI still prints plain human text to
  stdout and exits non-zero; there is no JSON error envelope. The adapter
  must never assume `stdout` is JSON just because `--json` was passed.

  Precisely what `run.js#readExpoConfig` does on failure, so the comparison
  to it is exact rather than a loose gesture: it branches on **exit code
  first, before ever calling `JSON.parse`** — a non-zero exit (or a spawn
  `error`) throws `fatal()` with message precedence `error?.message ??
  result.stderr ?? "exit ${code}"`; **`stdout` is never consulted in that
  branch**. Only on exit `0` does it attempt `JSON.parse(result.stdout)`,
  and a parse failure there throws `fatal()` quoting the parser's own error
  message (not the offending text). Both failure paths return `fatal`
  (`20`) — `expo config --json` failing is a workspace/config problem, not
  a transient one.

  Ship's parser must copy the **structure** of that (branch on exit code
  before ever attempting `JSON.parse` — never try/catch-parse text you
  already know isn't JSON because the process failed) but **cannot copy the
  message precedence verbatim**, because eas and expo disagree on which
  stream carries the useful text: every failure string captured live in
  this section ("An Expo user account is required...", "Run this command
  inside a project directory.", "EAS project not configured...") came back
  on **stdout**, not stderr, even with `--json` set. Applying
  `readExpoConfig`'s exact order (`error?.message ?? stderr ?? "exit
  ${code}"`) against `eas` would silently discard that text — `stderr` is
  typically empty for these failures — and surface a bare `"exit 1"`
  instead. Ship's parser precedence should instead be `error?.message ??
  result.stdout ?? result.stderr ?? "exit ${code}"`: stdout ahead of
  stderr, matching where `eas` actually writes its error text, confirmed
  live rather than assumed from `expo`'s convention.
- **`eas submit` has no `--json` flag at all** (confirmed against its full
  `--help` flag list: `-e/-g/-p/--id/--latest/--non-interactive/--path/--url
  /--verbose/--verbose-fastlane/--[no-]wait` — no `--json`). This is a real
  gap in the CLI surface, not an oversight in this spec — see §3's `submit`
  section for how the adapter has to work around it.
- Fail-closed ladder reproduced live, in order, each with the exact CLI
  message a future implementer should pattern-match on:
  1. No project directory (no `package.json`/`app.json`) → `Run this
     command inside a project directory.`
  2. No git repo → CLI tries to **prompt** to run `git init` even under
     `--non-interactive` (`Input is required, but stdin is not readable.
     Failed to display prompt: ...`) — i.e. this one check is **not**
     `--non-interactive`-safe in eas-cli 16.10.1. The adapter's pre-flight
     (§4) must check for `.git` itself and refuse before ever invoking
     `eas build`, rather than relying on `--non-interactive` to make this
     fail cleanly.
  3. No `eas.json` → the CLI **auto-generates** one on first run (even in
     non-interactive mode) rather than failing:
     ```json
     { "cli": { "version": ">= 16.10.1", "appVersionSource": "remote" },
       "build": {
         "development": { "developmentClient": true, "distribution": "internal" },
         "preview": { "distribution": "internal" },
         "production": { "autoIncrement": true }
       },
       "submit": { "production": {} } }
     ```
     Silent auto-generation is a footgun for an unattended adapter — see §4
     for why this spec has the adapter check for `eas.json` itself and
     refuse rather than let EAS write one on the fly.
  4. No linked EAS project id → `EAS project not configured. Must configure
     EAS project by running 'eas init' before this command can be run in
     non-interactive mode.` (this one *is* `--non-interactive`-safe: clean
     failure, no prompt).
  5. `eas build:list --non-interactive --json --limit 1` against a real,
     empty, logged-in project returns bare `[]` on stdout, exit `0` — the
     one full success-path JSON round-trip this investigation could
     reproduce without an actual Apple/Play credential.

  (Reproducing this ladder created one real, empty Expo project —
  `fakeproject` — under the investigating account on expo.dev, since `eas
  init --non-interactive --force` does not have a dry-run mode. It has no
  native SDK installed and cannot build; it is safe to delete from the
  expo.dev dashboard whenever convenient, but is otherwise inert.)

## 3. Op mapping: build / distribute / submit

### `build`

```sh
eas build \
  --platform <ios|android>            # from request.workspace's app config's
                                       # target platform, or request.platform
                                       # if ship.md's request ever carries one —
                                       # not shown in interfaces/ship.md's build
                                       # example today; see §10.
  --profile <request.profile>         # dev-client -> "development" in eas.json's
                                       # default template naming (see §2's
                                       # generated eas.json) — the profile NAME
                                       # is workspace-defined, not fixed by this
                                       # adapter; document the dev-client/preview/
                                       # production -> eas.json profile-key
                                       # mapping in the workspace's own eas.json,
                                       # the same way `run` defers scheme/bundle-id
                                       # resolution to the workspace's app config
                                       # rather than hardcoding it (see run.js's
                                       # schemeFromConfig).
  --non-interactive --json --no-wait  # see §5 for why --no-wait
  --freeze-credentials                # always — never let an unattended run
                                       # silently mutate credentials; a missing
                                       # credential is a fail-closed refusal
                                       # (§4), not something to auto-generate.
  --message "agentflow: <workspace> <version.app>+<version.build>"
```

`request.version.app`/`request.version.build` are not passed as CLI flags —
`eas.json`'s generated template already sets `"appVersionSource": "remote"`
(EAS's own autoIncrement/remote-version-source model), so version
bumping is a workspace/eas.json concern, not something this adapter
threads through per-invocation. If a future implementer needs per-call
version pinning, `app.json`'s `expo.version`/`expo.ios.buildNumber` /
`expo.android.versionCode` are the real knobs — set those in the workspace
before invoking `eas build`, don't invent a new EAS flag that doesn't exist.

On success (`--no-wait`, so this returns once the build is **queued**, not
finished), stdout is a JSON array with one object; the field the adapter
needs immediately is the build id (used for polling, §5). The full object
shape for a **finished** build (`artifacts.buildUrl` /
`artifacts.applicationArchiveUrl`, `status`, `platform`, `id`) is EAS's
documented schema — this investigation could not reach a finished build
live (no Apple/Play credentials exist for the genesis app, per the #132/#137
brief), so treat exact field names as "confirm against a live payload on
first real implementation", not as verified fact. What *is* verified live:
the CLI's overall JSON/no-JSON behavior (§2) and the `--status` enum used to
detect terminal states (§5, from `build:list --help`'s own flag
documentation).

Adapter's own response, once the poll loop (§5) reaches a terminal
`finished` state:

```json
{ "status": "ok", "artifact": { "kind": "ipa|apk|dev-client", "url": "<artifacts.applicationArchiveUrl>" } }
```

`kind` is derived from the **workspace's own eas.json profile**, not from
EAS's response — `developmentClient: true` in the resolved build profile ⇒
`"dev-client"`; else `"ipa"` for `--platform ios`, `"apk"` for
`--platform android`. See §10 for a real gap this last mapping runs into.

### `distribute`

**There is no dedicated `eas distribute` command.** Internal distribution in
EAS is a property of the *build profile* (`"distribution": "internal"` in
eas.json — present by default in the generated `development`/`preview`
profiles, see §2), not a separate step invoked after the fact. A build made
under an internal-distribution profile already carries its own
install/share link once finished.

Two real EAS "channel" concepts exist and are easy to conflate — pin this
down explicitly so a future implementer doesn't reach for the wrong one:
- `eas update --channel <name>` — OTA **JavaScript** update channels
  (`expo-updates`), for shipping JS-only changes to an already-installed
  native binary. Confirmed live via `eas update --help`. **Not** what
  ship.md's `distribute` op means.
- Native build "internal distribution" (`eas.json`'s
  `distribution: "internal"`) — an installable binary link, gated by
  registered Apple device UDIDs on iOS (`eas device:create`/`device:list`,
  confirmed live via `eas device --help`) or open on Android (no device
  registration needed for a direct APK link).

So: `distribute` for this adapter is **not a new EAS invocation** — it's a
lookup against the build the artifact URL already came from:

```sh
eas build:view <build_id> --json --non-interactive
```

(`build_id` recovered from the ship-state record persisted at `build` time,
§7 — the adapter does not need `artifact.url` re-parsed to find it, since it
already has the id.) The response maps to:

```json
{ "status": "ok", "channel_url": "https://expo.dev/accounts/<account>/projects/<project>/builds/<build_id>" }
```

Prefer the **build detail page URL** (durable, human-shareable, what EAS's
own product surfaces to testers) over the raw
`artifacts.applicationArchiveUrl` (a signed/expiring storage URL not meant
as a bookmark) as `channel_url` — this is the deliberate design choice a
future implementer should keep, not an accident of using whichever field
was easiest to read.

`channel: "internal"` is the only value this maps meaningfully today (it's
also the only value in ship.md's own example). A `channel` other than
`"internal"` (e.g. a hypothetical "beta" store track) has no EAS
equivalent short of `submit` itself — reject anything else as
`fatal(20)` rather than silently no-op.

### `submit`

```sh
eas submit \
  --platform <ios|android>            # from request.store: "app-store" -> ios,
                                       # "play" -> android
  --url <request.artifact.url>        # eas submit's --url flag takes an app
                                       # archive URL directly — confirmed live
                                       # in --help; this is the one submit flag
                                       # that lines up 1:1 with ship.md's
                                       # request shape, no --id/build lookup
                                       # needed.
  --non-interactive
```

**No `--json` flag exists on `eas submit`** (§2) — this is the one op where
the adapter cannot get a structured response back from the CLI itself.
Design for it explicitly rather than pretending `--json` will show up:

- Treat the **process exit code** as authoritative for success/failure (this
  part of the CLI contract is reliable — confirmed via `--help`'s
  documented flag surface and how every other `eas` subcommand in this
  investigation behaved: exit 0 only on real success).
- Best-effort extract `submission_id` by regex-matching a
  `https://expo.dev/.../submissions/<uuid>` (or equivalent App Store
  Connect/Play Console) URL out of stdout, since that is the only channel
  eas-cli exposes it through in this version. If the regex doesn't match,
  return `submission_id: null` and emit a `diagnostic()` line on stderr
  naming the miss — **do not** fail the op over an unmatched regex; the
  submission itself may have genuinely succeeded (exit 0) even if this
  adapter couldn't parse an id out of human-oriented text. A future
  eas-cli version may add `--json` here, at which point this whole
  regex-scrape branch should be deleted in favor of real structured output
  — flagged so nobody mistakes the regex for the intended long-term design.

```json
{ "status": "ok", "submission_id": "<regex-extracted or null>" }
```

## 4. Credentials & prerequisite contract (fail-closed)

**Cheap, local, pre-flight checks that name the exact gap and refuse before
spending any of a 15–40 minute cloud round-trip**, rather than letting a
slow remote call discover a config problem 30 minutes in — the same
motivation `run.js`'s `schemeFromConfig` has for resolving the dev-client
deep-link scheme before Metro even spawns. The **exit-code precedent**,
though, is `workspace.js#assertWorkspace` (not `schemeFromConfig` —
`schemeFromConfig` itself throws `recoverable(10)`, because a missing
`scheme` is one specific, narrowly-scoped app.json field a human can add in
seconds without touching anything else `run` already set up; it does not
generalize to "every pre-flight gap is recoverable"). `assertWorkspace` is
the right precedent here: a missing prerequisite (there, no workspace-local
`expo` binary; here, no `.git`/`eas.json`/project id/login) throws
`fatal(20)`, because none of these six checks are transient — a bounded
retry that changes nothing about the workspace or the credential state
hits the identical gap every time, exactly like `assertWorkspace`'s own
"no workspace-local expo" case. Every check below throws `fatal(20)` via
`adapters/lib/contract.js`'s existing `fatal()`; each rung's one-line
justification for why *this* gap is fatal rather than recoverable is
stated inline, since "fatal by default" is a deliberate per-rung judgment
here, not a blanket rule applied without checking each case.

Pre-flight ladder, run in this order (cheapest/most-fundamental first),
**before** invoking `eas build`/`eas submit` at all:

1. **Workspace has a `.git` directory.** EAS's own non-interactive git check
   is not prompt-safe (§2, ladder item 2) — the adapter must not rely on
   `eas` to fail this cleanly. `fatal(20)`: `"workspace <path> is not a git
   repository — EAS requires one (eas build); run 'git init'"`.
   *Fatal, not recoverable:* a missing `.git` is a static fact about the
   checkout; retrying the identical request without a human running
   `git init` in between reproduces the exact same gap every time.
2. **Workspace has `eas.json`.** Do not let EAS auto-generate one on the
   fly (§2, ladder item 3) — an unattended adapter silently accepting
   whatever default profiles EAS writes is exactly the kind of surprise
   this contract exists to prevent. `fatal(20)`: `"no eas.json in <path> —
   run 'eas build:configure' (or hand-author one) before shipping; see
   https://docs.expo.dev/build-reference/eas-json/"`.
   *Fatal, not recoverable:* same reasoning as (1) — `eas.json`'s absence
   doesn't change between retries; only a human authoring the file does.
3. **`eas.json` has a `build.<profile>` entry matching `request.profile`.**
   Read and parse `eas.json` directly (it's just JSON) rather than shelling
   out to `eas config --json` for this one check — no network round-trip
   needed. `fatal(20)`: `"eas.json has no build.<profile> profile — add one
   or pass a profile eas.json actually defines"`.
   *Fatal, not recoverable:* the named profile is deterministically absent
   from the file every retry would re-read — nothing about waiting or
   re-invoking changes what `eas.json` contains.
4. **The workspace's app config carries an EAS project id**
   (`extra.eas.projectId`, resolved via the same `expo config --json`
   pattern `run.js#readExpoConfig` already uses — reuse that function
   rather than re-deriving Expo's config merge a second time). `fatal(20)`:
   `"workspace app config has no extra.eas.projectId — run 'eas init' to
   link an EAS project"`.
   *Fatal, not recoverable:* linking a project is a one-time `eas init`
   action a human/CI step performs, not something elapsed time or a blind
   retry supplies on its own.
5. **Logged in, or `EXPO_TOKEN` set.** Run `eas whoami` (§2: <1s, no
   project needed) OR check `process.env.EXPO_TOKEN` is non-empty — either
   satisfies this. `fatal(20)`: `"not authenticated to EAS: not logged in
   (eas whoami) and EXPO_TOKEN is not set — run 'eas login' or set
   EXPO_TOKEN for CI (see https://docs.expo.dev/accounts/programmatic-access/)"`.
   This message deliberately echoes the exact real CLI text captured live
   in §2, so a human reading the adapter's own refusal recognizes it as the
   same underlying gap `eas` itself would report.
   *Fatal, not recoverable — the one rung worth double-checking explicitly,
   since a login gap could plausibly look transient:* it isn't. "Not
   authenticated" is a static credential-state fact, not a momentary
   network condition — a bounded retry with no human/CI action in between
   observes the identical `Not logged in` every time. Contrast this with a
   genuine network blip mid-poll against an *already-running* build (§5),
   which correctly stays `recoverable(10)` because retrying there really
   can succeed on its own, with nothing else changing.
6. **`submit` only: platform store credentials are configured.** Unlike
   1–5, this is **not** cheaply pre-flight-checkable — there is no
   `eas credentials list --json` in this CLI version's surface (`eas
   credentials --help` only exposes an interactive-shaped
   `credentials:configure-build` subcommand, no machine-readable listing).
   Document this as a **known gap**: the adapter cannot refuse before
   attempting `eas submit`; it must let the real invocation fail and
   pattern-match the resulting error text for known credential-missing
   phrasing (App Store Connect API key missing, provisioning profile
   missing, etc. — exact strings TBD against a live failure once real
   Apple credentials exist), reclassifying that as `fatal(20)` rather than
   the generic `recoverable(10)` a network blip would get. Do not invent
   exact error strings here without reproducing them live — that's exactly
   the kind of guess this document is trying not to make; leave the
   pattern-match table itself as a TODO for whoever implements against
   real ASC credentials, seeded from whatever `eas submit`'s actual
   stderr says on the first real attempt.
   *Fatal once detected, not recoverable:* like 1–5, a genuinely missing or
   misconfigured ASC credential doesn't heal on retry — only a human running
   `eas credentials` does. This is explicitly *not* the same bucket as an
   EAS-side network hiccup during the `submit` call itself, which is a real,
   separate failure mode that should be classified `recoverable(10)` and
   never routed through this pattern-match path at all — the two must not
   be conflated by whoever writes the pattern-match table.

`--freeze-credentials` (always passed on `build`, §3) is the enforcement
mechanism for "no silent credential mutation" between pre-flight checks
1–5 and the real invocation — if credentials genuinely need setting up,
that's a human running `eas credentials` interactively, never something
this adapter does on someone's behalf mid-build.

## 5. Long-run handling (15–40 minute cloud jobs)

`eas build` is invoked with `--no-wait` (§3) specifically so the CLI
invocation itself returns in seconds with a queued build id, rather than
blocking the whole adapter process for up to 40 minutes with no
intermediate state persisted anywhere (a crash mid-`--wait` would lose the
build id entirely — see §7 on why that id has to hit disk immediately).

Polling loop, owned by the adapter (not by `eas-cli` — `--wait`'s built-in
polling is deliberately not used, precisely so the adapter controls the
interval, the stderr diagnostics, and — critically — persistence between
polls):

```
loop, interval ~20-30s (injectable, like run.js#waitForMetroReady's own
                          interval/sleep/clock params — testable without a
                          real 20s wait):
  eas build:view <build_id> --json --non-interactive
  parse .status
  if status changed since last poll:
    diagnostic(`[ship build] <build_id>: <prev> -> <status>`, stderr)
    persist new status into the ship-state record (§7) — so a crash between
    polls resumes from the last OBSERVED status, not "unknown"
  if status in {finished}: return success, extract artifact.* (§3)
  if status in {errored, canceled}: throw recoverable(10) naming the build's
    own detail-page URL (a human/log needs the real EAS build log, this
    adapter has no access to Xcode/Gradle logs itself) — mirrors run.js's
    stance that a crashed session is recoverable(10), not fatal: core gets
    one bounded retry before escalating.
  if status in {new, in-queue, in-progress, pending-cancel}: keep polling
```

The `{new, in-queue, in-progress, pending-cancel, errored, finished,
canceled}` enum above is **not guessed** — it's `build:list --help`'s own
documented `--status` filter values, live-probed (§2), the one place this
version of eas-cli writes down its own build-status vocabulary.

**Resumability**: because the build id and last-observed status are
persisted to the ship-state file (§7) immediately after the enqueue call —
before the first poll even runs — a second invocation can pick the same
build back up rather than starting a new one. This is what makes a
30-minute EAS build survive an adapter-process restart (agent process
recycled, host rebooted) without either losing the build or accidentally
starting two.

**Resume-trigger shape (decided, not left open):** no fourth op is added to
`interfaces/ship.md`'s fixed `build`/`distribute`/`submit` vocabulary — that
would be a core-interface change this spec has no authority to make
unilaterally (contrast §10, which *does* flag two things that genuinely
need core's sign-off; this one doesn't need it, because it stays inside
`build`'s existing shape). Instead, `build`'s own request grows one
**optional** field:

```json
{ "op": "build", "workspace": "...", "profile": "preview", "build_id": "<eas build uuid from a prior enqueue>" }
```

Handler behavior, keyed on whether `request.build_id` is present:

- **Absent** (the normal case, ship.md's documented shape unchanged): run
  the full pre-flight ladder (§4) and enqueue a new build, exactly as
  described above.
- **Present**: skip the enqueue call and the pre-flight ladder's
  config-shape checks (1–4; login (5) is still worth re-checking, since it's
  as cheap the second time as the first) and go straight to loading the
  ship-state record for `ship-<build_id>` (§7) and resuming the poll loop
  from its last-observed `status`. This is the exact `loadSessionOrThrow`
  split `run.js` already uses for `stop`/`status`: `loadSession` failing
  with `ENOENT` means a genuinely unknown id — throw `fatal(20)`: `"unknown
  build_id: <id>"` (a bounded retry can't invent a build id that was never
  enqueued, so this is fatal, not recoverable, by the same argument §4
  applies throughout); any other read failure (corrupt state file) throws
  `recoverable(10)` naming the state path, since a concurrent writer
  finishing mid-read is a real possibility `run.js`'s own version of this
  split already accounts for.

The **response shape is identical either way** — `{"status":"ok",
"artifact":{...}}` once terminal, or the same `recoverable`/`fatal` throws
mid-poll (§5 above) — a caller resuming a build cannot tell, from the
response alone, whether this invocation enqueued it or picked up an
existing one. That symmetry is deliberate: `build_id` is purely a resume
hint, not a different mode with its own response contract to learn.

Progress reporting matches the shared contract's existing pattern exactly:
`diagnostic()` (already in `contract.js`, used today by `run.js` for `expo
run:ios` build output) writes one line per state *change* to stderr — not
one line per poll — so a 40-minute build sitting in `in-progress` doesn't
spam 80+ identical lines at a 30s interval.

## 6. Evidence (build URLs/artifacts into the manifest)

Every terminal op (`build` finishing, `distribute`, `submit`) appends a row
via the existing `adapters/lib/evidence.js#appendManifest` — same function
`run`/`verify`/`execute-step` already use, no new evidence machinery.

One real wrinkle worth calling out explicitly, since it's a genuine
departure from how the other three adapters use this function: every
existing manifest entry's `path` is a **local filesystem path** under
`evidence_dir` (a screenshot file, a log file) — `evidence.js`'s own header
comment describes the format as `[{type, path, label, step_ref?}]` with
`type: screenshot|log|video`. A build/submission artifact has no local
file — it lives entirely in EAS's/App Store Connect's cloud storage. This
spec's position: extend the `type` vocabulary with `"build"` (and,
separately, `"submission"`) and let `path` carry the **remote URL** for
those two types specifically, rather than inventing a new manifest field.
`appendManifest` itself does not validate `entry.type` against the
three-value enum (only requires `{type, path}` truthy) — so this is
forward-compatible with zero code changes to `evidence.js`; only its and
`interfaces/README.md`'s doc comments would eventually need a one-line
update acknowledging the extension. Flagged here rather than left
implicit, since "path" silently meaning something different for one type
is exactly the kind of thing a reviewer should be able to trace back to a
deliberate decision, not an oversight.

```js
await appendManifest(evidenceDir, {
  type: "build", path: artifactUrl, label: `eas build ${buildId} (${profile})`,
});
await appendManifest(evidenceDir, {
  type: "build", path: channelUrl, label: `eas build ${buildId} internal distribution`,
});
await appendManifest(evidenceDir, {
  type: "submission", path: submissionUrl ?? `eas submit ${store} (id unknown, see §3)`,
  label: `eas submit ${store}`,
});
```

The manifest row is supplementary evidence for PR comments/triage/UX review
(interfaces/README.md's stated consumers) — the **authoritative** return
value is still each op's own stdout response (`artifact.url` /
`channel_url` / `submission_id`, §1/§3). Do not make any caller depend on
the manifest to get the URL; it must be retrievable from the op's direct
JSON response alone, same as every other interface.

## 7. State-file reuse (`lib/session.js`)

No new state-persistence module — `adapters/lib/session.js`'s
`saveSession`/`loadSession`/`resolveStateDir` are already fully generic
(any record with a string id field, atomic write, ENOENT-vs-corrupt
distinction on read) despite the function names being `run`-flavored. Reuse
them as-is:

- **Key**: the EAS build id itself (already a globally unique UUID minted
  by EAS — no need for this adapter to mint its own like `run.js`'s
  `sess-<uuid>`). Prefix it `ship-<build_id>` when calling
  `saveSession`/`loadSession` so a directory listing of the shared state
  dir (`AGENTFLOW_EXPO_STATE_DIR`, same env var `run` already uses) can
  tell a `run` session record apart from a `ship` build record at a
  glance, without needing a second state directory constant.
- **Record shape** (ship-specific, not `run`'s shape — `session.js` places
  no constraint on record contents beyond the id field):
  ```js
  {
    session_id: "ship-<build_id>",   // required key field; see above
    op: "build",                      // which op created this record
    build_id, profile, platform, workspace,
    status,                           // last-observed EAS build status (§5)
    artifact: { kind, url } | null,   // populated once status === "finished"
    channel_url: null,                // populated by a later `distribute` call
    submission_id: null,              // populated by a later `submit` call
    state: "polling" | "done" | "failed",
    created_at, updated_at,           // added automatically by saveSession
  }
  ```
- **Write timing**: `saveSession` runs immediately after the enqueue call
  returns a `build_id` (before the first poll) — this is what makes §5's
  resumability claim true. It's the same "durably record before doing
  anything that could crash and lose the handle" discipline `run.js`
  applies to `saveSession` after `agentDevice.openSession` succeeds.

## 8. Out of scope for v1

- **Store metadata management** (`eas metadata` — App Store/Play listing
  copy, screenshots, categories). Confirmed as its own top-level `eas`
  topic in §2's `eas --help` output, entirely separate from `build`/
  `submit`. Out of scope because it's a one-time/rarely-changed asset
  pipeline, not a per-release operation this adapter's `build`/`distribute`
  /`submit` triad needs to touch — and it has its own, much larger surface
  (screenshot generation, localized copy) that deserves its own spec if
  ever prioritized, not a bolt-on to this one.
- **Screenshot automation for store listings.** Distinct from `verify`'s
  evidence screenshots (already implemented, #134) — this would mean
  driving simulators through a scripted tour of the app to produce
  App-Store-quality marketing screenshots per device size/locale. No
  EAS-native tooling for this exists in the probed CLI surface; it would be
  a new capability built on top of `verify`'s primitives, not something
  `ship` itself does. Deferred for the same reason as store metadata: no
  release target exists yet to make screenshots *for*.
- **OTA JS updates (`eas update`).** A genuinely different delivery
  mechanism (§3's `distribute` section) from native binary `build`/
  `submit` — conflating them would blur what `ship`'s three ops mean.
  Worth its own interface/adapter slice later if the workflow ever wants
  "push a JS fix without a full native build," not retrofitted into `ship`.
- **Auto-submit-on-build-complete** (`-s`/`--auto-submit-with-profile`,
  confirmed live on `eas build --help`). EAS supports it natively, but
  wiring it in here would let a `build` call silently trigger `submit` —
  and `submit` is gated on G4 by contract (§1). Keeping `build` and
  `submit` as two adapter-level ops core invokes separately, rather than
  one CLI flag that fuses them, is what keeps the G4 gate meaningful.
- **Credential provisioning itself** (`eas credentials`,
  `device:create` for iOS ad hoc registration). §4 treats these as a human
  prerequisite the adapter fails closed on, never something it performs on
  a user's behalf — provisioning profiles and ASC API keys are exactly the
  kind of one-time, human-in-the-loop setup this repo's gate model (G4) is
  built around, not something to automate into an unattended CLI call.

## 9. Acceptance test shape

No real EAS build can run in CI (no Apple/Play credentials exist for the
genesis app, and even if they did, a 15–40 minute cloud job has no place in
a CI unit-test loop) — same constraint `packs/expo/scripts/acceptance.sh`'s
own header comment states for `run`/`verify`/`execute-step` regarding no
simulator in cloud CI. The shape here mirrors `packs/expo/adapters/test/
run.test.js` exactly: pure-function unit tests for anything with no I/O,
plus fully-mocked-seam tests for the handlers (fake `runner.exec` returning
canned `eas` CLI stdout/exit codes, fake `sleep`/`clock` so the poll loop in
§5 runs in milliseconds instead of real minutes, fake `saveSession`/
`loadSession`).

### Mocked-seam unit tests (`packs/expo/adapters/test/ship.test.js`, CI-safe)

- **Pre-flight ladder (§4)**, one test per rung, each asserting the exact
  `fatal(20)` message naming the gap:
  - no `.git` → refuses before ever calling the injected `runner`
  - no `eas.json` → refuses, `runner` never invoked
  - `eas.json` missing the requested `build.<profile>` key → refuses
  - app config missing `extra.eas.projectId` → refuses
  - `eas whoami` mock returns exit 1 / "Not logged in" **and**
    `EXPO_TOKEN` unset → refuses; either one alone → proceeds
- **Build enqueue + poll loop (§5)**, `runner.exec` mocked to return, in
  sequence: an enqueue response with a fixed `build_id`, then
  `build:view --json` responses cycling `in-queue` → `in-progress` →
  `finished` (and a second test: → `errored`) — assert:
  - `saveSession` is called with the `build_id` **before** the first poll
    fires (resumability precondition, §7)
  - one `diagnostic()` line per status *change*, not per poll iteration
    (inject a fake `sleep`/`clock` so the loop advances N times without
    real time passing, then assert diagnostic call count == number of
    distinct status transitions, not N)
  - `finished` → op resolves `{status:"ok", artifact:{kind, url}}`;
    `errored`/`canceled` → throws `recoverable(10)` naming the build's
    detail-page URL
- **Resumability (§5's resume-trigger shape)**: seed `loadSession` with an
  existing `ship-<id>` record in `status: "in-progress"`, then call `build`
  with `request.build_id` set to that same id; assert the handler polls the
  *same* `build_id` and never calls the enqueue command a second time. A
  companion test: `request.build_id` naming an id `loadSession` doesn't
  have (mocked `ENOENT`) → `fatal(20)` `"unknown build_id: ..."` without
  ever calling `runner.exec`.
- **`--json` unreliable-on-failure guard (§2)**: mock `runner.exec`
  returning a non-zero exit with **plain text** stdout (not JSON) even
  though `--json` was in the invoked args; assert the handler doesn't throw
  a `JSON.parse` error itself, and that the resulting error message is
  built from `stdout` (not a bare `"exit ${code}"`) — pinning down the
  stdout-before-stderr precedence §2 specifies, which is the one place
  ship's parser deliberately diverges from `run.js#readExpoConfig`'s own
  order.
- **`submit`'s missing-`--json` regex fallback (§3)**: mock `runner.exec`
  returning exit 0 with human stdout containing a submissions URL → asserts
  `submission_id` extracted; mock exit 0 with stdout that has **no**
  matching URL → asserts `submission_id: null` **and** exit is still `0`
  (op succeeds; a parse miss is not a failure, per §3's explicit "do not
  fail the op over an unmatched regex").
- **`distribute`**: mock `build:view --json` returning a finished build →
  assert `channel_url` is the build detail page URL, not
  `artifacts.applicationArchiveUrl` (§3's explicit "prefer the durable page
  URL" decision — a test should pin this down so a future refactor can't
  silently swap it back to the expiring storage URL).
- **Evidence**: assert `appendManifest` is called with `type: "build"` /
  `type: "submission"` and a **URL**, not a local path, per §6's documented
  extension — a regression test here is what keeps that extension
  intentional instead of accidentally reverting to `"log"`.

### Manual live checklist (run once real Apple/EAS credentials exist — not before)

Not automatable in this repo's CI (same `runners.yml`/`simulator`-class
reasoning `scripts/acceptance.sh` already documents for the other three
adapters — this would need its own `eas`-capable, credentialed runner
class). Run by hand, on a machine with `eas` installed and a real,
credentialed Expo/Apple/Google account:

1. `eas login` (or set `EXPO_TOKEN`); `eas whoami` confirms the identity.
2. In a real Expo workspace with `eas.json` + a linked project id: invoke
   the adapter's `build` op with `profile: "preview"`. Confirm:
   - the op returns within seconds (not blocking for the full build,
     §5's `--no-wait` design) — inspect the persisted ship-state record
     (§7) for the `build_id` immediately, before the build finishes.
   - stderr shows one diagnostic line per real EAS status transition,
     matching what `eas build:view <id>` itself reports if polled by hand
     in a second terminal.
   - kill the adapter process mid-poll (simulating a crash), re-invoke
     `build` with `build_id` set to the persisted id (§5's resume-trigger
     shape): confirm it resumes polling rather than starting a second EAS
     build (check `eas build:list` for exactly one build, not two).
   - on completion, the op's stdout `artifact.url` downloads a real
     `.ipa`/`.apk` — confirm the file actually opens/installs, not just
     that a URL string came back.
3. Invoke `distribute`. Confirm `channel_url` opens the real
   expo.dev build page, and (iOS) that a UDID-registered test device can
   install from it.
4. **Only after a real G4 approval** in this repo's own gate flow, invoke
   `submit`. Confirm the submission actually appears in App Store
   Connect / Play Console under "processing", and that
   `submission_id` (if the regex in §3 matched) corresponds to the same
   submission.

## 10. Open questions flagged for core

Two real gaps this investigation surfaced that are outside a single
adapter's authority to resolve unilaterally — noted here so a future
implementer doesn't silently paper over either one:

- **`interfaces/ship.md`'s `artifact.kind` enum (`ipa|apk|dev-client`) has
  no `"aab"`.** EAS's real default for an Android **production** build is
  an app bundle (`.aab`, the format Play Store actually requires for new
  submissions), not a raw `.apk` — `.apk` only comes out of a profile that
  explicitly sets `"buildType": "apk"`. Two ways to resolve, neither of
  which this spec picks unilaterally since `ship.md` is core-owned: (a)
  widen the core interface's enum to include `"aab"`, or (b) have this
  adapter always force `buildType: "apk"` on Android profiles to stay
  within the documented enum, at the cost of shipping a non-Play-Store-
  optimal artifact by default. Flag this to whoever owns `interfaces/
  ship.md` before implementation starts.
- **`interfaces/ship.md`'s `build` request example has no `platform`
  field** (`{op, workspace, profile, version}` only) — yet `eas build`
  requires `--platform`. §3 assumes the workspace's own app config (an
  Expo app targeting both platforms, or a pack-level default) resolves
  which platform(s) to build, mirroring how `run.js` resolves `target`
  from `payload.target -> env -> DEFAULT_TARGET` rather than requiring the
  caller to always specify it. Confirm this assumption (or get `platform`
  added to ship.md's request shape) before implementation, rather than
  guessing silently.
