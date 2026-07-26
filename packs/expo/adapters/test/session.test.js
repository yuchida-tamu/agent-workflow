import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStateDir, saveSession, loadSession, deleteSession, SessionCorruptError } from "../lib/session.js";

async function withTempStateDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "agentflow-expo-session-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("resolveStateDir: env override wins, else a fixed tmp-dir default", () => {
  assert.equal(resolveStateDir({ AGENTFLOW_EXPO_STATE_DIR: "/custom/state" }), "/custom/state");
  const fallback = resolveStateDir({});
  assert.ok(fallback.includes("agentflow-expo"));
});

test("saveSession/loadSession: round-trips from a fresh process (stop/status resolve what start wrote)", async () => {
  await withTempStateDir(async (stateDir) => {
    const record = {
      session_id: "sess-abc123",
      workspace: "/ws",
      target: "iPhone 15",
      profile: "dev",
      bundle_id: "com.example.app",
      agent_device_session: "agentflow-run-sess-abc123",
      start_path: "reuse",
      metro: { pid: 4242, port: 8081, log: "/ws/evidence/app.log", identity: "Mon Jul 20 10:00:00 2026 node" },
      entry_point: "exp://127.0.0.1:8081",
      log_stream: "/ws/evidence/app.log",
      evidence_dir: "/ws/evidence",
      state: "running",
    };
    await saveSession(record, { stateDir });

    // Simulate a fresh process: load with only the session_id, as stop/status do.
    const loaded = await loadSession("sess-abc123", { stateDir });
    assert.equal(loaded.session_id, "sess-abc123");
    assert.equal(loaded.bundle_id, "com.example.app");
    assert.deepEqual(loaded.metro, {
      pid: 4242,
      port: 8081,
      log: "/ws/evidence/app.log",
      identity: "Mon Jul 20 10:00:00 2026 node",
    });
    assert.ok(loaded.created_at);
    assert.ok(loaded.updated_at);
  });
});

test("saveSession: a later save merges over the record and preserves created_at", async () => {
  await withTempStateDir(async (stateDir) => {
    const first = await saveSession({ session_id: "sess-1", state: "running" }, { stateDir });
    await new Promise((r) => setTimeout(r, 5));
    const second = await saveSession({ session_id: "sess-1", state: "stopped" }, { stateDir });
    assert.equal(second.created_at, first.created_at);
    assert.notEqual(second.updated_at, first.updated_at);
    assert.equal(second.state, "stopped");

    const loaded = await loadSession("sess-1", { stateDir });
    assert.equal(loaded.state, "stopped");
  });
});

test("saveSession: writes atomically — no leftover temp file after a successful save", async () => {
  await withTempStateDir(async (stateDir) => {
    await saveSession({ session_id: "sess-atomic" }, { stateDir });
    const files = await readdir(stateDir);
    assert.deepEqual(files, ["sess-atomic.json"]);
  });
});

test("loadSession: a missing session_id rejects with code ENOENT (callers branch on this to mean 'unknown session')", async () => {
  await withTempStateDir(async (stateDir) => {
    await assert.rejects(() => loadSession("sess-does-not-exist", { stateDir }), (err) => {
      assert.equal(err.code, "ENOENT");
      return true;
    });
  });
});

test("loadSession: a corrupt (non-JSON) state file rejects with SessionCorruptError naming the file, distinct from ENOENT", async () => {
  await withTempStateDir(async (stateDir) => {
    await writeFile(join(stateDir, "sess-broken.json"), "{not valid json");
    await assert.rejects(() => loadSession("sess-broken", { stateDir }), (err) => {
      assert.ok(err instanceof SessionCorruptError);
      assert.equal(err.code, "ECORRUPT");
      assert.ok(err.path.endsWith("sess-broken.json"));
      assert.match(err.message, /sess-broken\.json/);
      assert.notEqual(err.code, "ENOENT", "corruption must not be mistaken for an unknown session");
      return true;
    });
  });
});

test("saveSession: a corrupt existing file does not block writing a fresh record over it", async () => {
  await withTempStateDir(async (stateDir) => {
    await writeFile(join(stateDir, "sess-broken.json"), "{not valid json");
    const saved = await saveSession({ session_id: "sess-broken", state: "running" }, { stateDir });
    assert.equal(saved.state, "running");
    const loaded = await loadSession("sess-broken", { stateDir });
    assert.equal(loaded.state, "running");
  });
});

test("deleteSession: removes the record; is a no-op if already gone", async () => {
  await withTempStateDir(async (stateDir) => {
    await saveSession({ session_id: "sess-x" }, { stateDir });
    await deleteSession("sess-x", { stateDir });
    await assert.rejects(() => loadSession("sess-x", { stateDir }));
    await deleteSession("sess-x", { stateDir }); // no throw
  });
});

test("session_id is sanitised before touching the filesystem", async () => {
  await withTempStateDir(async (stateDir) => {
    await assert.rejects(() => saveSession({ session_id: "" }, { stateDir }));
    // a path-traversal-shaped id still resolves inside stateDir, not above it
    const record = await saveSession({ session_id: "../../evil" }, { stateDir });
    assert.equal(record.session_id, "../../evil");
    const loaded = await loadSession("../../evil", { stateDir });
    assert.equal(loaded.session_id, "../../evil");
  });
});
