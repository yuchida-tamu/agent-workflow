// The shape of `agentflow.config.json`, written down as code for the first time.
// Pure: no fs, no network, no `gh`.
//
// It describes *today's* config exactly — the eight keys the template ships,
// with only the value constraints the loop actually depends on. It deliberately
// does not tighten: `platform` is any string (the pack it names need not exist
// yet), and an unrecognised key is a warning, never a failure, because a
// consuming repo may carry its own and a validator that rejects them would make
// the config un-extensible.

// The template ships `approvers: ["CHANGE_ME"]`. That is not a login, and until
// a human replaces it nobody can pass G3 or G4 — so it fails validation rather
// than looking configured.
const PLACEHOLDER_APPROVER = "CHANGE_ME";

const MATURITIES = ["genesis", "steady"];

// What `released` means for this repo. Optional: a config written before this
// key existed is still valid, and infers its kind rather than breaking.
export const RELEASE_KINDS = ["store", "tag", "none"];

// Platforms that ship through a store. Everything else — a toolkit, a library,
// a service, `platform: null` — releases by tag.
const STORE_PLATFORMS = ["rn-expo", "expo", "react-native", "ios", "android"];

// Explicit config always wins; inference only fills a gap. Returning the reason
// as well as the kind keeps the choice legible in `--verify` output and in the
// dispatch comment, so nobody has to guess why their repo tags instead of ships.
export function resolveReleaseKind(config) {
  const explicit = config?.release_kind;
  if (explicit !== undefined && explicit !== null) {
    return { kind: explicit, source: "config" };
  }
  const platform = config?.platform ?? null;
  if (platform !== null && STORE_PLATFORMS.includes(platform)) {
    return { kind: "store", source: "inferred", from: `platform "${platform}"` };
  }
  return {
    kind: "tag",
    source: "inferred",
    from: platform === null ? "no platform" : `platform "${platform}"`,
  };
}

// Shared with `--verify`'s domains.yml check: one enum, one definition.
export const CRITICALITIES = ["low", "medium", "high", "critical"];

// Fixed order, so the issue list is stable and a test can assert on it.
const KNOWN_KEYS = [
  "platform",
  "maturity",
  "approvers",
  "intake_questions",
  "unmapped_criticality",
  "unmapped_warn_fraction",
  "model_overrides",
  "release_kind",
];

const typeName = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const oneOf = (allowed) => `must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`;

// → [{ path, message, level }] — `level` is "error" (the config is wrong) or
// "warn" (worth saying, still valid). An empty array means fully valid.
export function validateConfig(config) {
  if (!isPlainObject(config)) {
    return [{ path: "", message: `must be a JSON object (got ${typeName(config)})`, level: "error" }];
  }

  const issues = [];
  const error = (path, message) => issues.push({ path, message, level: "error" });
  const warn = (path, message) => issues.push({ path, message, level: "warn" });
  // Every key the template ships is expected to be there: a config missing one
  // is a half-finished adoption, which is exactly what `--verify` is looking for.
  const present = (key) => {
    if (Object.hasOwn(config, key)) return true;
    error(key, "is missing");
    return false;
  };

  if (present("platform") && config.platform !== null && typeof config.platform !== "string") {
    error("platform", `must be a string or null (got ${typeName(config.platform)})`);
  }

  if (present("maturity") && !MATURITIES.includes(config.maturity)) {
    error("maturity", oneOf(MATURITIES));
  }

  if (present("approvers")) {
    const approvers = config.approvers;
    if (!Array.isArray(approvers)) {
      error("approvers", `must be an array of GitHub logins (got ${typeName(approvers)})`);
    } else if (approvers.length === 0) {
      error("approvers", "must name at least one login — nobody can pass G3/G4 otherwise");
    } else {
      approvers.forEach((login, i) => {
        if (typeof login !== "string") error(`approvers[${i}]`, `must be a string (got ${typeName(login)})`);
        else if (login === PLACEHOLDER_APPROVER) {
          error(`approvers[${i}]`, `is still the template placeholder "${PLACEHOLDER_APPROVER}"`);
        }
      });
    }
  }

  if (present("intake_questions")) {
    const questions = config.intake_questions;
    if (!Array.isArray(questions)) {
      error("intake_questions", `must be an array of strings (got ${typeName(questions)})`);
    } else {
      questions.forEach((q, i) => {
        if (typeof q !== "string") error(`intake_questions[${i}]`, `must be a string (got ${typeName(q)})`);
      });
    }
  }

  if (present("unmapped_criticality") && !CRITICALITIES.includes(config.unmapped_criticality)) {
    error("unmapped_criticality", oneOf(CRITICALITIES));
  }

  if (present("unmapped_warn_fraction")) {
    const fraction = config.unmapped_warn_fraction;
    if (typeof fraction !== "number" || !Number.isFinite(fraction)) {
      error("unmapped_warn_fraction", `must be a number (got ${typeName(fraction)})`);
    } else if (fraction < 0 || fraction > 1) {
      error("unmapped_warn_fraction", `must be between 0 and 1 (got ${fraction})`);
    }
  }

  if (present("model_overrides") && !isPlainObject(config.model_overrides)) {
    error("model_overrides", `must be an object (got ${typeName(config.model_overrides)})`);
  }

  // Optional, unlike the keys above: it postdates the template, so a config
  // that predates it is complete, not half-finished. Present-but-wrong is still
  // an error — a typo must not silently infer something else.
  if (Object.hasOwn(config, "release_kind") && !RELEASE_KINDS.includes(config.release_kind)) {
    error("release_kind", oneOf(RELEASE_KINDS));
  }

  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.includes(key)) warn(key, "is not a key the loop reads — ignored");
  }

  return issues;
}
