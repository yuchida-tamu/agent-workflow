import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendManifest, readManifest, reserveEntry, MANIFEST_FILE } from "../lib/evidence.js";

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

// ---- concurrency: two writers sharing one evidence_dir (#134 writing
// screenshots to the same bundle a live `run` session already opened) -----

test("appendManifest: concurrent appenders don't lose an update — a same-directory lock serialises the read-modify-write", async () => {
  await withTempDir(async (dir) => {
    const N = 12;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appendManifest(dir, { type: "log", path: `entry-${i}.log`, label: `entry ${i}` })
      )
    );
    const manifest = await readManifest(dir);
    assert.equal(manifest.length, N, "every concurrent append must be represented, none lost to a race");
    const paths = new Set(manifest.map((r) => r.path));
    assert.equal(paths.size, N, "no two appends should have clobbered each other's row");
  });
});

test("appendManifest: leaves no lock or temp file behind once every concurrent append settles", async () => {
  await withTempDir(async (dir) => {
    await Promise.all([1, 2, 3].map((i) => appendManifest(dir, { type: "log", path: `x${i}` })));
    const files = await readdir(dir);
    assert.deepEqual(files.sort(), [MANIFEST_FILE], "no manifest.json.lock or manifest.json.tmp-* survives");
  });
});

test("appendManifest: the manifest is never observed as a torn/partial file mid-write (atomic rename)", async () => {
  await withTempDir(async (dir) => {
    // Prime a non-trivial manifest, then race a bunch of readers against a
    // bunch of writers; every read must parse as valid JSON (an array),
    // never a half-written fragment.
    await appendManifest(dir, { type: "log", path: "seed" });
    const writers = Array.from({ length: 6 }, (_, i) => appendManifest(dir, { type: "log", path: `w${i}` }));
    const readers = Array.from({ length: 6 }, () => readManifest(dir));
    const [, readResults] = await Promise.all([Promise.all(writers), Promise.all(readers)]);
    for (const manifest of readResults) {
      assert.ok(Array.isArray(manifest));
    }
  });
});

// ---- reserveEntry: an atomic "mint the next filename + record its row" ---
// transaction, added for #134 (verify) so a numbered evidence file (a
// screenshot) can never be assigned the same index as a concurrent writer's.

test("reserveEntry: mints sequential, zero-padded filenames and records the row in one call", async () => {
  await withTempDir(async (dir) => {
    const first = await reserveEntry(dir, { type: "screenshot", ext: ".png", label: "boot" });
    assert.deepEqual(first, { type: "screenshot", path: join(dir, "0001.png"), label: "boot" });
    const second = await reserveEntry(dir, { type: "screenshot", ext: ".png", label: "after tap" });
    assert.equal(second.path, join(dir, "0002.png"));

    const manifest = await readManifest(dir);
    assert.deepEqual(manifest, [first, second]);
  });
});

test("reserveEntry: numbering continues a sequence started by appendManifest (one shared index across the whole bundle)", async () => {
  await withTempDir(async (dir) => {
    await appendManifest(dir, { type: "log", path: "app.log" });
    const entry = await reserveEntry(dir, { type: "screenshot", ext: ".png" });
    assert.equal(entry.path, join(dir, "0002.png"));
  });
});

test("reserveEntry: label defaults to type, step_ref is carried through only when given", async () => {
  await withTempDir(async (dir) => {
    const entry = await reserveEntry(dir, { type: "screenshot", ext: ".png", step_ref: "given the app is open" });
    assert.equal(entry.label, "screenshot");
    assert.equal(entry.step_ref, "given the app is open");
    assert.ok(!("step_ref" in await reserveEntry(dir, { type: "screenshot", ext: ".png" })));
  });
});

test("reserveEntry: requires evidenceDir, type, and ext", async () => {
  await assert.rejects(() => reserveEntry(null, { type: "screenshot", ext: ".png" }), TypeError);
  await withTempDir(async (dir) => {
    await assert.rejects(() => reserveEntry(dir, { ext: ".png" }), TypeError);
    await assert.rejects(() => reserveEntry(dir, { type: "screenshot" }), TypeError);
  });
});

// The MED-severity finding this exists to fix (#134 review): the previous
// call site pattern — readManifest, compute a filename, do slow I/O, THEN
// appendManifest — let two concurrent callers both read the same manifest
// length and mint the same filename, so the second writer's file silently
// clobbered the first's. reserveEntry closes that window by picking the
// index and writing the row in the SAME lock-held transaction.
test("reserveEntry: concurrent reservations never mint the same index — the race the previous read-then-append pattern had", async () => {
  await withTempDir(async (dir) => {
    const N = 12;
    const entries = await Promise.all(
      Array.from({ length: N }, () => reserveEntry(dir, { type: "screenshot", ext: ".png" }))
    );
    const paths = new Set(entries.map((e) => e.path));
    assert.equal(paths.size, N, "every reservation must have minted a distinct filename");
    const manifest = await readManifest(dir);
    assert.equal(manifest.length, N, "every reservation's row must be durably recorded, none lost to a race");
  });
});
