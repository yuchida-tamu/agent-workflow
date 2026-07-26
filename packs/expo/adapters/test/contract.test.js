import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXIT_OK,
  EXIT_RECOVERABLE,
  EXIT_FATAL,
  AdapterError,
  recoverable,
  fatal,
  readStdinJSON,
  describeResponse,
  runMain,
} from "../lib/contract.js";

// A fake stdout/stderr stream: for await (chunk of arr) works on a plain
// array of strings (sync iterables yield their values directly), so tests
// don't need node:stream's Readable at all.
function fakeStream() {
  const written = [];
  return { write: (s) => written.push(s), written };
}

test("readStdinJSON: parses a single JSON object", async () => {
  const req = await readStdinJSON([JSON.stringify({ op: "describe" })]);
  assert.deepEqual(req, { op: "describe" });
});

test("readStdinJSON: rejects empty stdin as fatal", async () => {
  await assert.rejects(() => readStdinJSON([""]), (err) => {
    assert.ok(err instanceof AdapterError);
    assert.equal(err.code, EXIT_FATAL);
    return true;
  });
});

test("readStdinJSON: rejects malformed JSON as fatal", async () => {
  await assert.rejects(() => readStdinJSON(["{not json"]), (err) => {
    assert.equal(err.code, EXIT_FATAL);
    return true;
  });
});

test("readStdinJSON: rejects a JSON array/scalar as fatal (must be one object)", async () => {
  await assert.rejects(() => readStdinJSON(["[1,2,3]"]));
  await assert.rejects(() => readStdinJSON(["42"]));
});

test("recoverable/fatal mint AdapterErrors with the right exit code", () => {
  assert.equal(recoverable("x").code, EXIT_RECOVERABLE);
  assert.equal(fatal("x").code, EXIT_FATAL);
  // an unknown/garbage code collapses to fatal rather than escaping unchecked
  assert.equal(new AdapterError("x", { code: 99 }).code, EXIT_FATAL);
});

test("describeResponse: shape matches interfaces/README.md's version handshake", () => {
  assert.deepEqual(describeResponse("run"), { interface: "run", interface_version: "1" });
  assert.deepEqual(describeResponse("verify", "1"), { interface: "verify", interface_version: "1" });
});

test("runMain: describe op is answered automatically, exit 0, no handler needed", async () => {
  const stdout = fakeStream();
  const stderr = fakeStream();
  let exitCode;
  await runMain({
    interfaceName: "run",
    handlers: {},
    stdin: [JSON.stringify({ op: "describe" })],
    stdout,
    stderr,
    exit: (code) => (exitCode = code),
  });
  assert.equal(exitCode, EXIT_OK);
  assert.deepEqual(JSON.parse(stdout.written.join("")), { interface: "run", interface_version: "1" });
});

test("runMain: dispatches to the matching op handler and exits 0 on success", async () => {
  const stdout = fakeStream();
  let exitCode;
  await runMain({
    interfaceName: "run",
    handlers: { start: async (req) => ({ session_id: "sess-1", got: req.workspace }) },
    stdin: [JSON.stringify({ op: "start", workspace: "/ws" })],
    stdout,
    stderr: fakeStream(),
    exit: (code) => (exitCode = code),
  });
  assert.equal(exitCode, EXIT_OK);
  assert.deepEqual(JSON.parse(stdout.written.join("")), { session_id: "sess-1", got: "/ws" });
});

test("runMain: unknown op is a fatal (20) error with a JSON {error} on stdout", async () => {
  const stdout = fakeStream();
  let exitCode;
  await runMain({
    interfaceName: "run",
    handlers: { start: async () => ({}) },
    stdin: [JSON.stringify({ op: "bogus" })],
    stdout,
    stderr: fakeStream(),
    exit: (code) => (exitCode = code),
  });
  assert.equal(exitCode, EXIT_FATAL);
  assert.ok(JSON.parse(stdout.written.join("")).error.includes("unknown op"));
});

test("runMain: a handler throwing recoverable() maps to exit 10", async () => {
  let exitCode;
  const stdout = fakeStream();
  await runMain({
    interfaceName: "run",
    handlers: { start: async () => { throw recoverable("simulator boot flake"); } },
    stdin: [JSON.stringify({ op: "start" })],
    stdout,
    stderr: fakeStream(),
    exit: (code) => (exitCode = code),
  });
  assert.equal(exitCode, EXIT_RECOVERABLE);
  assert.equal(JSON.parse(stdout.written.join("")).error, "simulator boot flake");
});

test("runMain: a handler throwing fatal() maps to exit 20", async () => {
  let exitCode;
  await runMain({
    interfaceName: "run",
    handlers: { start: async () => { throw fatal("no workspace"); } },
    stdin: [JSON.stringify({ op: "start" })],
    stdout: fakeStream(),
    stderr: fakeStream(),
    exit: (code) => (exitCode = code),
  });
  assert.equal(exitCode, EXIT_FATAL);
});

test("runMain: an unexpected (non-AdapterError) throw still maps to fatal (20), not a crash", async () => {
  let exitCode;
  await runMain({
    interfaceName: "run",
    handlers: { start: async () => { throw new TypeError("bug"); } },
    stdin: [JSON.stringify({ op: "start" })],
    stdout: fakeStream(),
    stderr: fakeStream(),
    exit: (code) => (exitCode = code),
  });
  assert.equal(exitCode, EXIT_FATAL);
});

test("runMain: bad stdin JSON exits 20 before any handler runs", async () => {
  let exitCode;
  let handlerRan = false;
  await runMain({
    interfaceName: "run",
    handlers: { start: async () => { handlerRan = true; return {}; } },
    stdin: ["not json"],
    stdout: fakeStream(),
    stderr: fakeStream(),
    exit: (code) => (exitCode = code),
  });
  assert.equal(exitCode, EXIT_FATAL);
  assert.equal(handlerRan, false);
});

// ---- top-level uncaught net: no path emits non-JSON stdout -------------
//
// A handler that fires off a promise or a callback without awaiting/catching
// it can throw *outside* runMain's own try/catch entirely. Without a net,
// that becomes a bare stack trace on stderr, process exit code 1, and
// nothing at all on stdout — undefined behaviour for a caller expecting exit
// 0/10/20 with a JSON body on every path (see the #138 review).
//
// The net attaches to an injectable `errorSource` (real `process` by
// default) precisely so these tests can simulate the event without raising
// a genuine process-level uncaughtException/unhandledRejection: node's own
// test runner listens for those globally too, for its own crash detection,
// and would attribute a real one to this test regardless of what runMain
// does with it. A fake emitter exercises the exact same runMain code path
// (listener registration, settleOnce, cleanup) without that collision.
function fakeErrorSource() {
  const listeners = new Map();
  return {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    emit(event, err) {
      for (const fn of listeners.get(event) ?? []) fn(err);
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

test("runMain: an uncaughtException on errorSource while a handler is still pending yields exactly one JSON body and exit 20", async () => {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const exitCalls = [];
  const errorSource = fakeErrorSource();
  let releaseHandler;
  const handlerSettled = new Promise((resolve) => { releaseHandler = resolve; });

  const runPromise = runMain({
    interfaceName: "run",
    handlers: {
      start: async () => {
        await handlerSettled; // stays pending until the test releases it below
        return { ok: true }; // must lose the race to the net
      },
    },
    stdin: [JSON.stringify({ op: "start" })],
    stdout,
    stderr,
    exit: (code) => exitCalls.push(code),
    errorSource,
  });

  // Give runMain a turn to register its listeners before firing the event.
  await Promise.resolve();
  errorSource.emit("uncaughtException", new Error("boom, nobody awaited this"));
  releaseHandler();
  await runPromise;

  assert.equal(exitCalls.length, 1, "exactly one exit call, even though the handler's own success path also settled later");
  assert.equal(exitCalls[0], EXIT_FATAL);
  assert.equal(stdout.written.length, 1, "exactly one JSON body on stdout");
  assert.ok(JSON.parse(stdout.written[0]).error.includes("boom"));
});

test("runMain: an unhandledRejection on errorSource is caught by the same net", async () => {
  const stdout = fakeStream();
  const errorSource = fakeErrorSource();
  let releaseHandler;
  const handlerSettled = new Promise((resolve) => { releaseHandler = resolve; });
  let exitCode;

  const runPromise = runMain({
    interfaceName: "run",
    handlers: {
      start: async () => {
        await handlerSettled;
        return { ok: true };
      },
    },
    stdin: [JSON.stringify({ op: "start" })],
    stdout,
    stderr: fakeStream(),
    exit: (code) => (exitCode = code),
    errorSource,
  });

  await Promise.resolve();
  errorSource.emit("unhandledRejection", new Error("dangling rejection"));
  releaseHandler();
  await runPromise;

  assert.equal(exitCode, EXIT_FATAL);
  assert.ok(JSON.parse(stdout.written.join("")).error.includes("dangling rejection"));
});

test("runMain: the uncaught net is torn down after the call — it never leaks a listener for the next runMain", async () => {
  const errorSource = fakeErrorSource();
  await runMain({
    interfaceName: "run",
    handlers: { start: async () => ({ ok: true }) },
    stdin: [JSON.stringify({ op: "start" })],
    stdout: fakeStream(),
    stderr: fakeStream(),
    exit: () => {},
    errorSource,
  });
  assert.equal(errorSource.listenerCount("uncaughtException"), 0);
  assert.equal(errorSource.listenerCount("unhandledRejection"), 0);
});

test("runMain: with the real process as errorSource (the production default), the net still installs and tears down cleanly", async () => {
  const before = process.listenerCount("uncaughtException");
  await runMain({
    interfaceName: "run",
    handlers: { start: async () => ({ ok: true }) },
    stdin: [JSON.stringify({ op: "start" })],
    stdout: fakeStream(),
    stderr: fakeStream(),
    exit: () => {},
    // errorSource omitted: defaults to the real `process`
  });
  assert.equal(process.listenerCount("uncaughtException"), before);
  assert.equal(process.listenerCount("unhandledRejection"), before);
});
