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
//
// Once Metro is spawned, everything up to `saveSession` runs inside a single
// try/catch that kills Metro (by process group, identity-checked) before
// rethrowing: without that, a failure between spawning Metro and durably
// recording the session (a slow first boot, agent-device unreachable) leaks
// the bundler holding the port, AND dooms core's one bounded retry — the
// retry's own spawnBackground hits the still-held port and fails the same
// way, turning a transient 10 into a guaranteed escalation (see #138 review).

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile as fsReadFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { runMain, recoverable, fatal, diagnostic, AdapterError } from "./lib/contract.js";
import {
  resolveWorkspace,
  resolveTarget,
  resolveProfile,
  assertWorkspace,
  assertXcode,
} from "./lib/workspace.js";
import {
  defaultRunner,
  spawnForeground,
  spawnBackground,
  isAlive,
  kill,
  captureIdentity,
} from "./lib/proc.js";
import * as agentDevice from "./lib/agent-device.js";
import { saveSession, loadSession, resolveStateDir } from "./lib/session.js";
import { appendManifest } from "./lib/evidence.js";

const INTERFACE = "run";

export const DEFAULT_METRO_PORT = 8081;
export const BUILD_TIMEOUT_MS = Number(process.env.AGENTFLOW_EXPO_BUILD_TIMEOUT_MS) || 15 * 60 * 1000; // 15min: first `expo run:ios` build is Xcode + CocoaPods
export const METRO_READY_TIMEOUT_MS = Number(process.env.AGENTFLOW_EXPO_METRO_TIMEOUT_MS) || 30 * 1000;

// 128 bits of randomness (a full v4 UUID) — this is a durable global handle
// that outlives the process that minted it, not a short-lived local counter.
export function generateSessionId() {
  return `sess-${randomUUID()}`;
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

// Resolves the URL scheme the dev client itself is registered to open under.
// This is the workspace's own declared app.json/app.config.js `scheme` (a
// string, or the first entry of an array — Expo allows either shape) — never
// re-derived or guessed here, for the same reason bundleIdFromConfig defers
// to "expo config --json" rather than re-implementing Expo's config merge.
//
// #162: the generic `exp://` scheme (Expo Go's own) is not a substitute. A
// custom dev client and Expo Go both register schemes independently; opening
// `exp://` targets whichever one of them actually claims it — Expo Go, once
// it's installed — never this workspace's own app, so "falling back" to it
// isn't a degraded-but-working path, it's opening the wrong app entirely
// (confirmed live: the target app's own `CFBundleURLTypes` does not list
// `exp` at all). Recoverable(10) here, naming the missing scheme, so a
// misconfigured workspace fails loudly at `start` instead of quietly opening
// nothing useful.
export function schemeFromConfig(config) {
  const raw = config?.scheme;
  const scheme = Array.isArray(raw) ? raw[0] : raw;
  if (!scheme || typeof scheme !== "string") {
    throw recoverable(
      'workspace app config has no "scheme" ("expo config --json" -> scheme) — cannot build the dev client\'s own expo-development-client deep link, and opening the generic exp:// scheme instead would target Expo Go, not this app (see #162); add a "scheme" to the workspace\'s app.json'
    );
  }
  return scheme;
}

// Builds the bundle-scoped deep link a custom Expo dev client actually opens
// under — the same shape Expo's own CLI constructs for `expo run:ios`
// (`UrlCreator#constructDevClientUrl`, confirmed by reading it directly out
// of a live workspace's node_modules): `<scheme>://expo-development-client/
// ?url=<urlencoded manifest url>`. `metroUrl` is the Metro server's own
// address, url-encoded whole (not just its query-unsafe characters) since
// it's carried as a single opaque query value.
export function buildDevClientUrl(scheme, metroUrl) {
  return `${scheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}`;
}

// The start-path decision: is the dev client already installed on the target
// simulator? If so, skip the (minutes-long) `expo run:ios` build and just
// reuse it. Any failure to confirm (device not booted yet, agent-device
// error) falls back to the safe-but-slow "build" path rather than assuming
// an install that may not exist.
export async function decideStartPath({ bundleId, target, runner }) {
  try {
    // listApps already unwraps the {success, data:{apps:[...]}} envelope and
    // hands back the bare array (see lib/agent-device.js#listApps, #142) —
    // this used to re-derive the array itself via `apps?.apps`, which never
    // matched the real payload shape and defeated the reuse path entirely.
    const list = await agentDevice.listApps({ platform: "ios", device: target, runner });
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

// Metro's own /status endpoint is the actual readiness signal (200 once it
// can serve bundles) — a boot-banner grep in the log can fire on a line
// Metro prints at the *start* of boot, before it can serve anything.
function defaultProbe(port, { timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const req = httpGet({ host: "127.0.0.1", port, path: "/status", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

// Polls Metro's real readiness (HTTP /status) rather than its log output;
// the log is still watched for an EADDRINUSE line so a port conflict fails
// fast instead of waiting out the full timeout. Every dependency is
// injectable so this is testable without a real bundler or a real socket.
export async function waitForMetroReady({
  port,
  logPath,
  timeoutMs = METRO_READY_TIMEOUT_MS,
  intervalMs = 250,
  probe = defaultProbe,
  readFile = defaultReadFile,
  sleep = defaultSleep,
  clock = Date.now,
}) {
  const deadline = clock() + timeoutMs;
  do {
    if (port && (await probe(port).catch(() => false))) return true;
    const text = await readFile(logPath).catch(() => "");
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
    captureIdentity,
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

// A session's stop/status handling needs to tell "no such session" (the file
// was never written — a genuinely unknown session_id, fatal/20) apart from
// "the file exists but couldn't be read" (SessionCorruptError or any other
// I/O surprise — recoverable/10, naming the path, since retrying may see a
// concurrent writer finish). ENOENT is the only case that means "unknown".
function loadSessionOrThrow(deps, sessionId) {
  return deps.loadSession(sessionId).catch((err) => {
    if (err && err.code === "ENOENT") throw fatal(`unknown session_id: ${sessionId}`);
    throw recoverable(`session state for ${sessionId} is unreadable: ${err.message}`, { cause: err });
  });
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
    // Resolved now, before the (possibly 15-minute) build step or Metro even
    // spawns — a missing scheme is a workspace misconfiguration, not
    // something a build/Metro run can fix, so there is no reason to spend
    // either before failing on it (see schemeFromConfig).
    const scheme = schemeFromConfig(config);

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

    let metroProc;
    try {
      metroProc = await deps.spawnBackground(expoBin, ["start", "--port", String(port)], {
        cwd: workspace,
        env: spawnEnv,
        logPath,
      });
    } catch (err) {
      throw recoverable(`failed to start Metro (${expoBin} start --port ${port}): ${err.message}`);
    }

    const metroIdentity = await deps.captureIdentity(metroProc.pid, { runner: deps.runner });
    const metro = { pid: metroProc.pid, port, log: logPath, identity: metroIdentity };

    let entryPoint;
    try {
      const ready = await deps.waitForMetroReady({ logPath, port });
      if (!ready) {
        throw recoverable(`Metro did not report ready within ${METRO_READY_TIMEOUT_MS}ms (port ${port} may be in use)`);
      }

      // 127.0.0.1, not a LAN/gateway address: this adapter only targets the
      // iOS *simulator* (see the file header), which shares the host's
      // loopback interface — unlike a physical device, it needs no LAN IP to
      // reach Metro here.
      entryPoint = buildDevClientUrl(scheme, `http://127.0.0.1:${port}`);

      await agentDevice.openSession({
        app: bundleId,
        url: entryPoint,
        platform: "ios",
        device: target,
        session: adSession,
        runner: deps.runner,
      });
    } catch (err) {
      // Metro is live and the session is not yet durably recorded — kill it
      // before rethrowing, or a bounded retry inherits a held port and is
      // doomed to fail the same way (see the file-header note and the HIGH
      // finding on #138).
      await deps.kill(metro.pid, metro.identity, { group: true, runner: deps.runner }).catch(() => {});
      if (err instanceof AdapterError) throw err;
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
      metro,
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
    const record = await loadSessionOrThrow(deps, sessionId);

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

    if (record.metro?.pid) {
      // kill() itself verifies identity before signalling anything — no
      // separate isAlive pre-check needed here.
      await deps.kill(record.metro.pid, record.metro.identity, { group: true, runner: deps.runner });
    }

    await deps.saveSession({ ...record, state: "stopped" });
    return { session_id: sessionId, state: "stopped" };
  }

  async function status(request) {
    const sessionId = request.session_id;
    if (!sessionId) throw fatal("status requires session_id");
    const record = await loadSessionOrThrow(deps, sessionId);

    let state = record.state;
    if (state === "running" && record.metro?.pid) {
      const alive = await deps.isAlive(record.metro.pid, record.metro.identity, { runner: deps.runner });
      if (!alive) state = "crashed";
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
