# mobile-verify — driving the simulator via the adapters

Recipes for the implementer's self-verify step and the ux-reviewer's judgment
pass: start a session, look at the screen, act on it, capture evidence, read
logs, stop. Every recipe here is a real `node <adapter>.js` invocation with a
JSON request on stdin — copy them, don't reinvent the request shape.

All three adapters (`run.js`, `verify.js`, `execute-step.js`) speak one
contract (`packs/expo/adapters/lib/contract.js`): one JSON object on stdin,
one JSON object on stdout, diagnostics on stderr, exit `0` (ok) / `10`
(recoverable — retry) / `20` (fatal — don't retry, escalate). Every op
answers `{"op":"describe"}` with `{"interface": "<name>", "interface_version":
"1"}` regardless of what else it implements — use that to sanity-check an
adapter is reachable before anything else.

> **Live-proven end to end (#136's live acceptance, 2026-07-29):** `start`,
> `snapshot`, `act`, `read`, and `execute-step` (actions, `visible`
> assertions, and `text` assertions) all confirmed working reliably against
> a real booted simulator — the four bugs this recipe list originally
> surfaced (#156, #158, #162, #164) are all fixed and re-verified live, not
> just merged. See `expo-dev.md`'s "Fixed since first found" for what each
> one was.

## 1. Start a session

```sh
echo '{"op":"start","workspace":"/path/to/checkout","target":"iPhone 15",
       "evidence_dir":"/path/to/evidence"}' \
  | node packs/expo/adapters/run.js
```

→ `{"session_id":"sess-…","entry_point":"exp://127.0.0.1:8081","log_stream":"…/app.log"}`

Keep `session_id` — every later call (`verify`, `execute-step`, `stop`)
needs it. `workspace` falls back to `AGENTFLOW_EXPO_WORKSPACE` then `cwd`;
`target` falls back to `AGENTFLOW_EXPO_TARGET` then `"iPhone 15"`. Budget
minutes for a first build on a clean simulator — see `expo-dev.md`.

## 2. Snapshot — see what's actually on screen

```sh
echo '{"op":"snapshot","session_id":"sess-…","evidence_dir":"/path/to/evidence"}' \
  | node packs/expo/adapters/verify.js
```

→ `{"screenshot":"…/0001.png","elements":[
    {"ref":"e12","role":"button","label":"確認","test_id":"grade-confirm",
     "text":"確認","bounds":[x,y,w,h]}, …]}`

**Always snapshot before you act.** Don't guess a `testID` from reading the
component source and skip straight to `act` — component code drifts from
what's actually mounted (conditional rendering, a hydration gate, a
different route than you expected). The snapshot is ground truth; the
source is a hint. This is exactly how the live acceptance script (below)
derives its trace: snapshot first, then write actions against what
`elements` actually reports, never against an assumption.

## 3. Act — perform one step, always evidenced

```sh
echo '{"op":"act","session_id":"sess-…",
       "action":{"kind":"tap","selector":{"test_id":"grade-confirm"}},
       "evidence_dir":"/path/to/evidence"}' \
  | node packs/expo/adapters/verify.js
```

→ `{"ok":true,"screenshot":"…/0002.png"}` — a screenshot is captured on
**every** `act`, pass or fail (a failed action's screenshot is often the
highest-value evidence you'll get).

Prefer `ref` (from the snapshot you just took) when you have one — it's a
direct handle into the live tree. Use `selector` when you don't (a
compiled trace, or acting on an element you expect to appear but haven't
snapshotted yet, e.g. after `wait`). Either way, resolution for a selector
is fixed and pack-independent:

**`test_id` → accessibility label → visible text.**

This order is the whole determinism guarantee compiled E2E traces rely on
(`scenarios/SPEC.md`), which is why interactive elements you create get a
`testID` — a label or visible text can change with a copy edit or a
locale switch; a `testID` doesn't. Never write a trace or a verify call
against `label`/`text` when a `testID` is available.

Action kinds: `tap` (`{selector|ref}`) · `type` (`{selector|ref, text}` —
by ref/selector *replaces* the field's content; with neither, appends to
whatever's currently focused) · `scroll` (`{direction}`) · `navigate`
(`{url}`) · `wait` (`{until:{selector}, timeout_ms}`) · `press`
(`{key: "enter"|"return"|"dismiss"|"back"|"home"}`).

## 4. Read — pull the app's own log

```sh
echo '{"op":"read","session_id":"sess-…","source":"app","tail":200}' \
  | node packs/expo/adapters/verify.js
```

→ `{"lines":["…", "…"]}` — tails the session's `app.log` (Metro/app
stdout+stderr). Use this to confirm a background effect fired (an API
call, a persisted-state write) that isn't visible as a UI change, or to
pull context around an `act` failure.

## 5. Replay a compiled trace — `execute-step`

No model in the loop: mechanical action+assertion replay against one
already-running session. Used by the E2E runner (`scenarios/SPEC.md`) and
directly by the live acceptance script to prove the whole chain works.

```sh
echo '{"op":"execute","session_id":"sess-…",
       "trace":{
         "actions":[
           {"kind":"tap","selector":{"test_id":"acceptance-button"}}
         ],
         "assertions":[
           {"kind":"text","selector":{"test_id":"acceptance-button"},
            "contains":"1"}
         ]
       },
       "evidence_dir":"/path/to/evidence"}' \
  | node packs/expo/adapters/execute-step.js
```

→ exit `0` either way (a step *failing* is a verdict, not an adapter
error): `{"status":"passed","duration_ms":…,"evidence":[…]}` or
`{"status":"failed","failure":{"phase":"action|assertion","index":…,
"reason":"…","screenshot":"…","log_tail":[…]},"evidence":[…]}`. Exit
`10`/`20` mean the *driver* broke (dead session, simulator gone) — the
runner's retry/escalation machinery handles those, they are never a
scenario verdict. Assertion kinds: `visible` · `not_visible` · `text`
(`{equals|contains}`) · `log_contains`.

## 6. Stop the session

```sh
echo '{"op":"stop","session_id":"sess-…"}' | node packs/expo/adapters/run.js
```

→ `{"session_id":"sess-…","state":"stopped"}`. Always stop what you
started, including on a failed verify/self-verify pass — a leaked Metro
process holds its port for the next session (see `expo-dev.md`'s port
section). `status` (`{"op":"status","session_id":"…"}` →
`{"session_id":"…","state":"running"|"stopped"|"crashed"}`) is the cheap
way to check a session is still alive before spending an `act` on it.

## Evidence bundle

Every call that takes `evidence_dir` appends to `<evidence_dir>/manifest.json`
— a JSON array of `{type, path, label, step_ref?}` rows (`packs/expo/
adapters/lib/evidence.js`), written atomically and lock-serialized so
concurrent writers (a live `run` session and a `verify` call sharing one
bundle) can't corrupt it or collide on a filename. Screenshots are
numbered sequentially (`0001.png`, `0002.png`, …) as they're reserved.
Read the manifest, don't glob the directory — it's the one place that
tells you what each file *is* (a snapshot, a failed-action frame, a
step's final state) without re-deriving it from filenames.

## For the ux-reviewer

The same five ops are the whole toolkit for a UX pass: `start` a session
against the build under review, `snapshot` to see the current screen,
`act` to navigate the flow under judgment, `read` to correlate a visual
glitch with something the app logged, `stop` when done. There is no
separate "review mode" — judgment is what you bring; the adapters only
ever report what's actually on screen.
