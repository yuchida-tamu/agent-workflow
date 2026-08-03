// Who is acting, and what that entitles them to. Pure: no `gh`, no fs, no
// network — the same discipline `machine.js` and the gate validator keep, so
// every entry point (Actions, a local session, a future headless runner) shares
// one tested answer instead of each deciding for itself.
//
// The loop had no identity of its own: every agent action ran on the human's
// auth, which made "agents never mint gate approvals" a rule enforced by prompt
// text. This module is where that becomes mechanical.

import { authorises } from "../verdict/core.js";
import { filterByAuthor, latestNativeReview, latestReviewComment } from "../review/core.js";
import { reviewEnabled } from "../headless/config.js";

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

// --- who the G3 review guard trusts (#113) -----------------------------------
//
// scripts/review/core.js parses whatever artifact it is handed and refuses to
// pick a trusted identity on its own (see that module's header, at length): it
// is the composing caller's job to filter the RAW comment/native-review lists
// down to a trusted login BEFORE collapsing them to "the latest" — filtering
// after collapse can lose a genuine veto to a newer, untrusted, fake pass.
// This is that caller's identity half: which login(s) earn that trust, and
// why.
//
// Reuses g3Mode() for the mode question rather than re-deriving "configured or
// not" a second way — the same "one source of truth" reasoning `botApprovalAllowed`
// and every other identity predicate here already follows.
export const HEADLESS_REVIEW_BOT_LOGIN = "github-actions[bot]";

// → { logins: [string], mode, why }
//
// native-review: the only identity that can post the artifact this guard was
// designed to trust is the App itself — `decideBotReview` (auto-merge.js) and
// the headless reviewer's native-review submission both act as it, and
// `actions/headless-review/action.yml`/`actions/auto-merge/action.yml`
// authenticate `gh` as the App whenever its credentials are supplied. Trusted
// login: the App's bot login, derived from the same `agent_identity` config
// key `resolveIdentity` already reads — a second key naming the reviewer
// would be a second source of truth for an identity this repo already has one
// name for.
//
// solo-comment: there is no App, so a marker comment authored by *anyone who
// can comment on the PR* — including the PR's own author — is not
// distinguishable from a fake pass by login alone (scripts/review/core.js's
// header covers this at length: solo mode has no GitHub-side protection at
// all). The one poster in solo mode that is provably not the human is the
// headless reviewer, and it is that poster ONLY when `headless.review` is
// actually turned on for this repo: `actions/headless-review/action.yml`
// falls back to `secrets.GITHUB_TOKEN` when no App credentials are supplied,
// which GitHub always attributes to `github-actions[bot]` — never to the
// human, however the human authenticated the workflow run itself. So
// `headless.review: true` is the config signal this resolves from, read via
// `scripts/headless/config.js`'s own resolver rather than a second reading of
// the key (the same "do not re-derive" discipline `resolveHeadless` already
// enforces for `dispatchEnabled`).
//
// When headless review is OFF, config names nobody who is provably not the
// human — not "trust nobody's individual posts" (which would still imply
// someone to distrust), literally no identity is derivable at all. This
// returns an empty login list for that case, and every caller that feeds it
// into `filterByAuthor` gets that module's own documented fail-closed
// behaviour for free: an empty trusted list filters out everything, which
// `reviewAuthorises` then reads as `no-artifact`. Unconfigurable trust and
// absent trust resolve to the same refusal on purpose — this is the
// "fail closed when unconfigurable" decision #113 was asked to make and
// record.
export function trustedReviewerLogins({ config = {} } = {}) {
  const { mode } = g3Mode({ config });
  if (mode === "native-review") {
    const identity = resolveIdentity(config);
    const login = botLogin(identity.slug);
    return {
      logins: login ? [login] : [],
      mode,
      why: `native-review: @${login} is the only identity that can post the artifact this guard trusts`,
    };
  }
  if (reviewEnabled(config)) {
    return {
      logins: [HEADLESS_REVIEW_BOT_LOGIN],
      mode,
      why:
        `solo-comment with headless.review enabled: @${HEADLESS_REVIEW_BOT_LOGIN} is the only ` +
        "poster that is provably not the PR's own human author",
    };
  }
  return {
    logins: [],
    mode,
    why:
      "solo-comment with headless.review not enabled: no identity in config is provably not the " +
      "PR's own author — fails closed, same posture as no artifact at all",
  };
}

// → { native, comment, mode, trustedLogins, why }
//
// The full composition a G3 enforcement point needs: resolve who is trusted,
// filter the RAW lists to that trust BEFORE collapsing (never after — see
// scripts/review/core.js's header and its pinned ATTACK/ANTI-PATTERN tests for
// why the order is load-bearing), then hand the collapsed pair to
// `reviewAuthorises` at the call site. Pure — `nativeReviews`/`comments` are
// already-fetched plain data; no `gh` here, so this stays testable without a
// network.
//
// `prAuthor` (#187) is the PR's own author login, threaded straight into
// `filterByAuthor`'s `excludeAuthor` for BOTH lists. Trusted-login
// membership alone is not "not the implementer": once a write-capable agent
// authors its PRs under the same trusted login this guard trusts (the App
// bot, or `github-actions[bot]` under headless review), that agent can post
// its own `<!-- agentflow-review -->` marker comment and pass the trust
// check — the exact hole `decideBotReview`'s self-exclusion already closes
// for *submitting* a native review, but the comment-artifact *reading* path
// had no analogue. Applying it to `nativeReviews` too costs nothing (GitHub
// already forbids a login from approving its own PR natively) and keeps one
// exclusion rule for both sources rather than a rule that only covers one.
// `prAuthor: null` (the default) preserves every existing caller's exact
// behaviour — nothing is excluded, same as calling `filterByAuthor` with no
// third argument.
export function resolveTrustedReviewState({ config = {}, nativeReviews = [], comments = [], prAuthor = null } = {}) {
  const { logins, mode, why } = trustedReviewerLogins({ config });
  return {
    native: latestNativeReview(filterByAuthor(nativeReviews, logins, prAuthor)),
    comment: latestReviewComment(filterByAuthor(comments, logins, prAuthor)),
    mode,
    trustedLogins: logins,
    why,
  };
}

// --- who the risk-verdict reader trusts (#188) -------------------------------
//
// scripts/verdict/core.js's `latestVerdict` parses whatever comment it is
// handed and — like scripts/review/core.js before #113 — has no opinion of
// its own on who posted it (see that module's header). Skipping the check
// here IS the forged-verdict laundering #188 was filed over: a
// `<!-- agentflow-verdict -->` comment authored by *anyone who can comment on
// the PR* — including a write-capable implementer acting on this same repo —
// would otherwise be trusted, letting a forged `risk verdict: low` launder
// the self-mod-guard's high floor (the obligation that exists to force a
// human merge on workflow/policy/label changes) into an unattended merge.
//
// `actions/risk-verdict/action.yml` posts as the agentflow App when
// `agent_identity` is configured, and as `GITHUB_TOKEN` (which GitHub always
// attributes to `github-actions[bot]`) otherwise — exactly the two identities
// `trustedReviewerLogins` already resolves for the review artifact, via the
// same `g3Mode`/`resolveIdentity`/`botLogin` primitives, reused here rather
// than re-derived.
//
// It diverges from `trustedReviewerLogins` on exactly one point, and the
// divergence is deliberate: solo-comment mode trusts `github-actions[bot]`
// UNCONDITIONALLY, rather than gating on `headless.review`. That gate exists
// on the review artifact because the review artifact is optional
// infrastructure — with `headless.review` off, nothing in the intended
// design ever posts it as `github-actions[bot]`, so trusting that login
// anyway would trust an identity nothing should be producing. The
// risk-verdict workflow has no equivalent opt-in flag: `agentflow-verdict.yml`
// runs on every `pull_request` once a repo installs it, unconditionally, and
// it always posts as one of these two identities — there is no config key
// that means "this workflow is off" the way `headless.review` means that for
// the reviewer. Gating verdict trust on `headless.review` would mean the
// DEFAULT solo-comment config (`headless.review` unset, the common case)
// never trusts any verdict comment at all — silently disabling G2 auto-pass
// and G3 auto-merge everywhere headless review has not *also* been opted
// into, which is a far larger regression than #188 was filed to fix. A repo
// that never installed the risk-verdict workflow simply has no verdict
// comments to read, and absence is already refusal.
export function trustedVerdictLogins({ config = {} } = {}) {
  const { mode } = g3Mode({ config });
  if (mode === "native-review") {
    const identity = resolveIdentity(config);
    const login = botLogin(identity.slug);
    return {
      logins: login ? [login] : [],
      mode,
      why: `native-review: @${login} is the only identity the risk-verdict workflow acts as`,
    };
  }
  return {
    logins: [HEADLESS_REVIEW_BOT_LOGIN],
    mode,
    why:
      `solo-comment: the risk-verdict workflow falls back to GITHUB_TOKEN, which GitHub always ` +
      `attributes to @${HEADLESS_REVIEW_BOT_LOGIN} — never to a human, however the workflow run was triggered`,
  };
}
