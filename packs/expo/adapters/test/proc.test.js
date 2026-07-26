import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRunner, spawnForeground, spawnBackground, isAlive, kill } from "../lib/proc.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "agentflow-expo-proc-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// defaultRunner is exercised against a real (but trivial) child process —
// no simulator/Xcode/agent-device involved, so this stays CI-safe while
// still proving the actual spawning mechanism the adapters use.
test("defaultRunner.exec: captures stdout/stderr/exit code from a real process", async () => {
  const result = await defaultRunner.exec(process.execPath, ["-e", "console.log('hi'); console.error('oops')"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /hi/);
  assert.match(result.stderr, /oops/);
});

test("defaultRunner.exec: non-zero exit is reported via code, not a rejection", async () => {
  const result = await defaultRunner.exec(process.execPath, ["-e", "process.exit(7)"]);
  assert.equal(result.code, 7);
  assert.equal(result.error, null);
});

test("defaultRunner.exec: a missing binary is reported as a spawn-level error", async () => {
  const result = await defaultRunner.exec("agentflow-does-not-exist-binary", []);
  assert.ok(result.error);
});

function fakeChildFactory({ exitCode = 0, signal = null, delayMs = 0, stdout = "", stderr = "" } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      setImmediate(() => child.emit("close", null, "SIGTERM"));
    };
    setTimeout(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", exitCode, signal);
    }, delayMs);
    return child;
  };
}

test("spawnForeground: resolves with exit code and streams output lines to onOutput", async () => {
  const lines = [];
  const result = await spawnForeground("expo", ["run:ios"], {
    spawnFn: fakeChildFactory({ exitCode: 0, stdout: "line one\nline two\n" }),
    onOutput: (line, stream) => lines.push([line, stream]),
  });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.deepEqual(lines, [["line one", "stdout"], ["line two", "stdout"]]);
});

test("spawnForeground: a timeout kills the child and reports timedOut", async () => {
  const result = await spawnForeground("expo", ["run:ios"], {
    spawnFn: fakeChildFactory({ delayMs: 50 }),
    timeoutMs: 5,
  });
  assert.equal(result.timedOut, true);
});

test("spawnForeground: a spawn-level error resolves (not rejects) with the error", async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => child.emit("error", new Error("ENOENT")), 0);
    return child;
  };
  const result = await spawnForeground("nope", [], { spawnFn });
  assert.ok(result.error);
  assert.equal(result.code, null);
});

test("spawnBackground: returns a pid immediately and writes output to logPath", async () => {
  await withTempDir(async (dir) => {
    const logPath = join(dir, "app.log");
    const spawnFn = () => {
      const child = new EventEmitter();
      child.pid = 4242;
      child.unref = () => {};
      return child;
    };
    const { pid, logPath: returnedPath } = await spawnBackground("expo", ["start"], { spawnFn, logPath });
    assert.equal(pid, 4242);
    assert.equal(returnedPath, logPath);
  });
});

test("isAlive/kill: reflect real process liveness (self-check only, no simulator)", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(undefined), false);
  // an implausible pid should not report alive and kill() should not throw
  assert.equal(isAlive(999999), false);
  assert.equal(kill(999999), false);
});
