import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile as fsReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMain, EXIT_OK, EXIT_RECOVERABLE, EXIT_FATAL } from "../lib/contract.js";
import { saveSession, loadSession } from "../lib/session.js";
import { reserveEntry, finalizeEntry, readManifest } from "../lib/evidence.js";
import { AgentDeviceError } from "../lib/agent-device.js";
import {
  createHandlers,
  actionArgv,
  pollUntil,
  isInfrastructureError,
  describeSelector,
  assertSessionAlive,
  DEFAULT_ASSERT_TIMEOUT_MS,
} from "../execute-step.js";

// ---- small pure helpers -----------------------------------------------

test("actionArgv: tap -> press <selector>", () => {
  assert.deepEqual(actionArgv({ kind: "tap", selector: { test_id: "checkout-cta" } }), ["press", 'id="checkout-cta"']);
});

test("actionArgv: type -> fill <selector> <text>", () => {
  assert.deepEqual(actionArgv({ kind: "type", selector: { label: "Email" }, text: "qa@example.com" }), [
    "fill",
    'label="Email"',
    "qa@example.com",
  ]);
});

test("actionArgv: scroll -> scroll <direction> [--scope <selector>]", () => {
  assert.deepEqual(actionArgv({ kind: "scroll", direction: "down" }), ["scroll", "down"]);
  assert.deepEqual(actionArgv({ kind: "scroll", direction: "up", selector: { test_id: "list" } }), [
    "scroll",
    "up",
    "--scope",
    'id="list"',
  ]);
});

test("actionArgv: press key -> back/keyboard mapping", () => {
  assert.deepEqual(actionArgv({ kind: "press", key: "back" }), ["back"]);
  assert.deepEqual(actionArgv({ kind: "press", key: "enter" }), ["keyboard", "enter"]);
  assert.deepEqual(actionArgv({ kind: "press", key: "return" }), ["keyboard", "enter"]);
  assert.deepEqual(actionArgv({ kind: "press", key: "dismiss" }), ["keyboard", "dismiss"]);
});

test("actionArgv: unsupported press key -> fatal (20)", () => {
  assert.throws(() => actionArgv({ kind: "press", key: "volume-up" }), (err) => {
    assert.equal(err.code, EXIT_FATAL);
    return true;
  });
});

test("actionArgv: unsupported action kind -> fatal (20)", () => {
  assert.throws(() => actionArgv({ kind: "swipe" }), (err) => {
    assert.equal(err.code, EXIT_FATAL);
    return true;
  });
});

test("describeSelector: renders the fixed test_id/label/text order", () => {
  assert.equal(describeSelector({ test_id: "x" }), "test_id=x");
  assert.equal(describeSelector({ label: "x" }), "label=x");
  assert.equal(describeSelector({ text: "x" }), "text=x");
});

test("actionArgv: a malformed selector (none of test_id/label/text) is fatal (20), like an unsupported kind", () => {
  assert.throws(() => actionArgv({ kind: "tap", selector: { role: "button" } }), (err) => {
    assert.equal(err.code, EXIT_FATAL);
    assert.match(err.message, /malformed selector/);
    return true;
  });
});

test("isInfrastructureError: a normal command failure (stderr/stdout set) classifies on the driver's own diagnostic", () => {
  assert.equal(isInfrastructureError(new Error("plain error")), false);
  // A realistic non-zero-exit AgentDeviceError always carries stderr/stdout
  // (see lib/agent-device.js's `invoke`, the `result.code !== 0` branch) —
  // an ordinary "selector didn't resolve" failure is not infrastructure.
  assert.equal(
    isInfrastructureError(
      new AgentDeviceError('agent-device press id="checkout-cta" exited 1: Selector did not resolve uniquely', {
        stderr: "Selector did not resolve uniquely",
        stdout: "",
      })
    ),
    false
  );
  assert.equal(
    isInfrastructureError(
      new AgentDeviceError("agent-device press ... exited 1: agent-device daemon not running", {
        stderr: "agent-device daemon not running",
        stdout: "",
      })
    ),
    true
  );
  assert.equal(
    isInfrastructureError(
      new AgentDeviceError("boom", { stderr: "Simulator device is not booted", stdout: "" })
    ),
    true
  );
});

// Finding #1 (MED, false-positive direction): the echoed command line in
// `.message` must never be consulted — only the driver's own stderr/stdout.
// A UI element whose own label/text happens to contain an infra-sounding
// word ("Restart daemon") must still resolve as an ordinary step failure.
test("isInfrastructureError: a selector whose own text/label contains an infra-sounding word is NOT infrastructure — only .message is polluted, stderr is the real (unrelated) failure", () => {
  const err = new AgentDeviceError(
    'agent-device press text="Restart daemon" --platform ios --device "iPhone 15" --session s exited 1: Selector did not resolve uniquely (text="Restart daemon")',
    { stderr: 'Selector did not resolve uniquely (text="Restart daemon")', stdout: "" }
  );
  assert.match(err.message, /daemon/, "sanity: the echoed command line does carry the trigger word");
  assert.equal(isInfrastructureError(err), false);
});

// Finding #2 (MED, false-negative direction): a spawn-level failure never
// reached a real process exit, so `invoke`'s `result.error` branch sets only
// {command, code} on the AgentDeviceError — no stderr/stdout keys at all.
// That must be infrastructure unconditionally, regardless of message text.
test("isInfrastructureError: a spawn-level failure (ENOENT/EACCES/ETIMEDOUT — no stderr/stdout captured) is infra unconditionally", () => {
  const spawnEnoent = new AgentDeviceError("agent-device press id=\"x\": spawn agent-device ENOENT", {
    command: "agent-device press id=\"x\"",
    code: 1,
  });
  assert.equal(spawnEnoent.stderr, undefined);
  assert.equal(spawnEnoent.stdout, undefined);
  assert.equal(isInfrastructureError(spawnEnoent), true);
});

test("pollUntil: returns as soon as check reports ok, without waiting out the full timeout", async () => {
  let calls = 0;
  let t = 0;
  const result = await pollUntil(
    async () => {
      calls += 1;
      return { ok: calls === 2 };
    },
    { timeoutMs: 10_000, sleep: async () => { t += 250; }, clock: () => t }
  );
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test("pollUntil: gives up once the deadline passes, returning the last failing result", async () => {
  let calls = 0;
  let t = 0;
  const result = await pollUntil(
    async () => {
      calls += 1;
      return { ok: false, error: new Error(`attempt ${calls}`) };
    },
    { timeoutMs: 1000, intervalMs: 250, sleep: async () => { t += 250; }, clock: () => t }
  );
  assert.equal(result.ok, false);
  assert.ok(calls >= 4, "should have polled multiple times across the 1000ms/250ms window");
});

// ---- fixtures -----------------------------------------------------------

async function withDirs(fn) {
  const stateDir = await mkdtemp(join(tmpdir(), "agentflow-expo-xstep-state-"));
  const evidenceDir = await mkdtemp(join(tmpdir(), "agentflow-expo-xstep-evidence-"));
  try {
    await fn({ stateDir, evidenceDir });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(evidenceDir, { recursive: true, force: true });
  }
}

function baseRecord(overrides = {}) {
  return {
    session_id: "sess-fixed",
    workspace: "/ws",
    target: "iPhone 15",
    profile: "dev",
    bundle_id: "com.example.app",
    agent_device_session: "agentflow-run-sess-fixed",
    start_path: "reuse",
    metro: { pid: 4242, port: 8081, log: "/tmp/app.log", identity: "identity-token-4242" },
    entry_point: "exp://127.0.0.1:8081",
    log_stream: "/tmp/app.log",
    evidence_dir: null,
    state: "running",
    ...overrides,
  };
}

function makeRunner(dispatch) {
  const calls = [];
  return {
    calls,
    exec: async (_cmd, args) => {
      const result = await dispatch(_cmd, args, calls.length);
      calls.push({ cmd: _cmd, args });
      return result;
    },
  };
}

function okResult(stdout = "{}") {
  return { code: 0, stdout, stderr: "", error: null };
}

function failResult(stderr) {
  return { code: 1, stdout: "", stderr, error: null };
}

// A live `agent-device <cmd> --json` success reply is enveloped
// `{success:true, data:{...}}` — this is what the *real* runner's stdout
// looks like at the process boundary (before lib/agent-device.js's `invoke`
// unwraps it). `okResult(JSON.stringify({text:...}))` used above (pre-#164)
// mocked the WRONG, unenveloped shape — the same shape `assertText`'s bug
// accidentally expected, so that mock never caught the real defect. Tests
// that touch a data-bearing read (`get text`) go through this helper now;
// tests that only care about exit-code semantics (`is`, `press`, `wait`,
// `fill`, `screenshot`) can keep using bare `okResult()` since their body is
// never inspected.
function envelopeOk(data) {
  return okResult(JSON.stringify({ success: true, data }));
}

// The real `{success:false, error:{...}}` failure body agent-device writes
// even at exit 0 for a daemon-level "the command didn't really work" (see
// lib/agent-device.js's `unwrap` header) — distinct from `failResult`, which
// models an ordinary non-zero-exit command failure.
function envelopeFailAtExit0(code, message) {
  return okResult(JSON.stringify({ success: false, error: { code, message } }));
}

function fakeClock(step = 10) {
  let t = 0;
  return { clock: () => t, sleep: async () => { t += step; } };
}

function baseDeps({ stateDir, runner, readFile } = {}) {
  const { clock, sleep } = fakeClock();
  return {
    runner: runner ?? makeRunner(async () => okResult()),
    isAlive: async () => true,
    loadSession: (id) => loadSession(id, { stateDir }),
    reserveEntry,
    finalizeEntry,
    readFile: readFile ?? (async () => ""),
    sleep,
    clock,
    stderr: { write: () => {} },
  };
}

// ---- session liveness pre-flight ----------------------------------------

test("assertSessionAlive: a stopped session is recoverable (10), never a step verdict", async () => {
  await assert.rejects(
    () => assertSessionAlive(baseRecord({ state: "stopped" }), "sess-fixed", { isAlive: async () => true, runner: {} }),
    (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
  );
});

test("assertSessionAlive: Metro pid no longer identity-matches -> recoverable (10)", async () => {
  await assert.rejects(
    () => assertSessionAlive(baseRecord(), "sess-fixed", { isAlive: async () => false, runner: {} }),
    (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
  );
});

test("assertSessionAlive: running with a live Metro pid resolves cleanly", async () => {
  await assertSessionAlive(baseRecord(), "sess-fixed", { isAlive: async () => true, runner: {} });
});

// ---- execute: full flows via createHandlers ------------------------------

async function saveFixture(stateDir, overrides) {
  return saveSession(baseRecord(overrides), { stateDir });
}

test("execute: unknown session_id -> exit 20 (fatal)", async () => {
  await withDirs(async ({ stateDir }) => {
    const deps = baseDeps({ stateDir });
    const handlers = createHandlers(deps);
    await assert.rejects(
      () => handlers.execute({ op: "execute", session_id: "sess-nope", step: {}, trace: {} }),
      (err) => { assert.equal(err.code, EXIT_FATAL); return true; }
    );
  });
});

test("execute: a corrupt session state file is recoverable (10), not misreported as unknown", async () => {
  await withDirs(async ({ stateDir }) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(stateDir, "sess-broken.json"), "{not json");
    const deps = baseDeps({ stateDir });
    const handlers = createHandlers(deps);
    await assert.rejects(
      () => handlers.execute({ op: "execute", session_id: "sess-broken", step: {}, trace: {} }),
      (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
    );
  });
});

test("execute: a dead session (Metro pid gone) is recoverable (10) before any action runs", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async () => okResult());
    const deps = baseDeps({ stateDir, runner });
    deps.isAlive = async () => false;
    const handlers = createHandlers(deps);
    await assert.rejects(
      () =>
        handlers.execute({
          op: "execute",
          session_id: "sess-fixed",
          step: { keyword: "when", text: "x" },
          trace: { actions: [{ kind: "tap", selector: { test_id: "x" } }], assertions: [] },
        }),
      (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
    );
    assert.equal(runner.calls.length, 0, "no agent-device invocation should happen once the session is dead");
  });
});

test("execute: a stopped session is recoverable (10)", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir, { state: "stopped" });
    const deps = baseDeps({ stateDir });
    const handlers = createHandlers(deps);
    await assert.rejects(
      () => handlers.execute({ op: "execute", session_id: "sess-fixed", step: {}, trace: {} }),
      (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
    );
  });
});

test("execute: full passing trace -> status passed, duration_ms, one evidence screenshot", async () => {
  await withDirs(async ({ stateDir, evidenceDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async (_cmd, args) => {
      // Real envelope shape — `{success:true, data:{selector,text,node}}`
      // (confirmed live, #164) — not the bare `{text:...}` the pre-fix mock
      // used, which happened to match assertText's bug rather than reality.
      if (args[1] === "text") return envelopeOk({ selector: 'id="order-summary"', text: "Order summary", node: {} });
      return okResult();
    });
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: { keyword: "when", text: 'the user taps "Checkout"' },
      evidence_dir: evidenceDir,
      trace: {
        actions: [
          { kind: "wait", until: { selector: { test_id: "checkout-cta" } }, timeout_ms: 5000 },
          { kind: "tap", selector: { test_id: "checkout-cta" } },
        ],
        assertions: [
          { kind: "visible", selector: { test_id: "order-summary" }, timeout_ms: 5000 },
          { kind: "text", selector: { test_id: "order-summary" }, contains: "Order" },
        ],
      },
    });

    assert.equal(response.status, "passed");
    assert.equal(typeof response.duration_ms, "number");
    assert.ok(response.duration_ms >= 0);
    assert.equal(response.evidence.length, 1);
    assert.match(response.evidence[0], /0001\.png$/);

    const manifest = JSON.parse(await fsReadFile(join(evidenceDir, "manifest.json"), "utf8"));
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].type, "screenshot");

    // wait, press, is visible, get text, screenshot -> 5 agent-device calls.
    assert.equal(runner.calls.length, 5);
    assert.deepEqual(runner.calls[0].args.slice(0, 3), ["wait", 'id="checkout-cta"', "5000"]);
    assert.deepEqual(runner.calls[1].args.slice(0, 2), ["press", 'id="checkout-cta"']);
    assert.deepEqual(runner.calls[2].args.slice(0, 3), ["is", "visible", 'id="order-summary"']);
    assert.deepEqual(runner.calls[3].args.slice(0, 3), ["get", "text", 'id="order-summary"']);
    assert.equal(runner.calls[4].args[0], "screenshot");
  });
});

test("execute: action failure at index 1 -> status failed, phase action, correct index/reason/screenshot/log_tail", async () => {
  await withDirs(async ({ stateDir, evidenceDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async (_cmd, args) => {
      if (args[0] === "press") return failResult("Selector did not resolve uniquely: id=\"checkout-cta\"");
      return okResult();
    });
    const deps = baseDeps({
      stateDir,
      runner,
      readFile: async () => "line1\nline2\nERROR boom\n",
    });
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      evidence_dir: evidenceDir,
      trace: {
        actions: [
          { kind: "wait", until: { selector: { test_id: "checkout-cta" } }, timeout_ms: 1000 },
          { kind: "tap", selector: { test_id: "checkout-cta" } },
        ],
        assertions: [{ kind: "visible", selector: { test_id: "order-summary" } }],
      },
    });

    assert.equal(response.status, "failed");
    assert.equal(response.failure.phase, "action");
    assert.equal(response.failure.index, 1);
    assert.match(response.failure.reason, /Selector did not resolve/);
    assert.match(response.failure.screenshot, /0001\.png$/);
    assert.deepEqual(response.failure.log_tail, ["line1", "line2", "ERROR boom"]);
    assert.equal(response.evidence.length, 1);

    // wait, press (fails) -> assertions never run, then screenshot.
    assert.deepEqual(
      runner.calls.map((c) => c.args[0]),
      ["wait", "press", "screenshot"]
    );
  });
});

// #164 family sweep, defense-in-depth: every plain action (tap/type/scroll/
// press/wait) discards `invoke()`'s return and only reacts to a throw, so
// like `assertVisible` this was never the #164 bug itself, but it also
// never called `unwrap`. A `{success:false}` body at exit 0 used to be
// indistinguishable from success here; since #164, `invoke()`'s default
// unwrap throws for that shape too, so it now reports as a real action
// failure instead of silently continuing to the next action/assertion.
test("execute: an action reporting success:false at exit 0 fails the step, never silently continues", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async (_cmd, args) => {
      if (args[0] === "press") {
        return envelopeFailAtExit0("COMMAND_FAILED", "no visible effect");
      }
      return okResult();
    });
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      trace: {
        actions: [{ kind: "tap", selector: { test_id: "checkout-cta" } }],
        assertions: [],
      },
    });

    assert.equal(response.status, "failed");
    assert.equal(response.failure.phase, "action");
    assert.equal(response.failure.index, 0);
  });
});

test("execute: assertion failure -> status failed, phase assertion, correct index", async () => {
  await withDirs(async ({ stateDir, evidenceDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async (_cmd, args) => {
      if (args[0] === "is") return failResult("selector not visible");
      return okResult();
    });
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      evidence_dir: evidenceDir,
      trace: {
        actions: [{ kind: "tap", selector: { test_id: "checkout-cta" } }],
        assertions: [{ kind: "visible", selector: { test_id: "order-summary" }, timeout_ms: 500 }],
      },
    });

    assert.equal(response.status, "failed");
    assert.equal(response.failure.phase, "assertion");
    assert.equal(response.failure.index, 0);
    assert.match(response.failure.reason, /is not visible within 500ms/);
  });
});

// #164 family sweep, defense-in-depth: `assertVisible` never reads `is`'s
// response body (a real agent-device always signals a false predicate via a
// non-zero exit — confirmed live during this audit), so it was never the
// #164 bug itself. But it also never called `unwrap`, so a hypothetical
// `{success:false}` body arriving at exit 0 (the daemon-level failure mode
// lib/agent-device.js's `unwrap` header describes) would have silently read
// as "the invoke didn't throw" -> assertion passed. Since #164, `invoke()`
// applies `unwrap` by default, so this now surfaces as a real assertion
// failure instead.
test("execute: `is` reporting success:false at exit 0 fails the assertion, never silently reads as passed", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async (_cmd, args) => {
      if (args[0] === "is") {
        return envelopeFailAtExit0("COMMAND_FAILED", "no visible effect");
      }
      return okResult();
    });
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      trace: {
        actions: [],
        assertions: [{ kind: "visible", selector: { test_id: "order-summary" }, timeout_ms: 100 }],
      },
    });

    assert.equal(response.status, "failed");
    assert.equal(response.failure.phase, "assertion");
  });
});

test("execute: not_visible assertion -> `is hidden <selector>`", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async () => okResult());
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      trace: { actions: [], assertions: [{ kind: "not_visible", selector: { label: "Spinner" } }] },
    });

    assert.equal(response.status, "passed");
    assert.deepEqual(runner.calls[0].args.slice(0, 3), ["is", "hidden", 'label="Spinner"']);
  });
});

test("execute: text assertion (equals) fails and reports the last-read text", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async (_cmd, args) => {
      // Real envelope shape (#164) — see envelopeOk's own comment.
      if (args[0] === "get") return envelopeOk({ selector: 'id="status"', text: "Pending", node: {} });
      return okResult();
    });
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      trace: {
        actions: [],
        assertions: [{ kind: "text", selector: { test_id: "status" }, equals: "Confirmed", timeout_ms: 100 }],
      },
    });

    assert.equal(response.status, "failed");
    assert.equal(response.failure.phase, "assertion");
    assert.match(response.failure.reason, /equal "Confirmed"/);
    assert.match(response.failure.reason, /"Pending"/);
  });
});

// #164, pinned to the EXACT payload from the issue's own live repro: a
// `agent-device get text 'id="acceptance-count"' --json` reply against a
// real booted simulator —
//   {"success":true,"data":{"selector":"id=\"acceptance-count\"","text":"Tapped: 2","node":{...}}}
// — for a `contains: "2"` assertion. Pre-fix, `assertText` read `res.text`
// off this raw envelope (always `undefined` at the top level — the real
// value lives at `res.data.text`), so `extractText` fell through to `""`
// and this assertion failed on every single poll, regardless of the real
// on-screen state (screenshot-proven correct in the issue). This test fails
// against the pre-fix code and passes against the fix.
test("execute: text assertion (contains) reads the real .data.text, not the raw envelope (#164 exact repro payload)", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async (_cmd, args) => {
      if (args[0] === "get" && args[1] === "text") {
        return okResult(
          JSON.stringify({
            success: true,
            data: {
              selector: 'id="acceptance-count"',
              text: "Tapped: 2",
              node: { index: 4, type: "StaticText", label: "Tapped: 2", ref: "e5" },
            },
          })
        );
      }
      return okResult();
    });
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      trace: {
        actions: [],
        assertions: [{ kind: "text", selector: { test_id: "acceptance-count" }, contains: "2", timeout_ms: 100 }],
      },
    });

    assert.equal(response.status, "passed");
  });
});

test("execute: log_contains assertion reads the session's log via the injected read seam, no agent-device call", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir, { log_stream: "/fake/app.log" });
    const runner = makeRunner(async () => okResult());
    let readPath = null;
    const deps = baseDeps({
      stateDir,
      runner,
      readFile: async (p) => { readPath = p; return "boot ok\nBundle loaded successfully\n"; },
    });
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      trace: { actions: [], assertions: [{ kind: "log_contains", pattern: "Bundle loaded" }] },
    });

    assert.equal(response.status, "passed");
    assert.equal(readPath, "/fake/app.log");
    // only the screenshot call touches agent-device; log_contains itself does not.
    assert.deepEqual(runner.calls.map((c) => c.args[0]).filter((c) => c !== "screenshot"), []);
  });
});

test("execute: log_contains assertion failure names the log path and pattern", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir, { log_stream: "/fake/app.log" });
    const deps = baseDeps({ stateDir, readFile: async () => "nothing interesting\n" });
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      trace: { actions: [], assertions: [{ kind: "log_contains", pattern: "Bundle loaded", timeout_ms: 20 }] },
    });

    assert.equal(response.status, "failed");
    assert.match(response.failure.reason, /\/fake\/app\.log/);
    assert.match(response.failure.reason, /"Bundle loaded"/);
  });
});

test("execute: navigate action reuses lib's openSession (open <url> with session/platform/device)", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async () => okResult());
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);

    await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      trace: { actions: [{ kind: "navigate", url: "exp://127.0.0.1:8081/--/checkout" }], assertions: [] },
    });

    assert.equal(runner.calls[0].args[0], "open");
    assert.equal(runner.calls[0].args[1], "exp://127.0.0.1:8081/--/checkout");
    assert.ok(runner.calls[0].args.includes("--session"));
    assert.ok(runner.calls[0].args.includes("agentflow-run-sess-fixed"));
  });
});

test("execute: unsupported action kind escalates fatal (20), never a step failure", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir);
    const deps = baseDeps({ stateDir });
    const handlers = createHandlers(deps);
    await assert.rejects(
      () =>
        handlers.execute({
          op: "execute",
          session_id: "sess-fixed",
          step: {},
          trace: { actions: [{ kind: "swipe" }], assertions: [] },
        }),
      (err) => { assert.equal(err.code, EXIT_FATAL); return true; }
    );
  });
});

test("execute: a malformed selector (action) escalates fatal (20), like an unsupported kind — not a step failure", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir);
    const deps = baseDeps({ stateDir });
    const handlers = createHandlers(deps);
    await assert.rejects(
      () =>
        handlers.execute({
          op: "execute",
          session_id: "sess-fixed",
          step: {},
          trace: { actions: [{ kind: "tap", selector: { role: "button" } }], assertions: [] },
        }),
      (err) => { assert.equal(err.code, EXIT_FATAL); assert.match(err.message, /malformed selector/); return true; }
    );
  });
});

test("execute: a malformed selector (assertion) escalates fatal (20), like an unsupported kind — not a step failure", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir);
    const deps = baseDeps({ stateDir });
    const handlers = createHandlers(deps);
    await assert.rejects(
      () =>
        handlers.execute({
          op: "execute",
          session_id: "sess-fixed",
          step: {},
          trace: { actions: [], assertions: [{ kind: "visible", selector: {} }] },
        }),
      (err) => { assert.equal(err.code, EXIT_FATAL); assert.match(err.message, /malformed selector/); return true; }
    );
  });
});

// ---- infrastructure vs step failure --------------------------------------

// Finding #1 integration case: a selector whose own accessible text/label
// contains an infra-sounding word must NOT flip this to infrastructure — the
// echoed command line (which lib/agent-device.js's `invoke` puts in
// `.message`) is never consulted, only the driver's real stderr.
test("execute: a selector's own text containing an infra-sounding word ('Restart daemon') still resolves as an ordinary step failure", async () => {
  await withDirs(async ({ stateDir, evidenceDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async (_cmd, args) =>
      args[0] === "press" ? failResult('Selector did not resolve uniquely (text="Restart daemon")') : okResult()
    );
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      evidence_dir: evidenceDir,
      trace: { actions: [{ kind: "tap", selector: { text: "Restart daemon" } }], assertions: [] },
    });

    assert.equal(response.status, "failed");
    assert.equal(response.failure.phase, "action");
    assert.match(response.failure.reason, /Selector did not resolve/);
  });
});

// Finding #2 integration case: a spawn-level failure (agent-device binary
// itself unreachable — ENOENT) never reached a real process exit, so it must
// escalate as infrastructure unconditionally, not fall through to a step
// failure just because its message happens to carry no recognised keyword.
test("execute: a spawn-level failure (ENOENT — agent-device itself unreachable) escalates AdapterError(10) unconditionally", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir);
    const runner = {
      calls: [],
      exec: async (_cmd, args) => {
        runner.calls.push({ cmd: _cmd, args });
        return { code: 1, stdout: "", stderr: "", error: new Error("spawn agent-device ENOENT") };
      },
    };
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);

    await assert.rejects(
      () =>
        handlers.execute({
          op: "execute",
          session_id: "sess-fixed",
          step: {},
          trace: { actions: [{ kind: "tap", selector: { test_id: "x" } }], assertions: [] },
        }),
      (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
    );
  });
});

test("execute: an infrastructure signature mid-replay escalates AdapterError(10), NOT status:failed", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async (_cmd, args) => {
      if (args[0] === "press") return failResult("agent-device: daemon not running (state dir stale)");
      return okResult();
    });
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);

    await assert.rejects(
      () =>
        handlers.execute({
          op: "execute",
          session_id: "sess-fixed",
          step: {},
          trace: {
            actions: [
              { kind: "wait", until: { selector: { test_id: "x" } }, timeout_ms: 100 },
              { kind: "tap", selector: { test_id: "x" } },
            ],
            assertions: [],
          },
        }),
      (err) => {
        assert.equal(err.code, EXIT_RECOVERABLE);
        assert.match(err.message, /daemon not running/);
        return true;
      }
    );
  });
});

test("execute: an infrastructure signature during an assertion also escalates instead of polling to a false verdict", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async (_cmd, args) =>
      args[0] === "is" ? failResult("simulator is not booted") : okResult()
    );
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);

    await assert.rejects(
      () =>
        handlers.execute({
          op: "execute",
          session_id: "sess-fixed",
          step: {},
          trace: { actions: [], assertions: [{ kind: "visible", selector: { test_id: "x" }, timeout_ms: 1000 }] },
        }),
      (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
    );
    assert.equal(runner.calls.filter((c) => c.args[0] === "is").length, 1, "must not keep polling an infra failure");
  });
});

// ---- timeout semantics ----------------------------------------------------

test("execute: wait action timeout is a single agent-device call, reported as an action failure (not polled by us)", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async (_cmd, args) =>
      args[0] === "wait" ? failResult("timed out after 250ms waiting for id=\"x\"") : okResult()
    );
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      trace: { actions: [{ kind: "wait", until: { selector: { test_id: "x" } }, timeout_ms: 250 }], assertions: [] },
    });

    assert.equal(response.status, "failed");
    assert.equal(response.failure.phase, "action");
    assert.equal(runner.calls.filter((c) => c.args[0] === "wait").length, 1);
  });
});

test("execute: assertion polling retries until timeout_ms elapses, using the injected clock/sleep seam", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async () => failResult("not visible yet"));
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      trace: { actions: [], assertions: [{ kind: "visible", selector: { test_id: "x" }, timeout_ms: 40 }] },
    });

    assert.equal(response.status, "failed");
    // fakeClock advances 10ms per sleep; timeout_ms 40 -> polls at t=0,10,20,30,40 (5 attempts) before giving up.
    assert.ok(runner.calls.filter((c) => c.args[0] === "is").length >= 2, "must poll more than once before failing");
  });
});

test("execute: assertion default timeout is used when timeout_ms is omitted", async () => {
  await withDirs(async ({ stateDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async () => okResult());
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      trace: { actions: [], assertions: [{ kind: "visible", selector: { test_id: "x" } }] },
    });
    assert.equal(response.status, "passed");
    assert.equal(DEFAULT_ASSERT_TIMEOUT_MS, 5000);
  });
});

// ---- screenshot capture is best-effort ------------------------------------

test("execute: a screenshot capture failure does not mask a passing verdict, just leaves evidence empty — and finalizes the reserved row as 'failed', not a dangling ghost", async () => {
  await withDirs(async ({ stateDir, evidenceDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async (_cmd, args) =>
      args[0] === "screenshot" ? failResult("agent-device: no such command") : okResult()
    );
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      evidence_dir: evidenceDir,
      trace: { actions: [], assertions: [] },
    });

    assert.equal(response.status, "passed");
    assert.deepEqual(response.evidence, []);
    // #139: reserveEntry's row lands before the capture it names runs — a
    // capture failure after that must finalize the row "failed", an honest
    // record, rather than leaving it stuck at "reserved" forever.
    const manifest = await readManifest(evidenceDir);
    assert.equal(manifest.length, 1, "the reservation itself still landed a row");
    assert.equal(manifest[0].status, "failed");
  });
});

// Finding #3 (execute-step.js, pre-#139): the screenshot invoke AND its
// manifest bookkeeping shared one try/catch — a manifest-write failure
// (read-only evidence_dir, disk full, ...) must never throw out of
// captureScreenshot and mask the step's actual verdict. #139 moved the
// bookkeeping to reserveEntry/finalizeEntry (shared with verify.js); the
// failure now happens at the RESERVATION step instead of an append after
// capture, so these override `reserveEntry`, not `appendManifest`. Exercised
// for both a passing and a failing step so the fix isn't accidentally
// scoped to only one code path.
test("execute: a manifest reservation failure (e.g. read-only evidence_dir) does not mask a passing verdict", async () => {
  await withDirs(async ({ stateDir, evidenceDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async () => okResult());
    const deps = baseDeps({ stateDir, runner });
    deps.reserveEntry = async () => { throw new Error("EACCES: permission denied, open 'manifest.json'"); };
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      evidence_dir: evidenceDir,
      trace: { actions: [], assertions: [] },
    });

    assert.equal(response.status, "passed");
    assert.deepEqual(response.evidence, [], "screenshot is not reported as evidence if it was never durably recorded");
  });
});

test("execute: a manifest reservation failure does not mask a failing verdict either", async () => {
  await withDirs(async ({ stateDir, evidenceDir }) => {
    await saveFixture(stateDir);
    const runner = makeRunner(async (_cmd, args) => (args[0] === "press" ? failResult("Selector did not resolve") : okResult()));
    const deps = baseDeps({ stateDir, runner });
    deps.reserveEntry = async () => { throw new Error("EACCES: permission denied, open 'manifest.json'"); };
    const handlers = createHandlers(deps);

    const response = await handlers.execute({
      op: "execute",
      session_id: "sess-fixed",
      step: {},
      evidence_dir: evidenceDir,
      trace: { actions: [{ kind: "tap", selector: { test_id: "x" } }], assertions: [] },
    });

    assert.equal(response.status, "failed");
    assert.equal(response.failure.phase, "action");
    assert.equal(response.failure.screenshot, null, "screenshot is null, not a path never recorded to the manifest");
    assert.deepEqual(response.evidence, []);
  });
});

// ---- end-to-end through runMain -------------------------------------------

test("runMain + createHandlers: describe -> {interface:\"execute-step\", interface_version:\"1\"}, exit 0", async () => {
  const stdout = { chunks: [], write(s) { this.chunks.push(s); } };
  let exitCode;
  await runMain({
    interfaceName: "execute-step",
    handlers: createHandlers(),
    stdin: [JSON.stringify({ op: "describe" })],
    stdout,
    stderr: { write: () => {} },
    exit: (c) => (exitCode = c),
  });
  assert.equal(exitCode, EXIT_OK);
  assert.deepEqual(JSON.parse(stdout.chunks.join("")), { interface: "execute-step", interface_version: "1" });
});

test("runMain + createHandlers: a fatal execute (unknown session) exits 20 with a JSON error body on stdout", async () => {
  await withDirs(async ({ stateDir }) => {
    const stdout = { chunks: [], write(s) { this.chunks.push(s); } };
    let exitCode;
    const deps = baseDeps({ stateDir });
    await runMain({
      interfaceName: "execute-step",
      handlers: createHandlers(deps),
      stdin: [JSON.stringify({ op: "execute", session_id: "sess-nope", step: {}, trace: {} })],
      stdout,
      stderr: { write: () => {} },
      exit: (c) => (exitCode = c),
    });
    assert.equal(exitCode, EXIT_FATAL);
    assert.ok(JSON.parse(stdout.chunks.join("")).error);
  });
});
