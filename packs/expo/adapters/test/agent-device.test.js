import { test } from "node:test";
import assert from "node:assert/strict";
import {
  translateSelector,
  translateRef,
  invoke,
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
