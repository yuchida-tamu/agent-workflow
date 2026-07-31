import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMain, EXIT_OK, EXIT_RECOVERABLE, EXIT_FATAL } from "../lib/contract.js";
import { appendManifest, readManifest, reserveEntry, finalizeEntry, MANIFEST_FILE } from "../lib/evidence.js";
import {
  unwrap,
  normalizeElements,
  resolveActionTarget,
  mapPressKey,
  tailLines,
  requireRunningSession,
  createHandlers,
} from "../verify.js";

// ---- fixtures -------------------------------------------------------------

const RUNNING_RECORD = {
  session_id: "sess-abc123",
  workspace: "/ws",
  target: "iPhone 15",
  profile: "dev",
  bundle_id: "com.example.app",
  agent_device_session: "agentflow-run-sess-abc123",
  start_path: "reuse",
  metro: { pid: 4242, port: 8081, log: "/tmp/app.log", identity: "identity-token" },
  entry_point: "exp://127.0.0.1:8081",
  log_stream: "/tmp/app.log",
  evidence_dir: null,
  state: "running",
};

// A canned `agent-device snapshot -i --json` response, shaped exactly like a
// live 0.19.3 daemon's reply (verified against a real iOS simulator session
// during implementation): enveloped `{success, data:{nodes:[...]}}`, already
// flat (parentIndex/depth, not nested children), `ref` bare ("e12", no "@"),
// `identifier` carrying the RN testID, `value` carrying a control's state.
const CANNED_SNAPSHOT = {
  success: true,
  data: {
    nodes: [
      {
        ref: "e1",
        type: "Application",
        label: "MyApp",
        rect: { x: 0, y: 0, width: 393, height: 852 },
        hittable: true,
        enabled: true,
        index: 0,
        depth: 0,
      },
      {
        ref: "e12",
        type: "Button",
        label: "Checkout",
        identifier: "checkout-cta",
        rect: { x: 10, y: 20, width: 100, height: 44 },
        hittable: true,
        enabled: true,
        index: 1,
        parentIndex: 0,
        depth: 1,
      },
      {
        ref: "e13",
        type: "Switch",
        label: "Notifications",
        value: "1",
        rect: { x: 1, y: 2, width: 3, height: 4 },
        hittable: true,
        enabled: true,
        index: 2,
        parentIndex: 0,
        depth: 1,
      },
    ],
  },
};

function jsonOk(data) {
  return { code: 0, stdout: JSON.stringify({ success: true, data }), stderr: "", error: null };
}

function jsonFail(code, message) {
  return {
    code: 1,
    stdout: JSON.stringify({ success: false, error: { code, message } }),
    stderr: "",
    error: null,
  };
}

// Dispatches by agent-device subcommand (args[0]); each script fn receives
// (args) and returns a runner result. Default: an empty ok envelope.
function fakeRunner(script = {}) {
  const calls = [];
  return {
    calls,
    exec: async (cmd, args) => {
      calls.push({ cmd, args });
      const handler = script[args[0]];
      if (handler) return handler(args);
      return jsonOk({});
    },
  };
}

function baseDeps(overrides = {}) {
  return {
    runner: fakeRunner(),
    loadSession: async () => RUNNING_RECORD,
    readFile: async () => "",
    // A no-evidence_dir-shaped default: captureScreenshot only calls this
    // when a request actually carries evidence_dir, so most tests never
    // exercise it. Tests that care about numbering/manifest content pass
    // the real `reserveEntry` against a tmp dir instead (see withTempDir).
    reserveEntry: async (dir, { type, ext, label }) => ({ type, path: join(dir, `mock${ext}`), label, status: "reserved" }),
    finalizeEntry: async () => null,
    stderr: { write: () => {} },
    ...overrides,
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "agentflow-expo-verify-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- pure helpers -----------------------------------------------------

test("unwrap: pulls .data out of the {success,data} envelope", () => {
  assert.deepEqual(unwrap({ success: true, data: { nodes: [] } }), { nodes: [] });
});

test("unwrap: passes through a shape with no .data untouched", () => {
  assert.deepEqual(unwrap({ nodes: [] }), { nodes: [] });
  assert.equal(unwrap(null), null);
});

test("unwrap: success:false is an error even at exit 0 — never silently yields empty data", () => {
  assert.throws(
    () => unwrap({ success: false, error: { code: "COMMAND_FAILED", message: "no visible effect" } }),
    (err) => {
      assert.equal(err.name, "AgentDeviceError");
      assert.match(err.message, /COMMAND_FAILED/);
      assert.match(err.message, /no visible effect/);
      return true;
    }
  );
});

test("unwrap: success:false with no error body still throws, not a silent pass-through", () => {
  assert.throws(() => unwrap({ success: false }), /success:false/);
});

test("normalizeElements: maps agent-device nodes to the contract element shape, one-to-one", () => {
  const elements = normalizeElements(CANNED_SNAPSHOT);
  assert.equal(elements.length, 3);
  assert.deepEqual(elements[1], {
    ref: "e12",
    role: "button",
    label: "Checkout",
    test_id: "checkout-cta",
    text: "Checkout",
    bounds: [10, 20, 100, 44],
  });
});

test("normalizeElements: value (a control's live state) wins over label for text", () => {
  const elements = normalizeElements(CANNED_SNAPSHOT);
  assert.equal(elements[2].text, "1");
  assert.equal(elements[2].label, "Notifications");
  assert.equal(elements[2].test_id, null, "no identifier on this node");
});

test("normalizeElements: no nodes -> empty array, not a throw", () => {
  assert.deepEqual(normalizeElements({ success: true, data: {} }), []);
});

test("resolveActionTarget: ref wins, translated with the CLI's @ prefix", () => {
  assert.equal(resolveActionTarget({ kind: "tap", ref: "e12" }), "@e12");
});

test("resolveActionTarget: selector resolves via the fixed test_id -> label -> text order", () => {
  assert.equal(resolveActionTarget({ kind: "tap", selector: { test_id: "checkout-cta" } }), 'id="checkout-cta"');
  assert.equal(resolveActionTarget({ kind: "tap", selector: { label: "Checkout" } }), 'label="Checkout"');
});

test("resolveActionTarget: neither ref nor selector -> null", () => {
  assert.equal(resolveActionTarget({ kind: "type", text: "hi" }), null);
});

test("mapPressKey: enter/return/dismiss route through `keyboard`", () => {
  assert.deepEqual(mapPressKey("enter"), ["keyboard", "enter"]);
  assert.deepEqual(mapPressKey("return"), ["keyboard", "return"]);
  assert.deepEqual(mapPressKey("dismiss"), ["keyboard", "dismiss"]);
});

test("mapPressKey: back/home are top-level device navigation commands", () => {
  assert.deepEqual(mapPressKey("back"), ["back"]);
  assert.deepEqual(mapPressKey("home"), ["home"]);
});

test("mapPressKey: an unsupported key is fatal (20), not a silent no-op", () => {
  assert.throws(() => mapPressKey("volume-up"), (err) => {
    assert.equal(err.code, EXIT_FATAL);
    return true;
  });
  assert.throws(() => mapPressKey(undefined), (err) => {
    assert.equal(err.code, EXIT_FATAL);
    return true;
  });
});

test("tailLines: keeps only the last N lines", () => {
  assert.deepEqual(tailLines("a\nb\nc\nd\n", 2), ["c", "d"]);
});

test("tailLines: strips exactly one trailing newline, not trailing blank lines", () => {
  assert.deepEqual(tailLines("a\nb\n", 10), ["a", "b"]);
  assert.deepEqual(tailLines("a\n\nb\n", 10), ["a", "", "b"]);
});

test("tailLines: n larger than the file, or no n at all, returns everything", () => {
  assert.deepEqual(tailLines("a\nb\n", 100), ["a", "b"]);
  assert.deepEqual(tailLines("a\nb\n", undefined), ["a", "b"]);
});

// ---- requireRunningSession: the shared error-mapping seam ----------------

test("requireRunningSession: no session_id -> fatal (20)", async () => {
  await assert.rejects(
    () => requireRunningSession(undefined, baseDeps()),
    (err) => { assert.equal(err.code, EXIT_FATAL); return true; }
  );
});

test("requireRunningSession: session never existed (ENOENT) -> fatal (20), unknown session_id", async () => {
  const err = Object.assign(new Error("no such file"), { code: "ENOENT" });
  await assert.rejects(
    () => requireRunningSession("sess-nope", baseDeps({ loadSession: async () => { throw err; } })),
    (e) => { assert.equal(e.code, EXIT_FATAL); assert.match(e.message, /unknown session_id/); return true; }
  );
});

test("requireRunningSession: state file exists but is unreadable -> recoverable (10)", async () => {
  const err = new Error("corrupt session state file");
  await assert.rejects(
    () => requireRunningSession("sess-broken", baseDeps({ loadSession: async () => { throw err; } })),
    (e) => { assert.equal(e.code, EXIT_RECOVERABLE); return true; }
  );
});

test("requireRunningSession: a dead session (state stopped/crashed) -> recoverable (10) naming the reason", async () => {
  for (const state of ["stopped", "crashed"]) {
    await assert.rejects(
      () => requireRunningSession("sess-abc123", baseDeps({ loadSession: async () => ({ ...RUNNING_RECORD, state }) })),
      (e) => {
        assert.equal(e.code, EXIT_RECOVERABLE);
        assert.match(e.message, /dead session/);
        assert.match(e.message, new RegExp(state));
        return true;
      }
    );
  }
});

test("requireRunningSession: a running session resolves the record", async () => {
  const record = await requireRunningSession("sess-abc123", baseDeps());
  assert.equal(record.session_id, "sess-abc123");
});

// ---- snapshot ---------------------------------------------------------

test("snapshot: builds `snapshot -i --session --platform --device --json`, maps elements, captures a screenshot", async () => {
  await withTempDir(async (evidenceDir) => {
    const runner = fakeRunner({
      snapshot: () => jsonOk(CANNED_SNAPSHOT.data),
      screenshot: () => jsonOk({ path: "ignored" }),
    });
    const handlers = createHandlers(baseDeps({ runner, reserveEntry, finalizeEntry }));
    const response = await handlers.snapshot({ session_id: "sess-abc123", evidence_dir: evidenceDir });

    const snapshotCall = runner.calls.find((c) => c.args[0] === "snapshot");
    assert.deepEqual(snapshotCall.args, [
      "snapshot", "-i",
      "--session", "agentflow-run-sess-abc123",
      "--platform", "ios",
      "--device", "iPhone 15",
      "--json",
    ]);

    assert.equal(response.elements.length, 3);
    assert.equal(response.elements[1].test_id, "checkout-cta");
    assert.equal(response.screenshot, join(evidenceDir, "0001.png"));

    const manifest = JSON.parse(await readFile(join(evidenceDir, MANIFEST_FILE), "utf8"));
    // status: "written" — reserveEntry's row is finalized once the capture
    // below it actually succeeds (#139).
    assert.deepEqual(manifest, [
      { type: "screenshot", path: join(evidenceDir, "0001.png"), label: "snapshot", status: "written" },
    ]);
  });
});

test("snapshot: without evidence_dir still captures a screenshot (outside the bundle), never reserves a manifest slot", async () => {
  const runner = fakeRunner({ snapshot: () => jsonOk(CANNED_SNAPSHOT.data) });
  let reserveCalled = false;
  const handlers = createHandlers(baseDeps({ runner, reserveEntry: async () => { reserveCalled = true; } }));
  const response = await handlers.snapshot({ session_id: "sess-abc123" });
  assert.ok(response.screenshot);
  assert.equal(reserveCalled, false, "no evidence_dir means nothing to reserve a manifest slot in");
  const screenshotCall = runner.calls.find((c) => c.args[0] === "screenshot");
  assert.ok(screenshotCall, "screenshot must still be captured");
});

test("snapshot: second call in the same bundle numbers the screenshot 0002.png", async () => {
  await withTempDir(async (evidenceDir) => {
    await appendManifest(evidenceDir, { type: "screenshot", path: "x", label: "y" }); // seed one prior entry
    const runner = fakeRunner({ snapshot: () => jsonOk(CANNED_SNAPSHOT.data) });
    const handlers = createHandlers(baseDeps({ runner, reserveEntry, finalizeEntry }));
    const response = await handlers.snapshot({ session_id: "sess-abc123", evidence_dir: evidenceDir });
    assert.equal(response.screenshot, join(evidenceDir, "0002.png"));
  });
});

test("snapshot: two concurrent calls sharing one evidence_dir never mint the same screenshot filename (the race reserveEntry fixes)", async () => {
  await withTempDir(async (evidenceDir) => {
    const runner = fakeRunner({ snapshot: () => jsonOk(CANNED_SNAPSHOT.data) });
    const handlersA = createHandlers(baseDeps({ runner, reserveEntry, finalizeEntry }));
    const handlersB = createHandlers(baseDeps({ runner, reserveEntry, finalizeEntry }));
    const [a, b] = await Promise.all([
      handlersA.snapshot({ session_id: "sess-abc123", evidence_dir: evidenceDir }),
      handlersB.snapshot({ session_id: "sess-abc123", evidence_dir: evidenceDir }),
    ]);
    assert.notEqual(a.screenshot, b.screenshot, "two concurrent captures must never collide on one filename");
    const manifest = await readManifest(evidenceDir);
    assert.equal(manifest.length, 2, "both entries must land in the manifest, none lost to a race");
    assert.deepEqual(new Set(manifest.map((row) => row.path)), new Set([a.screenshot, b.screenshot]));
  });
});

// #139 (residual from #141's re-review): a reservation lands its manifest
// row BEFORE the actual PNG capture runs (reserveEntry's own doc comment) —
// if the capture then fails, the row must not stay a permanent dangling
// "reserved" reference to a file that was never written. It's finalized
// "failed" instead, an honest record, while the original capture error
// still propagates unchanged (never masked as a passing snapshot).
test("snapshot: a screenshot capture failure after reservation finalizes the row as 'failed', not a dangling 'reserved' ghost, and the error still propagates", async () => {
  await withTempDir(async (evidenceDir) => {
    const runner = fakeRunner({
      snapshot: () => jsonOk(CANNED_SNAPSHOT.data),
      screenshot: () => jsonFail("SESSION_NOT_FOUND", "session gone mid-capture"),
    });
    const handlers = createHandlers(baseDeps({ runner, reserveEntry, finalizeEntry }));
    await assert.rejects(
      () => handlers.snapshot({ session_id: "sess-abc123", evidence_dir: evidenceDir }),
      (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
    );
    const manifest = await readManifest(evidenceDir);
    assert.equal(manifest.length, 1, "the reservation itself still landed a row");
    assert.equal(manifest[0].status, "failed", "never left dangling at 'reserved' once the capture's outcome is known");
  });
});

test("snapshot: a dead session is recoverable (10) before any agent-device call is made", async () => {
  const runner = fakeRunner();
  const handlers = createHandlers(baseDeps({ runner, loadSession: async () => ({ ...RUNNING_RECORD, state: "crashed" }) }));
  await assert.rejects(
    () => handlers.snapshot({ session_id: "sess-abc123" }),
    (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
  );
  assert.equal(runner.calls.length, 0, "must not shell out for a session already known to be dead");
});

test("snapshot: agent-device losing the session mid-call (SESSION_NOT_FOUND) is recoverable (10), a dead session", async () => {
  const runner = fakeRunner({ snapshot: () => jsonFail("SESSION_NOT_FOUND", "no active app session") });
  const handlers = createHandlers(baseDeps({ runner }));
  await assert.rejects(
    () => handlers.snapshot({ session_id: "sess-abc123" }),
    (err) => { assert.equal(err.code, EXIT_RECOVERABLE); assert.match(err.message, /dead session/); return true; }
  );
});

// ---- act ----------------------------------------------------------------

test("act tap: ref -> `press @ref`", async () => {
  const runner = fakeRunner({ press: () => jsonOk({}), screenshot: () => jsonOk({}) });
  const handlers = createHandlers(baseDeps({ runner }));
  const response = await handlers.act({ session_id: "sess-abc123", action: { kind: "tap", ref: "e12" } });
  assert.deepEqual(response.ok, true);
  const pressCall = runner.calls.find((c) => c.args[0] === "press");
  assert.deepEqual(pressCall.args.slice(0, 2), ["press", "@e12"]);
});

test("act tap: selector -> `press id=\"...\"`", async () => {
  const runner = fakeRunner({ press: () => jsonOk({}), screenshot: () => jsonOk({}) });
  const handlers = createHandlers(baseDeps({ runner }));
  await handlers.act({ session_id: "sess-abc123", action: { kind: "tap", selector: { test_id: "checkout-cta" } } });
  const pressCall = runner.calls.find((c) => c.args[0] === "press");
  assert.deepEqual(pressCall.args.slice(0, 2), ["press", 'id="checkout-cta"']);
});

test("act tap: neither ref nor selector -> fatal (20)", async () => {
  const handlers = createHandlers(baseDeps());
  await assert.rejects(
    () => handlers.act({ session_id: "sess-abc123", action: { kind: "tap" } }),
    (err) => { assert.equal(err.code, EXIT_FATAL); return true; }
  );
});

test("act type: with a ref -> `fill @ref <text>` (replaces)", async () => {
  const runner = fakeRunner({ fill: () => jsonOk({}), screenshot: () => jsonOk({}) });
  const handlers = createHandlers(baseDeps({ runner }));
  await handlers.act({ session_id: "sess-abc123", action: { kind: "type", ref: "e5", text: "hello" } });
  const fillCall = runner.calls.find((c) => c.args[0] === "fill");
  assert.deepEqual(fillCall.args.slice(0, 3), ["fill", "@e5", "hello"]);
});

test("act type: no ref/selector -> `type <text>` (appends to whatever is focused)", async () => {
  const runner = fakeRunner({ type: () => jsonOk({}), screenshot: () => jsonOk({}) });
  const handlers = createHandlers(baseDeps({ runner }));
  await handlers.act({ session_id: "sess-abc123", action: { kind: "type", text: "hello" } });
  const typeCall = runner.calls.find((c) => c.args[0] === "type");
  assert.deepEqual(typeCall.args.slice(0, 2), ["type", "hello"]);
});

test("act scroll: builds `scroll <direction>`; a ref is accepted but has no agent-device equivalent to pass", async () => {
  const runner = fakeRunner({ scroll: () => jsonOk({}), screenshot: () => jsonOk({}) });
  const handlers = createHandlers(baseDeps({ runner }));
  await handlers.act({ session_id: "sess-abc123", action: { kind: "scroll", direction: "down", ref: "e7" } });
  const scrollCall = runner.calls.find((c) => c.args[0] === "scroll");
  assert.deepEqual(scrollCall.args.slice(0, 2), ["scroll", "down"]);
});

test("act navigate: `open <bundle_id> <url>`, bundle_id from the run session record", async () => {
  const runner = fakeRunner({ open: () => jsonOk({}), screenshot: () => jsonOk({}) });
  const handlers = createHandlers(baseDeps({ runner }));
  await handlers.act({ session_id: "sess-abc123", action: { kind: "navigate", url: "myapp://checkout" } });
  const openCall = runner.calls.find((c) => c.args[0] === "open");
  assert.deepEqual(openCall.args.slice(0, 3), ["open", "com.example.app", "myapp://checkout"]);
});

test("act navigate: no bundle_id on the session record -> fatal (20)", async () => {
  const handlers = createHandlers(baseDeps({ loadSession: async () => ({ ...RUNNING_RECORD, bundle_id: undefined }) }));
  await assert.rejects(
    () => handlers.act({ session_id: "sess-abc123", action: { kind: "navigate", url: "x" } }),
    (err) => { assert.equal(err.code, EXIT_FATAL); return true; }
  );
});

test("act wait: `wait <selector> <timeout_ms>`", async () => {
  const runner = fakeRunner({ wait: () => jsonOk({}), screenshot: () => jsonOk({}) });
  const handlers = createHandlers(baseDeps({ runner }));
  await handlers.act({
    session_id: "sess-abc123",
    action: { kind: "wait", until: { selector: { test_id: "order-summary" } }, timeout_ms: 5000 },
  });
  const waitCall = runner.calls.find((c) => c.args[0] === "wait");
  assert.deepEqual(waitCall.args.slice(0, 3), ["wait", 'id="order-summary"', "5000"]);
});

test("act wait: missing until.selector -> fatal (20)", async () => {
  const handlers = createHandlers(baseDeps());
  await assert.rejects(
    () => handlers.act({ session_id: "sess-abc123", action: { kind: "wait" } }),
    (err) => { assert.equal(err.code, EXIT_FATAL); return true; }
  );
});

test("act press: key=enter -> `keyboard enter`", async () => {
  const runner = fakeRunner({ keyboard: () => jsonOk({}), screenshot: () => jsonOk({}) });
  const handlers = createHandlers(baseDeps({ runner }));
  await handlers.act({ session_id: "sess-abc123", action: { kind: "press", key: "enter" } });
  const keyboardCall = runner.calls.find((c) => c.args[0] === "keyboard");
  assert.deepEqual(keyboardCall.args.slice(0, 2), ["keyboard", "enter"]);
});

test("act press: key=back -> the top-level `back` command", async () => {
  const runner = fakeRunner({ back: () => jsonOk({}), screenshot: () => jsonOk({}) });
  const handlers = createHandlers(baseDeps({ runner }));
  await handlers.act({ session_id: "sess-abc123", action: { kind: "press", key: "back" } });
  assert.ok(runner.calls.some((c) => c.args[0] === "back"));
});

test("act: unsupported action kind -> fatal (20)", async () => {
  const handlers = createHandlers(baseDeps());
  await assert.rejects(
    () => handlers.act({ session_id: "sess-abc123", action: { kind: "pinch" } }),
    (err) => { assert.equal(err.code, EXIT_FATAL); return true; }
  );
});

test("act: always captures a post-action screenshot and appends it to the manifest", async () => {
  await withTempDir(async (evidenceDir) => {
    const runner = fakeRunner({ press: () => jsonOk({}), screenshot: () => jsonOk({}) });
    const handlers = createHandlers(baseDeps({ runner, reserveEntry, finalizeEntry }));
    const response = await handlers.act({
      session_id: "sess-abc123",
      action: { kind: "tap", ref: "e12" },
      evidence_dir: evidenceDir,
    });
    assert.equal(response.screenshot, join(evidenceDir, "0001.png"));
    const manifest = await readManifest(evidenceDir);
    assert.deepEqual(manifest, [
      { type: "screenshot", path: join(evidenceDir, "0001.png"), label: "act:tap", status: "written" },
    ]);
  });
});

// #134 review: "always captured" reads literally — including a failed
// action, since the failure frame is often the highest-value evidence.
test("act: a failing action is still recoverable (10), but the failure frame is still captured and appended before rethrowing", async () => {
  await withTempDir(async (evidenceDir) => {
    const runner = fakeRunner({ press: () => jsonFail("COMMAND_FAILED", "no visible effect"), screenshot: () => jsonOk({}) });
    const handlers = createHandlers(baseDeps({ runner, reserveEntry, finalizeEntry }));
    await assert.rejects(
      () => handlers.act({ session_id: "sess-abc123", action: { kind: "tap", ref: "e1" }, evidence_dir: evidenceDir }),
      (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
    );
    const screenshotCall = runner.calls.find((c) => c.args[0] === "screenshot");
    assert.ok(screenshotCall, "the failure frame must still be captured");
    const manifest = await readManifest(evidenceDir);
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].label, "act:tap:failed");
  });
});

test("act: the original action error survives even when the failure screenshot itself also fails", async () => {
  const runner = fakeRunner({
    press: () => jsonFail("COMMAND_FAILED", "no visible effect"),
    screenshot: () => jsonFail("SESSION_NOT_FOUND", "session gone"),
  });
  const handlers = createHandlers(baseDeps({ runner }));
  await assert.rejects(
    () => handlers.act({ session_id: "sess-abc123", action: { kind: "tap", ref: "e1" } }),
    (err) => {
      assert.equal(err.code, EXIT_RECOVERABLE);
      assert.match(err.message, /COMMAND_FAILED|no visible effect/);
      return true;
    }
  );
});

test("act: agent-device reporting success:false at exit 0 is still recoverable (10), not silently accepted as ok", async () => {
  const zeroExitFail = () => ({
    code: 0,
    stdout: JSON.stringify({ success: false, error: { code: "COMMAND_FAILED", message: "no visible effect" } }),
    stderr: "",
    error: null,
  });
  const runner = fakeRunner({ press: zeroExitFail, screenshot: () => jsonOk({}) });
  const handlers = createHandlers(baseDeps({ runner }));
  await assert.rejects(
    () => handlers.act({ session_id: "sess-abc123", action: { kind: "tap", ref: "e1" } }),
    (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
  );
});

// ---- read -----------------------------------------------------------

test("read: source=app resolves the log path via `logs path` and tails it", async () => {
  const runner = fakeRunner({ logs: () => jsonOk({ path: "/fake/app.log", active: true, state: "active" }) });
  const handlers = createHandlers(baseDeps({
    runner,
    readFile: async (path) => { assert.equal(path, "/fake/app.log"); return "l1\nl2\nl3\n"; },
  }));
  const response = await handlers.read({ session_id: "sess-abc123", source: "app", tail: 2 });
  assert.deepEqual(response.lines, ["l2", "l3"]);
  const logsCall = runner.calls.find((c) => c.args[0] === "logs");
  assert.deepEqual(logsCall.args.slice(0, 2), ["logs", "path"]);
});

test("read: source=device also resolves via the one log stream agent-device exposes (documented CLI limitation)", async () => {
  const runner = fakeRunner({ logs: () => jsonOk({ path: "/fake/app.log" }) });
  const handlers = createHandlers(baseDeps({ runner, readFile: async () => "only\nline\n" }));
  const response = await handlers.read({ session_id: "sess-abc123", source: "device", tail: 200 });
  assert.deepEqual(response.lines, ["only", "line"]);
});

test("read: default source is app, default tail is 200", async () => {
  const runner = fakeRunner({ logs: () => jsonOk({ path: "/fake/app.log" }) });
  const lines = Array.from({ length: 300 }, (_, i) => `line-${i}`);
  const handlers = createHandlers(baseDeps({ runner, readFile: async () => `${lines.join("\n")}\n` }));
  const response = await handlers.read({ session_id: "sess-abc123" });
  assert.equal(response.lines.length, 200);
  assert.equal(response.lines[199], "line-299");
});

test("read: unsupported source -> fatal (20)", async () => {
  const handlers = createHandlers(baseDeps());
  await assert.rejects(
    () => handlers.read({ session_id: "sess-abc123", source: "network" }),
    (err) => { assert.equal(err.code, EXIT_FATAL); return true; }
  );
});

test("read: no log written yet (ENOENT) -> empty lines, not an error", async () => {
  const runner = fakeRunner({ logs: () => jsonOk({ path: "/fake/app.log" }) });
  const err = Object.assign(new Error("no such file"), { code: "ENOENT" });
  const handlers = createHandlers(baseDeps({ runner, readFile: async () => { throw err; } }));
  const response = await handlers.read({ session_id: "sess-abc123" });
  assert.deepEqual(response.lines, []);
});

test("read: a dead session (SESSION_NOT_FOUND from `logs path`) is recoverable (10)", async () => {
  const runner = fakeRunner({ logs: () => jsonFail("SESSION_NOT_FOUND", "no active session") });
  const handlers = createHandlers(baseDeps({ runner }));
  await assert.rejects(
    () => handlers.read({ session_id: "sess-abc123" }),
    (err) => { assert.equal(err.code, EXIT_RECOVERABLE); assert.match(err.message, /dead session/); return true; }
  );
});

// ---- end-to-end through runMain: the full contract + exit-code mapping --

test("runMain + createHandlers: describe -> {interface:\"verify\", interface_version:\"1\"}, exit 0", async () => {
  const stdout = { chunks: [], write(s) { this.chunks.push(s); } };
  let exitCode;
  await runMain({
    interfaceName: "verify",
    handlers: createHandlers(baseDeps()),
    stdin: [JSON.stringify({ op: "describe" })],
    stdout,
    stderr: { write: () => {} },
    exit: (c) => (exitCode = c),
  });
  assert.equal(exitCode, EXIT_OK);
  assert.deepEqual(JSON.parse(stdout.chunks.join("")), { interface: "verify", interface_version: "1" });
});

test("runMain + createHandlers: an unknown op exits 20 with a JSON error body on stdout", async () => {
  const stdout = { chunks: [], write(s) { this.chunks.push(s); } };
  let exitCode;
  await runMain({
    interfaceName: "verify",
    handlers: createHandlers(baseDeps()),
    stdin: [JSON.stringify({ op: "teleport", session_id: "sess-abc123" })],
    stdout,
    stderr: { write: () => {} },
    exit: (c) => (exitCode = c),
  });
  assert.equal(exitCode, EXIT_FATAL);
  const body = JSON.parse(stdout.chunks.join(""));
  assert.match(body.error, /unknown op/);
});

test("runMain + createHandlers: a full snapshot round-trip exits 0 with the documented response shape", async () => {
  const runner = fakeRunner({ snapshot: () => jsonOk(CANNED_SNAPSHOT.data), screenshot: () => jsonOk({}) });
  const stdout = { chunks: [], write(s) { this.chunks.push(s); } };
  let exitCode;
  await runMain({
    interfaceName: "verify",
    handlers: createHandlers(baseDeps({ runner })),
    stdin: [JSON.stringify({ op: "snapshot", session_id: "sess-abc123" })],
    stdout,
    stderr: { write: () => {} },
    exit: (c) => (exitCode = c),
  });
  assert.equal(exitCode, EXIT_OK);
  const body = JSON.parse(stdout.chunks.join(""));
  assert.ok(body.screenshot);
  assert.equal(body.elements.length, 3);
});
