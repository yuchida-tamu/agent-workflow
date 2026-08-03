import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKER, parseVerdict, latestVerdict, authoritativeMarkerComment, authorises } from "../scripts/verdict/core.js";

// Exactly the shape scripts/actions/pr-verdict.js renders.
const comment = ({ level = "low", requires = "—", blocks = "—", runs = "—", matched = "", sha = null } = {}) =>
  `${MARKER}
### agentflow risk verdict: \`${level}\` (score 2)

| requires | blocks | runs |
|---|---|---|
| ${requires} | ${blocks} | ${runs} |
${sha ? `\nverdict-sha: ${sha}\n` : ""}
${matched ? `<details><summary>1 rule(s) matched</summary>\n\n| pack | rule | obligations |\n|---|---|---|\n${matched}\n\n</details>` : "No rules matched."}`;

// The identity `actions/risk-verdict/action.yml` posts as (either the App's
// bot login or `github-actions[bot]`, resolved by `trustedVerdictLogins` —
// see scripts/identity/identity.js). Kept as a bare literal here rather than
// imported from that module: these tests exercise the pure reader's author
// check in isolation from how config resolves an identity.
const TRUSTED = "agentflow-bot[bot]";
// A write-capable actor with no trusted identity — the shape of the attack
// #188 was filed over, and (per #189) potentially the same login the
// implementer itself acts as.
const FORGER = "attacker";

test("a clean low verdict parses", () => {
  const v = parseVerdict(comment());
  assert.equal(v.level, "low");
  assert.deepEqual(v.require, []);
  assert.deepEqual(v.block, []);
});

test("obligations parse out of the table", () => {
  const v = parseVerdict(comment({ level: "high", requires: "G2, human-merge", blocks: "auto-merge" }));
  assert.equal(v.level, "high");
  assert.deepEqual(v.require, ["G2", "human-merge"]);
  assert.deepEqual(v.block, ["auto-merge"]);
});

test("matched rules parse with their pack and rule ids", () => {
  const v = parseVerdict(comment({ matched: "| `baseline` | `self-mod-guard` | floor, require |" }));
  assert.deepEqual(v.matched, [{ pack: "baseline", rule: "self-mod-guard" }]);
});

// --- absence is refusal ------------------------------------------------------

test("a body that is not a verdict yields nothing", () => {
  for (const body of ["", null, undefined, "just a comment", "## Plan\nsomething"]) {
    assert.equal(parseVerdict(body), null, JSON.stringify(body));
  }
});

test("a marker with no obligations table yields nothing, not a partial verdict", () => {
  const truncated = `${MARKER}\n### agentflow risk verdict: \`low\` (score 0)\n`;
  assert.equal(parseVerdict(truncated), null);
});

test("a verdict with an unrecognised level yields nothing", () => {
  assert.equal(parseVerdict(comment({ level: "spicy" })), null);
});

test("a table whose row is missing yields nothing", () => {
  const noRow = `${MARKER}\n### agentflow risk verdict: \`low\` (score 0)\n\n| requires | blocks | runs |\n|---|---|---|\n`;
  assert.equal(parseVerdict(noRow), null);
});

test("every malformed shape refuses rather than guessing", () => {
  const shapes = [
    `${MARKER}`,
    `${MARKER}\ngarbage`,
    `${MARKER}\n### agentflow risk verdict: \`\` (score 0)\n\n| requires |\n|---|\n| — |`,
  ];
  for (const body of shapes) assert.equal(authorises("G2", parseVerdict(body)), false);
});

test("the most recent verdict wins, deterministically", () => {
  const v = latestVerdict(
    [
      { body: comment({ level: "high", requires: "G2" }), author: { login: TRUSTED } },
      { body: "chatter", author: { login: TRUSTED } },
      { body: comment({ level: "low" }), author: { login: TRUSTED } },
    ],
    [TRUSTED]
  );
  assert.equal(v.level, "low");
  assert.deepEqual(v.require, []);
});

test("no verdict comments at all yields nothing", () => {
  assert.equal(latestVerdict([{ body: "hi", author: { login: TRUSTED } }], [TRUSTED]), null);
  assert.equal(latestVerdict([], [TRUSTED]), null);
  assert.equal(latestVerdict(undefined, [TRUSTED]), null);
});

// --- author authentication (#188) --------------------------------------------
//
// `latestVerdict` used to parse whatever comment it was handed with no
// opinion on who posted it — see scripts/verdict/core.js's header. A
// write-capable actor (any login able to comment on the PR — including, per
// #189, an implementer sharing the bot's own write access) could append a
// forged `<!-- agentflow-verdict -->` comment claiming `risk verdict: low`
// and it would win by arriving last. These pin the fix: only a comment
// authored by a caller-supplied trusted login is ever considered, and
// filtering happens before the latest-wins collapse so a forgery can never
// shadow a genuine verdict merely by being newer.

test("a forged low verdict from a non-trusted author is ignored", () => {
  const comments = [
    { body: comment({ level: "high", requires: "G2, human-merge" }), author: { login: TRUSTED } },
    { body: comment({ level: "low" }), author: { login: FORGER } }, // appended forgery, posted later
  ];
  const v = latestVerdict(comments, [TRUSTED]);
  assert.equal(v.level, "high", "the forged low verdict must never win, however recently it was posted");
  assert.deepEqual(v.require, ["G2", "human-merge"]);
});

test("the real bot verdict is authoritative even when a forgery is posted first", () => {
  const comments = [
    { body: comment({ level: "low" }), author: { login: FORGER } },
    { body: comment({ level: "high", requires: "human-merge" }), author: { login: TRUSTED } },
  ];
  const v = latestVerdict(comments, [TRUSTED]);
  assert.equal(v.level, "high");
});

test("no resolvable trusted identity means no verdict is ever trusted — fail closed", () => {
  // Same posture `filterByAuthor` already documents for the review artifact:
  // absence of a trust list is not "trust nobody's individual posts", it is
  // fully closed. Consistent with the G2 verdict-reader's absence-is-refusal.
  const comments = [{ body: comment({ level: "low" }), author: { login: TRUSTED } }];
  assert.equal(latestVerdict(comments, []), null);
  assert.equal(latestVerdict(comments, undefined), null);
  assert.equal(latestVerdict(comments, null), null);
});

// --- read == write on the marker (#188) ---------------------------------------
//
// `authoritativeMarkerComment` is the ONE selection rule pr-verdict.js's
// upsert (write) and `latestVerdict` (read) both call — see this module's
// header for why sharing it, rather than two independently-written filters,
// is what makes "read == write" structural.

test("authoritativeMarkerComment picks the latest trusted marker comment, not the first", () => {
  const comments = [
    { id: 1, body: comment({ level: "high" }), author: { login: TRUSTED } },
    { id: 2, body: "unrelated chatter", author: { login: "someone-else" } },
    { id: 3, body: comment({ level: "low" }), author: { login: TRUSTED } },
  ];
  const c = authoritativeMarkerComment(comments, [TRUSTED]);
  assert.equal(c.id, 3);
});

test("an appended second marker comment from a non-trusted author does not change the authoritative read", () => {
  const comments = [
    { id: 1, body: comment({ level: "high", requires: "human-merge" }), author: { login: TRUSTED } },
    { id: 2, body: comment({ level: "low" }), author: { login: FORGER } }, // appended after
  ];
  const c = authoritativeMarkerComment(comments, [TRUSTED]);
  assert.equal(c.id, 1, "the trusted bot's own comment stays authoritative — the forgery was never a candidate");
});

// --- SECURITY: pinned hard, including the #189 write-principal scenario ------

test("SECURITY: an appended forged low verdict cannot launder the self-mod-guard high floor into auto-merge", () => {
  // The exact attack #188 was filed over, and the one #189's write-capable
  // headless implementer is gated on being closed before it can ship: a
  // write-capable actor (potentially sharing the bot's own write access, per
  // #189) appends a second `<!-- agentflow-verdict -->` comment claiming
  // `risk verdict: low` after the genuine self-mod-guard verdict — high,
  // `requires: human-merge`, `blocks: auto-merge` — was already posted by the
  // trusted bot. Before #188 this collapsed to "low" (last-wins, no author
  // check) and G3 auto-merged unattended. It must not, however the forgery is
  // shaped or timed.
  const sha = "abc1234def5678";
  const genuine = comment({ level: "high", requires: "human-merge", blocks: "auto-merge", sha });
  const forged = comment({ level: "low", sha });
  const comments = [
    { body: genuine, author: { login: TRUSTED } },
    { body: forged, author: { login: FORGER } },
  ];
  const v = latestVerdict(comments, [TRUSTED]);
  assert.equal(v.level, "high");
  assert.equal(authorises("G3", v, { headSha: sha }), false, "the self-mod-guard floor must still block auto-merge");
});

// --- authorisation -----------------------------------------------------------

test("G2 is authorised only when the engine did not require it", () => {
  assert.equal(authorises("G2", parseVerdict(comment())), true);
  assert.equal(authorises("G2", parseVerdict(comment({ requires: "G2, human-merge" }))), false);
});

test("a null verdict authorises nothing", () => {
  for (const gate of ["G1", "G2", "G3", "G4"]) {
    assert.equal(authorises(gate, null), false, gate);
  }
});

test("G1 and G4 are never auto-crossable", () => {
  const clean = parseVerdict(comment());
  assert.equal(authorises("G1", clean), false);
  assert.equal(authorises("G4", clean), false);
});

test("G3 needs no human-merge, no auto-merge block, and a matching SHA", () => {
  const sha = "abc1234def5678";
  assert.equal(authorises("G3", parseVerdict(comment({ sha })), { headSha: sha }), true);
  assert.equal(
    authorises("G3", parseVerdict(comment({ sha, requires: "human-merge" })), { headSha: sha }),
    false
  );
  assert.equal(
    authorises("G3", parseVerdict(comment({ sha, blocks: "auto-merge" })), { headSha: sha }),
    false
  );
});

test("a verdict about a different SHA does not authorise a merge", () => {
  const v = parseVerdict(comment({ sha: "aaaaaaa" }));
  assert.equal(authorises("G3", v, { headSha: "bbbbbbb" }), false);
});

test("a verdict with no recorded SHA never authorises a merge", () => {
  // pr-verdict.js does not stamp the SHA today. Until it does, G3 cannot be
  // auto-crossed — which is the correct failure direction.
  const v = parseVerdict(comment());
  assert.equal(v.sha, null);
  assert.equal(authorises("G3", v, { headSha: "abc1234" }), false);
});

test("a short SHA prefix matches its full head", () => {
  const v = parseVerdict(comment({ sha: "abc1234" }));
  assert.equal(authorises("G3", v, { headSha: "abc1234def5678901234" }), true);
});

test("obligations decide, not the claimed level", () => {
  // A caller cannot talk their way past a gate by presenting a low level: the
  // decision reads the obligations the engine emitted, and a verdict that says
  // `low` while requiring G2 is still refused.
  assert.equal(authorises("G2", { level: "high", require: [], block: [] }), true);
  assert.equal(authorises("G2", { level: "low", require: ["G2"], block: [] }), false);
});

test("a fabricated verdict cannot authorise a merge without a SHA to check", () => {
  // The closest thing to an attack: hand-build the most permissive verdict
  // possible. It still fails, because G3 additionally demands that the verdict
  // demonstrably describes the code being merged.
  const fabricated = { level: "low", require: [], block: [], matched: [], sha: null };
  assert.equal(authorises("G3", fabricated, { headSha: "abc1234" }), false);
});

// --- the stamped SHA, in the exact shape pr-verdict.js now writes -------------

test("a verdict carrying its SHA authorises a matching head", () => {
  // Mirrors scripts/actions/pr-verdict.js: `verdict-sha:` on its own line
  // between the heading and the obligations table.
  const sha = "0e274670a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const body = `${MARKER}
### agentflow risk verdict: \`low\` (score 0)

verdict-sha: ${sha}

| requires | blocks | runs |
|---|---|---|
| — | — | — |

No rules matched.`;
  const v = parseVerdict(body);
  assert.equal(v.sha, sha);
  assert.equal(authorises("G3", v, { headSha: sha }), true);
  assert.equal(authorises("G3", v, { headSha: "deadbeef" }), false, "a different head must not be authorised");
});

test("a stamped verdict still refuses G3 when obligations demand a human", () => {
  const sha = "0e274670a1b2c3d4";
  const body = `${MARKER}
### agentflow risk verdict: \`high\` (score 0)

verdict-sha: ${sha}

| requires | blocks | runs |
|---|---|---|
| G2, human-merge | auto-merge | — |

No rules matched.`;
  assert.equal(authorises("G3", parseVerdict(body), { headSha: sha }), false);
});

test("verdicts written before the SHA existed remain parseable and simply never auto-merge", () => {
  // Backwards compatibility in the safe direction: old comments still yield a
  // usable verdict for G2, and are permanently closed for G3.
  const old = `${MARKER}
### agentflow risk verdict: \`low\` (score 0)

| requires | blocks | runs |
|---|---|---|
| — | — | — |

No rules matched.`;
  const v = parseVerdict(old);
  assert.equal(v.level, "low");
  assert.equal(authorises("G2", v), true);
  assert.equal(authorises("G3", v, { headSha: "anything" }), false);
});

// --- the G2 auto-pass decision, end to end -----------------------------------

test("the exact verdict shapes this repo produces decide G2 correctly", () => {
  // Drawn from real comments: a low verdict with no obligations auto-passes; a
  // self-mod-guard verdict does not; a medium human-merge verdict still passes
  // G2 because human-merge is a G3 obligation, not a G2 one.
  const cases = [
    { requires: "—", expect: true },
    { requires: "G2, human-merge", expect: false },
    { requires: "human-merge", expect: true },
    { requires: "G2", expect: false },
  ];
  for (const c of cases) {
    const v = parseVerdict(comment({ requires: c.requires }));
    assert.equal(authorises("G2", v), c.expect, `requires=[${c.requires}]`);
  }
});
