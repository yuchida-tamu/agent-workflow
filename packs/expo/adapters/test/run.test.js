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

test("generateSessionId: sess-<uuid> shape (128 bits), unique per call", () => {
  const a = generateSessionId();
  const b = generateSessionId();
  assert.match(a, /^sess-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
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

// #142: the real `agent-device apps --json` payload is enveloped
// `{success, data:{apps:[...]}}`, not a bare array. decideStartPath used to
// read `apps?.apps` straight off that envelope — which never matches, since
// the array is at `data.apps` — so the installed-dev-client check always
// came back empty and every session start paid a full `expo run:ios` build.
test("decideStartPath: dev client already installed (real {success,data:{apps}} envelope) -> reuse", async () => {
  const runner = {
    exec: async () => ({
      code: 0,
      stdout: JSON.stringify({ success: true, data: { apps: ["com.example.app"] } }),
      stderr: "",
    }),
  };
  const path = await decideStartPath({ bundleId: "com.example.app", target: "iPhone 15", runner });
  assert.equal(path, "reuse");
});

test("decideStartPath: dev client not installed (real envelope, empty apps) -> build", async () => {
  const runner = {
    exec: async () => ({ code: 0, stdout: JSON.stringify({ success: true, data: { apps: [] } }), stderr: "" }),
  };
  const path = await decideStartPath({ bundleId: "com.example.app", target: "iPhone 15", runner });
  assert.equal(path, "build");
});

test("decideStartPath: apps objects with an id/bundleId field also match, under the real envelope", async () => {
  const runner = {
    exec: async () => ({
      code: 0,
      stdout: JSON.stringify({ success: true, data: { apps: [{ id: "com.example.app" }] } }),
      stderr: "",
    }),
  };
  assert.equal(await decideStartPath({ bundleId: "com.example.app", target: "x", runner }), "reuse");
});

test("decideStartPath: body says success:false despite exit 0 -> falls back to the safe 'build' path", async () => {
  const runner = {
    exec: async () => ({
      code: 0,
      stdout: JSON.stringify({ success: false, error: { code: "DEVICE_NOT_FOUND", message: "no such device" } }),
      stderr: "",
    }),
  };
  const path = await decideStartPath({ bundleId: "com.example.app", target: "iPhone 15", runner });
  assert.equal(path, "build");
});

test("decideStartPath: can't confirm (agent-device error, device not booted) -> falls back to the safe 'build' path", async () => {
  const runner = { exec: async () => ({ code: 1, stdout: "", stderr: "no device" }) };
  const path = await decideStartPath({ bundleId: "com.example.app", target: "iPhone 15", runner });
  assert.equal(path, "build");
});

// Legacy/unenveloped tolerance: a bare array response (no {success,data}
// wrapper) is cheap to keep supporting since listApps's unwrap already
// passes a shape with no `.data` through untouched.
test("decideStartPath: tolerates a legacy unenveloped array response -> reuse", async () => {
  const runner = { exec: async () => ({ code: 0, stdout: '["com.example.app"]', stderr: "" }) };
  const path = await decideStartPath({ bundleId: "com.example.app", target: "iPhone 15", runner });
  assert.equal(path, "reuse");
});

// #158: a real `agent-device apps --json` (0.19.3) response has display
// strings, not bare bundle ids — this is the EXACT payload quoted in #158
// against a real session. decideStartPath used to compare the whole display
// string against the bare bundleId ("app (dev.agentflow.acceptance)" ===
// "dev.agentflow.acceptance" -> always false), so the reuse fast-path never
// fired against a real device even when the dev client genuinely was
// installed. Fixed at listApps (see agent-device.test.js), verified here
// end to end through decideStartPath.
test("decideStartPath: real 'Name (bundle.id)' apps format (#158, exact observed payload) -> reuse", async () => {
  const runner = {
    exec: async () => ({
      code: 0,
      stdout: JSON.stringify({
        success: true,
        data: {
          apps: [
            "gymtomo (org.reactjs.native.example.gymtomo)",
            "app (dev.agentflow.acceptance)",
            "Expo Go (host.exp.Exponent)",
          ],
        },
      }),
      stderr: "",
    }),
  };
  const path = await decideStartPath({ bundleId: "dev.agentflow.acceptance", target: "iPhone 15 Pro", runner });
  assert.equal(path, "reuse");
});

// ---- waitForMetroReady: real readiness (HTTP /status probe), not a log grep

test("waitForMetroReady: resolves true once the HTTP /status probe reports ready", async () => {
  const ready = await waitForMetroReady({
    port: 8081,
    logPath: "/fake/app.log",
    probe: async (port) => port === 8081,
    readFile: async () => "",
    sleep: async () => {},
    clock: (() => { let t = 0; return () => t++; })(),
  });
  assert.equal(ready, true);
});

test("waitForMetroReady: false when the probe never succeeds before the timeout", async () => {
  let t = 0;
  const ready = await waitForMetroReady({
    port: 8081,
    logPath: "/fake/app.log",
    timeoutMs: 10,
    probe: async () => false,
    readFile: async () => "still booting\n",
    sleep: async () => { t += 5; },
    clock: () => t,
  });
  assert.equal(ready, false);
});

test("waitForMetroReady: a probe that throws (ECONNREFUSED before the port is bound) is treated as not-ready, not a crash", async () => {
  let t = 0;
  const ready = await waitForMetroReady({
    port: 8081,
    logPath: "/fake/app.log",
    timeoutMs: 5,
    probe: async () => { throw new Error("ECONNREFUSED"); },
    readFile: async () => "",
    sleep: async () => { t += 5; },
    clock: () => t,
  });
  assert.equal(ready, false);
});

test("waitForMetroReady: EADDRINUSE in the log is still a recoverable (10) fast-fail even while the probe keeps failing", async () => {
  await assert.rejects(
    () => waitForMetroReady({
      port: 8081,
      logPath: "/fake/app.log",
      probe: async () => false,
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

test("waitForMetroReady: with no port given, falls back to log-only EADDRINUSE detection and never probes", async () => {
  let probeCalled = false;
  let t = 0;
  const ready = await waitForMetroReady({
    logPath: "/fake/app.log",
    timeoutMs: 5,
    probe: async () => { probeCalled = true; return true; },
    readFile: async () => "",
    sleep: async () => { t += 5; },
    clock: () => t,
  });
  assert.equal(ready, false);
  assert.equal(probeCalled, false);
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
// and agent-device (apps/open/close). `apps` responds with the real
// enveloped shape (#142: agent-device --json wraps every response as
// {success, data:{...}} — e.g. apps live at data.apps — not the bare array
// this fixture used to hand back, which is how the bug on #142 shipped with
// green tests: a bare-array mock can't catch a broken envelope unwrap).
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
        return { code: 0, stdout: JSON.stringify({ success: true, data: { apps: appsInstalled } }), stderr: "", error: null };
      }
      if (cmd === "agent-device" && (args[0] === "open" || args[0] === "close")) {
        return { code: 0, stdout: "{}", stderr: "", error: null };
      }
      throw new Error(`unexpected exec: ${cmd} ${args.join(" ")}`);
    },
  };
}

const FAKE_METRO_IDENTITY = "identity-token-4242";

function baseDeps({ stateDir, runner, appsInstalled, expoConfig } = {}) {
  return {
    runner: runner ?? agentDeviceAndExpoRunner({ appsInstalled, expoConfig }),
    spawnForeground: async () => ({ code: 0, signal: null, timedOut: false, error: null }),
    spawnBackground: async () => ({ pid: 4242, logPath: null }),
    waitForMetroReady: async () => true,
    captureIdentity: async () => FAKE_METRO_IDENTITY,
    isAlive: async () => true,
    kill: async () => true,
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
    assert.deepEqual(record.metro, {
      pid: 4242,
      port: 8081,
      log: join(evidenceDir, "app.log"),
      identity: FAKE_METRO_IDENTITY,
    });
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

test("start: Metro fails to even spawn (e.g. ENOENT) -> exit 10, recoverable, not an unhandled rejection", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const deps = {
      ...baseDeps({ stateDir, appsInstalled: ["com.example.app"] }),
      spawnBackground: async () => { throw new Error("ENOENT: expo not found"); },
    };
    const handlers = createHandlers(deps);
    await assert.rejects(
      () => handlers.start({ workspace, evidence_dir: evidenceDir }),
      (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
    );
  });
});

// ---- HIGH (#138 review): a post-spawn failure must kill Metro before ----
// rethrowing, or the leaked bundler dooms core's one bounded retry too.

test("start: Metro not becoming ready kills it (group, identity-checked) before rethrowing recoverable(10)", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    let killedWith = null;
    const deps = {
      ...baseDeps({ stateDir, appsInstalled: ["com.example.app"] }),
      waitForMetroReady: async () => false,
      kill: async (pid, identity, opts) => { killedWith = { pid, identity, opts }; return true; },
    };
    const handlers = createHandlers(deps);
    await assert.rejects(
      () => handlers.start({ workspace, evidence_dir: evidenceDir }),
      (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
    );
    assert.ok(killedWith, "Metro must be killed once it fails to become ready");
    assert.equal(killedWith.pid, 4242);
    assert.equal(killedWith.identity, FAKE_METRO_IDENTITY);
    assert.equal(killedWith.opts.group, true, "Metro was spawned detached — kill must target its process group");
  });
});

test("start: a failing agent-device open kills Metro before rethrowing — no orphaned bundler for the retry to inherit", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const runner = agentDeviceAndExpoRunner({ appsInstalled: ["com.example.app"] });
    const realExec = runner.exec;
    runner.exec = async (cmd, args) => {
      if (cmd === "agent-device" && args[0] === "open") return { code: 1, stdout: "", stderr: "no booted device", error: null };
      return realExec(cmd, args);
    };
    let killedWith = null;
    const deps = {
      ...baseDeps({ stateDir, runner }),
      kill: async (pid, identity, opts) => { killedWith = { pid, identity, opts }; return true; },
    };
    const handlers = createHandlers(deps);
    await assert.rejects(
      () => handlers.start({ workspace, evidence_dir: evidenceDir }),
      (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
    );

    assert.ok(killedWith, "Metro must be killed when start fails after it was spawned");
    assert.equal(killedWith.pid, 4242);
    assert.equal(killedWith.identity, FAKE_METRO_IDENTITY);
    assert.equal(killedWith.opts.group, true);

    // No session was durably recorded for a failed start — a retry mints a
    // brand new session_id rather than resolving a half-alive one.
    await assert.rejects(() => loadSession("sess-fixed", { stateDir }));
  });
});

test("start: Metro's own kill failing (e.g. already gone) does not mask the original recoverable error", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const deps = {
      ...baseDeps({ stateDir, appsInstalled: ["com.example.app"] }),
      waitForMetroReady: async () => false,
      kill: async () => { throw new Error("kill itself blew up"); },
    };
    const handlers = createHandlers(deps);
    await assert.rejects(
      () => handlers.start({ workspace, evidence_dir: evidenceDir }),
      (err) => {
        assert.equal(err.code, EXIT_RECOVERABLE);
        assert.match(err.message, /Metro did not report ready/);
        return true;
      }
    );
  });
});

test("start: workspace/target resolution falls back to env/default when the request has neither (E2E runner calls start with only {op, evidence_dir})", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const calls = [];
    const deps = {
      ...baseDeps({ stateDir, appsInstalled: [] }),
      env: { AGENTFLOW_EXPO_WORKSPACE: workspace, AGENTFLOW_EXPO_TARGET: "iPhone 16" },
      spawnForeground: async (_cmd, args) => { calls.push(args); return { code: 0, timedOut: false, error: null }; },
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

test("stop: resolves a session started in an earlier process, kills Metro by pid+identity+group, marks it stopped", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const deps = baseDeps({ stateDir, appsInstalled: ["com.example.app"] });
    const handlers = createHandlers(deps);
    const { session_id } = await handlers.start({ workspace, evidence_dir: evidenceDir });

    let killedWith = null;
    const stopDeps = { ...deps, kill: async (pid, identity, opts) => { killedWith = { pid, identity, opts }; return true; } };
    const stopHandlers = createHandlers(stopDeps);
    const response = await stopHandlers.stop({ session_id });

    assert.deepEqual(response, { session_id, state: "stopped" });
    assert.equal(killedWith.pid, 4242);
    assert.equal(killedWith.identity, FAKE_METRO_IDENTITY);
    assert.equal(killedWith.opts.group, true);
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

test("stop: a corrupt (unreadable) session state file is recoverable (10), not misreported as unknown (20)", async () => {
  await withTempDirs(async ({ stateDir }) => {
    await writeFile(join(stateDir, "sess-broken.json"), "{not json");
    const handlers = createHandlers(baseDeps({ stateDir }));
    await assert.rejects(
      () => handlers.stop({ session_id: "sess-broken" }),
      (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
    );
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

test("status: running while Metro's identity-checked pid is alive", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const deps = baseDeps({ stateDir, appsInstalled: ["com.example.app"] });
    const handlers = createHandlers(deps);
    const { session_id } = await handlers.start({ workspace, evidence_dir: evidenceDir });
    const response = await handlers.status({ session_id });
    assert.deepEqual(response, { session_id, state: "running" });
  });
});

test("status: a dead Metro pid (identity check fails) downgrades a running session to crashed", async () => {
  await withTempDirs(async ({ workspace, stateDir, evidenceDir }) => {
    const deps = baseDeps({ stateDir, appsInstalled: ["com.example.app"] });
    const handlers = createHandlers(deps);
    const { session_id } = await handlers.start({ workspace, evidence_dir: evidenceDir });

    const crashedHandlers = createHandlers({ ...deps, isAlive: async () => false });
    const response = await crashedHandlers.status({ session_id });
    assert.deepEqual(response, { session_id, state: "crashed" });

    const record = await loadSession(session_id, { stateDir });
    assert.equal(record.state, "crashed", "status persists the downgrade so a later status call agrees");
  });
});

test("status: a corrupt session state file is recoverable (10), distinct from a genuinely unknown session_id (20)", async () => {
  await withTempDirs(async ({ stateDir }) => {
    await writeFile(join(stateDir, "sess-broken.json"), "{not json");
    const handlers = createHandlers(baseDeps({ stateDir }));
    await assert.rejects(
      () => handlers.status({ session_id: "sess-broken" }),
      (err) => { assert.equal(err.code, EXIT_RECOVERABLE); return true; }
    );
    await assert.rejects(
      () => handlers.status({ session_id: "sess-truly-unknown" }),
      (err) => { assert.equal(err.code, EXIT_FATAL); return true; }
    );
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
