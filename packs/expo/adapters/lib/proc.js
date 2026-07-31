// proc.js — the one process-spawning seam every adapter op goes through.
// Real spawning lives here so tests can inject a fake `runner` (or fake
// `spawnFn`) instead of shelling real binaries — CI has no simulator/Xcode
// (see #132's capability probe), so anything that touches a real process
// must be swappable.
//
// Three spawn shapes, three use cases:
//   - `defaultRunner.exec`   short commands that return once (agent-device
//                            invocations, `xcrun --find`, `expo config`,
//                            `ps` for pid identity below).
//   - `spawnForeground`      long commands that must finish before continuing
//                            (`expo run:ios` — a first build is minutes; see
//                            interfaces/run.md's "Note on the dev profile").
//                            Spawned detached so a build timeout can signal
//                            the whole process group, not just the direct
//                            child (xcodebuild/CocoaPods grandchildren).
//   - `spawnBackground`      long-running daemons this adapter must outlive
//                            the invocation of (`expo start` / Metro) — pid
//                            and log path get persisted to the session state
//                            file so a later `stop` can find them.
//
// Pid identity: a bare pid is not a safe long-lived handle — the OS recycles
// pids, and a session record can outlive the process it named (crash,
// reboot, a tmp-dir that survives a restart). `captureIdentity` snapshots a
// process's start time + command line at spawn time; `isAlive`/`kill` verify
// that snapshot still matches before ever treating a pid as "ours" or
// signalling it. A mismatch — or no snapshot at all — is treated as *not*
// alive: this fails closed toward "leak a process" rather than toward
// "signal a stranger's pid".

import { execFile, spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// { code, stdout, stderr, error } — `error` is only set for spawn-level
// failures (ENOENT etc), never for a plain non-zero exit.
export const defaultRunner = {
  exec(cmd, args, opts = {}) {
    return new Promise((resolve) => {
      execFile(cmd, args, { ...opts, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          error: error && typeof error.code !== "number" ? error : null,
        });
      });
    });
  },
};

// Signals the process group a detached child leads (`-pid`) so grandchildren
// (xcodebuild, CocoaPods) don't outlive their parent; falls back to
// signalling just the child when group-kill isn't available (no real OS pid,
// not a group leader, unsupported platform, or a test double with a mocked
// `.kill()`).
function killChildGroup(child, signal) {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // fall through to a direct signal
    }
  }
  child.kill?.(signal);
}

// Runs `cmd` to completion, streaming each stdout/stderr line to onOutput as
// it arrives (progress for a slow `expo run:ios` build). Resolves
// {code, signal, timedOut}; never rejects on a non-zero exit — only on a
// spawn-level error (missing binary etc), which it still resolves as
// {code: null, error}.
export function spawnForeground(cmd, args, { cwd, env, timeoutMs, onOutput, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnFn(cmd, args, { cwd, env, detached: true });
    let timedOut = false;
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        killChildGroup(child, "SIGTERM");
      }, timeoutMs);
    }
    const forward = (stream) => (chunk) => {
      if (onOutput) {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (line.length) onOutput(line, stream);
        }
      }
    };
    child.stdout?.on("data", forward("stdout"));
    child.stderr?.on("data", forward("stderr"));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, error });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, timedOut, error: null });
    });
  });
}

// Starts a long-running background process (Metro), redirecting its
// stdout+stderr to `logPath` (created if needed), and returns its pid once
// the process has actually spawned. Rejects if the spawn itself fails
// (ENOENT/EACCES/etc) instead of leaving an unhandled 'error' event on the
// child: Node fires exactly one of 'spawn' (success) or 'error' (failure),
// so racing them turns a spawn-time failure into an ordinary rejection the
// caller can map to a normal JSON error response, instead of an
// uncaughtException with nothing on stdout. The child is unref'd once
// spawned so it outlives this invocation.
//
// #156: this used to pass a bare `createWriteStream(logPath)` straight into
// `stdio` — but a WriteStream opens its fd *asynchronously* (`.fd` stays
// `null` until its own 'open' event), and there is no await/tick between
// creating the stream and calling `spawnFn`, so Node's synchronous stdio
// validation always saw `fd: null` and threw immediately, every time, on
// every supported Node version. `fs.openSync` gets a real fd synchronously,
// so it's already a valid number by the time spawn validates `stdio` —
// no race, no await-the-stream's-'open'-event dance needed.
export async function spawnBackground(cmd, args, { cwd, env, logPath, spawnFn = spawn } = {}) {
  let stdio = ["ignore", "ignore", "ignore"];
  let fd = null;
  if (logPath) {
    await mkdir(dirname(logPath), { recursive: true });
    fd = openSync(logPath, "a");
    stdio = ["ignore", fd, fd];
  }
  const child = spawnFn(cmd, args, { cwd, env, detached: true, stdio });

  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      function cleanup() {
        child.off("error", onError);
        child.off("spawn", onSpawn);
      }
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
  } finally {
    // By the time spawnFn(...) returns, the underlying fork/exec has
    // already happened (or failed) — the OS has already duplicated `fd`
    // into the child's own stdio slots if the spawn succeeded, so closing
    // our copy here (success or failure) never touches the child's output;
    // it just stops this long-lived adapter process from leaking fds across
    // repeated `run start` calls.
    if (fd !== null) closeSync(fd);
  }

  // The caller has already moved on with the pid by the time any later
  // async error fires (EPIPE on the log stream, etc) — keep a listener
  // attached for the child's lifetime so that can never crash this process
  // via an unhandled 'error' event; there's nothing more to do with it here.
  child.on("error", () => {});
  child.unref();
  return { pid: child.pid, logPath: logPath ?? null };
}

// Captures a lightweight identity token for a freshly spawned pid: its start
// time + full command line, via `ps`. `null` means the pid can't be
// confirmed at all (already gone, or `ps` itself failed) — callers must
// treat that the same as "not ours".
export async function captureIdentity(pid, { runner = defaultRunner } = {}) {
  if (!pid) return null;
  const result = await runner.exec("ps", ["-p", String(pid), "-o", "lstart=,command="], {});
  if (result.error || result.code !== 0) return null;
  const text = result.stdout.trim();
  return text || null;
}

// True only when `pid` still exists AND its current `ps` identity matches
// the one captured at spawn time. No identity to compare against (capture
// failed, or an older record predates this check) fails closed to "not
// alive" — a false "crashed"/skip-the-kill is the safe direction; signalling
// a recycled pid that now belongs to an unrelated process is not.
export async function isAlive(pid, identity, { runner = defaultRunner } = {}) {
  if (!pid || !identity) return false;
  const current = await captureIdentity(pid, { runner });
  return current !== null && current === identity;
}

// Signals `pid` only after `isAlive` confirms the identity still matches.
// `group: true` signals the process group (`-pid`) instead of just the pid —
// use it for anything spawned detached (spawnBackground's Metro).
export async function kill(pid, identity, { signal = "SIGTERM", group = false, runner = defaultRunner } = {}) {
  const alive = await isAlive(pid, identity, { runner });
  if (!alive) return false;
  try {
    process.kill(group ? -pid : pid, signal);
    return true;
  } catch {
    return false;
  }
}

// ---- port ownership: is a listening port actually OUR spawned process? ----
//
// Metro's own `/status` endpoint (run.js's `waitForMetroReady`) is a bare
// `200`/text response — confirmed against a live `expo start`: no header,
// token, or body field distinguishes which invocation answered it. That's
// fine when only one Metro could possibly be bound to the port, but on a
// shared machine (see skills/expo-dev.md's "port 8081 already held" note) a
// *different*, already-running packager can already be listening on the
// exact port this session just asked for — our own `expo start` hasn't
// bound yet, is still polling, and picks up 200s from a process that isn't
// ours at all. There is no probe-the-endpoint-harder fix for this: the
// endpoint genuinely carries no identity to check. The only deterministic
// signal is the OS's own port -> pid mapping, so that's what this checks
// instead — `lsof`'s bare `-t` (pid-only) output for whatever process the
// kernel has actually bound to the port, compared against the pid we
// ourselves spawned.
export async function portOwners(port, { runner = defaultRunner } = {}) {
  const result = await runner.exec("lsof", [`-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {});
  if (result.error || result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
}

// True only when `pid` itself is among the process(es) the OS has bound to
// `port`. A missing pid, an unparseable/unavailable `lsof`, or a not-yet-
// bound port all resolve `false` — the same "not confirmed yet, keep
// waiting" direction `waitForMetroReady` already treats every other
// not-ready signal as, never a false positive.
export async function isPortOwnedBy(port, pid, { runner = defaultRunner } = {}) {
  if (!pid) return false;
  const owners = await portOwners(port, { runner });
  return owners.includes(pid);
}
