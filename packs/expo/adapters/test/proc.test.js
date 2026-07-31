import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRunner,
  spawnForeground,
  spawnBackground,
  captureIdentity,
  isAlive,
  kill,
  portOwners,
  isPortOwnedBy,
} from "../lib/proc.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "agentflow-expo-proc-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function isRealProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

test("spawnForeground: a timeout kills the child (fallback: no real pid on the test double) and reports timedOut", async () => {
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

test("spawnForeground: a timeout kills the whole process group of a real detached child, not just the direct child — grandchildren must not survive", async () => {
  await withTempDir(async (dir) => {
    const pidFile = join(dir, "grandchild.pid");
    // The build script spawns its own (non-detached, same-group) child and
    // never exits on its own — this is the shape of `expo run:ios` spawning
    // xcodebuild/CocoaPods: killing only the direct pid would orphan it.
    const script = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
      writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));
      setInterval(() => {}, 1000);
    `;
    const result = await spawnForeground(process.execPath, ["-e", script], { timeoutMs: 300 });
    assert.equal(result.timedOut, true);

    const grandchildPid = Number((await readFile(pidFile, "utf8")).trim());
    const deadline = Date.now() + 3000;
    let gone = false;
    while (Date.now() < deadline) {
      if (!isRealProcessAlive(grandchildPid)) {
        gone = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(gone, "a timed-out build's grandchild should not survive a process-group kill");
  });
});

function fakeSpawnEmitter({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// Schedules the emit from *inside* spawnFn, right when spawnBackground would
// actually call it — not from the test's outer scope on some independently
// guessed tick. spawnBackground awaits mkdir(dirname(logPath)) before ever
// calling spawnFn, so an emit scheduled purely by "wall clock proximity" to
// the outer spawnBackground() call can win the race against mkdir and fire
// before spawnBackground has attached its 'spawn'/'error' listeners — a real
// child process can't do that (its 'spawn'/'error' events are inherently
// asynchronous relative to the synchronous spawn() call), so this keeps the
// fake honest to that ordering guarantee instead of hanging on a lost event.
function spawnFnThatEmits(child, event, ...args) {
  return () => {
    setImmediate(() => child.emit(event, ...args));
    return child;
  };
}

test("spawnBackground: resolves once the child actually spawns (the 'spawn' event), not merely once .pid exists", async () => {
  await withTempDir(async (dir) => {
    const logPath = join(dir, "app.log");
    const child = fakeSpawnEmitter();
    const { pid, logPath: returnedPath } = await spawnBackground("expo", ["start"], {
      spawnFn: spawnFnThatEmits(child, "spawn"),
      logPath,
    });
    assert.equal(pid, 4242);
    assert.equal(returnedPath, logPath);
  });
});

test("spawnBackground: a spawn-time failure ('error' event, e.g. ENOENT) rejects instead of crashing via an unhandled 'error' event", async () => {
  await withTempDir(async (dir) => {
    const logPath = join(dir, "app.log");
    const child = fakeSpawnEmitter();
    await assert.rejects(
      () => spawnBackground("expo", ["start"], {
        spawnFn: spawnFnThatEmits(child, "error", new Error("ENOENT: expo not found")),
        logPath,
      }),
      /ENOENT/
    );
  });
});

test("spawnBackground: a listener stays attached after spawn — a later async error (EPIPE, etc) does not crash the process", async () => {
  await withTempDir(async (dir) => {
    const logPath = join(dir, "app.log");
    const child = fakeSpawnEmitter();
    const { pid } = await spawnBackground("expo", ["start"], { spawnFn: spawnFnThatEmits(child, "spawn"), logPath });
    assert.equal(pid, 4242);
    assert.equal(child.listenerCount("error"), 1, "an 'error' listener must remain attached post-spawn");
    // If nothing were listening, this would itself be an uncaughtException
    // and abort the whole test process.
    child.emit("error", new Error("EPIPE on the log stream"));
  });
});

// #156: every mock above swaps in a fake spawnFn, so none of them ever
// exercised the real seam that actually broke — spawnBackground handing a
// `createWriteStream()` (async-opening, `.fd: null` until its own 'open'
// event) straight into `spawn()`'s `stdio`, with no await/tick in between.
// Node's synchronous stdio validation always saw `fd: null` and threw
// immediately, on every Node version, on every real invocation — 100%
// reproduction, and no mock-based test could ever have caught it, since a
// fake spawnFn never runs Node's real stdio validation at all. This is the
// missing test class: no `spawnFn` override, a real `node:child_process`
// spawn, a real log file on disk.
test("spawnBackground: a REAL child process (no mocks) actually spawns and its output lands in a real log file", async () => {
  await withTempDir(async (dir) => {
    const logPath = join(dir, "app.log");
    const { pid, logPath: returnedPath } = await spawnBackground(
      process.execPath,
      ["-e", "console.log('hello from a real spawnBackground child')"],
      { logPath }
    );
    assert.ok(Number.isInteger(pid) && pid > 0, "a real spawn must yield a real OS pid");
    assert.equal(returnedPath, logPath);

    // The child writes and exits asynchronously; poll briefly for its
    // output to land rather than assuming it's already flushed.
    const deadline = Date.now() + 5000;
    let contents = "";
    while (Date.now() < deadline) {
      contents = await readFile(logPath, "utf8").catch(() => "");
      if (contents.includes("hello from a real spawnBackground child")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(
      contents,
      /hello from a real spawnBackground child/,
      "the real child's stdout should land in the real log file spawnBackground wired up"
    );
  });
});

// ---- pid identity: a bare pid is not a safe long-lived handle ----------
// (see #138 review: the OS recycles pids, so isAlive/kill must verify a
// start-time identity token, via `ps`, before ever treating a pid as ours.)

function fakePsRunner(responses) {
  return {
    exec: async (cmd, args) => {
      assert.equal(cmd, "ps");
      const pid = args[1];
      const found = typeof responses === "function" ? responses(pid) : responses[pid];
      return found ?? { code: 1, stdout: "", stderr: "No such process", error: null };
    },
  };
}

test("captureIdentity: returns ps's lstart+command for a pid it can describe", async () => {
  const runner = fakePsRunner({
    4242: { code: 0, stdout: "Mon Jul 20 10:00:00 2026 /usr/local/bin/node start\n", stderr: "", error: null },
  });
  assert.equal(await captureIdentity(4242, { runner }), "Mon Jul 20 10:00:00 2026 /usr/local/bin/node start");
});

test("captureIdentity: null when ps can't find the pid (already gone)", async () => {
  const runner = fakePsRunner({});
  assert.equal(await captureIdentity(4242, { runner }), null);
});

test("captureIdentity: null for a falsy pid, without shelling out at all", async () => {
  let called = false;
  const runner = { exec: async () => { called = true; return { code: 0, stdout: "x", stderr: "", error: null }; } };
  assert.equal(await captureIdentity(undefined, { runner }), null);
  assert.equal(await captureIdentity(0, { runner }), null);
  assert.equal(called, false);
});

test("isAlive: true only when the pid exists AND ps's current identity still matches the one captured at spawn", async () => {
  const identity = "Mon Jul 20 10:00:00 2026 /usr/local/bin/node start";
  const runner = fakePsRunner({ 4242: { code: 0, stdout: `${identity}\n`, stderr: "", error: null } });
  assert.equal(await isAlive(4242, identity, { runner }), true);
});

test("isAlive: false when the pid was recycled — ps now describes an unrelated process at the same pid", async () => {
  const runner = fakePsRunner({
    4242: { code: 0, stdout: "Mon Jul 20 11:00:00 2026 /usr/bin/some-unrelated-process\n", stderr: "", error: null },
  });
  const staleIdentity = "Mon Jul 20 10:00:00 2026 /usr/local/bin/node start";
  assert.equal(await isAlive(4242, staleIdentity, { runner }), false);
});

test("isAlive: false with no identity to compare against at all — fails closed rather than trusting bare liveness", async () => {
  const runner = fakePsRunner({ 4242: { code: 0, stdout: "whatever\n", stderr: "", error: null } });
  assert.equal(await isAlive(4242, null, { runner }), false);
  assert.equal(await isAlive(4242, undefined, { runner }), false);
});

test("isAlive: false for a missing pid, no ps call needed", async () => {
  let called = false;
  const runner = { exec: async () => { called = true; return { code: 0, stdout: "x", stderr: "", error: null }; } };
  assert.equal(await isAlive(undefined, "identity", { runner }), false);
  assert.equal(called, false);
});

test("kill: signals the pid only after isAlive confirms the identity matches", async () => {
  const identity = "Mon Jul 20 10:00:00 2026 /usr/local/bin/node start";
  const runner = fakePsRunner({ 4242: { code: 0, stdout: `${identity}\n`, stderr: "", error: null } });
  let signalled = null;
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    signalled = { pid, signal };
  };
  try {
    const result = await kill(4242, identity, { runner });
    assert.equal(result, true);
    assert.deepEqual(signalled, { pid: 4242, signal: "SIGTERM" });
  } finally {
    process.kill = originalKill;
  }
});

test("kill: a mismatched (recycled-pid) identity is refused — the pid is never signalled", async () => {
  const runner = fakePsRunner({
    4242: { code: 0, stdout: "Mon Jul 20 11:00:00 2026 /usr/bin/some-unrelated-process\n", stderr: "", error: null },
  });
  let signalled = false;
  const originalKill = process.kill;
  process.kill = () => {
    signalled = true;
  };
  try {
    const result = await kill(4242, "Mon Jul 20 10:00:00 2026 /usr/local/bin/node start", { runner });
    assert.equal(result, false);
    assert.equal(signalled, false, "a recycled pid must never be signalled");
  } finally {
    process.kill = originalKill;
  }
});

test("kill: group:true signals the negative (process-group) pid", async () => {
  const identity = "id-1";
  const runner = fakePsRunner({ 4242: { code: 0, stdout: `${identity}\n`, stderr: "", error: null } });
  let signalled = null;
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    signalled = { pid, signal };
  };
  try {
    const result = await kill(4242, identity, { group: true, runner });
    assert.equal(result, true);
    assert.deepEqual(signalled, { pid: -4242, signal: "SIGTERM" });
  } finally {
    process.kill = originalKill;
  }
});

test("kill: a process.kill throw (already gone between the check and the signal) is reported as false, not a rejection", async () => {
  const identity = "id-1";
  const runner = fakePsRunner({ 4242: { code: 0, stdout: `${identity}\n`, stderr: "", error: null } });
  const originalKill = process.kill;
  process.kill = () => {
    throw new Error("ESRCH");
  };
  try {
    assert.equal(await kill(4242, identity, { runner }), false);
  } finally {
    process.kill = originalKill;
  }
});

test("captureIdentity/isAlive against a real live process (self), using the real ps binary — proves the seam works end to end", async () => {
  const identity = await captureIdentity(process.pid);
  assert.ok(identity, "ps should be able to describe this live process");
  assert.equal(await isAlive(process.pid, identity), true);
  assert.equal(await isAlive(process.pid, "definitely not my own command line"), false);
});

// ---- port ownership: Metro's /status carries no identity of its own -----
// (#139: the deterministic replacement — ask the OS's own port->pid mapping
// via `lsof`, rather than trusting whichever process answers /status first.)

function fakeLsofRunner(responses) {
  return {
    exec: async (cmd, args) => {
      assert.equal(cmd, "lsof");
      const port = args[0];
      const found = typeof responses === "function" ? responses(port, args) : responses[port];
      return found ?? { code: 1, stdout: "", stderr: "", error: null };
    },
  };
}

test("portOwners: parses lsof's bare pid-per-line -t output", async () => {
  const runner = fakeLsofRunner({ "-iTCP:8081": { code: 0, stdout: "4242\n", stderr: "", error: null } });
  assert.deepEqual(await portOwners(8081, { runner }), [4242]);
});

test("portOwners: builds the exact `-iTCP:<port> -sTCP:LISTEN -t` argv", async () => {
  let seenArgs = null;
  const runner = { exec: async (cmd, args) => { seenArgs = args; return { code: 1, stdout: "", stderr: "", error: null }; } };
  await portOwners(8081, { runner });
  assert.deepEqual(seenArgs, ["-iTCP:8081", "-sTCP:LISTEN", "-t"]);
});

test("portOwners: multiple listeners on the port all come back (rare, but lsof -t can list more than one line)", async () => {
  const runner = fakeLsofRunner({ "-iTCP:8081": { code: 0, stdout: "4242\n5353\n", stderr: "", error: null } });
  assert.deepEqual(await portOwners(8081, { runner }), [4242, 5353]);
});

test("portOwners: nothing bound yet (lsof exits non-zero, nothing found) resolves an empty array, not a throw", async () => {
  const runner = fakeLsofRunner({});
  assert.deepEqual(await portOwners(8081, { runner }), []);
});

test("portOwners: lsof missing entirely (spawn-level error) also resolves an empty array", async () => {
  const runner = { exec: async () => ({ code: 1, stdout: "", stderr: "", error: new Error("ENOENT") }) };
  assert.deepEqual(await portOwners(8081, { runner }), []);
});

test("isPortOwnedBy: true only when the given pid is among the port's actual listeners", async () => {
  const runner = fakeLsofRunner({ "-iTCP:8081": { code: 0, stdout: "4242\n", stderr: "", error: null } });
  assert.equal(await isPortOwnedBy(8081, 4242, { runner }), true);
});

// The whole point: a foreign packager already bound to the port (a stale
// session, a developer's own terminal) must never read as "ours" just
// because SOMETHING answers on the port.
test("isPortOwnedBy: false when a DIFFERENT pid owns the port — the two-Metro false-ready case", async () => {
  const runner = fakeLsofRunner({ "-iTCP:8081": { code: 0, stdout: "9999\n", stderr: "", error: null } });
  assert.equal(await isPortOwnedBy(8081, 4242, { runner }), false);
});

test("isPortOwnedBy: false for a falsy pid, without even shelling out to lsof", async () => {
  let called = false;
  const runner = { exec: async () => { called = true; return { code: 0, stdout: "4242\n", stderr: "", error: null }; } };
  assert.equal(await isPortOwnedBy(8081, undefined, { runner }), false);
  assert.equal(await isPortOwnedBy(8081, 0, { runner }), false);
  assert.equal(called, false);
});

test("isPortOwnedBy: false when nothing is bound to the port yet (not ready, not a foreign owner either)", async () => {
  const runner = fakeLsofRunner({});
  assert.equal(await isPortOwnedBy(8081, 4242, { runner }), false);
});
