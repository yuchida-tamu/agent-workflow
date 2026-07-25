// Risk policy engine: pure evaluation, facts in → verdict out. No I/O here.
//
// A pack is { pack, version, rules: [...], disable?: [ruleId], tests?: [...] }.
// A rule is { id, description?, stage?, locked?, when?, then }.
// Conditions are fact/operator trees combined with all/any/not.
// Obligations union monotonically across all matched rules; packs can only
// add restrictions. Loosening happens only via `disable` by rule id, and
// `locked: true` rules ignore it.

export const LEVELS = ["low", "medium", "high"];

export const DEFAULT_LEVELS_CONFIG = {
  low: { max: 3 },
  medium: { max: 7, obligations: { require: ["human-merge"] } },
  high: { obligations: { require: ["G2"], block: ["auto-merge"] } },
};

const OBLIGATION_LIST_KEYS = ["require", "block", "run", "notify", "label"];
const THEN_KEYS = [...OBLIGATION_LIST_KEYS, "score", "floor"];
const OPERATORS = ["is", "in", "gte", "lte", "contains", "matches", "exists"];
const STAGES = ["plan", "pr", "both"];

export function resolveFact(facts, path) {
  return path.split(".").reduce((obj, key) => (obj == null ? undefined : obj[key]), facts);
}

export function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // "**/" also matches zero directories
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(out + "$");
}

function asArray(v) {
  return Array.isArray(v) ? v : [v];
}

function evalLeaf(leaf, facts) {
  const value = resolveFact(facts, leaf.fact);
  for (const op of OPERATORS) {
    if (!(op in leaf)) continue;
    const expected = leaf[op];
    switch (op) {
      case "exists":
        if ((value !== undefined) !== Boolean(expected)) return false;
        break;
      case "is":
        if (value !== expected) return false;
        break;
      case "in":
        if (!asArray(expected).includes(value)) return false;
        break;
      case "gte":
        if (typeof value !== "number" || value < expected) return false;
        break;
      case "lte":
        if (typeof value !== "number" || value > expected) return false;
        break;
      case "contains": {
        const haystack = Array.isArray(value) || typeof value === "string" ? value : null;
        if (haystack === null) return false;
        if (!asArray(expected).some((e) => haystack.includes(e))) return false;
        break;
      }
      case "matches": {
        const regexps = asArray(expected).map(globToRegExp);
        const candidates = asArray(value ?? []).filter((v) => typeof v === "string");
        if (!candidates.some((c) => regexps.some((r) => r.test(c)))) return false;
        break;
      }
    }
  }
  return true;
}

export function evalCondition(cond, facts) {
  if (cond == null) return true;
  if (cond.all) return cond.all.every((c) => evalCondition(c, facts));
  if (cond.any) return cond.any.some((c) => evalCondition(c, facts));
  if (cond.not) return !evalCondition(cond.not, facts);
  return evalLeaf(cond, facts);
}

function validateCondition(cond, path, errors) {
  if (cond == null || typeof cond !== "object") {
    errors.push(`${path}: condition must be an object`);
    return;
  }
  const combinators = ["all", "any", "not"].filter((k) => k in cond);
  if (combinators.length > 1) {
    errors.push(`${path}: only one of all/any/not per node`);
    return;
  }
  if (combinators.length === 1) {
    const key = combinators[0];
    if (key === "not") {
      validateCondition(cond.not, `${path}.not`, errors);
    } else if (!Array.isArray(cond[key]) || cond[key].length === 0) {
      errors.push(`${path}.${key}: must be a non-empty array`);
    } else {
      cond[key].forEach((c, i) => validateCondition(c, `${path}.${key}[${i}]`, errors));
    }
    return;
  }
  if (typeof cond.fact !== "string" || !cond.fact) {
    errors.push(`${path}: leaf condition needs a "fact" path`);
    return;
  }
  const ops = OPERATORS.filter((op) => op in cond);
  if (ops.length === 0) {
    errors.push(`${path} (${cond.fact}): needs at least one operator of ${OPERATORS.join("/")}`);
  }
  const unknown = Object.keys(cond).filter((k) => k !== "fact" && !OPERATORS.includes(k));
  if (unknown.length) errors.push(`${path} (${cond.fact}): unknown operator(s) ${unknown.join(", ")}`);
}

export function validatePack(pack) {
  const errors = [];
  if (!pack || typeof pack !== "object") return ["pack must be an object"];
  if (typeof pack.pack !== "string" || !pack.pack) errors.push('missing "pack" id');
  if (!Array.isArray(pack.rules)) {
    errors.push('"rules" must be an array');
    return errors;
  }
  const seen = new Set();
  for (const rule of pack.rules) {
    const rid = rule?.id ?? "<missing id>";
    const where = `rule ${rid}`;
    if (typeof rule?.id !== "string" || !rule.id) errors.push(`${where}: missing id`);
    else if (seen.has(rule.id)) errors.push(`${where}: duplicate id`);
    seen.add(rule.id);
    if (rule.stage != null && !STAGES.includes(rule.stage)) {
      errors.push(`${where}: stage must be one of ${STAGES.join("/")}`);
    }
    if (rule.when !== undefined) validateCondition(rule.when, `${where}.when`, errors);
    if (rule.then == null || typeof rule.then !== "object") {
      errors.push(`${where}: missing "then"`);
      continue;
    }
    for (const key of Object.keys(rule.then)) {
      if (!THEN_KEYS.includes(key)) errors.push(`${where}.then: unknown obligation "${key}"`);
    }
    if ("score" in rule.then && typeof rule.then.score !== "number") {
      errors.push(`${where}.then.score: must be a number`);
    }
    if ("floor" in rule.then && !LEVELS.includes(rule.then.floor)) {
      errors.push(`${where}.then.floor: must be one of ${LEVELS.join("/")}`);
    }
  }
  if (pack.disable != null && !Array.isArray(pack.disable)) errors.push('"disable" must be an array of rule ids');
  return errors;
}

function newObligations() {
  const acc = { score: 0, floor: null };
  for (const key of OBLIGATION_LIST_KEYS) acc[key] = new Set();
  return acc;
}

function mergeThen(acc, then) {
  for (const key of OBLIGATION_LIST_KEYS) {
    if (then[key] != null) for (const v of asArray(then[key])) acc[key].add(v);
  }
  if (typeof then.score === "number") acc.score += then.score;
  if (then.floor && (!acc.floor || LEVELS.indexOf(then.floor) > LEVELS.indexOf(acc.floor))) {
    acc.floor = then.floor;
  }
}

function levelForScore(score, levelsConfig) {
  for (const level of LEVELS) {
    const cfg = levelsConfig[level];
    if (cfg && typeof cfg.max === "number" && score <= cfg.max) return level;
  }
  return LEVELS[LEVELS.length - 1];
}

// packs: ordered array of parsed packs (baseline first by convention — order
// does not affect the outcome; obligations union monotonically).
export function evaluate(packs, facts, { levelsConfig = DEFAULT_LEVELS_CONFIG } = {}) {
  const warnings = [];
  const stage = resolveFact(facts, "meta.stage") ?? "pr";

  const lockedIds = new Set();
  for (const pack of packs) {
    for (const rule of pack.rules) if (rule.locked) lockedIds.add(rule.id);
  }
  const disabled = new Set();
  for (const pack of packs) {
    for (const id of pack.disable ?? []) {
      if (lockedIds.has(id)) {
        warnings.push(`pack "${pack.pack}" tried to disable locked rule "${id}" — ignored`);
      } else {
        disabled.add(id);
      }
    }
  }

  const acc = newObligations();
  const matched = [];
  for (const pack of packs) {
    for (const rule of pack.rules) {
      if (disabled.has(rule.id)) continue;
      const ruleStage = rule.stage ?? "both";
      if (ruleStage !== "both" && ruleStage !== stage) continue;
      if (!evalCondition(rule.when, facts)) continue;
      mergeThen(acc, rule.then);
      matched.push({ pack: pack.pack, rule: rule.id, then: rule.then });
    }
  }

  const scoreLevel = levelForScore(acc.score, levelsConfig);
  const level =
    acc.floor && LEVELS.indexOf(acc.floor) > LEVELS.indexOf(scoreLevel) ? acc.floor : scoreLevel;
  const levelObligations = levelsConfig[level]?.obligations;
  if (levelObligations) mergeThen(acc, levelObligations);

  const obligations = { score: acc.score };
  for (const key of OBLIGATION_LIST_KEYS) obligations[key] = [...acc[key]].sort();
  return { level, stage, obligations, matched, warnings };
}

// Fixture tests embedded in packs: tests: [{ name, facts, expect }].
// `expect` is a subset assertion over the verdict: `level` compares exactly;
// obligation lists assert containment; `score` compares exactly.
export function runPackTests(packs, packUnderTest, options = {}) {
  const results = [];
  for (const test of packUnderTest.tests ?? []) {
    const verdict = evaluate(packs, test.facts ?? {}, options);
    const failures = [];
    const expect = test.expect ?? {};
    if ("level" in expect && verdict.level !== expect.level) {
      failures.push(`level: expected ${expect.level}, got ${verdict.level}`);
    }
    if ("score" in expect && verdict.obligations.score !== expect.score) {
      failures.push(`score: expected ${expect.score}, got ${verdict.obligations.score}`);
    }
    for (const key of OBLIGATION_LIST_KEYS) {
      if (!(key in expect)) continue;
      for (const want of asArray(expect[key])) {
        if (!verdict.obligations[key].includes(want)) {
          failures.push(`${key}: expected to include "${want}", got [${verdict.obligations[key]}]`);
        }
      }
    }
    results.push({ name: test.name ?? "<unnamed>", ok: failures.length === 0, failures, verdict });
  }
  return results;
}
