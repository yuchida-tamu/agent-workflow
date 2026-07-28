#!/usr/bin/env node
// packs/expo/adapters/execute-step.js — implements interfaces/execute-step.md:
// deterministic replay of one compiled step trace ({actions, assertions})
// against the `agent-device` CLI. No model in the loop — see #132's plan and
// ../scenarios/SPEC.md for the compile-once-replay-forever model this serves.
//
// Reuses `lib/`: `invoke`/`translateSelector` from lib/agent-device.js drive
// every agent-device call, `loadSession` from lib/session.js resolves the
// `run`-started session, `isAlive` from lib/proc.js re-checks Metro's
// pid+identity the same way run.js's own `status` op does, and
// `appendManifest`/`readManifest` from lib/evidence.js own the evidence
// bundle. Each action/assertion is compiled to a plain agent-device argv
// array inline, so there is no seam for this file and verify.js to collide
// on. `invoke()` itself gained a lib-level behavior change in #164 (unwraps
// the `{success,data}` envelope by default) — see lib/agent-device.js's file
// header for why that's a structural fix, not a per-caller one.
//
// ---- The failure-vs-infrastructure line (the whole point of this contract) -
//
// A step FAILURE (selector never resolved, assertion stayed false, log never
// matched) is a valid verdict about the app under test — it is captured in
// the response body and the adapter still exits 0. An INFRASTRUCTURE failure
// (the daemon is gone, the simulator died, the session is dead) is not a
// verdict at all; it is escalated as an AdapterError (exit 10/20) so core's
// retry/escalation machinery handles it, never reported as `status:"failed"`.
//
// Two places draw that line:
//   1. Pre-flight (`assertSessionAlive`): before touching a single action, the
//      session record's own `state` and (if a Metro process is recorded) its
//      identity-checked liveness are re-verified — exactly the check run.js's
//      `status` op performs. A dead session never gets to a verdict; it is
//      `recoverable(10)` immediately.
//   2. Mid-replay (`isInfrastructureError`): every agent-device invocation
//      that fails is an `AgentDeviceError` from lib/agent-device.js, and by
//      default that means "the predicate was false" / "the selector never
//      resolved" — an ordinary step failure. Only messages carrying a known
//      driver/daemon/simulator-death signature (see `INFRA_ERROR_PATTERN`)
//      are reclassified as infrastructure and escalated instead. This keeps
//      the common case (a selector genuinely isn't there) a `failed` verdict,
//      while a daemon dying mid-batch still surfaces as 10, not a false step
//      failure.

import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import { runMain, recoverable, fatal, diagnostic, AdapterError } from "./lib/contract.js";
import { invoke, translateSelector, openSession, AgentDeviceError, defaultRunner } from "./lib/agent-device.js";
import { isAlive } from "./lib/proc.js";
import { loadSession } from "./lib/session.js";
import { appendManifest, readManifest } from "./lib/evidence.js";

const INTERFACE = "execute-step";

// Defaults when a trace step doesn't set its own timeout_ms.
export const DEFAULT_ASSERT_TIMEOUT_MS = 5000;
export const POLL_INTERVAL_MS = 250;
const LOG_TAIL_LINES = 20;

// agent-device only supports iOS today (see #132's plan: Android is out of
// scope) — run.js hardcodes "ios" the same way rather than trusting an
// unvalidated `platform` field on the session record.
const PLATFORM = "ios";

// Messages carrying one of these signatures mean the *driver* is gone, not
// that a predicate was false — see the file header. Grounded in agent-device
// help text (daemon idle-reap, stale runner lease, simulator boot/connect
// failures) rather than the ordinary "selector did not resolve"/"assertion
// failed" wording `is`/`press`/`fill`/`wait` use for a genuine step failure.
// "daemon" alone is deliberately NOT an alternative here (only paired with a
// failure verb, or the one literal agent-device phrase below) — a bare
// substring match on "daemon" would trip on agent-device's own
// `Selector did not resolve uniquely (text="Restart daemon")` diagnostic,
// which legitimately echoes a UI element's own accessible text.
const INFRA_ERROR_PATTERN =
  /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|daemon\s*(?:is\s*)?(?:not\s*running|unreachable|not\s*responding|died|crashed|gone|down|stale)|is already owned by another agent-device daemon|not booted|simulator.*(?:not (?:running|found|available)|died|crashed)|device not found|no such session|session not found|command not found/i;

// Strips any echoed selector expression (id="…"/label="…"/text="…") out of a
// diagnostic before classification. agent-device's own error text for a
// failed resolution legitimately echoes the selector's value back (e.g.
// `Selector did not resolve uniquely (text="Restart daemon")`) — the
// classifier must never let a UI element's own accessible text/label steer
// its own verdict, so that content is removed before the pattern runs.
function stripEchoedSelectors(text) {
  return text.replace(/(?:id|label|text)="(?:[^"\\]|\\.)*"/g, "");
}

export function isInfrastructureError(err) {
  if (!(err instanceof AgentDeviceError)) return false;
  // Spawn-level failure (lib/agent-device.js's `invoke` hits its `result.error`
  // branch: ENOENT/EACCES/ETIMEDOUT etc — the child process never produced a
  // real exit, so neither `stderr` nor `stdout` was ever set on the error).
  // agent-device wasn't even reachable, so this is infrastructure
  // unconditionally — never dependent on message content.
  if (err.stderr === undefined && err.stdout === undefined) return true;
  // Otherwise classify on the driver's own diagnostic only (stderr, falling
  // back to stdout when the driver wrote nothing to stderr) — NEVER on
  // `.message`, which echoes the full invoked command line (bin, subcommand,
  // every flag, and the selector) verbatim. A button whose accessible label
  // happens to be "Restart daemon" must still resolve as an ordinary step
  // failure, not get reclassified as infrastructure because its own selector
  // text contains an infra-sounding word.
  const diagnostic = stripEchoedSelectors(`${err.stderr ?? ""} ${err.stdout ?? ""}`).trim();
  return INFRA_ERROR_PATTERN.test(diagnostic);
}

// ---- selector / argv helpers -------------------------------------------

export function describeSelector(selector) {
  if (!selector || typeof selector !== "object") return "(no selector)";
  if (selector.test_id !== undefined) return `test_id=${selector.test_id}`;
  if (selector.label !== undefined) return `label=${selector.label}`;
  if (selector.text !== undefined) return `text=${selector.text}`;
  return JSON.stringify(selector);
}

function withSessionFlags(args, ctx) {
  const out = [...args];
  out.push("--platform", ctx.platform, "--device", ctx.target, "--session", ctx.session);
  return out;
}

// `translateSelector` (lib/agent-device.js) throws a bare TypeError for a
// selector with none of test_id/label/text set. That's a malformed trace,
// exactly like an unsupported action/assertion kind — not a live-UI verdict —
// so it must escalate fatal(20) the same way, not fall through to an ordinary
// step failure. Every selector translation in this file goes through this
// wrapper rather than calling `translateSelector` directly.
function selectorArg(selector) {
  try {
    return translateSelector(selector);
  } catch (err) {
    throw fatal(`malformed selector: ${err.message}`);
  }
}

// tap -> press, type -> fill (replaces, matching verify.md's `type` action),
// scroll -> scroll [--scope <selector>], press (key) -> keyboard/back. `wait`
// and `navigate` have their own dedicated runners below since they don't
// reduce to one plain agent-device argv (`wait`'s timeout is a trailing
// positional, `navigate` reuses lib's `openSession`, not a bare `invoke`).
export function actionArgv(action) {
  switch (action.kind) {
    case "tap":
      return ["press", selectorArg(action.selector)];
    case "type":
      return ["fill", selectorArg(action.selector), String(action.text ?? "")];
    case "scroll": {
      const args = ["scroll", action.direction ?? "down"];
      if (action.amount !== undefined) args.push(String(action.amount));
      if (action.selector) args.push("--scope", selectorArg(action.selector));
      return args;
    }
    case "press":
      return keyArgv(action.key);
    default:
      throw fatal(`unsupported action kind: ${JSON.stringify(action.kind)}`);
  }
}

// `press` (the trace's key-press action, distinct from `tap`) only covers
// what agent-device's `keyboard`/`back` commands expose (help keyboard: only
// status/get/dismiss/enter/return) — any other key is a malformed trace, not
// a live-UI verdict, so it's fatal (20) rather than a step failure.
function keyArgv(key) {
  switch (key) {
    case "back":
      return ["back"];
    case "enter":
    case "return":
      return ["keyboard", "enter"];
    case "dismiss":
      return ["keyboard", "dismiss"];
    default:
      throw fatal(`unsupported press key: ${JSON.stringify(key)}`);
  }
}

async function runAction(action, ctx) {
  if (action.kind === "wait") {
    const selector = action.until?.selector;
    if (!selector) throw fatal("wait action requires until.selector");
    const timeoutMs = action.timeout_ms ?? DEFAULT_ASSERT_TIMEOUT_MS;
    // `agent-device wait <selector> <timeoutMs>` polls internally (fixed
    // 300ms interval) and raises a command failure on timeout — exactly the
    // action-phase failure shape we want, no app-level poll loop needed.
    return invoke(withSessionFlags(["wait", selectorArg(selector), String(timeoutMs)], ctx), {
      runner: ctx.runner,
    });
  }
  if (action.kind === "navigate") {
    if (!action.url) throw fatal("navigate action requires url");
    // Reuses lib/agent-device.js's `openSession` as-is (same helper run.js's
    // `start` uses to open the entry-point URL) rather than hand-rolling an
    // `open` invoke — no lib change needed for this to work.
    return openSession({ url: action.url, platform: ctx.platform, device: ctx.target, session: ctx.session, runner: ctx.runner });
  }
  return invoke(withSessionFlags(actionArgv(action), ctx), { runner: ctx.runner });
}

// ---- assertion polling ---------------------------------------------------

// Generic deadline poll: calls `check` until it resolves {ok:true} or the
// deadline passes, returning the last result either way. Every dependency is
// injectable (mirrors run.js's `waitForMetroReady`) so tests drive this
// without real timers.
export async function pollUntil(check, { timeoutMs, intervalMs = POLL_INTERVAL_MS, sleep, clock }) {
  const deadline = clock() + timeoutMs;
  let last = { ok: false };
  do {
    last = await check();
    if (last.ok) return last;
    if (clock() >= deadline) return last;
    await sleep(intervalMs);
  } while (clock() < deadline);
  return last;
}

// Wraps a check so an ordinary "predicate false" AgentDeviceError becomes a
// poll miss (retry), while an infrastructure-classified error (or an
// AdapterError, or a coding bug) propagates immediately instead of being
// retried until the deadline.
function guard(fn) {
  return async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AgentDeviceError && !isInfrastructureError(err)) {
        return { ok: false, error: err };
      }
      throw err;
    }
  };
}

// visible/not_visible: `is visible|hidden <selector>` — "Assert UI state" per
// `agent-device help is`; a false predicate is a command failure (non-zero
// exit), so success of the invoke IS the assertion passing. Polled ourselves
// (agent-device's own `is` has no timeout flag) up to timeout_ms.
//
// Confirmed live against a real 0.19.3 session (#164's audit): every `is`
// outcome — predicate false, selector not found, even a malformed predicate
// name — comes back as a non-zero exit with a `{success:false, error:{...}}`
// body; a passing predicate is the only case that exits 0
// (`{success:true, data:{predicate,pass:true,selector}}`). There is no data
// this assertion needs to read — `invoke()`'s return is discarded on
// purpose — so unlike `assertText` there was never a raw-envelope read to
// get wrong here. It does still benefit from `invoke()`'s default unwrap:
// a hypothetical `success:false` body at exit 0 (agent-device's own stated
// failure mode for a daemon-level non-process error — see lib/agent-device.js's
// `unwrap()`) now throws instead of silently reading as "passed".
async function assertVisible(assertion, ctx, { hidden }) {
  const predicate = hidden ? "hidden" : "visible";
  const timeoutMs = assertion.timeout_ms ?? DEFAULT_ASSERT_TIMEOUT_MS;
  const check = guard(async () => {
    await invoke(withSessionFlags(["is", predicate, selectorArg(assertion.selector)], ctx), { runner: ctx.runner });
    return { ok: true };
  });
  const result = await pollUntil(check, { timeoutMs, sleep: ctx.sleep, clock: ctx.clock });
  if (!result.ok) {
    const detail = result.error?.message ? ` (${result.error.message})` : "";
    throw new Error(`selector ${describeSelector(assertion.selector)} is not ${predicate} within ${timeoutMs}ms${detail}`);
  }
}

// `res` here is `invoke()`'s return, which is already the unwrapped `data`
// payload (see lib/agent-device.js's "no adapter touches a raw envelope"
// header) — a live `agent-device get text <selector> --json` reply is
// `{success:true, data:{selector, text, node}}` (confirmed live, #164), so
// `res.text` is correct. #164 was exactly this function reading `res.text`
// off the *raw* envelope (where the real value lives at `res.data.text`),
// which was always `undefined` — every poll read fell through to `return ""`
// regardless of the real on-screen text. Fixed structurally, not locally:
// `invoke()` unwraps by default now, so there is no raw envelope left for
// this function to mis-read even if it never thought about `.data` at all.
// `res.value`/bare-string fallbacks are kept for tolerance of a future/older
// agent-device shape, not because the live 0.19.3 response ever takes them.
function extractText(res) {
  if (typeof res === "string") return res;
  if (res && typeof res.text === "string") return res.text;
  if (res && typeof res.value === "string") return res.value;
  return "";
}

// text: {selector, equals|contains} — `get text <selector>`, compared here
// since agent-device has no built-in equals/contains predicate for text.
async function assertText(assertion, ctx) {
  const hasEquals = assertion.equals !== undefined;
  const hasContains = assertion.contains !== undefined;
  if (!hasEquals && !hasContains) throw fatal("text assertion requires equals or contains");
  const timeoutMs = assertion.timeout_ms ?? DEFAULT_ASSERT_TIMEOUT_MS;
  let lastText = "";
  const check = guard(async () => {
    const res = await invoke(withSessionFlags(["get", "text", selectorArg(assertion.selector)], ctx), {
      runner: ctx.runner,
    });
    lastText = extractText(res);
    const ok = hasEquals ? lastText === assertion.equals : lastText.includes(assertion.contains);
    return { ok };
  });
  const result = await pollUntil(check, { timeoutMs, sleep: ctx.sleep, clock: ctx.clock });
  if (!result.ok) {
    const expectDesc = hasEquals ? `equal ${JSON.stringify(assertion.equals)}` : `contain ${JSON.stringify(assertion.contains)}`;
    const detail = result.error?.message ? ` (${result.error.message})` : "";
    throw new Error(
      `text at ${describeSelector(assertion.selector)} did not ${expectDesc} within ${timeoutMs}ms ` +
        `(last read: ${JSON.stringify(lastText)})${detail}`
    );
  }
}

// log_contains: no agent-device invocation at all — scans the session's own
// app.log (the file `run.js` already streams Metro/app output into, per
// #132's plan: "log_contains -> scan session app.log"). `ctx.readFile` is the
// injected read seam the task calls for.
async function assertLogContains(assertion, ctx) {
  const pattern = assertion.pattern ?? assertion.contains ?? assertion.text;
  if (!pattern) throw fatal("log_contains assertion requires a pattern");
  const timeoutMs = assertion.timeout_ms ?? DEFAULT_ASSERT_TIMEOUT_MS;
  const check = async () => {
    if (!ctx.logPath) return { ok: false };
    const content = await ctx.readFile(ctx.logPath).catch(() => "");
    return { ok: content.includes(pattern) };
  };
  const result = await pollUntil(check, { timeoutMs, sleep: ctx.sleep, clock: ctx.clock });
  if (!result.ok) {
    const where = ctx.logPath ? ctx.logPath : "(no log_stream recorded for this session)";
    throw new Error(`log at ${where} does not contain ${JSON.stringify(pattern)} within ${timeoutMs}ms`);
  }
}

async function runAssertion(assertion, ctx) {
  switch (assertion.kind) {
    case "visible":
      return assertVisible(assertion, ctx, { hidden: false });
    case "not_visible":
      return assertVisible(assertion, ctx, { hidden: true });
    case "text":
      return assertText(assertion, ctx);
    case "log_contains":
      return assertLogContains(assertion, ctx);
    default:
      throw fatal(`unsupported assertion kind: ${JSON.stringify(assertion.kind)}`);
  }
}

// ---- evidence -------------------------------------------------------------

// One screenshot per execute-step call — captured at the end of replay
// (either the final UI state on a pass, or the failure moment on a fail),
// matching both illustrative examples in interfaces/execute-step.md (each
// shows exactly one evidence entry). Best-effort end to end: the screenshot
// invoke AND the manifest write share one try/catch, so a manifest-write
// failure (a read-only/unwritable evidence_dir, for instance) can never
// throw out of here and mask the step's actual pass/fail verdict — it just
// leaves evidence empty, same as a screenshot capture failure.
async function captureScreenshot(ctx, deps, evidenceDir) {
  if (!evidenceDir) return null;
  const manifest = await deps.readManifest(evidenceDir).catch(() => []);
  const fileName = `${String(manifest.length + 1).padStart(4, "0")}.png`;
  const outPath = join(evidenceDir, fileName);
  try {
    await invoke(withSessionFlags(["screenshot", "--out", outPath], ctx), { runner: ctx.runner, json: false });
    await deps.appendManifest(evidenceDir, { type: "screenshot", path: outPath, label: "execute-step" });
  } catch (err) {
    diagnostic(`[execute-step] screenshot capture failed: ${err.message}`, deps.stderr);
    return null;
  }
  return outPath;
}

async function readLogTail(ctx) {
  if (!ctx.logPath) return [];
  try {
    const content = await ctx.readFile(ctx.logPath);
    return content.split("\n").filter((line) => line.length > 0).slice(-LOG_TAIL_LINES);
  } catch {
    return [];
  }
}

// ---- session liveness ------------------------------------------------------

// Re-verifies the `run`-started session is actually usable before replaying a
// single action — the same identity-checked liveness `run.js`'s own `status`
// op performs (lib/proc.js's `isAlive`), reused as-is. A session already
// marked stopped, or one whose recorded Metro process is gone, is
// infrastructure trouble, not a step verdict: recoverable(10), never a
// `status:"failed"` response.
export async function assertSessionAlive(record, sessionId, deps) {
  if (record.state === "stopped") {
    throw recoverable(`session ${sessionId} is stopped — cannot execute a step against it`);
  }
  if (record.metro?.pid) {
    const alive = await deps.isAlive(record.metro.pid, record.metro.identity, { runner: deps.runner });
    if (!alive) {
      throw recoverable(`session ${sessionId} is not alive (Metro process ${record.metro.pid} is gone)`);
    }
  }
}

function loadSessionOrThrow(deps, sessionId) {
  return deps.loadSession(sessionId).catch((err) => {
    if (err && err.code === "ENOENT") throw fatal(`unknown session_id: ${sessionId}`);
    throw recoverable(`session state for ${sessionId} is unreadable: ${err.message}`, { cause: err });
  });
}

// ---- handler ---------------------------------------------------------------

async function defaultReadFile(path) {
  return fsReadFile(path, "utf8");
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultHandlerDeps() {
  return {
    runner: defaultRunner,
    isAlive,
    loadSession,
    appendManifest,
    readManifest,
    readFile: defaultReadFile,
    sleep: defaultSleep,
    clock: Date.now,
    stderr: process.stderr,
  };
}

export function createHandlers(overrides = {}) {
  const deps = { ...defaultHandlerDeps(), ...overrides };

  async function execute(request) {
    const sessionId = request.session_id;
    if (!sessionId) throw fatal("execute requires session_id");
    const trace = request.trace ?? {};
    const actions = Array.isArray(trace.actions) ? trace.actions : [];
    const assertions = Array.isArray(trace.assertions) ? trace.assertions : [];
    const evidenceDir = request.evidence_dir ?? null;

    const record = await loadSessionOrThrow(deps, sessionId);
    await assertSessionAlive(record, sessionId, deps);

    const ctx = {
      session: record.agent_device_session,
      platform: PLATFORM,
      target: record.target,
      runner: deps.runner,
      sleep: deps.sleep,
      clock: deps.clock,
      logPath: record.log_stream ?? record.metro?.log ?? null,
      readFile: deps.readFile,
    };

    const start = deps.clock();
    let failure = null;

    for (let i = 0; i < actions.length && !failure; i++) {
      try {
        await runAction(actions[i], ctx);
      } catch (err) {
        if (err instanceof AdapterError) throw err;
        if (isInfrastructureError(err)) {
          throw recoverable(`agent-device infrastructure failure during action[${i}] (${actions[i].kind}): ${err.message}`, {
            cause: err,
          });
        }
        failure = { phase: "action", index: i, reason: err.message };
      }
    }

    for (let i = 0; i < assertions.length && !failure; i++) {
      try {
        await runAssertion(assertions[i], ctx);
      } catch (err) {
        if (err instanceof AdapterError) throw err;
        if (isInfrastructureError(err)) {
          throw recoverable(
            `agent-device infrastructure failure during assertion[${i}] (${assertions[i].kind}): ${err.message}`,
            { cause: err }
          );
        }
        failure = { phase: "assertion", index: i, reason: err.message };
      }
    }

    const durationMs = deps.clock() - start;
    const screenshot = await captureScreenshot(ctx, deps, evidenceDir);
    const evidence = screenshot ? [screenshot] : [];

    if (failure) {
      const logTail = await readLogTail(ctx);
      return {
        status: "failed",
        failure: { ...failure, screenshot, log_tail: logTail },
        evidence,
      };
    }

    return { status: "passed", duration_ms: durationMs, evidence };
  }

  return { execute };
}

async function main() {
  await runMain({ interfaceName: INTERFACE, handlers: createHandlers() });
}

// Only run as a CLI when invoked directly (the E2E resolver spawns this file
// with `node`) — importing it for tests must not touch stdin.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
