import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMain, EXIT_OK, EXIT_RECOVERABLE, EXIT_FATAL } from "../lib/contract.js";
import { saveSession, loadSession } from "../lib/session.js";
import {
  generateSessionId,
  agentDeviceSessionName,
  bundleIdFromConfig,
  decideStartPath,
  waitForMetroReady,
  createHandlers,
} from "../run.js";

// ---- small pure helpers -----------------------------------------------

test("generateSessionId: sess-<hex> shape, unique per call", () => {
  const a = generateSessionId();
  const b = generateSessionId();
  assert.match(a, /^sess-[0-9a-f]+$/);
  assert.notEqual(a, b);
});

test("agentDeviceSessionName: derives a stable, namespaced agent-device session name", () => {
  assert.equal(agentDeviceSessionName("sess-abc123"), "agentflow-run-sess-abc123");
});

test("bundleIdFromConfig: reads ios.bundleIdentifier from `expo config --json`", () => {
  assert.equal(bundleIdFromConfig({ ios: { bundleIdentifier: "com.example.app" } }), "com.example.app");
});

test("bundleIdFromConfig: fatal (20) when the config has no ios.bundleIdentifier", () => {
  assert.throws(() => bundleIdFromConfig({}), (err) => {
    assert.equal(err.code, EXIT_FATAL);
    return true;
  });
});

test("decideStartPath: dev client already installed -> reuse", async () => {
  const runner = { exec: async () => ({ code: 0, stdout: '["com.example.app"]', stderr: "" }) };
  const path = await decideStartPath({ bundleId: "com.example.app", target: "iPhone 15", runner });
  assert.equal(path, "reuse");
});

test("decideStartPath: dev client not installed -> build", async () => {
  const runner = { exec: async () => ({ code: 0, stdout: "[]", stderr: "" }) };
  const path = await decideStartPath({ bundleId: "com.example.app", target: "iPhone 15", runner });
  assert.equal(path, "build");
});

test("decideStartPath: apps objects with an id/bundleId field also match", async () => {
  const runner = { exec: async () => ({ code: 0, stdout: '[{"id":"com.example.app"}]', stderr: "" }) };
  assert.equal(await decideStartPath({ bundleId: "com.example.app", target: "x", runner }), "reuse");
});

test("decideStartPath: can't confirm (agent-device error, device not booted) -> falls back to the safe 'build' path", async () => {
  const runner = { exec: async () => ({ code: 1, stdout: "", stderr: "no device" }) };
  const path = await decideStartPath({ bundleId: "com.example.app", target: "iPhone 15", runner });
  assert.equal(path, "build");
});

test("waitForMetroReady: resolves true as soon as the ready banner appears in the log", async () => {
  const ready = await waitForMetroReady({
    logPath: "/fake/app.log",
    readFile: async () => "Starting Metro Bundler\nMetro waiting on exp://127.0.0.1:8081\n",
    sleep: async () => {},
    clock: (() => { let t = 0; return () => t++; })(),
  });
  assert.equal(ready, true);
});

test("waitForMetroReady: false when the timeout elapses without the banner", async () => {
  let t = 0;
  const ready = await waitForMetroReady({
    logPath: "/fake/app.log",
    timeoutMs: 10,
    readFile: async () => "still booting\n",
    sleep: async () => { t += 5; },
    clock: () => t,
  });
  assert.equal(ready, false);
});

test("waitForMetroReady: EADDRINUSE in the log is a recoverable (10) error, not a plain timeout", async () => {
  await assert.rejects(
    () => waitForMetroReady({
      logPath: "/fake/app.log",
      readFile: async () => "Error: listen EADDRINUSE: address already in use :::8081\n",
      sleep: async () => {},
      clock: () => 0,
    }),
    (err) => {
      assert.equal(err.code, EXIT_RECOVERABLE);
      return true;
    }
  );
});

// ---- full start/stop/status flows, deps fully mocked -------------------

async function withTempDirs(fn) {
  const workspace = await mkdtemp(join(tmpdir(), "agentflow-expo-run-ws-"));
  const stateDir = await mkdtemp(join(tmpdir(), "agentflow-expo-run-state-"));
  const evidenceDir = await mkdtemp(join(tmpdir(), "agentflow-expo-run-evidence-"));
  await writeFile(join(workspace, "package.json"), "{}");
  await mkdir(join(workspace, "node_modules", ".bin"), { recursive: true });
  await writeFile(join(workspace, "node_modules", ".bin", "expo"), "#!/usr/bin/env node\n");
  try {
    await fn({ workspace, stateDir, evidenceDir });
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    await rm(evidenceDir, { recursive: true, force: true });
  }
}

// Dispatches by the command name every real dependency this adapter shells:
// xcrun (assertXcode), the workspace-local expo bin (`expo config --json`),
// and agent-device (apps/open/close).
function agentDeviceAndExpoRunner({ appsInstalled = [], expoConfig = { ios: { bundleIdentifier: "com.example.app" } } } = {}) {
  const calls = [];
  return {
    calls,
    exec: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "xcrun") return { code: 0, stdout: "/usr/bin/simctl\n", stderr: "", error: null };
      if (cmd.endsWith("/expo") && args[0] === "config") {
        return { code: 0, stdout: JSON.stringify(expoConfig), stderr: "", error: null };
      }
      if (cmd === "agent-device" && args[0] === "apps") {
        return { code: 0, stdout: JSON.stringify(appsInstalled), stderr: "", error: null };
      }
      if (cmd === "agent-device" && (args[0] === "open" || args[0] === "close")) {
        return { code: 0, stdout: "{}", stderr: "", error: null };
      }
      throw new Error(`unexpected exec: ${cmd} ${args.join(" ")}`);
    },
  };
}

function baseDeps({ stateDir, runner, appsInstalled, expoConfig } = {}) {
  return {
    runner: runner ?? agentDeviceAndExpoRunner({ appsInstalled, expoConfig }),
    spawnForeground: async () => ({ code: 0, signal: null, timedOut: false, error: null }),
    spawnBackground: async () => ({ pid: 4242, logPath: null }),
    waitForMetroReady: async () => true,
    isAlive: () => true,
    kill: () => true,
    saveSession: (record) => saveSession(record, { stateDir }),
    loadSession: (id) => loadSession(id, { stateDir }),
    generateSessionId: () => "sess-fixed",
    env: {},
    stderr: { write: () => {} },
  };
}

test("start (reuse path): dev client already installed -> no build, Metro starts, returns session_id/entry_point/log_stream", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    let spawnForegroundCalled = false;
    const deps = {
      ...baseDeps({ stateDir, appsInstalled: ["com.example.app"] }),
      spawnForeground: async () => { spawnForegroundCalled = true; return { code: 0, timedOut: false, error: null }; },
    };
    const handlers = createHandlers(deps);
    const response = await handlers.start({ workspace, target: "iPhone 15", evidence_dir: evidenceDir });

    assert.equal(spawnForegroundCalled, false, "reuse path must not run the full expo run:ios build");
    assert.equal(response.session_id, "sess-fixed");
    assert.equal(response.entry_point, "exp://127.0.0.1:8081");
    assert.equal(response.log_stream, join(evidenceDir, "app.log"));

    const record = await loadSession("sess-fixed", { stateDir });
    assert.equal(record.start_path, "reuse");
    assert.equal(record.bundle_id, "com.example.app");
    assert.equal(record.agent_device_session, "agentflow-run-sess-fixed");
    assert.equal(record.state, "running");
    assert.deepEqual(record.metro, { pid: 4242, port: 8081, log: join(evidenceDir, "app.log") });
  });
});

test("start (build path): dev client not installed -> full expo run:ios --no-bundler runs before Metro", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const calls = [];
    const deps = {
      ...baseDeps({ stateDir, appsInstalled: [] }),
      spawnForeground: async (cmd, args) => { calls.push({ cmd, args }); return { code: 0, timedOut: false, error: null }; },
      spawnBackground: async (cmd, args) => { calls.push({ cmd, args }); return { pid: 4343, logPath: null }; },
    };
    const handlers = createHandlers(deps);
    const response = await handlers.start({ workspace, target: "iPhone 15", evidence_dir: evidenceDir });

    assert.equal(calls[0].args[0], "run:ios");
    assert.deepEqual(calls[0].args, ["run:ios", "--device", "iPhone 15", "--no-bundler"]);
    assert.deepEqual(calls[1].args, ["start", "--port", "8081"]);

    const record = await loadSession(response.session_id, { stateDir });
    assert.equal(record.start_path, "build");
  });
});

test("start: no workspace-local expo -> exit 20 (fatal, not retried)", async () => {
  await withTempDirs(async ({ stateDir, evidenceDir }) => {
    const deps = baseDeps({ stateDir });
    const handlers = createHandlers(deps);
    await assert.rejects(
      () => handlers.start({ workspace: "/no/such/workspace", evidence_dir: evidenceDir }),
      (err) => { assert.equal(err.code, EXIT_FATAL); return true; }
    );
  });
});

test("start: no Xcode (xcrun --find simctl fails) -> exit 20", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const runner = {
      exec: async (cmd) => (cmd === "xcrun"
        ? { code: 1, stdout: "", stderr: "", error: null }
        : { code: 0, stdout: "{}", stderr: "", error: null }),
    };
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);
    await assert.rejects(
      () => handlers.start({ workspace, evidence_dir: evidenceDir }),
      (err) => { assert.equal(err.code, EXIT_FATAL); return true; }
    );
  });
});

test("start: expo run:ios build fails (non-zero exit) -> exit 10, recoverable", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const deps = {
      ...baseDeps({ stateDir, appsInstalled: [] }),
      spawnForeground: async () => ({ code: 65, timedOut: false, error: null }),
    };
    const handlers = createHandlers(deps);
    await assert.rejects(
      () => handlers.start({ workspace, evidence_dir: evidenceDir }),
      (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
    );
  });
});

test("start: expo run:ios build times out (simulator boot flake) -> exit 10", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const deps = {
      ...baseDeps({ stateDir, appsInstalled: [] }),
      spawnForeground: async () => ({ code: null, timedOut: true, error: null }),
    };
    const handlers = createHandlers(deps);
    await assert.rejects(
      () => handlers.start({ workspace, evidence_dir: evidenceDir }),
      (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
    );
  });
});

test("start: Metro never reports ready (e.g. port in use) -> exit 10", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const deps = { ...baseDeps({ stateDir }), waitForMetroReady: async () => false };
    const handlers = createHandlers(deps);
    await assert.rejects(
      () => handlers.start({ workspace, evidence_dir: evidenceDir }),
      (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
    );
  });
});

test("start: agent-device open fails -> wrapped as recoverable (10)", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const runner = agentDeviceAndExpoRunner({ appsInstalled: ["com.example.app"] });
    const realExec = runner.exec;
    runner.exec = async (cmd, args) => {
      if (cmd === "agent-device" && args[0] === "open") return { code: 1, stdout: "", stderr: "no booted device", error: null };
      return realExec(cmd, args);
    };
    const deps = baseDeps({ stateDir, runner });
    const handlers = createHandlers(deps);
    await assert.rejects(
      () => handlers.start({ workspace, evidence_dir: evidenceDir }),
      (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
    );
  });
});

test("start: workspace/target resolution falls back to env/default when the request has neither (E2E runner calls start with only {op, evidence_dir})", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const calls = [];
    const deps = {
      ...baseDeps({ stateDir, appsInstalled: [] }),
      env: { AGENTFLOW_EXPO_WORKSPACE: workspace, AGENTFLOW_EXPO_TARGET: "iPhone 16" },
      spawnForeground: async (cmd, args) => { calls.push(args); return { code: 0, timedOut: false, error: null }; },
    };
    const handlers = createHandlers(deps);
    const response = await handlers.start({ evidence_dir: evidenceDir }); // no workspace/target
    assert.equal(response.session_id, "sess-fixed");
    assert.deepEqual(calls[0], ["run:ios", "--device", "iPhone 16", "--no-bundler"]);
  });
});

test("stop: unknown session_id -> exit 20", async () => {
  await withTempDirs(async ({ stateDir }) => {
    const handlers = createHandlers(baseDeps({ stateDir }));
    await assert.rejects(
      () => handlers.stop({ session_id: "sess-nope" }),
      (err) => { assert.equal(err.code, EXIT_FATAL); return true; }
    );
  });
});

test("stop: resolves a session started in an earlier process, closes it, marks it stopped", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const deps = baseDeps({ stateDir, appsInstalled: ["com.example.app"] });
    const handlers = createHandlers(deps);
    const { session_id } = await handlers.start({ workspace, evidence_dir: evidenceDir });

    let killedPid = null;
    const stopDeps = { ...deps, kill: (pid) => { killedPid = pid; return true; } };
    const stopHandlers = createHandlers(stopDeps);
    const response = await stopHandlers.stop({ session_id });

    assert.deepEqual(response, { session_id, state: "stopped" });
    assert.equal(killedPid, 4242);
    const record = await loadSession(session_id, { stateDir });
    assert.equal(record.state, "stopped");
  });
});

test("stop: agent-device close failing is best-effort — the session is still marked stopped", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const deps = baseDeps({ stateDir, appsInstalled: ["com.example.app"] });
    const handlers = createHandlers(deps);
    const { session_id } = await handlers.start({ workspace, evidence_dir: evidenceDir });

    const failingRunner = { exec: async () => { throw new Error("daemon unreachable"); } };
    const stopHandlers = createHandlers({ ...deps, runner: failingRunner });
    const response = await stopHandlers.stop({ session_id });
    assert.equal(response.state, "stopped");
  });
});

test("status: unknown session_id -> exit 20", async () => {
  await withTempDirs(async ({ stateDir }) => {
    const handlers = createHandlers(baseDeps({ stateDir }));
    await assert.rejects(
      () => handlers.status({ session_id: "sess-nope" }),
      (err) => { assert.equal(err.code, EXIT_FATAL); return true; }
    );
  });
});

test("status: running while Metro's pid is alive", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const deps = baseDeps({ stateDir, appsInstalled: ["com.example.app"] });
    const handlers = createHandlers(deps);
    const { session_id } = await handlers.start({ workspace, evidence_dir: evidenceDir });
    const response = await handlers.status({ session_id });
    assert.deepEqual(response, { session_id, state: "running" });
  });
});

test("status: a dead Metro pid downgrades a running session to crashed", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const deps = baseDeps({ stateDir, appsInstalled: ["com.example.app"] });
    const handlers = createHandlers(deps);
    const { session_id } = await handlers.start({ workspace, evidence_dir: evidenceDir });

    const crashedHandlers = createHandlers({ ...deps, isAlive: () => false });
    const response = await crashedHandlers.status({ session_id });
    assert.deepEqual(response, { session_id, state: "crashed" });

    const record = await loadSession(session_id, { stateDir });
    assert.equal(record.state, "crashed", "status persists the downgrade so a later status call agrees");
  });
});

// ---- end-to-end through runMain: the full contract + exit-code mapping --

test("runMain + createHandlers: describe -> {interface:\"run\", interface_version:\"1\"}, exit 0", async () => {
  const stdout = { chunks: [], write(s) { this.chunks.push(s); } };
  let exitCode;
  await runMain({
    interfaceName: "run",
    handlers: createHandlers(),
    stdin: [JSON.stringify({ op: "describe" })],
    stdout,
    stderr: { write: () => {} },
    exit: (c) => (exitCode = c),
  });
  assert.equal(exitCode, EXIT_OK);
  assert.deepEqual(JSON.parse(stdout.chunks.join("")), { interface: "run", interface_version: "1" });
});

test("runMain + createHandlers: a fatal start (no workspace) exits 20 with a JSON error body on stdout", async () => {
  await withTempDirs(async ({ stateDir }) => {
    const stdout = { chunks: [], write(s) { this.chunks.push(s); } };
    let exitCode;
    await runMain({
      interfaceName: "run",
      handlers: createHandlers(baseDeps({ stateDir })),
      stdin: [JSON.stringify({ op: "start", workspace: "/no/such/workspace" })],
      stdout,
      stderr: { write: () => {} },
      exit: (c) => (exitCode = c),
    });
    assert.equal(exitCode, EXIT_FATAL);
    assert.ok(JSON.parse(stdout.chunks.join("")).error);
  });
});
