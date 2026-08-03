// Which pack answers a repo's configured platform? Pure: the caller supplies
// what it found on disk — the toolkit's own `packs/`, and whatever the
// consumer vendored under its own `packs/` — so this is testable without
// touching the filesystem.
//
// #182: post-merge used to resolve `packs/` against the *consumer's* checkout,
// where nothing ever puts a pack (`agentflow-init adopt` does not vendor one,
// and no doc tells a human to). The pack lives in the toolkit, at the same
// distance from `scripts/` that the composite actions already resolve via
// `$GITHUB_ACTION_PATH/../..` — so toolkit resolution is tried first here.
// A consumer that vendors its own `packs/<name>` anyway (the old behaviour)
// stays a supported fallback, tried second.

import { join } from "node:path";

// "rn-expo" is the platform string `agentflow.config.json` ships; "expo" is
// the directory name under `packs/`. Mirrors `PLATFORM_PACKS` in
// pr-verdict.js / dispatch-comment.js, which map the same platform to its
// *policy* file — kept separate here because this one names a directory.
export const PLATFORM_PACK_DIRS = { "rn-expo": "expo" };

// `toolkitPacks` / `consumerPacks`: directory listings the caller already
// read (`packs/` under the toolkit root, and under the consumer's own
// checkout). `toolkitRoot` is only used to build the returned path — when
// omitted the toolkit pack is addressed relative to cwd, which is correct
// when this runs inside the toolkit's own checkout (dogfooding).
export function resolvePackDir({ platform, toolkitRoot = null, toolkitPacks = [], consumerPacks = [] } = {}) {
  const dirName = PLATFORM_PACK_DIRS[platform];
  if (dirName && toolkitPacks.includes(dirName)) {
    return {
      dir: toolkitRoot ? join(toolkitRoot, "packs", dirName) : join("packs", dirName),
      source: "toolkit",
      reason: `platform "${platform}" → packs/${dirName}`,
    };
  }
  if (consumerPacks.length > 0) {
    return {
      dir: join("packs", consumerPacks[0]),
      source: "consumer",
      reason: `packs/${consumerPacks[0]} vendored in this repo`,
    };
  }
  return null;
}
