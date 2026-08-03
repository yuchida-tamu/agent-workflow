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

async function identityOf(pathOrStat) {
  try {
    const st = typeof pathOrStat === "string" ? await stat(pathOrStat) : pathOrStat;
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

// Age (ms) and dev:ino identity of `path`, both read from ONE `stat` call,
// or null if it's already gone (raced away between the failed `open` and
// this `stat` — treated as "not stale", just retry the open normally on the
// next loop iteration rather than acting on stale information). Capturing
// age and identity from a single snapshot (rather than a separate stat for
// each) means the staleness judgment and the identity later used to verify
// a claim always describe the exact same file, never two different
// snapshots in time.
async function lockSnapshot(lockPath) {
  try {
    const st = await stat(lockPath);
    return { ageMs: Date.now() - st.mtimeMs, identity: `${st.dev}:${st.ino}` };
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
//
// Stale-lock takeover, twice-revised:
//
// Pass 1 (review finding — HIGH) used unconditional `rm(lockPath,
// {force:true})`, which gives no exclusivity signal at all — every waiter
// that independently judged the SAME originally-dead lock as stale would
// each "successfully" rm it, including a waiter whose rm executes AFTER a
// faster waiter already removed the dead lock and `wx`-created a brand-new
// one — deleting that ACTIVE holder's fresh lock out from under it and
// letting a second waiter's `wx` also succeed. Two holders inside the
// critical section at once is exactly the lost-update corruption this lock
// exists to prevent.
//
// Pass 2 (#177, merged) serialised takeovers behind a second, separate
// `wx`-exclusive "arbitration" lock file: at most one waiter could ever be
// mid-takeover, so its own re-check of `lockPath` right after winning
// arbitration was trustworthy — nothing else could have disturbed
// `lockPath` in the interim. That closed the double-entry hole, but the
// arbitration file was itself an ordinary lock with no crash recovery of
// its own: an arbiter SIGKILLed between winning it and its cleanup orphaned
// it, and every future waiter then piled up on THAT file's own EEXIST
// forever — the exact permanent wedge this whole feature exists to break,
// recreated one level up (#177's re-review, MEDIUM; #179).
//
// Pass 3 (this one) drops the second lock file entirely and makes the claim
// itself self-verifying, so there is nothing left that can crash-wedge:
//
//   1. Judge `lockPath` stale from age (unchanged) and capture its dev:ino
//      identity in the SAME stat call (`lockSnapshot`).
//   2. `rename(lockPath, claimPath)`, `claimPath` unique per attempt
//      (pid + random). `rename` is atomic: of however many waiters
//      independently judged the SAME dead lock stale and race this same
//      rename concurrently, exactly one detaches `lockPath`'s CURRENT
//      content; every other one's source is already gone, so it gets
//      ENOENT and just retries — no second lock needed to keep them from
//      "piling on", the filesystem already refuses more than one of them
//      anything to do.
//   3. But `rename` only guarantees SOMETHING got detached, not that it's
//      the specific dead lock a given waiter judged stale a moment ago — a
//      faster waiter can already have completed claim → verify →
//      fresh-relock in that same window, in which case a slower waiter's
//      rename (still targeting the same well-known `lockPath` name) grabs
//      the fast waiter's brand-new, LIVE lock instead (confirmed
//      empirically to happen under real N-way concurrency during #177).
//      This is what makes the claim self-verifying rather than trusting
//      the rename alone: stat the claimed file and compare its actual
//      dev:ino to the identity captured in step 1. A match proves this
//      waiter really did detach the dead lock it judged stale; a mismatch
//      means it grabbed someone else's fresh one.
//   4. On mismatch, put it back (`rename(claimPath, lockPath)`) — the real
//      holder's mutual exclusion depends on that path continuing to exist
//      while it's mid-critical-section — then back off and retry against
//      what is, from this waiter's perspective, simply a fresh (non-stale)
//      lock like any other. (Accepted tradeoff: between the detach and the
//      restore, `lockPath` is briefly absent, so in principle a THIRD
//      waiter's ordinary, non-takeover `open(lockPath, "wx")` could land in
//      that gap and then get overwritten by the restore. Closing this
//      fully would need an atomic rename-swap Node doesn't expose
//      portably. The window is a couple of in-process awaits nested inside
//      an already-compound scenario — stale lock, multiple simultaneous
//      takeover attempts, AND a third, independently-timed waiter hitting
//      that exact gap — several orders of magnitude narrower than the bug
//      this rewrite fixes, and, like the release check's own documented
//      inode-reuse residual below, considered acceptable rather than worth
//      a non-portable syscall.)
//   5. On a match, the claim is provably the dead lock and ours alone (a
//      unique name nothing else references) — discard it, log the
//      takeover, and try to become the fresh holder. If a third waiter's
//      ordinary `open(wx)` beat this one to the now-empty `lockPath`, that
//      is just contention (EEXIST), not a bug — back off and retry.
//
// The recursion bottoms out here because the claim IS the arbitration: it
// needs no lock of its own to protect it, since a wrongly-grabbed claim is
// detected (by inode) and reversible (by rename) rather than requiring
// exclusivity to have been established beforehand. A claimant that crashes
// before step 5's cleanup leaks nothing but an inert, uniquely-named file —
// nobody ever tries to open that exact name again, so unlike the
// arbitration file it replaces, it can never block a future takeover (see
// the crash-recovery test in evidence.test.js).
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
      const snapshot = await lockSnapshot(lockPath);
      if (snapshot === null || snapshot.ageMs < staleMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      // Worth attempting a takeover. `claimPath` is unique to this
      // attempt, so nothing else will ever try to open this exact name —
      // there is no exclusivity to win or lose over the NAME itself, only
      // over what `rename` actually detaches (see the function header).
      const claimPath = `${lockPath}.claim-${process.pid}-${randomUUID()}`;
      try {
        await rename(lockPath, claimPath);
      } catch (renameErr) {
        if (renameErr.code === "ENOENT") {
          // Another waiter's rename already detached `lockPath` first —
          // this one lost the race for the source path itself, so there is
          // nothing here to verify or clean up. Retry fresh.
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw renameErr;
      }

      const claimedIdentity = await identityOf(claimPath);
      if (claimedIdentity !== snapshot.identity) {
        // Detached someone's fresh lock, not the dead one this waiter
        // judged stale (step 3 in the header). Restore it so the real
        // holder's exclusivity isn't compromised, then back off and retry
        // against it like any other live lock.
        //
        // RESIDUAL (accepted, PR #184 review): this restore rename clobbers
        // an occupied target atomically (POSIX rename(2)). If a *third*
        // waiter grabs the briefly-empty lockPath inside this detach→restore
        // gap, its lock is silently overwritten — a 4-party, sub-millisecond,
        // no-crash interleave. This trades #177's fail-LOUD arbitration wedge
        // for a far-rarer fail-SILENT corruption; it is a strict probability
        // improvement but a change in failure *character*. Closing it needs an
        // atomic rename-swap (renameat2 RENAME_EXCHANGE) Node does not expose
        // portably — tracked for that path. The claim-side inode-REUSE
        // false-match (snapshot.identity recycled onto a fresh lockPath before
        // this rename) shares the release-side window and the same acceptance.
        await rename(claimPath, lockPath).catch((restoreErr) => {
          if (restoreErr.code !== "ENOENT") throw restoreErr;
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      // Verified: `claimPath` really is the dead lock this waiter judged
      // stale, and it's ours alone — safe to discard. Bounded takeover, not
      // a silent one: a crashed holder must never wedge the rest of a
      // run's evidence collection, but taking over a lock that might still
      // be legitimately held is exactly the "lost update" hazard this lock
      // exists to prevent, so it's logged, not quiet.
      diagnostic(
        `[evidence] manifest lock ${lockPath} was ${Math.round(snapshot.ageMs)}ms old (>= ${staleMs}ms) — assuming its holder crashed mid-write and taking it over`,
        stderr
      );
      await rm(claimPath, { force: true });

      try {
        handle = await open(lockPath, "wx");
      } catch (openErr) {
        if (openErr.code !== "EEXIST") throw openErr;
        // A third waiter's ordinary (non-takeover) open beat this one to
        // the now-empty path — plain contention, not a bug. Retry.
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
    }
  }
  if (!handle) {
    throw new Error(`could not acquire manifest lock at ${lockPath} after ${retries} attempts`);
  }
  try {
    return await fn();
  } finally {
    // Release by verified identity, not a blind path removal: the
    // self-verifying claim above is designed to never disturb an active
    // holder's lock, but this is the backstop — if `lockPath` doesn't
    // currently resolve to the exact inode this handle created, something
    // else's lock now occupies that name, and removing it would be the same
    // class of bug the takeover rewrite above exists to close, just from
    // the release side instead of the takeover side.
    //
    // Documented residual, vanishingly rare: `ownIdentity` is fstat'd
    // before `close()` (so it can't itself be stale), but `currentIdentity`
    // is stat'd by path AFTER close — if this handle's own lock was taken
    // over (its inode freed at close) and the OS immediately reuses that
    // exact inode number for a brand-new `lockPath` in the sub-millisecond
    // close→stat window, the identities would falsely match. Filesystem-
    // dependent and requires immediate inode-number recycling, which most
    // filesystems don't do; closing it fully would need an OS-level
    // open-by-inode compare that Node doesn't expose portably.
    const ownIdentity = await identityOf(await handle.stat().catch(() => null));
    await handle.close();
    const currentIdentity = await identityOf(lockPath);
    if (ownIdentity && currentIdentity === ownIdentity) {
      await rm(lockPath, { force: true });
    } else if (!ownIdentity) {
      // Could not even confirm our own identity (shouldn't happen) — fall
      // back to best-effort removal, same as before this hardening.
      await rm(lockPath, { force: true }).catch(() => {});
    }
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
