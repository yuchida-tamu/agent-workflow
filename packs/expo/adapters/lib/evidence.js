// evidence.js — appends rows to `manifest.json` in `evidence_dir`, the
// core-owned evidence-bundle format every adapter writes to (see
// interfaces/README.md: `[{type, path, label, step_ref?}]`).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MANIFEST_FILE = "manifest.json";

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

// entry: {type: "screenshot"|"log"|"video", path, label, step_ref?}
export async function appendManifest(evidenceDir, entry) {
  if (!evidenceDir) return null;
  if (!entry || !entry.type || !entry.path) {
    throw new TypeError("evidence entry requires at least {type, path}");
  }
  await mkdir(evidenceDir, { recursive: true });
  const manifest = await readManifest(evidenceDir);
  const row = {
    type: entry.type,
    path: entry.path,
    label: entry.label ?? entry.type,
    ...(entry.step_ref !== undefined ? { step_ref: entry.step_ref } : {}),
  };
  manifest.push(row);
  await writeFile(join(evidenceDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return row;
}
