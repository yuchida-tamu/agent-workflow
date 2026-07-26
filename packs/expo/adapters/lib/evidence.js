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
//     so concurrent appenders queue instead of racing.

import { mkdir, readFile, writeFile, rename, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const MANIFEST_FILE = "manifest.json";
const LOCK_FILE = `${MANIFEST_FILE}.lock`;

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

async function withManifestLock(evidenceDir, fn, { retries = 100, delayMs = 20 } = {}) {
  const lockPath = join(evidenceDir, LOCK_FILE);
  let handle = null;
  for (let attempt = 0; attempt < retries && !handle; attempt++) {
    try {
      handle = await open(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
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

// entry: {type: "screenshot"|"log"|"video", path, label, step_ref?}
export async function appendManifest(evidenceDir, entry) {
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
    const finalPath = join(evidenceDir, MANIFEST_FILE);
    const tmpPath = join(evidenceDir, `${MANIFEST_FILE}.tmp-${process.pid}-${randomUUID()}`);
    await writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(tmpPath, finalPath);
  });
  return row;
}
