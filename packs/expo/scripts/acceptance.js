#!/usr/bin/env node
// packs/expo/scripts/acceptance.js — see acceptance.sh for usage/env docs and
// exit-code meaning. This is the real logic: drive the run/verify/
// execute-step adapters, as real child processes speaking their documented
// stdin/stdout contract, against a real booted iOS simulator. No mocks below
// this line — that's the whole point of #136 (unit tests already cover the
// contract with a mocked runner; this is the live proof).
//
// Target app: self-provisioned by default (a vanilla `create-expo-app
// --template blank-typescript` scaffold with one injected screen — see
// injectScreen below), so this script is reproducible on any machine with
// network + Xcode, never depends on a specific consuming app's state, and
// never touches any other app's workspace. `AGENTFLOW_ACCEPTANCE_APP`
// overrides with an existing app path when you want to point this at
// something else — it must already expose the acceptance-* testIDs
// injectScreen writes, or the execute-step stage will fail on a genuine
// selector miss rather than an adapter bug.
//
// A CONTRACT violation (an adapter's response doesn't match its documented
// interface shape or exit code) is a candidate adapter bug — file it, don't
// silently tolerate it. A STEP failure (execute-step legitimately returns
// status:"failed") is a verdict about the fixture app, not the adapter: the
// adapter did its job correctly by reporting the failure at all.

import { spawn, execFile } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(HERE, "..", "adapters");

const TARGET = process.env.AGENTFLOW_ACCEPTANCE_TARGET || "iPhone 15";
const METRO_PORT = process.env.AGENTFLOW_ACCEPTANCE_METRO_PORT || "8081";
const EVIDENCE_DIR =
  process.env.AGENTFLOW_ACCEPTANCE_EVIDENCE_DIR ||
  join(tmpdir(), "agentflow-expo-acceptance", "evidence", new Date().toISOString().replace(/[:.]/g, "-"));
const APP_OVERRIDE = process.env.AGENTFLOW_ACCEPTANCE_APP || null;
const APP_CACHE = process.env.AGENTFLOW_ACCEPTANCE_APP_CACHE || join(tmpdir(), "agentflow-expo-acceptance", "app");
const BUNDLE_ID = "dev.agentflow.acceptance";

class SkipError extends Error {}

const transcriptLines = [];
const results = { target: TARGET, metro_port: METRO_PORT, stages: [], violations: [] };

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  transcriptLines.push(line);
}

function recordStage(name, status, detail) {
  results.stages.push({ name, status, detail: detail ?? null });
  log(`STAGE ${name}: ${status}${detail ? ` — ${detail}` : ""}`);
}

// kind "contract": the adapter's own response didn't match interfaces/*.md —
// a candidate adapter bug (outside this script's declared surface — file it).
// kind "assertion": a documented step/assertion verdict came back false —
// the fixture app's behavior, not the adapter's; still fails the run (proof
// requires the trace to actually pass) but is not, by itself, evidence of an
// adapter defect.
function record(kind, stage, message) {
  results.violations.push({ kind, stage, message });
  log(`${kind === "contract" ? "CONTRACT VIOLATION" : "ASSERTION MISS"} [${stage}]: ${message}`);
}

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        error: error && typeof error.code !== "number" ? error : null,
      });
    });
  });
}

// Spawns `node <adaptersDir>/<adapterFile>`, writes `request` as its one
// stdin JSON object, and collects the whole stdout/stderr/exit — exactly how
// a real caller (an agent, the E2E runner) invokes these, per
// packs/expo/adapters/lib/contract.js. No importing adapter internals: this
// is a black-box proof of the CLI contract, not a unit test.
function callAdapter(adapterFile, request) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ADAPTERS_DIR, adapterFile)], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      let parsed = null;
      let parseError = null;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch (err) {
        parseError = err.message;
      }
      resolve({ code, stdout, stderr, parsed, parseError });
    });
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}

async function checkDescribe(adapterFile, expectedInterface) {
  const res = await callAdapter(adapterFile, { op: "describe" });
  if (res.code !== 0) {
    return record("contract", `describe:${adapterFile}`, `expected exit 0, got ${res.code}. stderr: ${res.stderr.slice(0, 500)}`);
  }
  if (res.parseError) {
    return record("contract", `describe:${adapterFile}`, `stdout was not valid JSON: ${res.parseError} (stdout: ${res.stdout.slice(0, 200)})`);
  }
  if (res.parsed?.interface !== expectedInterface) {
    return record("contract", `describe:${adapterFile}`, `expected interface "${expectedInterface}", got ${JSON.stringify(res.parsed?.interface)}`);
  }
  log(`describe ${adapterFile} OK -> ${JSON.stringify(res.parsed)}`);
}

// A minimal known screen: one static label, one tappable counter (the
// execute-step trace taps it and asserts the count text), one text input
// (the verify stage's `act type` exercises it). Every interactive element
// carries a testID — per interfaces/verify.md's fixed selector order
// (test_id -> a11y label -> text), a testID is the only selector this trace
// ever uses.
const APP_TSX = `// Injected by packs/expo/scripts/acceptance.js for the pack-expo live
// acceptance run (#136) — not part of any product surface. Every
// interactive element carries a stable testID, the selector this script's
// trace targets.
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

export default function App() {
  const [count, setCount] = useState(0);
  const [value, setValue] = useState("");

  return (
    <View style={styles.container}>
      <Text testID="acceptance-title" style={styles.title}>agentflow acceptance</Text>
      <Pressable
        testID="acceptance-button"
        accessibilityRole="button"
        onPress={() => setCount((c) => c + 1)}
        style={styles.button}
      >
        <Text testID="acceptance-count">Tapped: {count}</Text>
      </Pressable>
      <TextInput
        testID="acceptance-input"
        style={styles.input}
        value={value}
        onChangeText={setValue}
        placeholder="type here"
      />
      <Text testID="acceptance-echo">{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  title: { fontSize: 20, fontWeight: "600" },
  button: { paddingVertical: 12, paddingHorizontal: 24, backgroundColor: "#208AEF", borderRadius: 8 },
  input: { borderWidth: 1, borderColor: "#999", borderRadius: 8, padding: 12, width: "100%" },
});
`;

// create-expo-app's blank-typescript template ships app.json with no
// ios.bundleIdentifier and no scheme — run.js's bundleIdFromConfig requires
// the former (see packs/expo/adapters/run.js); schemeFromConfig requires the
// latter as of #163 (`run start` now opens the dev client via its own
// `<scheme>://expo-development-client/?url=…` deep link, matching @expo/cli
// byte-for-byte, rather than the generic exp:// scheme Expo Go itself claims
// — see #162). Without a scheme, `start` now fails fast with a clear
// recoverable(10) naming the gap, before any build or Metro spawn — by
// design, not a bug, but the scaffold has to actually set one.
async function injectScreen(appDir) {
  await writeFile(join(appDir, "App.tsx"), APP_TSX);
  const appJsonPath = join(appDir, "app.json");
  const appJson = JSON.parse(await readFile(appJsonPath, "utf8"));
  appJson.expo.ios = { ...appJson.expo.ios, bundleIdentifier: BUNDLE_ID };
  appJson.expo.scheme = "agentflowacceptance";
  await writeFile(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`);
  log(`Injected acceptance screen (App.tsx) + ios.bundleIdentifier + scheme into ${appDir}`);
}

// #162's fix (#163) only gets the *deep link* right — it still needs
// something in the built binary actually listening for
// `<scheme>://expo-development-client/…` and connecting to Metro. That
// listener is the `expo-dev-client` package's own native module (the
// "dev-launcher"): live inspection during #163's investigation confirmed the
// vanilla blank-typescript scaffold's build has no dev-launcher pod and no
// `expo-development-client` string anywhere in it at all — opening a
// well-formed deep link against that build reproduces "No script URL
// provided… unsanitizedScriptURLString = (null)" regardless of URL
// correctness. `expo install expo-dev-client` (never bare `npm install` —
// this resolves the SDK-compatible version the same way every other
// dependency in this workspace was resolved) adds it; removing the stale
// `ios/` directory forces `expo run:ios`'s next build to regenerate the
// native project from scratch (via `expo prebuild`), so the new package
// actually gets autolinked into the Podfile — an existing `ios/` dir is
// otherwise never resynced from package.json/app.json on subsequent builds.
// Returns true when it actually changed the workspace (freshly installed
// expo-dev-client) — false when it was already present (idempotent re-run
// against a cache that already has it).
async function ensureDevClient(appDir) {
  const pkgPath = join(appDir, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  if (pkg.dependencies?.["expo-dev-client"]) {
    log(`expo-dev-client already present in ${pkgPath} — skipping install.`);
    return false;
  }
  log(`Installing expo-dev-client into ${appDir} (expo install, not npm install — SDK-resolved version)...`);
  const expoBin = join(appDir, "node_modules", ".bin", "expo");
  const res = await sh(expoBin, ["install", "expo-dev-client"], { cwd: appDir, timeout: 5 * 60 * 1000 });
  if (res.code !== 0 || res.error) {
    throw new SkipError(`expo install expo-dev-client failed: ${res.error?.message ?? res.stderr.slice(0, 1000)}`);
  }
  log("expo-dev-client installed. Removing the stale ios/ directory so the next build regenerates it via expo prebuild (autolinking the new native module).");
  await rm(join(appDir, "ios"), { recursive: true, force: true });
  return true;
}

// decideStartPath (run.js) picks "reuse" vs "build" purely by asking the
// TARGET SIMULATOR whether the bundle id is already installed there — it has
// no idea the local ios/ directory just got invalidated above. Left alone,
// a simulator that already has the OLD (pre-dev-client) binary installed
// would report "installed" and `start` would reuse a build with no
// dev-launcher in it — silently defeating the whole point of
// ensureDevClient. Uninstalling the stale binary from the exact target this
// run will use forces a correct "not installed" -> build decision. Best
// effort: `simctl uninstall` on a bundle id that was never installed there
// exits non-zero, which is exactly the common/expected case and not an
// error worth failing the run over.
async function evictStaleInstall(target, bundleId) {
  const listRes = await sh("xcrun", ["simctl", "list", "devices", "--json"]);
  let udid = null;
  try {
    const parsed = JSON.parse(listRes.stdout);
    for (const devices of Object.values(parsed.devices ?? {})) {
      const match = devices.find((d) => d.name === target && d.isAvailable);
      if (match) {
        udid = match.udid;
        break;
      }
    }
  } catch {
    // fall through — best effort only
  }
  if (!udid) {
    log(`Could not resolve a UDID for simulator "${target}" to evict a stale install — proceeding anyway (decideStartPath will fall back to "build" if agent-device can't confirm an install either).`);
    return;
  }
  const res = await sh("xcrun", ["simctl", "uninstall", udid, bundleId]);
  if (res.code === 0) {
    log(`Evicted stale ${bundleId} install from "${target}" (${udid}) so this run rebuilds with the new native dependency.`);
  } else {
    log(`Nothing to evict for ${bundleId} on "${target}" (${udid}) — not previously installed there.`);
  }
}

// ---- known-issue workaround ------------------------------------------
//
// `expo-modules-jsi` — a transitive dependency of every Expo SDK 57 app,
// not specific to this scaffold — fails to compile on this machine's
// toolchain (Xcode 26.2 / Swift 6.2.3): `Coding/JavaScriptCodable+Date.swift`'s
// `abs(milliseconds) <= maxJavaScriptDateMilliseconds` guard is reported
// "ambiguous" by this exact Swift version even though every operand is an
// explicit `Double` — a real upstream/toolchain interaction, confirmed live
// during #136's own acceptance run (first attempt: `expo run:ios exited 1`),
// not a pack-expo defect, and outside this pack's adapter surface to fix at
// the source. Two one-line, purely type-disambiguating patches (no behavior
// change) unblock the build: hoist `abs(milliseconds)` into its own
// `Double`-typed local, and use `.magnitude` instead of the free-function
// `abs` (whose overload set is *also* ambiguous under this compiler — the
// first patch alone still failed, just one line lower). Applied
// defensively: only if the exact known-ambiguous text is still present, so
// a future expo-modules-jsi release that changes or fixes this file makes
// this a silent no-op rather than a crash.
async function patchKnownCompilerIssues(appDir) {
  const target = join(
    appDir,
    "node_modules",
    "expo-modules-jsi",
    "apple",
    "Sources",
    "ExpoModulesJSI",
    "Coding",
    "JavaScriptCodable+Date.swift"
  );
  if (!existsSync(target)) return; // not this SDK version — nothing to patch
  const text = await readFile(target, "utf8");
  const ambiguous = "  guard milliseconds.isFinite, abs(milliseconds) <= maxJavaScriptDateMilliseconds else {\n";
  const fixed =
    "  let magnitude: Double = milliseconds.magnitude\n" +
    "  guard milliseconds.isFinite, magnitude <= maxJavaScriptDateMilliseconds else {\n";
  if (!text.includes(ambiguous)) {
    log(`No known-issue patch needed for ${target} (already patched, or upstream text changed).`);
    return;
  }
  await writeFile(target, text.replace(ambiguous, fixed));
  log(`Applied known-issue workaround (ambiguous 'abs' comparison under Xcode 26.2/Swift 6.2.3) to ${target}`);
}

async function resolveAppDir() {
  if (APP_OVERRIDE) {
    log(`Using AGENTFLOW_ACCEPTANCE_APP override: ${APP_OVERRIDE}`);
    if (!existsSync(join(APP_OVERRIDE, "package.json"))) {
      throw new SkipError(`AGENTFLOW_ACCEPTANCE_APP=${APP_OVERRIDE} has no package.json`);
    }
    // Safe regardless of app: a no-op unless the exact known-ambiguous
    // upstream text is present (see patchKnownCompilerIssues below).
    await patchKnownCompilerIssues(APP_OVERRIDE);
    return APP_OVERRIDE;
  }

  const expoBin = join(APP_CACHE, "node_modules", ".bin", "expo");
  if (existsSync(expoBin)) {
    log(`Reusing cached scaffold at ${APP_CACHE} (set AGENTFLOW_ACCEPTANCE_APP_CACHE to a fresh path to force a rebuild)`);
  } else {
    log(`Scaffolding a fresh vanilla Expo app at ${APP_CACHE} (npx create-expo-app@latest, blank-typescript template)`);
    await mkdir(dirname(APP_CACHE), { recursive: true });
    await rm(APP_CACHE, { recursive: true, force: true });
    const res = await sh("npx", ["--yes", "create-expo-app@latest", APP_CACHE, "-t", "blank-typescript", "-y"], {
      timeout: 5 * 60 * 1000,
    });
    if (res.code !== 0 || res.error) {
      throw new SkipError(
        `create-expo-app failed (no network / registry unreachable?): ${res.error?.message ?? res.stderr.slice(0, 1000)}`
      );
    }
    log("Scaffold + npm install complete.");
  }

  await injectScreen(APP_CACHE);
  const devClientJustInstalled = await ensureDevClient(APP_CACHE);
  if (devClientJustInstalled) await evictStaleInstall(TARGET, BUNDLE_ID);
  await patchKnownCompilerIssues(APP_CACHE);
  return APP_CACHE;
}

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  log(`Evidence dir: ${EVIDENCE_DIR}`);
  log(`Target simulator: ${TARGET}; Metro port: ${METRO_PORT}`);
  if (APP_OVERRIDE) log(`App override: ${APP_OVERRIDE}`);

  await checkDescribe("run.js", "run");
  await checkDescribe("verify.js", "verify");
  await checkDescribe("execute-step.js", "execute-step");

  let appDir;
  try {
    appDir = await resolveAppDir();
  } catch (err) {
    if (err instanceof SkipError) {
      recordStage("provision", "skip", err.message);
      return finish(3);
    }
    throw err;
  }
  recordStage("provision", "pass", `app at ${appDir}`);

  let sessionId = null;
  try {
    // ---- start ----
    const startRes = await callAdapter("run.js", {
      op: "start",
      workspace: appDir,
      target: TARGET,
      env: { EXPO_METRO_PORT: METRO_PORT },
      evidence_dir: EVIDENCE_DIR,
    });
    log(`run start -> exit ${startRes.code}, stdout: ${startRes.stdout.trim()}`);
    if (![0, 10, 20].includes(startRes.code)) {
      record("contract", "start", `exit code ${startRes.code} is outside the documented 0/10/20 contract`);
      recordStage("start", "fail", `exit ${startRes.code}`);
      return finish(1);
    }
    if (startRes.parseError) {
      record("contract", "start", `stdout not JSON: ${startRes.parseError}`);
      recordStage("start", "fail");
      return finish(1);
    }
    if (startRes.code !== 0) {
      // A recoverable(10)/fatal(20) exit with a well-formed {error} body is
      // the adapter behaving exactly per interfaces/run.md ("a crashed
      // session is a recoverable failure (10)") — not a contract violation.
      // It does mean this run can't prove the rest of the chain, so the run
      // still fails overall, just not as an adapter-bug candidate.
      if (typeof startRes.parsed?.error !== "string" || !startRes.parsed.error) {
        record("contract", "start", `exit ${startRes.code} response missing a string "error" field: ${JSON.stringify(startRes.parsed)}`);
      }
      recordStage("start", "fail", `adapter correctly reported exit ${startRes.code}: ${startRes.parsed?.error ?? "(no message)"}`);
      return finish(2);
    }
    for (const field of ["session_id", "entry_point", "log_stream"]) {
      if (!startRes.parsed?.[field]) record("contract", "start", `response missing required field "${field}": ${JSON.stringify(startRes.parsed)}`);
    }
    sessionId = startRes.parsed.session_id ?? null;
    if (!sessionId) {
      recordStage("start", "fail", "no session_id returned");
      return finish(1);
    }
    recordStage("start", "pass", `session_id=${sessionId} entry_point=${startRes.parsed.entry_point}`);

    // ---- verify: snapshot (discovery), then act/read AFTER execute-step ----
    // execute-step's trace runs before verify's own `act(type)` so the two
    // stages can never interfere with each other (a keyboard left up by
    // `type` was an early hypothesis for a `get text` read coming back
    // empty during this investigation — ruled out live: an isolated
    // tap-tap-read with no `type` involved at all still read empty. The
    // real cause is #164, in execute-step.js itself, not this script's
    // ordering — see expo-dev.md's "known open bugs"). Keeping this
    // ordering anyway: it's a harmless, honest separation of concerns
    // between the two stages regardless, and this app's plain TextInput has
    // no submit/return control for agent-device's `keyboard dismiss` to
    // press if a dismiss were ever needed (confirmed live:
    // UNSUPPORTED_OPERATION, "Unable to dismiss the iOS keyboard without a
    // safe native dismiss control").
    // Tracked as two separate before/after deltas (snapshot now, act/read
    // later, after execute-step runs in between) rather than one span, so
    // execute-step's own violations — recorded on the very same shared
    // `results.violations` array — are never miscounted as "verify" stage
    // issues just because they happened to occur chronologically between
    // verify's two halves.
    const verifyCountBeforeSnapshot = results.violations.length;

    const snapRes = await callAdapter("verify.js", { op: "snapshot", session_id: sessionId, evidence_dir: EVIDENCE_DIR });
    log(`verify snapshot -> exit ${snapRes.code}`);
    let discoveredIds = [];
    if (snapRes.code !== 0 || snapRes.parseError || !Array.isArray(snapRes.parsed?.elements) || !snapRes.parsed?.screenshot) {
      record("contract", "verify:snapshot", `unexpected response: exit=${snapRes.code} parseError=${snapRes.parseError ?? "none"} body=${snapRes.stdout.slice(0, 1000)}`);
    } else {
      discoveredIds = snapRes.parsed.elements.map((e) => e.test_id).filter(Boolean);
      log(`snapshot elements test_ids: ${JSON.stringify(discoveredIds)}`);
      for (const want of ["acceptance-title", "acceptance-button", "acceptance-input"]) {
        if (!discoveredIds.includes(want)) record("assertion", "verify:snapshot", `expected testID "${want}" in snapshot elements, got ${JSON.stringify(discoveredIds)}`);
      }
    }
    const verifyIssuesFromSnapshot = results.violations.length - verifyCountBeforeSnapshot;

    // ---- execute-step: a hand-compiled 2-action / 2-assertion trace ----
    const trace = {
      actions: [
        { kind: "tap", selector: { test_id: "acceptance-button" } },
        { kind: "tap", selector: { test_id: "acceptance-button" } },
      ],
      assertions: [
        { kind: "visible", selector: { test_id: "acceptance-button" } },
        { kind: "text", selector: { test_id: "acceptance-count" }, contains: "2" },
      ],
    };
    const execRes = await callAdapter("execute-step.js", {
      op: "execute",
      session_id: sessionId,
      evidence_dir: EVIDENCE_DIR,
      step: { keyword: "when", text: "the learner taps the acceptance button twice" },
      trace,
    });
    log(`execute-step -> exit ${execRes.code}, body: ${execRes.stdout.trim()}`);
    if (![0, 10, 20].includes(execRes.code)) {
      record("contract", "execute-step", `exit code ${execRes.code} is outside the documented 0/10/20 contract`);
      recordStage("execute-step", "fail");
    } else if (execRes.code !== 0) {
      // Per interfaces/execute-step.md, 10/20 mean the driver/session broke —
      // infrastructure, not a scenario verdict (a step *failure* always exits
      // 0). Contract-conformant if the body is a well-formed {error} string;
      // still fails this run either way (the chain can't be proven further).
      if (typeof execRes.parsed?.error !== "string" || !execRes.parsed.error) {
        record("contract", "execute-step", `exit ${execRes.code} response missing a string "error" field: ${JSON.stringify(execRes.parsed)}`);
      }
      recordStage("execute-step", "fail", `adapter correctly reported exit ${execRes.code}: ${execRes.parsed?.error ?? "(no message)"}`);
    } else if (execRes.parseError) {
      record("contract", "execute-step", `stdout not JSON: ${execRes.parseError}`);
      recordStage("execute-step", "fail");
    } else if (execRes.parsed.status === "passed") {
      recordStage("execute-step", "pass", `duration_ms=${execRes.parsed.duration_ms}`);
    } else if (execRes.parsed.status === "failed") {
      record("assertion", "execute-step", JSON.stringify(execRes.parsed.failure));
      recordStage("execute-step", "step-failed", JSON.stringify(execRes.parsed.failure));
    } else {
      record("contract", "execute-step", `response has neither status:"passed" nor status:"failed": ${JSON.stringify(execRes.parsed)}`);
      recordStage("execute-step", "fail");
    }

    // ---- verify: act(type) + read — after execute-step, see the ordering
    // note above for why. Only attempted if the input testID was actually
    // discovered by the snapshot above (no point typing into a selector
    // that isn't there — that's already recorded as an assertion miss).
    const verifyCountBeforeActRead = results.violations.length;
    if (discoveredIds.includes("acceptance-input")) {
      const actRes = await callAdapter("verify.js", {
        op: "act",
        session_id: sessionId,
        evidence_dir: EVIDENCE_DIR,
        action: { kind: "type", selector: { test_id: "acceptance-input" }, text: "hello" },
      });
      log(`verify act(type) -> exit ${actRes.code}`);
      if (actRes.code !== 0 || actRes.parseError || actRes.parsed?.ok !== true || !actRes.parsed?.screenshot) {
        record("contract", "verify:act", `unexpected response: exit=${actRes.code} body=${actRes.stdout.slice(0, 1000)}`);
      }
    } else {
      log("Skipping verify act(type) — acceptance-input was not in the discovered snapshot elements.");
    }

    const readRes = await callAdapter("verify.js", { op: "read", session_id: sessionId, source: "app", tail: 50 });
    log(`verify read -> exit ${readRes.code}, ${Array.isArray(readRes.parsed?.lines) ? readRes.parsed.lines.length : "?"} lines`);
    if (readRes.code !== 0 || readRes.parseError || !Array.isArray(readRes.parsed?.lines)) {
      record("contract", "verify:read", `unexpected response: exit=${readRes.code} body=${readRes.stdout.slice(0, 1000)}`);
    }
    const verifyIssuesFromActRead = results.violations.length - verifyCountBeforeActRead;
    recordStage("verify", verifyIssuesFromSnapshot + verifyIssuesFromActRead === 0 ? "pass" : "fail");
  } finally {
    // Always stop what we started, pass or fail, so a bad run doesn't leak
    // Metro holding a port for the next one (see skills/expo-dev.md).
    if (sessionId) {
      const stopRes = await callAdapter("run.js", { op: "stop", session_id: sessionId });
      log(`run stop -> exit ${stopRes.code}, body: ${stopRes.stdout.trim()}`);
      if (stopRes.code !== 0 || stopRes.parsed?.state !== "stopped") {
        record("contract", "stop", `expected exit 0 + state:"stopped", got exit=${stopRes.code} body=${stopRes.stdout.slice(0, 1000)}`);
        recordStage("stop", "fail");
      } else {
        recordStage("stop", "pass");
      }
    } else {
      recordStage("stop", "skip", "no session was started");
    }
  }

  const hasContractViolation = results.violations.some((v) => v.kind === "contract");
  const hasAssertionMiss = results.violations.some((v) => v.kind === "assertion");
  return finish(hasContractViolation ? 1 : hasAssertionMiss ? 2 : 0);
}

async function finish(exitCode) {
  await writeFile(join(EVIDENCE_DIR, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  await writeFile(join(EVIDENCE_DIR, "transcript.log"), `${transcriptLines.join("\n")}\n`);
  log(`Done. exit=${exitCode} contract_violations=${results.violations.filter((v) => v.kind === "contract").length} assertion_misses=${results.violations.filter((v) => v.kind === "assertion").length}`);
  log(`Evidence + results.json + transcript.log: ${EVIDENCE_DIR}`);
  process.exitCode = exitCode;
}

main().catch(async (err) => {
  log(`UNCAUGHT: ${err.stack || err.message}`);
  results.violations.push({ kind: "contract", stage: "script", message: err.message });
  await finish(1);
});
