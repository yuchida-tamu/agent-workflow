import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  translateSelector,
  translateRef,
  invoke,
  rawInvoke,
  openSession,
  closeSession,
  listApps,
  normalizeAppEntry,
  unwrap,
  AgentDeviceError,
} from "../lib/agent-device.js";

function fakeRunner(script) {
  const calls = [];
  return {
    calls,
    exec: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return script(cmd, args, opts);
    },
  };
}

test("translateSelector: fixed order test_id -> label -> text (determinism guarantee)", () => {
  assert.equal(translateSelector({ test_id: "checkout-cta" }), 'id="checkout-cta"');
  assert.equal(translateSelector({ label: "Checkout" }), 'label="Checkout"');
  assert.equal(translateSelector({ text: "Checkout" }), 'text="Checkout"');
  // test_id wins even if other keys are also present
  assert.equal(translateSelector({ test_id: "a", label: "b", text: "c" }), 'id="a"');
  assert.equal(translateSelector({ label: "b", text: "c" }), 'label="b"');
});

test("translateSelector: escapes embedded double quotes", () => {
  assert.equal(translateSelector({ label: 'Don"t leave' }), 'label="Don\\"t leave"');
});

test("translateSelector: rejects a selector with none of the known keys", () => {
  assert.throws(() => translateSelector({}), TypeError);
  assert.throws(() => translateSelector(null), TypeError);
});

test("invoke: appends --json and parses stdout", async () => {
  const runner = fakeRunner(() => ({ code: 0, stdout: '{"ok":true}', stderr: "" }));
  const result = await invoke(["open", "MyApp"], { runner });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(runner.calls[0].args, ["open", "MyApp", "--json"]);
});

test("invoke: non-zero exit raises AgentDeviceError with stderr context", async () => {
  const runner = fakeRunner(() => ({ code: 1, stdout: "", stderr: "device not found" }));
  await assert.rejects(() => invoke(["open", "MyApp"], { runner }), (err) => {
    assert.ok(err instanceof AgentDeviceError);
    assert.match(err.message, /device not found/);
    assert.equal(err.code, 1);
    return true;
  });
});

test("invoke: a spawn-level error (missing binary) also raises AgentDeviceError", async () => {
  const runner = fakeRunner(() => ({ code: 1, stdout: "", stderr: "", error: new Error("ENOENT") }));
  await assert.rejects(() => invoke(["open"], { runner }), AgentDeviceError);
});

test("invoke: invalid JSON on stdout raises AgentDeviceError", async () => {
  const runner = fakeRunner(() => ({ code: 0, stdout: "not json", stderr: "" }));
  await assert.rejects(() => invoke(["snapshot"], { runner }), AgentDeviceError);
});

// ---- invoke: unwraps by default (#164, the structural fix) ---------------
//
// #142/#158/#164 were the same root cause in three different adapters: a
// live `agent-device <cmd> --json` reply is enveloped `{success, data:{...}}`,
// and each adapter forgot to unwrap it at its own call site. Moving the
// unwrap into `invoke()` itself — the one chokepoint every caller already
// goes through — means there is no raw envelope left for a future caller to
// forget to unwrap. These pin the exact shapes from #164's own live repro
// (issue body) and PR #159 (acceptance transcript).

test("invoke: unwraps the {success,data} envelope by default — exact `get text` payload from #164", async () => {
  const runner = fakeRunner(() => ({
    code: 0,
    stdout: JSON.stringify({
      success: true,
      data: { selector: 'id="acceptance-count"', text: "Tapped: 2", node: { ref: "e5" } },
    }),
    stderr: "",
  }));
  const result = await invoke(["get", "text", 'id="acceptance-count"'], { runner });
  assert.deepEqual(result, { selector: 'id="acceptance-count"', text: "Tapped: 2", node: { ref: "e5" } });
});

test("invoke: a bare/unenveloped body (no .data) passes through untouched", async () => {
  const runner = fakeRunner(() => ({ code: 0, stdout: '{"ok":true}', stderr: "" }));
  assert.deepEqual(await invoke(["open", "MyApp"], { runner }), { ok: true });
});

test("invoke: success:false in the body raises AgentDeviceError even at exit 0 (daemon-level failure, not a process failure)", async () => {
  const runner = fakeRunner(() => ({
    code: 0,
    stdout: JSON.stringify({ success: false, error: { code: "COMMAND_FAILED", message: "no visible effect" } }),
    stderr: "",
  }));
  await assert.rejects(() => invoke(["is", "visible", 'id="x"'], { runner }), (err) => {
    assert.ok(err instanceof AgentDeviceError);
    assert.match(err.message, /COMMAND_FAILED: no visible effect/);
    return true;
  });
});

test("invoke: json:false still returns raw stdout, bypassing unwrap entirely", async () => {
  const runner = fakeRunner(() => ({ code: 0, stdout: "not json at all", stderr: "" }));
  const result = await invoke(["screenshot", "--out", "/tmp/x.png"], { runner, json: false });
  assert.deepEqual(result, { raw: "not json at all" });
});

// ---- rawInvoke: the explicit, named opt-out -------------------------------

test("rawInvoke: returns the FULL envelope unexamined, even a success:true body", async () => {
  const runner = fakeRunner(() => ({
    code: 0,
    stdout: JSON.stringify({ success: true, data: { apps: ["com.example.app"] } }),
    stderr: "",
  }));
  const result = await rawInvoke(["apps"], { runner });
  assert.deepEqual(result, { success: true, data: { apps: ["com.example.app"] } });
});

test("rawInvoke: does NOT throw on a success:false body at exit 0 — that's `invoke()`'s job, not this one's", async () => {
  const runner = fakeRunner(() => ({
    code: 0,
    stdout: JSON.stringify({ success: false, error: { code: "COMMAND_FAILED", message: "no visible effect" } }),
    stderr: "",
  }));
  const result = await rawInvoke(["is", "visible", 'id="x"'], { runner });
  assert.deepEqual(result, { success: false, error: { code: "COMMAND_FAILED", message: "no visible effect" } });
});

test("rawInvoke: still throws on a non-zero exit / spawn failure, same as invoke()", async () => {
  const runner = fakeRunner(() => ({ code: 1, stdout: "", stderr: "device not found" }));
  await assert.rejects(() => rawInvoke(["open", "MyApp"], { runner }), AgentDeviceError);
});

// A live `agent-device is visible|hidden <selector> --json` reply against a
// real booted iOS simulator (confirmed during this #164 audit, agent-device
// 0.19.3): success is `{success:true, data:{predicate,pass,selector}}` at
// exit 0; EVERY failure mode (predicate false, selector not found, even a
// malformed predicate name) comes back `{success:false, error:{...}}` at a
// NON-zero exit — never `success:true` with `pass:false`, and never
// `success:false` at exit 0 either. This is why `assertVisible`
// (execute-step.js) can correctly treat "the invoke didn't throw" as the
// entire assertion, with no `.data` read needed — unlike `assertText`,
// there is no data-bearing field this command's real behavior requires.
test("invoke: real `is visible` success shape unwraps to {predicate, pass, selector}", async () => {
  const runner = fakeRunner(() => ({
    code: 0,
    stdout: JSON.stringify({ success: true, data: { predicate: "visible", pass: true, selector: 'label="Home"' } }),
    stderr: "",
  }));
  const result = await invoke(["is", "visible", 'label="Home"'], { runner });
  assert.deepEqual(result, { predicate: "visible", pass: true, selector: 'label="Home"' });
});

test("openSession: builds the documented `open <app> <url> --platform --device --session` shape", async () => {
  const runner = fakeRunner(() => ({ code: 0, stdout: "{}", stderr: "" }));
  await openSession({
    app: "com.example.app",
    url: "exp://127.0.0.1:8081",
    platform: "ios",
    device: "iPhone 15",
    session: "agentflow-run-sess-1",
    runner,
  });
  assert.deepEqual(runner.calls[0].args, [
    "open",
    "com.example.app",
    "exp://127.0.0.1:8081",
    "--platform",
    "ios",
    "--device",
    "iPhone 15",
    "--session",
    "agentflow-run-sess-1",
    "--json",
  ]);
});

test("closeSession: adds --shutdown only when requested", async () => {
  const runner = fakeRunner(() => ({ code: 0, stdout: "{}", stderr: "" }));
  await closeSession({ session: "s1", runner });
  assert.ok(!runner.calls[0].args.includes("--shutdown"));
  await closeSession({ session: "s1", shutdown: true, runner });
  assert.ok(runner.calls[1].args.includes("--shutdown"));
});

// ---- openSession/closeSession go through invoke()'s default unwrap ------
// (#139, pinning #165: both used to return `invoke()`'s value raw, which
// was harmless only because every caller discarded the body or reacted
// solely to the throw — see lib/agent-device.js's file header, "blast
// radius considered". #165 made `invoke()` unwrap the {success,data}
// envelope by default at the one chokepoint every caller (including these
// two) already goes through, which structurally closes the #134-class
// "return the raw envelope, let a caller forget to unwrap it" defect for
// openSession/closeSession too — even though nothing here reads their
// return value today. These pin that it actually holds, not just that it
// happens to compile, so a future caller that DOES start reading the body
// gets the unwrapped shape for free instead of reintroducing #134's bug.)

test("openSession: returns invoke()'s unwrapped payload, not the raw {success,data} envelope", async () => {
  const runner = fakeRunner(() => ({
    code: 0,
    stdout: JSON.stringify({ success: true, data: { session: "agentflow-run-sess-1", pid: 4242 } }),
    stderr: "",
  }));
  const result = await openSession({ app: "com.example.app", session: "agentflow-run-sess-1", runner });
  assert.deepEqual(result, { session: "agentflow-run-sess-1", pid: 4242 });
});

test("openSession: a success:false body at exit 0 throws AgentDeviceError — a daemon-level open failure is never silently accepted", async () => {
  const runner = fakeRunner(() => ({
    code: 0,
    stdout: JSON.stringify({ success: false, error: { code: "DEVICE_NOT_FOUND", message: "no booted device" } }),
    stderr: "",
  }));
  await assert.rejects(
    () => openSession({ app: "com.example.app", session: "s1", runner }),
    (err) => {
      assert.ok(err instanceof AgentDeviceError);
      assert.match(err.message, /DEVICE_NOT_FOUND/);
      return true;
    }
  );
});

test("closeSession: returns invoke()'s unwrapped payload, not the raw {success,data} envelope", async () => {
  const runner = fakeRunner(() => ({
    code: 0,
    stdout: JSON.stringify({ success: true, data: { closed: true } }),
    stderr: "",
  }));
  const result = await closeSession({ session: "s1", runner });
  assert.deepEqual(result, { closed: true });
});

test("closeSession: a success:false body at exit 0 throws AgentDeviceError, same as any other invoke() caller", async () => {
  const runner = fakeRunner(() => ({
    code: 0,
    stdout: JSON.stringify({ success: false, error: { code: "SESSION_NOT_FOUND", message: "no such session" } }),
    stderr: "",
  }));
  await assert.rejects(
    () => closeSession({ session: "s1", runner }),
    (err) => {
      assert.ok(err instanceof AgentDeviceError);
      assert.match(err.message, /SESSION_NOT_FOUND/);
      return true;
    }
  );
});

test("translateRef: adds the CLI's required @ prefix to a bare snapshot ref", () => {
  assert.equal(translateRef("e12"), "@e12");
});

test("translateRef: idempotent when the ref already carries @", () => {
  assert.equal(translateRef("@e12"), "@e12");
});

test("translateRef: rejects a non-string / empty ref", () => {
  assert.throws(() => translateRef(""), TypeError);
  assert.throws(() => translateRef(null), TypeError);
  assert.throws(() => translateRef(42), TypeError);
});

test("listApps: scopes to platform/device for the install-check", async () => {
  const runner = fakeRunner(() => ({ code: 0, stdout: '{"success":true,"data":{"apps":[]}}', stderr: "" }));
  await listApps({ platform: "ios", device: "iPhone 15", runner });
  assert.deepEqual(runner.calls[0].args, ["apps", "--platform", "ios", "--device", "iPhone 15", "--json"]);
});

// #142: the real `agent-device apps --json` payload is enveloped
// `{success, data:{apps:[...]}}`, not a bare array — decideStartPath used to
// read `apps?.apps` straight off that envelope (finding nothing) instead of
// off listApps's return value, so the installed-dev-client check never
// fired and every session start paid a full `expo run:ios` build.
test("listApps: unwraps the real {success, data:{apps}} envelope to the bare array", async () => {
  const runner = fakeRunner(() => ({
    code: 0,
    stdout: JSON.stringify({ success: true, data: { apps: ["com.example.app"] } }),
    stderr: "",
  }));
  const apps = await listApps({ platform: "ios", device: "iPhone 15", runner });
  assert.deepEqual(apps, ["com.example.app"]);
});

test("listApps: success:false in the body is an error even at exit 0", async () => {
  const runner = fakeRunner(() => ({
    code: 0,
    stdout: JSON.stringify({ success: false, error: { code: "DEVICE_NOT_FOUND", message: "no such device" } }),
    stderr: "",
  }));
  await assert.rejects(() => listApps({ platform: "ios", device: "iPhone 15", runner }), (err) => {
    assert.ok(err instanceof AgentDeviceError);
    assert.match(err.message, /DEVICE_NOT_FOUND/);
    return true;
  });
});

// Tolerance for a bare/legacy array response (no envelope) — cheap to keep
// supporting since `unwrap` already passes a shape with no `.data` through
// untouched.
test("listApps: tolerates a legacy unenveloped array response", async () => {
  const runner = fakeRunner(() => ({ code: 0, stdout: '["com.example.app"]', stderr: "" }));
  const apps = await listApps({ platform: "ios", device: "iPhone 15", runner });
  assert.deepEqual(apps, ["com.example.app"]);
});

// #158: a live `agent-device apps --json` (0.19.3) entry is a display
// string, not a bare bundle id — this is the EXACT payload quoted in #158
// against a real session (`agent-device apps --platform ios --device
// "iPhone 15 Pro" --json`). decideStartPath compares list entries against a
// bare bundleId, so `"app (dev.agentflow.acceptance)" === "dev.agentflow.acceptance"`
// was always false — the reuse fast-path could never fire against a real
// device. Fixed by normalizing at listApps, once, at the source.
test("listApps: normalizes real 'Name (bundle.id)' entries to bare bundle ids (#158, exact observed payload)", async () => {
  const runner = fakeRunner(() => ({
    code: 0,
    stdout: JSON.stringify({
      success: true,
      data: {
        apps: [
          "gymtomo (org.reactjs.native.example.gymtomo)",
          "app (dev.agentflow.acceptance)",
          "Expo Go (host.exp.Exponent)",
        ],
      },
    }),
    stderr: "",
  }));
  const apps = await listApps({ platform: "ios", device: "iPhone 15 Pro", runner });
  assert.deepEqual(apps, [
    "org.reactjs.native.example.gymtomo",
    "dev.agentflow.acceptance",
    "host.exp.Exponent",
  ]);
});

test("normalizeAppEntry: extracts the parenthesized bundle id from a display string", () => {
  assert.equal(normalizeAppEntry("app (dev.agentflow.acceptance)"), "dev.agentflow.acceptance");
  assert.equal(normalizeAppEntry("Expo Go (host.exp.Exponent)"), "host.exp.Exponent");
});

test("normalizeAppEntry: tolerates a plain-string id with no parenthesized tail (legacy/synthetic shape)", () => {
  assert.equal(normalizeAppEntry("com.example.app"), "com.example.app");
});

test("normalizeAppEntry: leaves object entries ({id,...}/{bundleId,...}) untouched", () => {
  assert.deepEqual(normalizeAppEntry({ id: "com.example.app" }), { id: "com.example.app" });
  assert.deepEqual(normalizeAppEntry({ bundleId: "com.example.app" }), { bundleId: "com.example.app" });
});

test("unwrap: pulls .data out of the {success,data} envelope", () => {
  assert.deepEqual(unwrap({ success: true, data: { apps: [] } }), { apps: [] });
});

test("unwrap: passes through a shape with no .data untouched", () => {
  assert.deepEqual(unwrap({ apps: [] }), { apps: [] });
  assert.equal(unwrap(null), null);
});

test("unwrap: success:false is an error even at exit 0 — never silently yields empty data", () => {
  assert.throws(
    () => unwrap({ success: false, error: { code: "COMMAND_FAILED", message: "no visible effect" } }),
    (err) => {
      assert.ok(err instanceof AgentDeviceError);
      assert.match(err.message, /COMMAND_FAILED: no visible effect/);
      return true;
    }
  );
});

// ---- family regression guard: no adapter touches a raw envelope ----------
//
// #142, #158, and #164 were the same defect class recurring in three
// different adapter files, each time because a call site read a raw
// `{success, data}` envelope (or forgot `unwrap`) instead of going through
// the one chokepoint that now guarantees it can't. This is a static guard
// against the *mechanism* regressing, not just the three known symptoms:
// with `invoke()` unwrapping by default (see this file's header), the only
// way an adapter outside lib/ could get back to touching a raw envelope is
// to (a) opt out via the explicit `rawInvoke()` escape hatch, (b) redefine
// its own local `unwrap`-shaped helper (exactly what verify.js used to do,
// byte-for-byte duplicated from this file, until this sweep consolidated
// it), or (c) reach into `.data` on a result by hand. Source-slice style
// matches this repo's existing convention for cross-file invariants (see
// test/agents.test.js's installed-copy/autonomy-section checks).
//
// Comments are stripped before matching (rather than parsed properly — this
// is a grep-based guard, not a linter) specifically so this file's own
// prose about `res.data.text` (see execute-step.js's `extractText` comment)
// can't trip the very check it documents.
const ADAPTERS_DIR = dirname(fileURLToPath(import.meta.url)) + "/..";
const ADAPTER_ENTRYPOINTS = ["execute-step.js", "run.js", "verify.js"];

function stripComments(source) {
  return source
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

for (const file of ADAPTER_ENTRYPOINTS) {
  test(`family regression guard: ${file} never touches a raw agent-device envelope`, () => {
    const code = stripComments(readFileSync(join(ADAPTERS_DIR, file), "utf8"));

    assert.ok(!/\brawInvoke\s*\(/.test(code), `${file} calls rawInvoke() — nothing in this pack needs the raw envelope; if it genuinely does now, document why here rather than reading .data by hand`);

    assert.ok(!/\bfunction\s+unwrap\s*\(/.test(code) && !/\bconst\s+unwrap\s*=/.test(code), `${file} defines its own unwrap-shaped helper instead of importing lib/agent-device.js's — this is exactly the duplication #164's sweep removed from verify.js`);

    assert.ok(!/\.data\b/.test(code), `${file} reads .data directly off a result — the envelope should already be unwrapped by lib/agent-device.js's invoke() before it ever reaches an adapter`);
  });
}
