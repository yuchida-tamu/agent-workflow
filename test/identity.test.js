import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IDENTITY_KEY,
  botLogin,
  botApprovalAllowed,
  g3Mode,
  isBotAuthor,
  isBotLogin,
  resolveIdentity,
} from "../scripts/identity/identity.js";

// --- resolveIdentity ---------------------------------------------------------

test("an absent agent_identity is a first-class answer, not an error", () => {
  for (const config of [{}, { [IDENTITY_KEY]: null }, undefined, null]) {
    const id = resolveIdentity(config);
    assert.equal(id.configured, false, JSON.stringify(config));
    assert.equal(id.slug, null);
    assert.equal(id.appId, null);
  }
});

test("a string agent_identity is the App slug", () => {
  const id = resolveIdentity({ [IDENTITY_KEY]: "agentflow-bot" });
  assert.equal(id.configured, true);
  assert.equal(id.slug, "agentflow-bot");
  assert.equal(id.source, "config");
});

test("the [bot] suffix is accepted and normalised away", () => {
  // Humans copy the login they see on a comment, which carries the suffix. Both
  // spellings have to mean the same App or half the config surface is a trap.
  assert.equal(resolveIdentity({ [IDENTITY_KEY]: "agentflow-bot[bot]" }).slug, "agentflow-bot");
  assert.equal(botLogin("agentflow-bot"), "agentflow-bot[bot]");
  assert.equal(botLogin("agentflow-bot[bot]"), "agentflow-bot[bot]");
});

test("the object form carries an app id alongside the slug", () => {
  const id = resolveIdentity({ [IDENTITY_KEY]: { slug: "agentflow-bot", app_id: 12345 } });
  assert.equal(id.configured, true);
  assert.equal(id.slug, "agentflow-bot");
  assert.equal(id.appId, "12345");
});

test("a malformed agent_identity resolves to unconfigured rather than throwing", () => {
  // Config *validation* is where a typo is reported. Resolution is called from
  // gate paths, and a throw there would fail closed in the loud, confusing way.
  for (const bad of [42, [], { app_id: 1 }, "", "   "]) {
    assert.equal(resolveIdentity({ [IDENTITY_KEY]: bad }).configured, false, JSON.stringify(bad));
  }
});

// --- isBotAuthor -------------------------------------------------------------

test("a bot is recognised by account type, not by name", () => {
  // Two distinct logins, neither of which any rule may name: a check that
  // matched "agentflow" would make every other bot a loophole.
  assert.ok(isBotAuthor({ login: "agentflow-bot[bot]", type: "Bot" }));
  assert.ok(isBotAuthor({ login: "dependabot[bot]", type: "Bot" }));
  assert.ok(isBotAuthor({ login: "github-actions[bot]", type: "Bot" }));
});

test("the [bot] login shape is enough on its own", () => {
  // The type is not always present on a webhook payload we did not shape.
  assert.ok(isBotAuthor({ login: "some-app[bot]" }));
  assert.ok(isBotAuthor({ login: "some-app[bot]", type: "User" }));
  assert.ok(isBotLogin("some-app[BOT]"));
});

test("humans are not bots", () => {
  assert.equal(isBotAuthor({ login: "yuchida-tamu", type: "User" }), false);
  assert.equal(isBotAuthor({ login: "robot-enthusiast", type: "User" }), false);
  assert.equal(isBotAuthor({}), false);
  assert.equal(isBotAuthor(null), false);
});

// --- botApprovalAllowed ------------------------------------------------------

const authorising = { level: "low", require: [], block: [], run: [], matched: [], sha: "abc1234" };
const head = "abc1234def5678";

test("a bot may approve G3 on a PR the engine already authorised", () => {
  assert.ok(botApprovalAllowed({ gate: "G3", surface: "pr", verdict: authorising, headSha: head }));
});

test("the carve-out does not reach any other gate", () => {
  for (const gate of ["G1", "G2", "G4"]) {
    assert.equal(
      botApprovalAllowed({ gate, surface: "pr", verdict: authorising, headSha: head }),
      false,
      gate
    );
  }
});

test("the carve-out does not reach an issue comment", () => {
  // The gate workflow only ever sees issue comments. This is what keeps it
  // unreachable there by construction rather than by configuration.
  for (const surface of ["issue", null, undefined]) {
    assert.equal(
      botApprovalAllowed({ gate: "G3", surface, verdict: authorising, headSha: head }),
      false,
      String(surface)
    );
  }
});

test("no verdict is refusal", () => {
  assert.equal(botApprovalAllowed({ gate: "G3", surface: "pr", verdict: null, headSha: head }), false);
});

test("a verdict with no recorded SHA is refusal", () => {
  // Absence is refusal: a verdict describes the code it was computed over, and
  // without a SHA there is no way to know it still does. `pr-verdict.js` does
  // stamp `verdict-sha:` today, so this is not a dormant path — it is what
  // catches a verdict written by anything that forgets to.
  const unstamped = { ...authorising, sha: null };
  assert.equal(botApprovalAllowed({ gate: "G3", surface: "pr", verdict: unstamped, headSha: head }), false);
});

test("a verdict describing different code is refusal", () => {
  const stale = { ...authorising, sha: "9999999" };
  assert.equal(botApprovalAllowed({ gate: "G3", surface: "pr", verdict: stale, headSha: head }), false);
});

test("a verdict demanding a human is refusal", () => {
  const demanding = { ...authorising, require: ["human-merge"] };
  assert.equal(botApprovalAllowed({ gate: "G3", surface: "pr", verdict: demanding, headSha: head }), false);
  const blocked = { ...authorising, block: ["auto-merge"] };
  assert.equal(botApprovalAllowed({ gate: "G3", surface: "pr", verdict: blocked, headSha: head }), false);
});

test("there is no parameter by which a caller can assert authorisation", () => {
  // The guarantee is that authority is read from the record. A caller passing
  // anything it likes alongside a refusing verdict still gets refused.
  const forged = {
    gate: "G3",
    surface: "pr",
    verdict: { ...authorising, sha: null },
    headSha: head,
    allowed: true,
    autoMergeable: true,
    level: "low",
  };
  assert.equal(botApprovalAllowed(forged), false);
});

// --- g3Mode ------------------------------------------------------------------

test("no agent identity means solo-comment, with the reason", () => {
  const { mode, why } = g3Mode({ config: {} });
  assert.equal(mode, "solo-comment");
  assert.match(why, /agent_identity/);
});

test("a configured identity restores native review", () => {
  const { mode, why, enforced } = g3Mode({
    config: { [IDENTITY_KEY]: "agentflow-bot" },
    protection: { required_pull_request_reviews: {} },
  });
  assert.equal(mode, "native-review");
  assert.equal(enforced, true);
  assert.match(why, /agentflow-bot/);
});

test("a configured identity on an unprotected branch is still native-review, but unenforced", () => {
  // Authorship decides whether a native review is *possible*; branch protection
  // decides whether it is *required*. Reporting them as one number would tell a
  // free-private-repo user their G3 does not work when it does.
  const { mode, enforced, why } = g3Mode({ config: { [IDENTITY_KEY]: "agentflow-bot" }, protection: null });
  assert.equal(mode, "native-review");
  assert.equal(enforced, false);
  assert.match(why, /unprotected|not enforced/i);
});

test("unreadable protection is reported as unknown, never as protected", () => {
  const { mode, enforced, why } = g3Mode({
    config: { [IDENTITY_KEY]: "agentflow-bot" },
    protection: undefined,
  });
  assert.equal(mode, "native-review");
  assert.equal(enforced, false);
  assert.match(why, /could not be read|unreadable/i);
});
