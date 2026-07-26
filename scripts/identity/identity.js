// Who is acting, and what that entitles them to. Pure: no `gh`, no fs, no
// network — the same discipline `machine.js` and the gate validator keep, so
// every entry point (Actions, a local session, a future headless runner) shares
// one tested answer instead of each deciding for itself.
//
// The loop had no identity of its own: every agent action ran on the human's
// auth, which made "agents never mint gate approvals" a rule enforced by prompt
// text. This module is where that becomes mechanical.

import { authorises } from "../verdict/core.js";

// The config key naming the App whose identity agents act as. Optional
// everywhere: the toolkit ships to repos that will never create an App, and
// every path keeps a working unconfigured branch.
export const IDENTITY_KEY = "agent_identity";

const BOT_SUFFIX = /\[bot\]$/i;

// A GitHub App comments as `<slug>[bot]`. Humans copy the login they see, so
// both spellings have to resolve to the same App.
export function normaliseSlug(slug) {
  return typeof slug === "string" ? slug.trim().replace(BOT_SUFFIX, "") : null;
}

export function botLogin(slug) {
  const base = normaliseSlug(slug);
  return base ? `${base}[bot]` : null;
}

// Name-shape only. `isBotAuthor` is the one to reach for when an account type is
// available; this exists for the places that only ever see a login string —
// config validation, most of all.
export function isBotLogin(login) {
  return typeof login === "string" && BOT_SUFFIX.test(login.trim());
}

// By account **type**, never by name. A check that recognised one App by its
// slug would leave every other bot as a loophole, which is the opposite of the
// property this module exists to provide. The login shape is a fallback for
// payloads that carry no type.
export function isBotAuthor(author) {
  if (!author) return false;
  if (typeof author.type === "string" && author.type.toLowerCase() === "bot") return true;
  return isBotLogin(author.login);
}

// → { configured, slug, appId, source }
//
// Accepts `"agentflow-bot"` or `{ slug, app_id }`. A malformed value resolves to
// *unconfigured* rather than throwing: this is called from gate paths, where a
// throw would fail in the loudest and least useful way. A typo is reported by
// `validateConfig`, which is the surface built to report typos.
export function resolveIdentity(config) {
  const raw = config?.[IDENTITY_KEY] ?? null;
  const unset = { configured: false, slug: null, appId: null, source: "unset" };
  if (raw === null || raw === undefined) return unset;

  if (typeof raw === "string") {
    const slug = normaliseSlug(raw);
    return slug ? { configured: true, slug, appId: null, source: "config" } : unset;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const slug = normaliseSlug(raw.slug);
    if (!slug) return unset;
    const appId = raw.app_id === undefined || raw.app_id === null ? null : String(raw.app_id);
    return { configured: true, slug, appId, source: "config" };
  }
  return unset;
}

// May a bot-authored approval stand?
//
// Almost never — and where it may, the authority is not the bot's. A PR whose
// recorded verdict carries no `human-merge`, no `auto-merge` block, and
// demonstrably describes the head being merged is one `auto-merge.js` already
// merges with no `/approve` at all. Letting the App submit the approving review
// in exactly that case transcribes an engine decision into a reviewable
// artifact; it grants nothing new.
//
// There is deliberately no parameter, flag or field by which a caller can state
// that a PR is auto-mergeable — the same rule `verdict/core.js` keeps about risk
// levels. The predicate reads the record, or it refuses.
export function botApprovalAllowed({ gate, surface, verdict = null, headSha = null } = {}) {
  if (gate !== "G3") return false;
  if (surface !== "pr") return false;
  return authorises("G3", verdict, { headSha });
}

// Which G3 does this repo have, and why?
//
// Two independent questions, deliberately reported as two values. **Authorship**
// decides whether a native review is possible at all: with no App, agent PRs are
// authored by the human, and GitHub forbids approving your own PR — so G3
// degrades to a comment ritual. **Branch protection** decides whether that review
// is required rather than merely available. Collapsing them into one verdict
// would tell a free-private-repo user their G3 does not work when it does.
//
// `protection` is the GET on the branch's protection endpoint: the response body,
// `null` when absent (404), or `undefined` when unreadable (403 — a free private
// repo, or a token without admin) or simply not looked up. It carries no default
// on purpose: a default would collapse "unreadable" into "absent", and unreadable
// must never be reported as protected *or* as unprotected.
export function g3Mode({ config = {}, protection } = {}) {
  const identity = resolveIdentity(config);
  if (!identity.configured) {
    return {
      mode: "solo-comment",
      enforced: false,
      why:
        `no ${IDENTITY_KEY} configured — agent PRs are authored by the human, and ` +
        "GitHub forbids approving your own PR, so G3 is a SHA-naming comment plus a merge",
    };
  }
  if (protection === undefined) {
    return {
      mode: "native-review",
      enforced: false,
      why:
        `agent PRs are authored by @${botLogin(identity.slug)}, so a human can approve them natively; ` +
        "branch protection could not be read (403 — a free private repo, or a token without admin) " +
        "or was not looked up, so the review is available but not known to be required",
    };
  }
  if (protection === null) {
    return {
      mode: "native-review",
      enforced: false,
      why:
        `agent PRs are authored by @${botLogin(identity.slug)}, so a human can approve them natively; ` +
        "the default branch is unprotected, so the review is available but not enforced",
    };
  }
  return {
    mode: "native-review",
    enforced: true,
    why:
      `agent PRs are authored by @${botLogin(identity.slug)} and the default branch is protected, ` +
      "so G3 is a native review and it is required",
  };
}
