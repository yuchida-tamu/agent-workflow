#!/usr/bin/env node
// agentflow-identity — act as the agentflow GitHub App instead of as a human.
//
//   agentflow-identity token  [--repo owner/name] [--installation <id>]
//   agentflow-identity exec   [--repo owner/name] -- <command…>
//   agentflow-identity whoami [--repo owner/name]
//   agentflow-identity doctor [--repo owner/name]
//
// `token` prints an installation access token. `exec` runs a command with
// `GH_TOKEN` set to a fresh one — a convenience over the module, never a place a
// rule is enforced, so deleting it weakens nothing. `whoami` says who would act.
// `doctor` checks the credentials resolve and reports how.
//
// Zero dependencies: the RS256 JWT is assembled in credentials.js and signed
// with node:crypto, and the token exchange uses fetch. `jsonwebtoken` and
// `octokit` are both refused — the toolkit's rule is no deps except `yaml`.
//
// Exit codes: 0 ok · 10 not configured / credentials missing · 20 usage/error.

import { execFileSync, spawnSync } from "node:child_process";
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadConfig } from "../config/load.js";
import { botLogin, resolveIdentity } from "./identity.js";
import {
  KEYCHAIN_SERVICE,
  chooseKeySource,
  describeMissingKey,
  jwtClaims,
  keyIsInWorkingTree,
  resolveAppId,
  signingInput,
} from "./credentials.js";

const API = "https://api.github.com";

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
  }
  return { flags, rest };
}

function die(code, message) {
  console.error(message);
  process.exit(code);
}

// --- credentials -------------------------------------------------------------

// Reading the PEM is the one step that touches disk, and it is also the step
// that can put a private key in a repository. The check runs before the read, so
// a key inside the working tree is reported rather than used.
function readPrivateKey(env, cwd) {
  const chosen = chooseKeySource(env);
  if (chosen.source === "env") return { pem: chosen.pem, from: "AGENTFLOW_APP_PRIVATE_KEY" };

  if (chosen.source === "file") {
    if (keyIsInWorkingTree(chosen.path, cwd)) {
      die(
        10,
        `refusing to read an App private key from inside the working tree:\n  ${chosen.path}\n\n` +
          "A key in the repository is one `git add` away from being published, and no\n" +
          "diagnostic afterwards can call it back. Move it outside the repo, or put it in\n" +
          `the keychain:\n  security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "$USER" -w "$(cat ${chosen.path})"`
      );
    }
    try {
      return { pem: readFileSync(chosen.path, "utf8"), from: `AGENTFLOW_APP_PRIVATE_KEY_FILE (${chosen.path})` };
    } catch (error) {
      die(10, `could not read the App private key at ${chosen.path}: ${error.message}`);
    }
  }

  try {
    const pem = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    if (pem.trim()) return { pem, from: `keychain (${KEYCHAIN_SERVICE})` };
  } catch {
    // Not on macOS, or no such item. Either way the answer is the same.
  }
  return { pem: null, from: null };
}

function appJwt({ appId, pem }) {
  const input = signingInput(jwtClaims({ appId, nowSeconds: Date.now() / 1000 }));
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  const signature = signer
    .sign(pem)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${input}.${signature}`;
}

async function api(path, { jwt, method = "GET" }) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agentflow-identity",
    },
  });
  const body = await response.text();
  if (!response.ok) {
    die(10, `GitHub refused ${method} ${path} (${response.status}): ${body.slice(0, 400)}`);
  }
  return body ? JSON.parse(body) : {};
}

function repoSlug(flags) {
  if (flags.repo) return flags.repo;
  try {
    return execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// The installation is discoverable from the repo, so nobody has to look up an
// opaque id by hand — but an explicit --installation still wins.
async function installationToken({ appId, pem, repo, installation }) {
  const jwt = appJwt({ appId, pem });
  let id = installation;
  if (!id) {
    if (!repo) {
      die(20, "cannot find the installation: pass --installation <id>, or --repo owner/name to discover it");
    }
    id = (await api(`/repos/${repo}/installation`, { jwt })).id;
  }
  const created = await api(`/app/installations/${id}/access_tokens`, { jwt, method: "POST" });
  return created.token;
}

// Everything a command needs before it can act as the App, or a reason it can't.
function context(flags) {
  const config = loadConfig();
  const identity = resolveIdentity(config);
  const repo = repoSlug(flags);
  const { appId, source: appIdSource } = resolveAppId({ env: process.env, identity });
  return { config, identity, repo, appId, appIdSource };
}

async function mint(flags) {
  const { identity, repo, appId } = context(flags);
  if (!identity.configured) {
    die(
      10,
      'this repo has no `agent_identity` in agentflow.config.json, so there is no App to act as.\n' +
        'Set it to the App slug (e.g. "agentflow-bot") — see docs/github-app-runbook.md.'
    );
  }
  if (!appId) {
    die(10, "no App ID: set AGENTFLOW_APP_ID, or `agent_identity: { slug, app_id }` in agentflow.config.json");
  }
  const { pem } = readPrivateKey(process.env, process.cwd());
  if (!pem) die(10, describeMissingKey());
  return installationToken({ appId, pem, repo, installation: flags.installation });
}

// --- commands ----------------------------------------------------------------

const [command, ...argv] = process.argv.slice(2);
const { flags, rest } = parseArgs(argv);

if (command === "token") {
  console.log(await mint(flags));
  process.exit(0);
}

if (command === "exec") {
  if (rest.length === 0) {
    die(20, "usage: agentflow-identity exec [--repo owner/name] -- <command…>");
  }
  const token = await mint(flags);
  const [bin, ...args] = rest;
  const result = spawnSync(bin, args, {
    stdio: "inherit",
    env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
  });
  process.exit(result.status ?? 20);
}

if (command === "whoami") {
  const { identity, repo, appId, appIdSource } = context(flags);
  if (!identity.configured) {
    // Not a failure. A repo with no App is a supported configuration, and the
    // honest answer is that the human's own auth is what acts.
    console.log(
      "agentflow has no identity of its own here: `agent_identity` is unset, so every\n" +
        "agent action runs on your own `gh` auth. That is a supported configuration —\n" +
        "see docs/github-app-runbook.md to give it one."
    );
    process.exit(0);
  }
  console.log(
    [
      `identity   ${botLogin(identity.slug)}`,
      `app id     ${appId ?? "(unset — set AGENTFLOW_APP_ID or agent_identity.app_id)"}${appId ? ` (from ${appIdSource})` : ""}`,
      `repo       ${repo ?? "(unknown — pass --repo owner/name)"}`,
    ].join("\n")
  );
  process.exit(0);
}

if (command === "doctor") {
  const { identity, repo, appId, appIdSource } = context(flags);
  const lines = [];
  let ok = true;
  const check = (pass, text) => {
    if (!pass) ok = false;
    lines.push(`${pass ? "✓" : "✗"} ${text}`);
  };

  check(identity.configured, identity.configured
    ? `agent_identity — ${botLogin(identity.slug)}`
    : "agent_identity — unset in agentflow.config.json");
  check(Boolean(appId), appId
    ? `app id — ${appId} (from ${appIdSource})`
    : "app id — set AGENTFLOW_APP_ID, or agent_identity.app_id");

  // Runs even when the rest failed: a human fixing three things wants all three
  // named, not one per invocation.
  const { pem, from } = readPrivateKey(process.env, process.cwd());
  check(Boolean(pem), pem ? `private key — ${from}` : "private key — not found in any source");

  check(Boolean(repo), repo ? `repo — ${repo}` : "repo — could not resolve; pass --repo owner/name");

  console.log(lines.join("\n"));
  if (!pem) console.log(`\n${describeMissingKey()}`);
  if (!ok) {
    console.log("\nUnconfigured is a supported state: the loop runs on your own `gh` auth,");
    console.log("with G3 in solo-comment mode. See docs/github-app-runbook.md to change that.");
  }
  process.exit(ok ? 0 : 10);
}

die(20, "usage: agentflow-identity <token|exec|whoami|doctor> [--repo owner/name] [--installation <id>]");
