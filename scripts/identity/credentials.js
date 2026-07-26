// Where the App's credentials come from, and what a JWT asserting them looks
// like. Pure: no fs, no network, no signing — every decision here is a function
// of the environment it is handed, so the whole resolution story is testable
// without a private key existing anywhere.
//
// `cli.js` does the three things that cannot be pure: read the file, sign, and
// call GitHub.

// Checked in order, first hit wins. There is deliberately no "read it from the
// repo" source: a private key committed to a repository is a finding, and
// offering the path would invite it.
export const KEY_SOURCES = [
  {
    id: "env",
    description: "AGENTFLOW_APP_PRIVATE_KEY (the PEM itself)",
  },
  {
    id: "file",
    description: "AGENTFLOW_APP_PRIVATE_KEY_FILE (a path to the PEM)",
  },
  {
    id: "keychain",
    description: 'macOS keychain (security find-generic-password -s "agentflow-app-private-key")',
  },
];

export const KEYCHAIN_SERVICE = "agentflow-app-private-key";

// A PEM in an env var, a path in another, or neither — the keychain is the only
// source this cannot decide alone, since answering needs a subprocess.
// → { source, pem } | { source: "file", path } | { source: "keychain" } | { source: "none" }
export function chooseKeySource(env = {}) {
  const inline = env.AGENTFLOW_APP_PRIVATE_KEY;
  if (typeof inline === "string" && inline.trim()) {
    return { source: "env", pem: inline };
  }
  const path = env.AGENTFLOW_APP_PRIVATE_KEY_FILE;
  if (typeof path === "string" && path.trim()) {
    return { source: "file", path: path.trim() };
  }
  return { source: "keychain" };
}

// A key inside the working tree is a defect, not a configuration — one `git add`
// away from being published, and no diagnostic afterwards can call it back. This
// is a path comparison, so it catches the mistake before the file is ever read.
export function keyIsInWorkingTree(path, cwd) {
  if (typeof path !== "string" || typeof cwd !== "string" || !path || !cwd) return false;
  const normalise = (p) => p.replace(/\/+$/, "");
  const resolved = path.startsWith("/") ? normalise(path) : `${normalise(cwd)}/${path.replace(/^\.\//, "")}`;
  return resolved === normalise(cwd) || resolved.startsWith(`${normalise(cwd)}/`);
}

// The App ID, from the environment or from the config's `agent_identity`.
// Environment wins: a runner overriding config is the normal case, and config
// overriding a runner would make a CI failure inexplicable from the logs.
export function resolveAppId({ env = {}, identity = null } = {}) {
  const fromEnv = env.AGENTFLOW_APP_ID;
  if (fromEnv !== undefined && fromEnv !== null && String(fromEnv).trim()) {
    return { appId: String(fromEnv).trim(), source: "AGENTFLOW_APP_ID" };
  }
  if (identity?.appId) return { appId: String(identity.appId), source: "agent_identity.app_id" };
  return { appId: null, source: null };
}

// GitHub rejects a JWT whose lifetime exceeds 10 minutes, and one whose `iat` is
// in the future by the receiving clock. 60s back and 9 minutes forward is the
// documented shape, and it is asserted rather than assumed.
export const MAX_JWT_LIFETIME_SECONDS = 600;
const CLOCK_SKEW_SECONDS = 60;
const LIFETIME_SECONDS = 540;

export function jwtClaims({ appId, nowSeconds }) {
  const iat = Math.floor(nowSeconds) - CLOCK_SKEW_SECONDS;
  return { iat, exp: iat + LIFETIME_SECONDS, iss: String(appId) };
}

export function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The bytes that get signed. Split out so a test can verify a real signature
// against a throwaway key without any of this module knowing how to sign.
export function signingInput(claims) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  return `${header}.${base64url(JSON.stringify(claims))}`;
}

// What `doctor` prints when nothing resolves. Naming every source tried is the
// difference between "it doesn't work" and a human knowing which env var to set.
export function describeMissingKey() {
  return [
    "no App private key found. Tried, in order:",
    ...KEY_SOURCES.map((s, i) => `  ${i + 1}. ${s.description}`),
    "",
    "The key must never live in the repository. Put the PEM in the environment,",
    "or in the keychain:",
    `  security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "$USER" -w "$(cat app.private-key.pem)"`,
  ].join("\n");
}
