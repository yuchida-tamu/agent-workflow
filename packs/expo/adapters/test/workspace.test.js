import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveWorkspace,
  resolveTarget,
  resolveProfile,
  expoBinPath,
  assertWorkspace,
  assertXcode,
  DEFAULT_TARGET,
  DEFAULT_PROFILE,
} from "../lib/workspace.js";
import { AdapterError, EXIT_FATAL } from "../lib/contract.js";

// Resolution order is the load-bearing part of #133: the E2E runner calls
// `run start` with only {op, evidence_dir} (scripts/e2e/runner.js), so
// without these fallbacks replay can never boot (see #132's risk #3).
test("resolveWorkspace: payload.workspace beats env beats cwd", () => {
  const env = { AGENTFLOW_EXPO_WORKSPACE: "/from/env" };
  assert.equal(resolveWorkspace({ workspace: "/from/payload" }, env, () => "/from/cwd"), "/from/payload");
  assert.equal(resolveWorkspace({}, env, () => "/from/cwd"), "/from/env");
  assert.equal(resolveWorkspace({}, {}, () => "/from/cwd"), "/from/cwd");
});

test("resolveTarget: payload.target beats env beats the iPhone 15 default", () => {
  const env = { AGENTFLOW_EXPO_TARGET: "iPhone 16" };
  assert.equal(resolveTarget({ target: "iPad Pro" }, env), "iPad Pro");
  assert.equal(resolveTarget({}, env), "iPhone 16");
  assert.equal(resolveTarget({}, {}), DEFAULT_TARGET);
});

test("resolveProfile: payload.profile beats the dev default", () => {
  assert.equal(resolveProfile({ profile: "release" }), "release");
  assert.equal(resolveProfile({}), DEFAULT_PROFILE);
  assert.equal(DEFAULT_PROFILE, "dev");
});

test("expoBinPath: workspace-local node_modules/.bin/expo, never a global/shim expo", () => {
  assert.equal(expoBinPath("/ws"), join("/ws", "node_modules", ".bin", "expo"));
});

async function withTempWorkspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), "agentflow-expo-workspace-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("assertWorkspace: fatal (20) when there is no package.json — 'no workspace'", async () => {
  await withTempWorkspace(async (dir) => {
    await assert.rejects(() => assertWorkspace(dir), (err) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, EXIT_FATAL);
      assert.match(err.message, /no workspace/);
      return true;
    });
  });
});

test("assertWorkspace: fatal (20) when package.json exists but node_modules/.bin/expo does not", async () => {
  await withTempWorkspace(async (dir) => {
    await writeFile(join(dir, "package.json"), "{}");
    await assert.rejects(() => assertWorkspace(dir), (err) => {
      assert.equal(err.code, EXIT_FATAL);
      assert.match(err.message, /no workspace-local expo/);
      return true;
    });
  });
});

test("assertWorkspace: resolves the expo bin path when the workspace is valid", async () => {
  await withTempWorkspace(async (dir) => {
    await writeFile(join(dir, "package.json"), "{}");
    await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(dir, "node_modules", ".bin", "expo"), "#!/usr/bin/env node\n");
    const bin = await assertWorkspace(dir);
    assert.equal(bin, expoBinPath(dir));
  });
});

test("assertWorkspace: fatal (20) when no workspace can be resolved at all", async () => {
  await assert.rejects(() => assertWorkspace(""), (err) => {
    assert.equal(err.code, EXIT_FATAL);
    assert.match(err.message, /no workspace/);
    return true;
  });
});

test("assertXcode: fatal (20) when xcrun --find simctl fails — 'no Xcode' per #132 risk #2", async () => {
  const runner = { exec: async () => ({ code: 1, stdout: "", stderr: "", error: null }) };
  await assert.rejects(() => assertXcode({ runner }), (err) => {
    assert.equal(err.code, EXIT_FATAL);
    assert.match(err.message, /Xcode/);
    return true;
  });
});

test("assertXcode: resolves quietly when xcrun --find simctl succeeds", async () => {
  const runner = { exec: async () => ({ code: 0, stdout: "/usr/bin/simctl\n", stderr: "", error: null }) };
  await assert.doesNotReject(() => assertXcode({ runner }));
});
