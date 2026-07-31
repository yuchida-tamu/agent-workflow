#!/usr/bin/env node
// packs/expo/adapters/verify.js — implements interfaces/verify.md: snapshot /
// act / read, driving an already-running `run` session via agent-device and
// writing every screenshot into the shared evidence bundle. See #132's plan
// (agent-device capability findings) and #134.
//
// Every op resolves its target from lib/session.js's state file — the same
// record `run start` wrote (agent_device_session, target, bundle_id, state)
// — since, like run.js, this is a fresh `node verify.js` process per
// invocation with nothing surviving in memory between calls. `verify` never
// writes to that record; it only reads it.
//
// op -> agent-device command mapping (see #132's capability findings and a
// live probe against agent-device 0.19.3 for the exact shapes below):
//
//   snapshot                     -> snapshot -i --json
//   act tap                      -> press <ref|selector>
//   act type (ref/selector+text) -> fill <ref|selector> <text>
//   act type (no target)         -> type <text>            (appends to focused)
//   act scroll                   -> scroll <direction>      (no element scope — see performAction)
//   act navigate                 -> open <bundle_id> <url>  (bundle_id from the run session record)
//   act wait                     -> wait <selector> [timeout_ms]
//   act press key=enter|return|dismiss -> keyboard <key>
//   act press key=back           -> back
//   act press key=home           -> home
//   read source=app|device       -> logs path, then tail the resolved file
//
// Every command above also carries `--session <agent_device_session>
// --platform ios --device <target>` (sessionFlags), matching the targeting
// convention `run.js`/`lib/agent-device.js` already use for open/close/apps.
//
// Platform is hardcoded to "ios" (matching run.js) — Android is out of scope
// per #132 ("Out of scope: ... Android").

import { join } from "node:path";
import { readFile as fsReadFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runMain, recoverable, fatal, diagnostic } from "./lib/contract.js";
import * as agentDevice from "./lib/agent-device.js";
import { unwrap } from "./lib/agent-device.js";
import { defaultRunner } from "./lib/proc.js";
import { loadSession } from "./lib/session.js";
import { reserveEntry, finalizeEntry } from "./lib/evidence.js";

const INTERFACE = "verify";
const PLATFORM = "ios";

// `unwrap` used to be duplicated here byte-for-byte with lib/agent-device.js's
// copy — exactly the kind of drift risk the #164 family sweep exists to
// close ("no adapter touches a raw envelope" is a lib-level guarantee now,
// not a per-file one; see that file's header). Re-exported (not redefined)
// so this module's own tests, which import `unwrap` from `../verify.js`,
// keep working unchanged. `agentDevice.invoke()` already applies it by
// default now — see `callAgentDevice` below — so nothing in this file is
// *required* to call it directly anymore, but `normalizeElements` and
// `readOp` still do, defensively: both are also exercised directly in this
// file's own unit tests against a raw enveloped fixture, and `unwrap` is
// idempotent on already-unwrapped input, so calling it twice is harmless.
export { unwrap };

function sessionFlags(record) {
  return ["--session", record.agent_device_session, "--platform", PLATFORM, "--device", record.target];
}

// The agent-device error code carried in a failed `--json` response body
// (`{success:false, error:{code, message, ...}}`), read from the raw stdout
// AgentDeviceError preserves — `invoke()`'s own message is a truncated,
// human-readable summary, not something safe to pattern-match on.
function agentDeviceErrorCode(err) {
  if (!err || typeof err.stdout !== "string" || !err.stdout.trim()) return null;
  try {
    return JSON.parse(err.stdout)?.error?.code ?? null;
  } catch {
    return null;
  }
}

// agent-device error codes that mean "the session agent-device knows about
// is gone" — the daemon restarted, the app process died, the simulator was
// shut down out from under us, etc. This is the "dead session" case: distinct
// from our own state file saying the session never existed (fatal/20, a
// caller bug) or being unreadable (recoverable/10, an I/O surprise) — here
// our record still says "running", but the live driver disagrees. Mapped
// recoverable/10 since core's bounded retry can act on it (re-run `run
// start`), unlike a permanently wrong session_id.
const DEAD_SESSION_CODES = new Set(["SESSION_NOT_FOUND", "DEVICE_NOT_FOUND", "APP_NOT_RUNNING"]);

// Every agent-device invocation `verify` makes funnels through here so the
// dead-session error mapping (below) is applied exactly once.
// `agentDevice.invoke()` already unwraps the `{success,data}` envelope and
// throws `AgentDeviceError` even for a `success:false` body at exit 0 (see
// lib/agent-device.js's header) — this used to re-do that check locally via
// its own duplicated `unwrap`; now it just reacts to whatever `invoke()`
// already decided.
async function callAgentDevice(args, { runner, sessionId }) {
  try {
    return await agentDevice.invoke(args, { runner });
  } catch (err) {
    if (err instanceof agentDevice.AgentDeviceError) {
      const code = agentDeviceErrorCode(err);
      if (DEAD_SESSION_CODES.has(code)) {
        throw recoverable(`agent-device lost session ${sessionId} (${code}) — dead session: ${err.message}`, {
          cause: err,
        });
      }
      throw recoverable(`agent-device ${args[0]} failed: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

// Resolves `session_id` against the `run` session record and confirms it's
// actually alive. Three distinct outcomes, matching run.js's own
// loadSessionOrThrow split for the first two, plus a third this adapter adds:
//   - the record never existed (ENOENT)      -> fatal/20 "unknown session_id"
//   - the state file exists but is unreadable -> recoverable/10
//   - the record exists but state != "running" -> recoverable/10, "dead session"
export async function requireRunningSession(sessionId, deps) {
  if (!sessionId) throw fatal("session_id is required");
  let record;
  try {
    record = await deps.loadSession(sessionId);
  } catch (err) {
    if (err && err.code === "ENOENT") throw fatal(`unknown session_id: ${sessionId}`);
    throw recoverable(`session state for ${sessionId} is unreadable: ${err.message}`, { cause: err });
  }
  if (record.state !== "running") {
    throw recoverable(`session ${sessionId} is not running (state: ${record.state}) — dead session`);
  }
  return record;
}

// ---- snapshot -------------------------------------------------------------

// agent-device's `-i` flag already scopes the tree to interactive elements
// (see `snapshot --help`); the JSON it returns is already a flat array
// (`nodes`, each carrying its own `depth`/`parentIndex` rather than nested
// `children`) — "flattened" per interfaces/verify.md is agent-device's job,
// not ours. This only renames fields to the contract's shape, one-to-one, no
// additional filtering — so this mapping never second-guesses which nodes
// agent-device already chose to include.
export function normalizeElements(snapshotResult) {
  const nodes = unwrap(snapshotResult)?.nodes ?? [];
  return nodes.map((node) => ({
    ref: node.ref ?? null,
    role: typeof node.type === "string" ? node.type.toLowerCase() : null,
    label: node.label ?? null,
    test_id: node.identifier ?? null,
    // `value` carries a control's current content/state (confirmed live: a
    // Switch's on/off value) — it's the closest analog to "text" for an
    // input; for everything else the contract's own example treats `text`
    // as equal to `label` (a static "Checkout" button: label=text="Checkout").
    text: node.value ?? node.label ?? null,
    bounds: node.rect ? [node.rect.x, node.rect.y, node.rect.width, node.rect.height] : null,
  }));
}

async function snapshotOp(request, deps) {
  const record = await requireRunningSession(request.session_id, deps);
  const result = await callAgentDevice(["snapshot", "-i", ...sessionFlags(record)], {
    runner: deps.runner,
    sessionId: request.session_id,
  });
  const elements = normalizeElements(result);
  const screenshot = await captureScreenshot({ record, evidenceDir: request.evidence_dir, deps, label: "snapshot" });
  return { screenshot, elements };
}

// ---- act --------------------------------------------------------------

// `{ref}` -> a snapshot ref (translateRef adds the CLI's required "@");
// `{selector}` -> the fixed test_id -> label -> text order (translateSelector).
// Returns null when the action carries neither (e.g. a plain `type` that
// appends to whatever is already focused).
export function resolveActionTarget(action) {
  if (action.ref !== undefined && action.ref !== null) return agentDevice.translateRef(action.ref);
  if (action.selector !== undefined && action.selector !== null) return agentDevice.translateSelector(action.selector);
  return null;
}

const KEYBOARD_KEYS = new Set(["enter", "return", "dismiss"]);
const TOP_LEVEL_KEYS = { back: ["back"], home: ["home"] };

// `press` (key) actions cover two agent-device surfaces: `keyboard
// enter|return|dismiss` for on-screen keyboard actions, and the top-level
// `back`/`home` commands for device navigation keys. Anything else is a
// contract violation this adapter can't translate — fatal, not a guess.
export function mapPressKey(key) {
  if (!key) throw fatal("press requires key");
  if (KEYBOARD_KEYS.has(key)) return ["keyboard", key];
  if (TOP_LEVEL_KEYS[key]) return TOP_LEVEL_KEYS[key];
  throw fatal(`unsupported press key: ${key}`);
}

// Builds and runs the one agent-device command each action kind maps to (see
// the file-header table). Returns nothing meaningful — the caller always
// follows up with its own post-action screenshot regardless of what this
// command reported, per interfaces/verify.md's "a post-action screenshot is
// always captured".
async function performAction(action, { record, deps }) {
  const flags = sessionFlags(record);
  const run = (args) => callAgentDevice([...args, ...flags], { runner: deps.runner, sessionId: record.session_id });

  switch (action.kind) {
    case "tap": {
      const target = resolveActionTarget(action);
      if (!target) throw fatal("tap requires ref or selector");
      return run(["press", target]);
    }
    case "type": {
      if (typeof action.text !== "string") throw fatal("type requires text");
      const target = resolveActionTarget(action);
      // By ref/selector: `fill` replaces that field's content directly. With
      // neither: `type` appends to whatever the app currently has focused
      // (see #134's issue body: "type -> fill (by ref) / type (appends to
      // focused)").
      return target ? run(["fill", target, action.text]) : run(["type", action.text]);
    }
    case "scroll": {
      if (!action.direction) throw fatal("scroll requires direction");
      // agent-device's `scroll` has no element-scoping flag (confirmed via
      // `scroll --help`: only --pixels/--duration-ms, unlike press/fill/wait
      // which accept a ref/selector target) — action.ref is accepted for
      // contract compliance but has no CLI equivalent to pass; the scroll is
      // always global to the current screen.
      return run(["scroll", action.direction]);
    }
    case "navigate": {
      if (!action.url) throw fatal("navigate requires url");
      if (!record.bundle_id) throw fatal(`session ${record.session_id} has no bundle_id — cannot navigate`);
      return run(["open", record.bundle_id, action.url]);
    }
    case "wait": {
      const selector = action.until?.selector;
      if (!selector) throw fatal("wait requires until.selector");
      const target = agentDevice.translateSelector(selector);
      const args = ["wait", target];
      if (action.timeout_ms !== undefined) args.push(String(action.timeout_ms));
      return run(args);
    }
    case "press": {
      return run(mapPressKey(action.key));
    }
    default:
      throw fatal(`unsupported action kind: ${JSON.stringify(action.kind)}`);
  }
}

async function actOp(request, deps) {
  const record = await requireRunningSession(request.session_id, deps);
  const action = request.action;
  if (!action || typeof action !== "object" || !action.kind) {
    throw fatal("act requires an action with a kind");
  }
  try {
    await performAction(action, { record, deps });
  } catch (err) {
    // The failure frame is often the highest-value evidence — interfaces/
    // verify.md's "a post-action screenshot is always captured" reads
    // literally: that includes a failed action, not just a successful one
    // (#134 review). A screenshot failure here must never mask the original
    // action error, so it's swallowed (diagnostic only) rather than thrown.
    await captureScreenshot({
      record,
      evidenceDir: request.evidence_dir,
      deps,
      label: `act:${action.kind}:failed`,
    }).catch((screenshotErr) => {
      diagnostic(
        `[verify] failure screenshot also failed for act:${action.kind}: ${screenshotErr.message}`,
        deps.stderr
      );
    });
    throw err;
  }
  const screenshot = await captureScreenshot({
    record,
    evidenceDir: request.evidence_dir,
    deps,
    label: `act:${action.kind}`,
  });
  return { ok: true, screenshot };
}

// ---- read ---------------------------------------------------------------

// agent-device 0.19.3 exposes exactly one file-backed log stream per session
// (`logs path|start|stop|clear|...` — its own help text calls it "Session
// app log info"; there is no separate device-level log command). Both `app`
// and `device` sources therefore resolve through the same `logs path` call
// today — this is a driver capability limit, not a shortcut taken here; if a
// future agent-device version exposes a distinct device log this is the one
// place that needs to branch.
export function tailLines(text, n) {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // trailing newline
  if (!Number.isFinite(n) || n <= 0) return lines;
  return lines.slice(Math.max(0, lines.length - n));
}

async function readOp(request, deps) {
  const record = await requireRunningSession(request.session_id, deps);
  const source = request.source ?? "app";
  if (source !== "app" && source !== "device") {
    throw fatal(`unsupported read source: ${JSON.stringify(source)}`);
  }
  const tail = request.tail !== undefined ? Number(request.tail) : 200;

  const pathResult = await callAgentDevice(["logs", "path", ...sessionFlags(record)], {
    runner: deps.runner,
    sessionId: request.session_id,
  });
  const logPath = unwrap(pathResult)?.path;
  if (!logPath) return { lines: [] };

  let text;
  try {
    text = await deps.readFile(logPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { lines: [] }; // nothing logged yet
    throw recoverable(`could not read log file ${logPath}: ${err.message}`, { cause: err });
  }
  return { lines: tailLines(text, tail) };
}

// ---- evidence -------------------------------------------------------------

// Shared by snapshot and act: capture a screenshot and record it in the
// evidence manifest. The contract's own examples number screenshots
// sequentially within the bundle ("evidence/0007.png", "evidence/0008.png")
// — `lib/evidence.js`'s `reserveEntry` picks that index and writes the
// manifest row atomically (under the same lock, in one transaction), so two
// concurrent callers sharing one evidence_dir (a live `run` session and a
// `verify` call, or two `verify` calls racing) can never both mint the same
// filename and clobber each other's screenshot (#134 review — the manifest
// row is written by `reserveEntry` itself, not by us after the fact).
//
// Without an evidence_dir (not guaranteed on every call — see
// lib/session.js's header note on the same fallback shape) this still
// honors "a screenshot is always captured", just outside the bundle, under a
// random name since there's no manifest to reserve a slot in.
//
// #139 (residual from #141's re-review): `reserveEntry`'s row lands BEFORE
// the actual PNG capture below — that's the whole point of reserving the
// slot atomically (see reserveEntry's own comment) — which means a capture
// that fails AFTER a successful reservation used to leave a permanent
// manifest row pointing at a file that was never written: not silent
// corruption (the missing file is visible), but a dangling reference with
// no way to tell "still capturing" from "capture died" after the fact. The
// row now carries `status`, finalized to "written" or "failed" once the
// capture's outcome is known — best-effort (`.catch`): a finalize failure
// must never mask the capture's own real outcome, which this still throws
// for exactly as before.
async function captureScreenshot({ record, evidenceDir, deps, label }) {
  let path;
  let finalize = null;
  if (evidenceDir) {
    const entry = await deps.reserveEntry(evidenceDir, { type: "screenshot", ext: ".png", label: label ?? "screenshot" });
    path = entry.path;
    finalize = (status) => deps.finalizeEntry(evidenceDir, path, status).catch(() => {});
  } else {
    const dir = join(tmpdir(), "agentflow-expo-verify");
    await mkdir(dir, { recursive: true });
    path = join(dir, `${randomUUID()}.png`);
  }

  try {
    await callAgentDevice(["screenshot", "--out", path, ...sessionFlags(record)], {
      runner: deps.runner,
      sessionId: record.session_id,
    });
  } catch (err) {
    if (finalize) await finalize("failed");
    throw err;
  }
  if (finalize) await finalize("written");

  return path;
}

// ---- wiring ---------------------------------------------------------------

function defaultHandlerDeps() {
  return {
    runner: defaultRunner,
    loadSession,
    readFile: fsReadFile,
    reserveEntry,
    finalizeEntry,
    stderr: process.stderr,
  };
}

// Builds the {snapshot, act, read} handler map runMain dispatches on. Every
// side-effecting dependency has a default but is overridable — tests build
// this with a fully mocked runner/session store (see
// packs/expo/adapters/test/verify.test.js), matching run.js's pattern.
export function createHandlers(overrides = {}) {
  const deps = { ...defaultHandlerDeps(), ...overrides };
  return {
    snapshot: (request) => snapshotOp(request, deps),
    act: (request) => actOp(request, deps),
    read: (request) => readOp(request, deps),
  };
}

async function main() {
  await runMain({ interfaceName: INTERFACE, handlers: createHandlers() });
}

// Only run as a CLI when invoked directly — importing it for tests must not
// touch stdin (same guard as run.js).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
