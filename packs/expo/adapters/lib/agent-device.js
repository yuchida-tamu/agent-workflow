// agent-device.js — thin wrapper around the `agent-device` CLI (v0.19.3+):
// shells out with `--json`, parses the result, and centralises the fixed
// selector-translation order the whole run/verify/execute-step surface
// shares. Introduced by #133; #134 and #135 build directly on `invoke` and
// `translateSelector`.
//
// Every process-spawning call goes through an injected `runner` so tests can
// drive this module without a real agent-device / simulator (none is
// available in CI — see interfaces/README.md and #132's capability probe).

import { defaultRunner } from "./proc.js";

// Re-exported so callers that only touch agent-device don't need to know
// about proc.js — same `{code, stdout, stderr, error}` runner shape used by
// every process-spawning module in this lib.
export { defaultRunner };

// Fixed resolution order the whole contract relies on for determinism:
// test_id -> accessibility label -> visible text. See interfaces/verify.md
// "Selector contract" and execute-step.md.
export function translateSelector(selector) {
  if (!selector || typeof selector !== "object") {
    throw new TypeError("selector must be an object with test_id, label, or text");
  }
  if (selector.test_id !== undefined) return `id=${quote(selector.test_id)}`;
  if (selector.label !== undefined) return `label=${quote(selector.label)}`;
  if (selector.text !== undefined) return `text=${quote(selector.text)}`;
  throw new TypeError("selector must set one of test_id, label, or text");
}

function quote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

// Snapshot refs travel through the contract bare ("e12" — see
// interfaces/verify.md's snapshot example and a live agent-device 0.19.3
// `snapshot -i --json` response, where the `ref` field is likewise bare),
// but the CLI itself requires the "@" prefix to tell a ref apart from a
// literal string/selector: `agent-device press e12` fails with
// `INVALID_ARGS: Did you mean "@e12"? Snapshot refs need the @ prefix.`
// against a real session. Both #134 (verify) and #135 (execute-step, which
// replays refs recorded in a compiled trace) need this identical
// translation, so it lives beside `translateSelector` rather than being
// duplicated per adapter. Idempotent: a ref that already carries "@" (e.g.
// forwarded verbatim from a snapshot response) is left as-is.
export function translateRef(ref) {
  if (!ref || typeof ref !== "string") {
    throw new TypeError("ref must be a non-empty string");
  }
  return ref.startsWith("@") ? ref : `@${ref}`;
}

export class AgentDeviceError extends Error {
  constructor(message, { command, code, stderr, stdout } = {}) {
    super(message);
    this.name = "AgentDeviceError";
    this.command = command;
    this.code = code;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

// Runs `agent-device <...args> --json` (unless json:false) and parses stdout.
export async function invoke(args, { runner = defaultRunner, json = true, cwd, env, bin = "agent-device" } = {}) {
  const fullArgs = json ? [...args, "--json"] : [...args];
  const result = await runner.exec(bin, fullArgs, { cwd, env });
  const command = [bin, ...fullArgs].join(" ");
  if (result.error) {
    throw new AgentDeviceError(`${command}: ${result.error.message}`, { command, code: result.code });
  }
  if (result.code !== 0) {
    throw new AgentDeviceError(
      `${command} exited ${result.code}: ${(result.stderr || result.stdout || "").trim().slice(0, 500)}`,
      { command, code: result.code, stderr: result.stderr, stdout: result.stdout }
    );
  }
  if (!json) return { raw: result.stdout };
  const trimmed = result.stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new AgentDeviceError(`${command}: could not parse JSON output: ${err.message}`, {
      command,
      code: result.code,
      stdout: result.stdout,
    });
  }
}

// `agent-device open [app] [url] --platform <p> --device <d> --session <s>
// [--relaunch] [--launch-console <path>]` — boots the simulator if needed and
// launches the app / deep link. See `agent-device help react-native`.
export function openSession({ app, url, platform = "ios", device, session, relaunch = false, launchConsole, runner } = {}) {
  const args = ["open"];
  if (app) args.push(app);
  if (url) args.push(url);
  if (platform) args.push("--platform", platform);
  if (device) args.push("--device", device);
  if (session) args.push("--session", session);
  if (relaunch) args.push("--relaunch");
  if (launchConsole) args.push("--launch-console", launchConsole);
  return invoke(args, { runner });
}

// `agent-device close [app] --session <s> [--shutdown]`
export function closeSession({ app, platform = "ios", device, session, shutdown = false, runner } = {}) {
  const args = ["close"];
  if (app) args.push(app);
  if (platform) args.push("--platform", platform);
  if (device) args.push("--device", device);
  if (session) args.push("--session", session);
  if (shutdown) args.push("--shutdown");
  return invoke(args, { runner });
}

// `agent-device apps [--all] --platform <p> --device <d>` — used by `run`'s
// start-path decision: is the dev client already installed on the target sim?
export function listApps({ platform = "ios", device, session, all = false, runner } = {}) {
  const args = ["apps"];
  if (all) args.push("--all");
  if (platform) args.push("--platform", platform);
  if (device) args.push("--device", device);
  if (session) args.push("--session", session);
  return invoke(args, { runner });
}

export function listDevices({ runner } = {}) {
  return invoke(["devices"], { runner });
}

export function listSessions({ runner } = {}) {
  return invoke(["session", "list"], { runner });
}
