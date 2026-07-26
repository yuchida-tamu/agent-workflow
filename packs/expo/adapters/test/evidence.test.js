import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendManifest, readManifest, MANIFEST_FILE } from "../lib/evidence.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "agentflow-expo-evidence-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("appendManifest: creates manifest.json with the core-owned row shape", async () => {
  await withTempDir(async (dir) => {
    const row = await appendManifest(dir, { type: "log", path: "app.log", label: "app log" });
    assert.deepEqual(row, { type: "log", path: "app.log", label: "app log" });
    const manifest = JSON.parse(await readFile(join(dir, MANIFEST_FILE), "utf8"));
    assert.deepEqual(manifest, [row]);
  });
});

test("appendManifest: accumulates across calls, preserves order", async () => {
  await withTempDir(async (dir) => {
    await appendManifest(dir, { type: "log", path: "app.log" });
    await appendManifest(dir, { type: "screenshot", path: "0001.png", label: "boot", step_ref: "given the app is open" });
    const manifest = await readManifest(dir);
    assert.equal(manifest.length, 2);
    assert.equal(manifest[1].step_ref, "given the app is open");
  });
});

test("appendManifest: no evidence_dir is a no-op, not an error", async () => {
  const row = await appendManifest(null, { type: "log", path: "x" });
  assert.equal(row, null);
});

test("appendManifest: requires type and path", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(() => appendManifest(dir, { path: "x" }));
    await assert.rejects(() => appendManifest(dir, { type: "log" }));
  });
});

test("readManifest: missing manifest.json reads as an empty list, not an error", async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await readManifest(dir), []);
  });
});
