// workspace.js — resolves which Expo checkout and simulator target an
// invocation means, and validates the workspace is usable before `run` tries
// to boot anything. Fallback order is load-bearing: the E2E runner calls
// `run start` with only `{op, evidence_dir}` (scripts/e2e/runner.js), so
// without these fallbacks replay can never boot (#132 risk #3).

import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { fatal } from "./contract.js";

export const DEFAULT_TARGET = "iPhone 15";
export const DEFAULT_PROFILE = "dev";

// workspace: payload.workspace -> AGENTFLOW_EXPO_WORKSPACE -> cwd
export function resolveWorkspace(payload = {}, env = process.env, cwd = process.cwd) {
  return payload.workspace || env.AGENTFLOW_EXPO_WORKSPACE || (typeof cwd === "function" ? cwd() : cwd);
}

// target: payload.target -> AGENTFLOW_EXPO_TARGET -> "iPhone 15"
export function resolveTarget(payload = {}, env = process.env) {
  return payload.target || env.AGENTFLOW_EXPO_TARGET || DEFAULT_TARGET;
}

// profile: payload.profile -> "dev" (rn-expo: dev = dev client + Metro)
export function resolveProfile(payload = {}) {
  return payload.profile || DEFAULT_PROFILE;
}

export function expoBinPath(workspace) {
  return join(workspace, "node_modules", ".bin", "expo");
}

// Global/nodenv-shim `expo` is unusable on the reference machine (#132 risk
// #2) — every invocation MUST go through the workspace-local binary. This
// throws a fatal (20) AdapterError, never a bare Error, so callers can just
// `await assertWorkspace(...)` and let it propagate to runMain.
export async function assertWorkspace(workspace, { fs = { access } } = {}) {
  if (!workspace) {
    throw fatal("no workspace: resolve workspace via payload.workspace, AGENTFLOW_EXPO_WORKSPACE, or cwd");
  }
  try {
    await fs.access(join(workspace, "package.json"), constants.F_OK);
  } catch {
    throw fatal(`no workspace: ${workspace} has no package.json`);
  }
  const expoBin = expoBinPath(workspace);
  try {
    await fs.access(expoBin, constants.F_OK);
  } catch {
    throw fatal(
      `no workspace-local expo: ${expoBin} not found — run "npm install" in ${workspace} ` +
        "(a global/shim expo is not supported)"
    );
  }
  return expoBin;
}

// `xcrun --find simctl` is the cheapest signal that Xcode command line tools
// are present. Absence is fatal (20) per #132 risk: "no Xcode" is not
// something a retry recovers from.
export async function assertXcode({ runner, exec = "xcrun" } = {}) {
  if (!runner) throw new TypeError("assertXcode requires a runner");
  const result = await runner.exec(exec, ["--find", "simctl"], {});
  if (result.error || result.code !== 0) {
    throw fatal(
      `Xcode command line tools not available: ${exec} --find simctl failed ` +
        `(${result.error?.message ?? `exit ${result.code}`})`
    );
  }
}
