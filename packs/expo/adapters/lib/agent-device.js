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

// A response from `agent-device <cmd> --json` is enveloped as
// `{success, data: {...}}` (confirmed against a live 0.19.3 session — e.g.
// `apps --json` -> `{success:true, data:{apps:[...]}}`). `invoke()` below
// returns the whole parsed body, not just `data` — this unwraps it, falling
// back to the raw value for a shape that doesn't carry `data` (defensive,
// and also what lets a bare/legacy array response pass through untouched).
//
// `invoke()` only inspects the process exit code — it has no opinion on the
// body. If agent-device ever exits 0 while its own body says
// `{success:false, error:{...}}` (a daemon-level "the command didn't really
// work" that doesn't surface as a process failure), silently returning
// `undefined` data here would look like "nothing observed" rather than the
// actual failure it is (see #134's review, which found the same shape in
// verify.js). Treat that shape as an error too: throw the same
// `AgentDeviceError` a non-zero exit would have produced, carrying the
// body's own error detail.
export function unwrap(result) {
  if (result && typeof result === "object" && result.success === false) {
    const error = result.error && typeof result.error === "object" ? result.error : {};
    const detail = error.message ? `${error.code ? `${error.code}: ` : ""}${error.message}` : "no error detail in body";
    throw new AgentDeviceError(`agent-device reported success:false despite exit 0: ${detail}`, {
      code: 0,
      stdout: JSON.stringify(result),
    });
  }
  return result && typeof result === "object" && "data" in result ? result.data : result;
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

// A live `agent-device apps --json` (0.19.3) entry is a display string, not
// a bare bundle id — e.g. `"app (dev.agentflow.acceptance)"` (confirmed
// against a real session, see #158):
//
//   {"success":true,"data":{"apps":[
//     "gymtomo (org.reactjs.native.example.gymtomo)",
//     "app (dev.agentflow.acceptance)",
//     "Expo Go (host.exp.Exponent)"
//   ]}}
//
// `decideStartPath` compares this array against a bare bundleId, so a raw
// `"Name (bundle.id)"` string can never match — the reuse fast-path silently
// never fires (#158). Extract the parenthesized bundle id here, once, at the
// source of the array, rather than pushing that parsing onto every caller.
// Tolerates entries that are already bare ids (no trailing `(...)` — the
// legacy/synthetic shape this module's own tests and #142's fix used) and
// object entries ({id,...}/{bundleId,...}), both left untouched since
// `decideStartPath`'s own matching already understands those shapes.
export function normalizeAppEntry(entry) {
  if (typeof entry !== "string") return entry;
  const match = entry.match(/\(([^()]+)\)\s*$/);
  return match ? match[1] : entry;
}

// `agent-device apps [--all] --platform <p> --device <d>` — used by `run`'s
// start-path decision: is the dev client already installed on the target sim?
// Returns the bare apps array: the real payload is enveloped
// `{success, data:{apps:[...]}}` (see `unwrap` above), so this resolves
// `data.apps` itself rather than pushing that unwrapping onto every caller —
// `decideStartPath` was the one caller that got this wrong (#142), reading
// `apps?.apps` against the raw envelope, which never finds the array and
// silently defeats the reuse path on every run.
export async function listApps({ platform = "ios", device, session, all = false, runner } = {}) {
  const args = ["apps"];
  if (all) args.push("--all");
  if (platform) args.push("--platform", platform);
  if (device) args.push("--device", device);
  if (session) args.push("--session", session);
  const result = await invoke(args, { runner });
  const data = unwrap(result);
  const apps = Array.isArray(data) ? data : (data?.apps ?? []);
  return apps.map(normalizeAppEntry);
}

export function listDevices({ runner } = {}) {
  return invoke(["devices"], { runner });
}

export function listSessions({ runner } = {}) {
  return invoke(["session", "list"], { runner });
}
