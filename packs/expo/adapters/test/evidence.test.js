import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, open, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendManifest, readManifest, reserveEntry, finalizeEntry, MANIFEST_FILE } from "../lib/evidence.js";

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
    assert.deepEqual(first, { type: "screenshot", path: join(dir, "0001.png"), label: "boot", status: "reserved" });
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

// ---- finalizeEntry: honestly closing the "reserved" window (#139, a ------
// residual from #141's re-review) --------------------------------------

test("finalizeEntry: transitions a reserved row to written", async () => {
  await withTempDir(async (dir) => {
    const entry = await reserveEntry(dir, { type: "screenshot", ext: ".png" });
    assert.equal(entry.status, "reserved");
    const updated = await finalizeEntry(dir, entry.path, "written");
    assert.equal(updated.status, "written");
    const manifest = await readManifest(dir);
    assert.equal(manifest[0].status, "written");
  });
});

test("finalizeEntry: transitions a reserved row to failed — a PNG-write failure leaves an honest row instead of a silent ghost reference", async () => {
  await withTempDir(async (dir) => {
    const entry = await reserveEntry(dir, { type: "screenshot", ext: ".png" });
    await finalizeEntry(dir, entry.path, "failed");
    const manifest = await readManifest(dir);
    assert.equal(manifest[0].status, "failed");
    assert.equal(manifest[0].path, entry.path, "the row still names the file that was never actually written");
  });
});

test("finalizeEntry: rejects any status other than written/failed", async () => {
  await withTempDir(async (dir) => {
    const entry = await reserveEntry(dir, { type: "screenshot", ext: ".png" });
    await assert.rejects(() => finalizeEntry(dir, entry.path, "reserved"), TypeError);
    await assert.rejects(() => finalizeEntry(dir, entry.path, "bogus"), TypeError);
  });
});

test("finalizeEntry: a path with no matching row is a no-op, not a throw — finalize is best-effort bookkeeping on a decision already made elsewhere", async () => {
  await withTempDir(async (dir) => {
    const result = await finalizeEntry(dir, join(dir, "9999.png"), "written");
    assert.equal(result, null);
    assert.deepEqual(await readManifest(dir), []);
  });
});

test("finalizeEntry: appendManifest rows never carry a status field at all — only reserveEntry's two-step rows need one", async () => {
  await withTempDir(async (dir) => {
    const row = await appendManifest(dir, { type: "log", path: "app.log" });
    assert.ok(!("status" in row));
    const manifest = await readManifest(dir);
    assert.ok(!("status" in manifest[0]));
  });
});

// ---- manifest lock age-out: a crashed holder must not wedge every later --
// writer forever (#139, residual from #138's review) ------------------

async function writeLockFile(dir, ageMs) {
  const lockPath = join(dir, `${MANIFEST_FILE}.lock`);
  const handle = await open(lockPath, "w");
  await handle.close();
  const past = new Date(Date.now() - ageMs);
  await utimes(lockPath, past, past);
  return lockPath;
}

test("appendManifest: a lock file older than staleMs is taken over (with a warning), not waited out forever", async () => {
  await withTempDir(async (dir) => {
    const lockPath = await writeLockFile(dir, 500); // already "ancient" relative to a tiny staleMs below
    const warnings = { chunks: [], write(s) { this.chunks.push(s); } };
    const row = await appendManifest(
      dir,
      { type: "log", path: "app.log" },
      { staleMs: 50, retries: 50, delayMs: 5, stderr: warnings }
    );
    assert.deepEqual(row, { type: "log", path: "app.log", label: "log" });
    const manifest = await readManifest(dir);
    assert.deepEqual(manifest, [row]);
    assert.ok(
      warnings.chunks.some((c) => c.includes(lockPath) && /taking it over/.test(c)),
      "a stale-lock takeover must warn, naming the lock path"
    );
  });
});

test("reserveEntry: a lock file older than staleMs is taken over the same way", async () => {
  await withTempDir(async (dir) => {
    await writeLockFile(dir, 500);
    const entry = await reserveEntry(
      dir,
      { type: "screenshot", ext: ".png" },
      { staleMs: 50, retries: 50, delayMs: 5, stderr: { write: () => {} } }
    );
    assert.equal(entry.path, join(dir, "0001.png"));
  });
});

test("appendManifest: a FRESH lock (younger than staleMs) is never taken over — only a provably abandoned lock is, so a genuinely live holder is never disturbed mid-write", async () => {
  await withTempDir(async (dir) => {
    await writeLockFile(dir, 5); // fresh — well under staleMs
    await assert.rejects(
      () =>
        appendManifest(
          dir,
          { type: "log", path: "app.log" },
          { staleMs: 10_000, retries: 5, delayMs: 5, stderr: { write: () => {} } }
        ),
      /could not acquire manifest lock/
    );
  });
});

// A prior version took a stale lock over via an unconditional
// `rm(lockPath, {force:true})`, which gives no exclusivity signal: every
// waiter that independently judged the SAME stale lock as stale would each
// "successfully" rm it — including a waiter whose rm executes AFTER a
// faster waiter already removed the stale lock and won a brand-new `wx`
// lock, ripping that FRESH lock out from under its active holder and
// letting a second waiter's `wx` also succeed. Two holders inside the
// critical section at once is exactly the lost-update corruption the lock
// exists to prevent — and with N waiters racing the same dead lock, this
// isn't a rare edge case, it's the common one. The fix (atomic rename to a
// unique claim name, self-verified by dev:ino — see evidence.js's own
// header for the full "twice-revised" history) is only proven by
// exercising real concurrency: a single-waiter test can't distinguish
// "takes over correctly" from "takes over racily but nobody else was there
// to notice."
//
// staleMs is deliberately wide (not the 50ms of the single-waiter tests
// above) and the assertion is `>= 1`, not `=== 1` (review LOW finding on
// #177's original version of this test): with N=10 real concurrent
// appenders doing actual fs I/O, a loaded CI runner can stall long enough
// for even a freshly-won lock to itself age past a razor-thin staleMs,
// triggering a second, benign takeover round. That would fail a strict
// `=== 1` on correct code. What must never happen — corruption — is fully
// covered by the row-count and distinct-path assertions below regardless
// of how many takeover rounds it actually took.
test("appendManifest: MULTI-WAITER takeover — N concurrent waiters against one dead holder's aged lock take over with zero double-entry and no lost rows", async () => {
  await withTempDir(async (dir) => {
    const lockPath = await writeLockFile(dir, 2000); // one shared stale lock, pre-seeded once
    const N = 10;
    const warnings = { chunks: [], write(s) { this.chunks.push(s); } };

    const rows = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appendManifest(
          dir,
          { type: "log", path: `waiter-${i}.log`, label: `waiter ${i}` },
          { staleMs: 200, retries: 400, delayMs: 5, stderr: warnings }
        )
      )
    );

    // The observable signature of double-entry corruption: two waiters both
    // inside the critical section at once means both read the same array,
    // both push, and the LAST writeManifestAtomic clobbers everything the
    // other one wrote — a lost row, not an extra one. So "every waiter's
    // row survived, all distinct" is exactly what rules that out.
    const manifest = await readManifest(dir);
    assert.equal(manifest.length, N, "every waiter's row must survive — none lost to overlapping critical sections");
    const paths = new Set(manifest.map((r) => r.path));
    assert.equal(paths.size, N, "no two waiters' rows collapsed into one — distinct paths for every waiter");
    assert.deepEqual(new Set(rows.map((r) => r.path)), paths, "every waiter's own return value matches a real, distinct row");

    // At least one waiter must have performed the actual takeover of the
    // originally-dead lock — the corruption-prevention property is "not
    // one per waiter racing the same dead lock", which a `>= 1` bound on a
    // race-free run still demonstrates without being sensitive to a
    // possible second, benign round (see comment above the test).
    const takeovers = warnings.chunks.filter((c) => c.includes(lockPath) && c.includes("taking it over"));
    assert.ok(takeovers.length >= 1, "at least one waiter must win the stale-lock takeover");

    // No leftover lock file or .claim-* file survives once every waiter has
    // settled — the winner's own cleanup, and every eventual lock holder's
    // own release, account for all of them.
    const files = await readdir(dir);
    assert.deepEqual(files.sort(), [MANIFEST_FILE], "no manifest.json.lock or .claim-* file left behind");
  });
});

// ---- crash-recovery: an arbiter dying mid-takeover must never wedge -----
// future takeovers (#179, replacing #177's takeover-arbitration race file,
// which had exactly this hole — a SIGKILLed arbiter left its own
// `wx`-exclusive race file behind, and every later waiter's own arbitration
// attempt then piled up on THAT file's EEXIST forever, even though the
// original dead lock it was arbitrating had already been dealt with. The
// permanent wedge this whole feature exists to break, recreated one level
// up).
//
// The inode-checked claim replacing it has no such file: its only artifacts
// are `lockPath` itself (already renamed away by the time a claim exists at
// all) and a uniquely-named `claimPath` nothing else will ever try to open
// again by name. Simulating a claimant that dies right after detaching
// `lockPath` but before creating the fresh lock or cleaning its claim up —
// the only crash point `rename`'s atomicity actually allows — leaves
// exactly that: `lockPath` absent, one orphaned claim file. A later waiter
// must recover immediately (it doesn't even need staleMs — `lockPath`
// being gone just means `open(lockPath, "wx")` succeeds on the first try),
// and the orphan must never be consulted or block anything.
test("appendManifest: an arbiter that dies mid-takeover (lockPath already detached, claim never cleaned up) never wedges a later waiter", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, `${MANIFEST_FILE}.lock`);
    // Simulate the dead arbiter's exact mid-takeover state: its rename
    // already succeeded (lockPath is gone) and it crashed before creating
    // a fresh lock or removing its claim.
    const orphanClaim = `${lockPath}.claim-999999-${randomUUID()}`;
    const orphanHandle = await open(orphanClaim, "w");
    await orphanHandle.close();

    const row = await appendManifest(dir, { type: "log", path: "app.log" }, { staleMs: 50, retries: 50, delayMs: 5 });
    assert.deepEqual(row, { type: "log", path: "app.log", label: "log" });
    const manifest = await readManifest(dir);
    assert.deepEqual(manifest, [row], "the write went through — no wedge from the crashed arbiter's leftovers");

    // The orphaned claim is inert litter, not a hazard: nobody references
    // its exact random name again, so unlike the race file it replaces it
    // never gets in a later waiter's way. This test doesn't assert it away
    // (nothing in the design sweeps it up) — only that it never blocks.
    const files = await readdir(dir);
    assert.ok(files.includes(MANIFEST_FILE));
  });
});

// A second, harsher crash point: several dead arbiters over time (repeated
// crashes across many evidence-collection runs against the same dir) leave
// several orphaned claims behind at once. None of them individually or
// collectively block anything, because none of their names is ever the one
// a later waiter tries to open.
test("appendManifest: multiple leftover orphaned claims from repeated dead arbiters still never wedge a later waiter", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, `${MANIFEST_FILE}.lock`);
    for (let i = 0; i < 5; i++) {
      const h = await open(`${lockPath}.claim-${1000 + i}-${randomUUID()}`, "w");
      await h.close();
    }

    const row = await appendManifest(dir, { type: "log", path: "app.log" }, { staleMs: 50, retries: 50, delayMs: 5 });
    assert.deepEqual(row, { type: "log", path: "app.log", label: "log" });
    const manifest = await readManifest(dir);
    assert.deepEqual(manifest, [row]);
  });
});
