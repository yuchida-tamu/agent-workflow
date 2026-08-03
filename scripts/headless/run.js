// The I/O half of the launcher: spawn `claude`, hold it to a wall clock, hand
// the result back to `core.js` to classify. Everything decidable lives there;
// this file only does the things that cannot be tested without a process.
//
// The spawn is injected rather than imported so the whole path above it stays
// testable with no `claude` binary, no token and no network.

import { spawn } from "node:child_process";
import { loadTiers } from "../log/cli.js";
import { classify, launchPlan } from "./core.js";

export const CLI = "claude";

// Spawn, collect, and enforce the timeout. Resolves — never rejects — because a
// failed run still owes the caller a ledger row, and a rejection would tempt the
// caller into a bare try/catch that loses the distinction between the outcomes
// `core.js` works to keep apart.
export function runProcess(
  { argv, env, timeoutMs, cwd },
  spawnFn = spawn,
) {
  return new Promise((resolve) => {
    const child = spawnFn(CLI, argv, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first; the process is killed rather than orphaned, which is the
      // difference between a bounded run and a runner minute leak.
      child.kill("SIGTERM");
    }, timeoutMs);

    // `setEncoding` and not `+= buffer`. Concatenating raw Buffers with `+=`
    // calls `toString()` per chunk, so a multi-byte character straddling a chunk
    // boundary is decoded as two broken halves — `verdict — approved` arrives as
    // `verdict ��� approved`. A stream decoder holds the partial sequence until
    // the rest arrives. Em dashes are everywhere in this repo's artifacts, so
    // this is a routine trigger, not an exotic one; and a split inside the JSON
    // body would make `parseUsage` fail on a run that actually succeeded.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));

    const finish = (code, signal = null) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, timeoutMs });
    };

    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      finish(127); // could not spawn — classified as `failed`, not as auth
    });
    // A signal-killed process reports `code === null`. Coercing that to 0 would
    // classify an OOM-killed or operator-cancelled run as a success and close
    // its ledger row `ok` — the one case our own timeout does not cover, since
    // `timedOut` short-circuits first.
    child.on("close", (code, signal) => finish(code, signal));
  });
}

// The one call an Actions entry point makes.
//
// → { outcome, reason, usage, model, argv } — always, for every path. A refusal
// (`disabled`, `unauthenticated`) returns the same shape as a completed run, so
// the caller writes one ledger row in one place instead of branching on whether
// anything ran.
export async function launch(options, { spawnFn = spawn, tiers = null } = {}) {
  const plan = launchPlan({ ...options, tiers: tiers ?? loadTiers() });
  if (!plan.launch) {
    return { outcome: plan.outcome, reason: plan.reason, usage: null, model: null, argv: null };
  }

  // `cwd` comes off the PLAN, not off `options` directly: `launchPlan` already
  // received `options.cwd` (the spread above) and echoes it back on the plan
  // it returns — a single source of truth for "where does this run", rather
  // than two paths (`options.cwd` here, `plan.cwd` everywhere else this
  // module is called via `runProcess(plan)` directly) that could drift.
  const result = await runProcess(
    { argv: plan.argv, env: plan.env, timeoutMs: plan.timeoutMs, cwd: plan.cwd },
    spawnFn,
  );
  const verdict = classify(result);
  return { ...verdict, model: plan.model, argv: plan.argv };
}
