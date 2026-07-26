import { test } from "node:test";
import assert from "node:assert/strict";
import {
  translateSelector,
  translateRef,
  invoke,
  openSession,
  closeSession,
  listApps,
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
  const runner = fakeRunner(() => ({ code: 0, stdout: "[]", stderr: "" }));
  await listApps({ platform: "ios", device: "iPhone 15", runner });
  assert.deepEqual(runner.calls[0].args, ["apps", "--platform", "ios", "--device", "iPhone 15", "--json"]);
});
