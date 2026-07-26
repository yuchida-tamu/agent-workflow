// Which stages may run without a human session, and which may not. Pure: no
// fs, no `gh`, no spawn — the discipline `machine.js`, `next/core.js` and
// `identity.js` already keep, so the Actions entry points, a local session and
// a future runner all read one tested answer.
//
// Every flag is **off unless explicitly `true`**. A missing block, a missing
// key, a malformed value and a stringly-typed `"true"` all resolve to off. That
// asymmetry is the point: this file decides whether an agent runs unattended,
// and the failure mode of guessing wrong in the permissive direction is an
// unattended agent nobody asked for.
//
// Resolving to off and *reporting* the typo are two different jobs. This module
// only resolves — it is called from Actions entry points, where throwing is the
// loudest and least useful way to fail. `validateConfig` reports, because that
// is the surface built to report.

import { DISPATCH } from "../next/core.js";

export const HEADLESS_KEY = "headless";

// The stages a dispatch flag may name: exactly those the dispatch table says an
// agent acts on. Derived from that table rather than restated, so a state whose
// actor changes cannot leave a flag behind that can never fire.
//
// `in-review` is in this set because an agent does act on it — but the shipped
// template does not offer it, because review is reached through the
// `pull_request` event rather than through a state label. Setting it is legal
// and does nothing useful; the template names the three stages that do.
export function agentActionableStates() {
  return Object.keys(DISPATCH).filter((state) => DISPATCH[state].actor === "agent");
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Strictly the boolean `true`. `"true"`, `1` and `"yes"` are all off — and all
// reported by `validateConfig`, so a human who wrote one learns it rather than
// wondering why nothing launched.
const isOn = (v) => v === true;

// → { review, dispatch: { <state>: bool } } — total over the agent-actionable
// states, so a caller never has to distinguish "absent" from "false".
export function resolveHeadless(config) {
  const off = { review: false, dispatch: Object.fromEntries(agentActionableStates().map((s) => [s, false])) };
  const raw = config?.[HEADLESS_KEY];
  if (!isPlainObject(raw)) return off;

  const dispatch = { ...off.dispatch };
  if (isPlainObject(raw.dispatch)) {
    for (const state of agentActionableStates()) {
      if (isOn(raw.dispatch[state])) dispatch[state] = true;
    }
  }
  return { review: isOn(raw.review), dispatch };
}

// The two questions callers actually ask.
export function reviewEnabled(config) {
  return resolveHeadless(config).review;
}

export function dispatchEnabled(config, state) {
  return resolveHeadless(config).dispatch[state] === true;
}

// → [{ path, message, level }] in `validateConfig`'s own shape, so the caller
// concatenates rather than translates. Lives beside the resolver deliberately: a
// validator that drifted from the resolver would bless a config that silently
// does nothing, which is the exact failure this whole module exists to prevent.
//
// `level` follows the config's established split — a wrong value is an "error"
// (it was meant to do something and won't), an unrecognised key is a "warn" (a
// consuming repo may carry its own, and a validator that rejected them would
// make the config un-extensible).
export function headlessIssues(config) {
  if (!Object.hasOwn(config ?? {}, HEADLESS_KEY)) return [];
  const raw = config[HEADLESS_KEY];
  if (raw === null) return [];

  const shape = "must be an object — e.g. { review: false, dispatch: { spec: false } }";
  const typeName = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
  if (!isPlainObject(raw)) {
    return [{ path: HEADLESS_KEY, message: `${shape} (got ${typeName(raw)})`, level: "error" }];
  }

  const issues = [];
  const error = (path, message) => issues.push({ path, message, level: "error" });
  const warn = (path, message) => issues.push({ path, message, level: "warn" });
  const bool = (path, value) => {
    if (value !== undefined && typeof value !== "boolean") {
      error(path, `must be a boolean (got ${typeName(value)}) — anything but true is off`);
    }
  };

  bool(`${HEADLESS_KEY}.review`, raw.review);

  if (raw.dispatch !== undefined) {
    if (!isPlainObject(raw.dispatch)) {
      error(`${HEADLESS_KEY}.dispatch`, `must be an object keyed by state (got ${typeName(raw.dispatch)})`);
    } else {
      const allowed = agentActionableStates();
      for (const [state, value] of Object.entries(raw.dispatch)) {
        if (!allowed.includes(state)) {
          // An error, not a warning, and not for being unrecognised: a flag on a
          // state no agent acts on is unfireable. It reads as configured autonomy
          // that can never happen, which is worse than no flag at all.
          error(
            `${HEADLESS_KEY}.dispatch.${state}`,
            `no agent acts on state "${state}" — must be one of ${allowed.map((s) => `"${s}"`).join(", ")}`,
          );
          continue;
        }
        bool(`${HEADLESS_KEY}.dispatch.${state}`, value);
      }
    }
  }

  for (const key of Object.keys(raw)) {
    if (key !== "review" && key !== "dispatch") {
      warn(`${HEADLESS_KEY}.${key}`, "is not a headless stage the loop reads — ignored");
    }
  }

  return issues;
}
