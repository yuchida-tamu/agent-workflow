// proc.js — the one process-spawning seam every adapter op goes through.
// Real spawning lives here so tests can inject a fake `runner` (or fake
// `spawnFn`) instead of shelling real binaries — CI has no simulator/Xcode
// (see #132's capability probe), so anything that touches a real process
// must be swappable.
//
// Three shapes, three use cases:
//   - `defaultRunner.exec`   short commands that return once (agent-device
//                            invocations, `xcrun --find`, `expo config`).
//   - `spawnForeground`      long commands that must finish before continuing
//                            (`expo run:ios` — a first build is minutes; see
//                            interfaces/run.md's "Note on the dev profile").
//   - `spawnBackground`      long-running daemons this adapter must outlive
//                            the invocation of (`expo start` / Metro) — pid
//                            and log path get persisted to the session state
//                            file so a later `stop` can find them.

import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
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

// Runs `cmd` to completion, streaming each stdout/stderr line to onOutput as
// it arrives (progress for a slow `expo run:ios` build). Resolves
// {code, signal, timedOut}; never rejects on a non-zero exit — only on a
// spawn-level error (missing binary etc), which it still resolves as
// {code: null, error}.
export function spawnForeground(cmd, args, { cwd, env, timeoutMs, onOutput, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnFn(cmd, args, { cwd, env });
    let timedOut = false;
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
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
// stdout+stderr to `logPath` (created if needed), and returns immediately
// with its pid so the caller can persist it to the session record. The child
// is unref'd so it outlives this adapter invocation once node exits.
export async function spawnBackground(cmd, args, { cwd, env, logPath, spawnFn = spawn } = {}) {
  let out = "ignore";
  if (logPath) {
    await mkdir(dirname(logPath), { recursive: true });
    out = createWriteStream(logPath, { flags: "a" });
  }
  const child = spawnFn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  return { pid: child.pid, logPath: logPath ?? null };
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function kill(pid, signal = "SIGTERM") {
  if (!pid) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}
