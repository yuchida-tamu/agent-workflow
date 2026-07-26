// Reading `agentflow.config.json` from disk, for the CLIs that need to know
// what kind of repo they are running in. Kept out of the pure modules on
// purpose: `machine.js`, `next/core.js` and the gate validator take the
// resolved values as parameters and stay dependency-free.
//
// A missing or unreadable config is not an error — every consuming repo that
// predates a given key must keep working, and the resolver infers rather than
// demanding.

import { readFileSync } from "node:fs";
import { resolveReleaseKind } from "../../init/config-schema.js";

export function loadConfig(path = "agentflow.config.json") {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function releaseKindOf(path = "agentflow.config.json") {
  return resolveReleaseKind(loadConfig(path)).kind;
}
