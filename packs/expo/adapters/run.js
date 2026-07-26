#!/usr/bin/env node
// packs/expo/adapters/run.js — implements interfaces/run.md: start / stop /
// status, launching the Expo app in an observable environment on an iOS
// simulator via the `agent-device` CLI. See #133 and the plan on #132 for the
// design rationale (agent-device capability probe, feasibility risks).
//
// `start`'s build-vs-reuse fork only decides whether a build step runs
// first — Metro is always this adapter's own managed background process in
// both paths, so `log_stream`/pid bookkeeping stays uniform. See
// `decideStartPath` and the "start sequence" comment below.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile as fsReadFile } from "node:fs/promises";
import { runMain, recoverable, fatal, diagnostic } from "./lib/contract.js";
import {
  resolveWorkspace,
  resolveTarget,
  resolveProfile,
  assertWorkspace,
  assertXcode,
} from "./lib/workspace.js";
import { defaultRunner, spawnForeground, spawnBackground, isAlive, kill } from "./lib/proc.js";
import * as agentDevice from "./lib/agent-device.js";
import { saveSession, loadSession, resolveStateDir } from "./lib/session.js";
import { appendManifest } from "./lib/evidence.js";

const INTERFACE = "run";

export const DEFAULT_METRO_PORT = 8081;
export const BUILD_TIMEOUT_MS = Number(process.env.AGENTFLOW_EXPO_BUILD_TIMEOUT_MS) || 15 * 60 * 1000; // 15min: first `expo run:ios` build is Xcode + CocoaPods
export const METRO_READY_TIMEOUT_MS = Number(process.env.AGENTFLOW_EXPO_METRO_TIMEOUT_MS) || 30 * 1000;

export function generateSessionId() {
  return `sess-${randomUUID().split("-")[0]}`;
}

export function agentDeviceSessionName(sessionId) {
  return `agentflow-run-${sessionId}`;
}

// Resolves the iOS bundle identifier `agent-device open` needs, via the
// workspace-local expo's own config resolution (never re-implement Expo's
// app.json/app.config.js merge logic here).
export async function readExpoConfig(workspace, expoBin, { runner = defaultRunner } = {}) {
  const result = await runner.exec(expoBin, ["config", "--json"], { cwd: workspace });
  if (result.error || result.code !== 0) {
    throw fatal(
      `"expo config --json" failed in ${workspace}: ${result.error?.message ?? result.stderr ?? `exit ${result.code}`}`
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw fatal(`"expo config --json" returned invalid JSON: ${err.message}`);
  }
}

export function bundleIdFromConfig(config) {
  const id = config?.ios?.bundleIdentifier;
  if (!id) {
    throw fatal('workspace app config has no ios.bundleIdentifier ("expo config --json" -> ios.bundleIdentifier)');
  }
  return id;
}

// The start-path decision: is the dev client already installed on the target
// simulator? If so, skip the (minutes-long) `expo run:ios` build and just
// reuse it. Any failure to confirm (device not booted yet, agent-device
// error) falls back to the safe-but-slow "build" path rather than assuming
// an install that may not exist.
export async function decideStartPath({ bundleId, target, runner }) {
  try {
    const apps = await agentDevice.listApps({ platform: "ios", device: target, runner });
    const list = Array.isArray(apps) ? apps : (apps?.apps ?? []);
    const installed = list.some((a) =>
      typeof a === "string" ? a === bundleId : a?.id === bundleId || a?.bundleId === bundleId
    );
    return installed ? "reuse" : "build";
  } catch {
    return "build";
  }
}

async function defaultReadFile(path) {
  return fsReadFile(path, "utf8");
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls Metro's own log output for its ready banner. Every dependency is
// injectable so this is testable without a real bundler.
export async function waitForMetroReady({
  logPath,
  timeoutMs = METRO_READY_TIMEOUT_MS,
  intervalMs = 250,
  readFile = defaultReadFile,
  sleep = defaultSleep,
  clock = Date.now,
}) {
  const deadline = clock() + timeoutMs;
  do {
    const text = await readFile(logPath).catch(() => "");
    if (/Metro waiting on|Logs for your project will appear below|Starting Metro Bundler/i.test(text)) {
      return true;
    }
    if (/EADDRINUSE|address already in use/i.test(text)) {
      throw recoverable(`Metro port already in use (see ${logPath})`);
    }
    await sleep(intervalMs);
  } while (clock() < deadline);
  return false;
}

function defaultHandlerDeps() {
  return {
    runner: defaultRunner,
    spawnForeground,
    spawnBackground,
    waitForMetroReady,
    isAlive,
    kill,
    saveSession,
    loadSession,
    appendManifest,
    generateSessionId,
    env: process.env,
    stderr: process.stderr,
  };
}

// Builds the {start, stop, status} handler map runMain dispatches on. Every
// side-effecting dependency has a default but is overridable — tests build
// this with a fully mocked runner/spawn/session-store (see
// packs/expo/adapters/test/run.test.js).
export function createHandlers(overrides = {}) {
  const deps = { ...defaultHandlerDeps(), ...overrides };

  async function start(request) {
    const workspace = resolveWorkspace(request, deps.env);
    const target = resolveTarget(request, deps.env);
    const profile = resolveProfile(request);
    const evidenceDir = request.evidence_dir ?? null;
    const port = Number(request.env?.EXPO_METRO_PORT) || Number(deps.env.AGENTFLOW_EXPO_METRO_PORT) || DEFAULT_METRO_PORT;

    const expoBin = await assertWorkspace(workspace);
    await assertXcode({ runner: deps.runner });

    const config = await readExpoConfig(workspace, expoBin, { runner: deps.runner });
    const bundleId = bundleIdFromConfig(config);

    const sessionId = deps.generateSessionId();
    const adSession = agentDeviceSessionName(sessionId);
    const logPath = evidenceDir
      ? join(evidenceDir, "app.log")
      : join(resolveStateDir(deps.env), "..", "logs", `${sessionId}.log`);

    const startPath = await decideStartPath({ bundleId, target, runner: deps.runner });

    const spawnEnv = { ...process.env, ...request.env };

    if (startPath === "build") {
      const buildResult = await deps.spawnForeground(expoBin, ["run:ios", "--device", target, "--no-bundler"], {
        cwd: workspace,
        env: spawnEnv,
        timeoutMs: BUILD_TIMEOUT_MS,
        onOutput: (line) => diagnostic(`[expo run:ios] ${line}`, deps.stderr),
      });
      if (buildResult.error) {
        throw recoverable(`expo run:ios failed to start: ${buildResult.error.message}`);
      }
      if (buildResult.timedOut) {
        throw recoverable(`expo run:ios did not finish within ${BUILD_TIMEOUT_MS}ms (possible simulator boot flake)`);
      }
      if (buildResult.code !== 0) {
        throw recoverable(`expo run:ios exited ${buildResult.code} (build/install failure)`);
      }
    }

    const metroProc = await deps.spawnBackground(expoBin, ["start", "--port", String(port)], {
      cwd: workspace,
      env: spawnEnv,
      logPath,
    });

    const ready = await deps.waitForMetroReady({ logPath });
    if (!ready) {
      throw recoverable(`Metro did not report ready within ${METRO_READY_TIMEOUT_MS}ms (port ${port} may be in use)`);
    }

    const entryPoint = `exp://127.0.0.1:${port}`;

    try {
      await agentDevice.openSession({
        app: bundleId,
        url: entryPoint,
        platform: "ios",
        device: target,
        session: adSession,
        runner: deps.runner,
      });
    } catch (err) {
      throw recoverable(`agent-device could not open a session for ${bundleId}: ${err.message}`);
    }

    await deps.saveSession({
      session_id: sessionId,
      workspace,
      target,
      profile,
      bundle_id: bundleId,
      agent_device_session: adSession,
      start_path: startPath,
      metro: { pid: metroProc.pid, port, log: logPath },
      entry_point: entryPoint,
      log_stream: logPath,
      evidence_dir: evidenceDir,
      state: "running",
    });

    if (evidenceDir) {
      await deps.appendManifest(evidenceDir, { type: "log", path: logPath, label: "app.log" });
    }

    return { session_id: sessionId, entry_point: entryPoint, log_stream: logPath };
  }

  async function stop(request) {
    const sessionId = request.session_id;
    if (!sessionId) throw fatal("stop requires session_id");
    let record;
    try {
      record = await deps.loadSession(sessionId);
    } catch {
      throw fatal(`unknown session_id: ${sessionId}`);
    }

    try {
      await agentDevice.closeSession({
        session: record.agent_device_session,
        platform: "ios",
        device: record.target,
        runner: deps.runner,
      });
    } catch (err) {
      // Best-effort: the session record is still ours to mark stopped even
      // if agent-device already lost track of it (daemon restart, etc).
      diagnostic(`[run] agent-device close failed for ${sessionId}: ${err.message}`, deps.stderr);
    }

    if (record.metro?.pid && deps.isAlive(record.metro.pid)) {
      deps.kill(record.metro.pid);
    }

    await deps.saveSession({ ...record, state: "stopped" });
    return { session_id: sessionId, state: "stopped" };
  }

  async function status(request) {
    const sessionId = request.session_id;
    if (!sessionId) throw fatal("status requires session_id");
    let record;
    try {
      record = await deps.loadSession(sessionId);
    } catch {
      throw fatal(`unknown session_id: ${sessionId}`);
    }

    let state = record.state;
    if (state === "running" && record.metro?.pid && !deps.isAlive(record.metro.pid)) {
      state = "crashed";
    }
    if (state !== record.state) {
      await deps.saveSession({ ...record, state });
    }
    return { session_id: sessionId, state };
  }

  return { start, stop, status };
}

async function main() {
  await runMain({ interfaceName: INTERFACE, handlers: createHandlers() });
}

// Only run as a CLI when invoked directly (the E2E resolver spawns this file
// with `node`) — importing it for tests must not touch stdin.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
