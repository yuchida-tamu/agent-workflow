// evidence.js — appends rows to `manifest.json` in `evidence_dir`, the
// core-owned evidence-bundle format every adapter writes to (see
// interfaces/README.md: `[{type, path, label, step_ref?}]`). The format
// stays the JSON array interfaces/README.md documents (not JSONL) since
// that shape is core-owned and other consumers (PR comments, triage, UX
// review) read it as such.
//
// Two hazards a shared evidence_dir creates once #134 (verify) writes to the
// same bundle a live `run` session already opened:
//   - a torn read: one process reads manifest.json while another is
//     mid-write. Every write here goes to a sibling temp file and `rename`s
//     onto the final path, so a reader only ever sees a complete old or new
//     file, never a partial one.
//   - a lost update: two concurrent appends both read the same array, both
//     push, and the second writeFile clobbers the first's row. `appendManifest`
//     serialises its whole read-modify-write cycle behind a same-directory
//     lock file (`manifest.json.lock`, exclusive create + short retry/backoff)
//     so concurrent appenders queue instead of racing. A holder that crashes
//     mid-critical-section (killed between `open(lockPath, "wx")` and the
//     `finally` that removes it) would otherwise wedge every future writer
//     forever — the backoff loop also age-checks the lock file's own mtime
//     and takes it over (with a diagnostic warning) once it's provably older
//     than any real holder could still legitimately need it; see
//     `STALE_LOCK_AGE_MS` below for the threshold and its justification.
//
// `reserveEntry` extends the same lock to entries whose filename isn't known
// ahead of time (screenshots, numbered sequentially): it picks the next
// index and writes the manifest row in one lock-held transaction, so the
// index itself can never race — see its own doc comment. Any adapter (#134's
// verify, and #135's execute-step) that mints a sequentially-named evidence
// file should go through it rather than reimplementing "read the manifest
// length, guess a filename".
//
// `reserveEntry` rows carry a `status` field precisely because the row and
// the file it names are written by two separate steps (see reserveEntry's
// own comment: the manifest row lands first, the actual capture happens
// after, outside the lock). "reserved" means the row exists but the file
// might not yet; a caller MUST call `finalizeEntry(evidenceDir, path,
// "written")` once the file is actually on disk, or `finalizeEntry(...,
// "failed")` if capturing it errored out — leaving a row honestly marked
// "the capture that would have produced this file failed" instead of a
// silent ghost reference that stays "reserved" forever and looks, to any
// reader, indistinguishable from a capture that's merely still in flight.
// `appendManifest` rows never carry `status` — that path only ever writes a
// row for a file that's already fully written, so there's no in-between
// state to track. #139 (residual from #141's re-review): the prior shape had
// no way to tell "reserved, file pending" apart from "reserved, file capture
// died" — both looked like a manifest row pointing at a file that
// (transiently, or permanently) doesn't exist yet.

import { mkdir, readFile, writeFile, rename, rm, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { diagnostic } from "./contract.js";

export const MANIFEST_FILE = "manifest.json";
const LOCK_FILE = `${MANIFEST_FILE}.lock`;

// A manifest-lock hold here is a JSON read + array push + one atomic
// rename — sub-millisecond in practice, and the evidence.test.js concurrency
// suite (12+ concurrent appenders) settles well under a second total even
// under real contention. 10s is two to three orders of magnitude past any
// legitimate hold, so age-out only fires once the holder is provably gone
// (a crash mid-critical-section — see the file header's stale-lock note),
// never against a live but merely-slow writer; it's still short enough that
// a crashed session doesn't stall the rest of a (potentially minutes-long)
// run's evidence collection waiting on a lock nobody will ever release.
const STALE_LOCK_AGE_MS = 10_000;

export async function readManifest(evidenceDir) {
  try {
    const raw = await readFile(join(evidenceDir, MANIFEST_FILE), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

// Age of `lockPath` in ms, or null if it's already gone (raced away between
// the failed `open` and this `stat` — treated as "not stale", just retry the
// open normally on the next loop iteration rather than acting on stale
// information).
async function lockAgeMs(lockPath) {
  try {
    const st = await stat(lockPath);
    return Date.now() - st.mtimeMs;
  } catch {
    return null;
  }
}

// retries/delayMs give a ~12s total wait budget (600 * 20ms) — comfortably
// past `staleMs`'s default 10s, so a genuinely stale lock always gets a
// chance to be detected and taken over before this gives up outright; a
// non-stale but long-held contention case (a real concurrent holder that
// just hasn't finished yet) still eventually times out rather than looping
// forever.
async function withManifestLock(
  evidenceDir,
  fn,
  { retries = 600, delayMs = 20, staleMs = STALE_LOCK_AGE_MS, stderr = process.stderr } = {}
) {
  const lockPath = join(evidenceDir, LOCK_FILE);
  let handle = null;
  for (let attempt = 0; attempt < retries && !handle; attempt++) {
    try {
      handle = await open(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const age = await lockAgeMs(lockPath);
      if (age !== null && age >= staleMs) {
        // Bounded takeover, not a silent one: a crashed holder must never
        // wedge the rest of a run's evidence collection, but taking over a
        // lock that might still be legitimately held is exactly the "lost
        // update" hazard this lock exists to prevent — so it's logged, not
        // quiet, and only fires once age has already ruled out every
        // realistic legitimate hold (see STALE_LOCK_AGE_MS's own comment).
        diagnostic(
          `[evidence] manifest lock ${lockPath} is ${Math.round(age)}ms old (>= ${staleMs}ms) — assuming its holder crashed mid-write and taking it over`,
          stderr
        );
        await rm(lockPath, { force: true });
        continue; // retry the open immediately, no backoff sleep needed
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  if (!handle) {
    throw new Error(`could not acquire manifest lock at ${lockPath} after ${retries} attempts`);
  }
  try {
    return await fn();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function writeManifestAtomic(evidenceDir, manifest) {
  const finalPath = join(evidenceDir, MANIFEST_FILE);
  const tmpPath = join(evidenceDir, `${MANIFEST_FILE}.tmp-${process.pid}-${randomUUID()}`);
  await writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(tmpPath, finalPath);
}

// entry: {type: "screenshot"|"log"|"video", path, label, step_ref?}
export async function appendManifest(evidenceDir, entry, lockOpts = {}) {
  if (!evidenceDir) return null;
  if (!entry || !entry.type || !entry.path) {
    throw new TypeError("evidence entry requires at least {type, path}");
  }
  await mkdir(evidenceDir, { recursive: true });
  const row = {
    type: entry.type,
    path: entry.path,
    label: entry.label ?? entry.type,
    ...(entry.step_ref !== undefined ? { step_ref: entry.step_ref } : {}),
  };
  await withManifestLock(evidenceDir, async () => {
    const manifest = await readManifest(evidenceDir);
    manifest.push(row);
    await writeManifestAtomic(evidenceDir, manifest);
  }, lockOpts);
  return row;
}

// Mints the next sequential path for an entry whose filename isn't known
// ahead of time (a screenshot: "0007.png", "0008.png", ...) and records its
// manifest row in the SAME lock-held transaction `appendManifest` uses for
// its own read-modify-write — so two concurrent writers to one evidence_dir
// (a live `run` session and a `verify` snapshot/act call sharing a bundle,
// or two `verify` calls racing) can never both compute the same index and
// have one silently clobber the other's file. (#134 review: the prior
// approach in verify.js called `readManifest` to compute a filename,
// captured the screenshot, THEN `appendManifest`'d it — three separate
// operations with no lock spanning all of them, so two concurrent callers
// could both read the same manifest length and mint the same filename.)
//
// The caller writes the actual file to the returned `path` AFTER this
// resolves, outside the lock: that I/O (an agent-device screenshot capture)
// can be slow, and the lock only needs to guard the cheap read-modify-write
// of manifest.json itself, not arbitrary external work. This means a reader
// can observe a manifest row for a file that doesn't exist on disk yet, for
// a brief window — an accepted tradeoff over two writers racing to the same
// filename, which corrupts evidence silently instead of just being briefly
// stale. The row's `status: "reserved"` names that window explicitly — see
// `finalizeEntry` and the file header's own note on the field.
export async function reserveEntry(evidenceDir, { type, ext, label, step_ref } = {}, lockOpts = {}) {
  if (!evidenceDir) throw new TypeError("reserveEntry requires an evidenceDir");
  if (!type || !ext) throw new TypeError("reserveEntry requires at least {type, ext}");
  await mkdir(evidenceDir, { recursive: true });
  return withManifestLock(evidenceDir, async () => {
    const manifest = await readManifest(evidenceDir);
    const index = manifest.length + 1;
    const path = join(evidenceDir, `${String(index).padStart(4, "0")}${ext}`);
    const row = {
      type,
      path,
      label: label ?? type,
      status: "reserved",
      ...(step_ref !== undefined ? { step_ref } : {}),
    };
    manifest.push(row);
    await writeManifestAtomic(evidenceDir, manifest);
    return row;
  }, lockOpts);
}

// Transitions a `reserveEntry` row from "reserved" to its outcome:
// "written" once the caller has actually put a file at `path`, or "failed"
// if that write/capture errored out. Runs under the same manifest lock as
// every other read-modify-write here, so it can never race a concurrent
// append/reserve/finalize. Matches by `path` (reserveEntry's own return
// value) rather than array index — the index a caller captured at reserve
// time could, in principle, no longer be that row's position by the time
// finalize runs, though nothing here currently reorders rows.
//
// A `path` that no longer has a matching row (the manifest was somehow
// rewritten out from under it) is a no-op, not a throw: finalizing is
// inherently best-effort bookkeeping on top of an already-decided outcome
// (the screenshot either exists on disk or it doesn't) — a caller should
// never let a finalize failure mask that real outcome. Every call site in
// this pack already wraps its own finalizeEntry call accordingly.
export async function finalizeEntry(evidenceDir, path, status, lockOpts = {}) {
  if (status !== "written" && status !== "failed") {
    throw new TypeError('finalizeEntry status must be "written" or "failed"');
  }
  return withManifestLock(evidenceDir, async () => {
    const manifest = await readManifest(evidenceDir);
    const row = manifest.find((r) => r.path === path);
    if (!row) return null;
    row.status = status;
    await writeManifestAtomic(evidenceDir, manifest);
    return row;
  }, lockOpts);
}
