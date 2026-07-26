import { test } from "node:test";
import assert from "node:assert/strict";
import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import {
  KEYCHAIN_SERVICE,
  KEY_SOURCES,
  MAX_JWT_LIFETIME_SECONDS,
  base64url,
  chooseKeySource,
  describeMissingKey,
  jwtClaims,
  keyIsInWorkingTree,
  resolveAppId,
  signingInput,
} from "../scripts/identity/credentials.js";

// --- key source resolution ---------------------------------------------------

test("an inline PEM wins, and is never confused with a path", () => {
  const chosen = chooseKeySource({
    AGENTFLOW_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----",
    AGENTFLOW_APP_PRIVATE_KEY_FILE: "/tmp/key.pem",
  });
  assert.equal(chosen.source, "env");
  assert.match(chosen.pem, /BEGIN RSA PRIVATE KEY/);
});

test("a path is used when no inline PEM is set", () => {
  const chosen = chooseKeySource({ AGENTFLOW_APP_PRIVATE_KEY_FILE: "  /tmp/key.pem  " });
  assert.deepEqual(chosen, { source: "file", path: "/tmp/key.pem" });
});

test("an empty or whitespace value is not a credential", () => {
  // A blank env var in CI is the usual way this fails, and treating it as set
  // produces an unsigned JWT and a baffling 401 rather than a diagnostic.
  for (const env of [{}, { AGENTFLOW_APP_PRIVATE_KEY: "" }, { AGENTFLOW_APP_PRIVATE_KEY: "   " }]) {
    assert.equal(chooseKeySource(env).source, "keychain", JSON.stringify(env));
  }
  assert.equal(chooseKeySource({ AGENTFLOW_APP_PRIVATE_KEY_FILE: "  " }).source, "keychain");
});

test("there is no source that reads a key out of the repository", () => {
  assert.equal(KEY_SOURCES.some((s) => /repo|working tree|\.pem file in/i.test(s.description)), false);
  assert.equal(KEY_SOURCES.length, 3);
});

// --- the key must not live in the repo ---------------------------------------

test("a key inside the working tree is caught before it is ever read", () => {
  const cwd = "/Users/dev/projects/agent-workflow";
  assert.ok(keyIsInWorkingTree(`${cwd}/app.private-key.pem`, cwd));
  assert.ok(keyIsInWorkingTree(`${cwd}/secrets/key.pem`, cwd));
  assert.ok(keyIsInWorkingTree("app.private-key.pem", cwd), "a relative path resolves against cwd");
  assert.ok(keyIsInWorkingTree("./key.pem", cwd));
});

test("a key outside the working tree is fine", () => {
  const cwd = "/Users/dev/projects/agent-workflow";
  assert.equal(keyIsInWorkingTree("/Users/dev/.config/agentflow/key.pem", cwd), false);
  assert.equal(keyIsInWorkingTree("/Users/dev/projects/agent-workflow-notes/key.pem", cwd), false);
  assert.equal(keyIsInWorkingTree(null, cwd), false);
  assert.equal(keyIsInWorkingTree("/tmp/key.pem", null), false);
});

// --- app id ------------------------------------------------------------------

test("the environment's App ID beats the config's", () => {
  // A runner overriding config is the normal case; the reverse would make a CI
  // failure impossible to explain from the logs.
  const r = resolveAppId({ env: { AGENTFLOW_APP_ID: "999" }, identity: { appId: "111" } });
  assert.equal(r.appId, "999");
  assert.equal(r.source, "AGENTFLOW_APP_ID");
});

test("the config's app_id is used when the environment is silent", () => {
  const r = resolveAppId({ env: {}, identity: { appId: 111 } });
  assert.equal(r.appId, "111", "numbers are normalised to strings");
  assert.match(r.source, /agent_identity/);
});

test("no App ID anywhere is a null answer, not a throw", () => {
  assert.deepEqual(resolveAppId({}), { appId: null, source: null });
  assert.deepEqual(resolveAppId({ env: { AGENTFLOW_APP_ID: "  " } }), { appId: null, source: null });
});

// --- the JWT -----------------------------------------------------------------

const NOW = 1_800_000_000;

test("the JWT claims are what GitHub accepts", () => {
  const claims = jwtClaims({ appId: 12345, nowSeconds: NOW });
  assert.equal(claims.iss, "12345");
  assert.ok(claims.iat < NOW, "iat is backdated for clock skew");
  assert.ok(claims.exp > NOW, "the token is valid now");
  assert.ok(
    claims.exp - claims.iat <= MAX_JWT_LIFETIME_SECONDS,
    "GitHub rejects a lifetime over 10 minutes",
  );
});

test("base64url leaves nothing a URL would have to escape", () => {
  const encoded = base64url(JSON.stringify({ a: "?>?>?>", b: "ÿþ" }));
  assert.equal(/[+/=]/.test(encoded), false);
});

test("the signing input is a real JWT that verifies against its key", () => {
  // The whole point of the pure/impure split: this proves the assembled bytes
  // are signable and verifiable without a real App credential existing anywhere.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const input = signingInput(jwtClaims({ appId: 12345, nowSeconds: NOW }));

  const signer = createSign("RSA-SHA256");
  signer.update(input);
  const signature = signer.sign(privateKey);

  const verifier = createVerify("RSA-SHA256");
  verifier.update(input);
  assert.ok(verifier.verify(publicKey, signature));

  const [header, payload] = input.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  assert.equal(JSON.parse(Buffer.from(payload, "base64url").toString()).iss, "12345");
});

// --- the diagnostic ----------------------------------------------------------

test("the missing-key diagnostic names every source it tried", () => {
  const message = describeMissingKey();
  for (const source of KEY_SOURCES) {
    assert.ok(message.includes(source.description), source.id);
  }
  assert.match(message, /never live in the repository/);
  assert.ok(message.includes(KEYCHAIN_SERVICE), "it hands over a keychain command that works");
});
