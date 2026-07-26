// contract.js — the shared executable contract every pack-expo adapter speaks:
// JSON on stdin, JSON on stdout, diagnostics on stderr, exit 0/10/20.
// See interfaces/README.md. Introduced by #133 (`run`); reused as-is by
// #134 (`verify`) and #135 (`execute-step`) — do not fork it per adapter.

export const EXIT_OK = 0;
export const EXIT_RECOVERABLE = 10; // core's bounded-retry scripts may re-invoke
export const EXIT_FATAL = 20; // escalate, do not retry

const KNOWN_CODES = new Set([EXIT_RECOVERABLE, EXIT_FATAL]);

// An error an adapter op can throw to control the process exit code. Anything
// else thrown (a bug) is treated as EXIT_FATAL by runMain, same as an explicit
// fatal() — a coding error is not something a retry can fix either.
export class AdapterError extends Error {
  constructor(message, { code = EXIT_FATAL, cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "AdapterError";
    this.code = KNOWN_CODES.has(code) ? code : EXIT_FATAL;
  }
}

export function recoverable(message, opts = {}) {
  return new AdapterError(message, { ...opts, code: EXIT_RECOVERABLE });
}

export function fatal(message, opts = {}) {
  return new AdapterError(message, { ...opts, code: EXIT_FATAL });
}

// Reads the whole stream and parses it as one JSON object. Adapters take
// exactly one request object per invocation — no streaming, no NDJSON.
export async function readStdinJSON(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw fatal("empty stdin: expected one JSON object with an \"op\" field");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw fatal(`invalid JSON on stdin: ${err.message}`, { cause: err });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw fatal("stdin must be a single JSON object");
  }
  return parsed;
}

export function writeStdout(obj, stream) {
  stream.write(`${JSON.stringify(obj)}\n`);
}

export function diagnostic(message, stream) {
  stream.write(`${message}\n`);
}

// {"op":"describe"} -> {"interface": name, "interface_version": version}.
// `interface` is the adapter's own name ("run" / "verify" / "execute-step"),
// not the pack's.
export function describeResponse(interfaceName, version = "1") {
  return { interface: interfaceName, interface_version: version };
}

// Wires a map of { op: async (request) => responseObject } handlers to real
// stdin/stdout/stderr and process.exit, with the `describe` op always
// answered automatically (handlers never need to implement it themselves).
// Every dependency is injectable so tests can drive this without a child
// process or the exit call actually terminating the test runner.
export async function runMain({
  interfaceName,
  interfaceVersion = "1",
  handlers,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  exit = process.exit,
}) {
  let request;
  try {
    request = await readStdinJSON(stdin);
  } catch (err) {
    return fail(err, stdout, stderr, exit);
  }

  const op = request.op;
  if (op === "describe") {
    writeStdout(describeResponse(interfaceName, interfaceVersion), stdout);
    return exit(EXIT_OK);
  }

  const handler = handlers?.[op];
  if (typeof handler !== "function") {
    return fail(fatal(`unknown op: ${JSON.stringify(op)}`), stdout, stderr, exit);
  }

  try {
    const response = await handler(request);
    writeStdout(response, stdout);
    return exit(EXIT_OK);
  } catch (err) {
    return fail(err, stdout, stderr, exit);
  }
}

function fail(err, stdout, stderr, exit) {
  const code = err instanceof AdapterError ? err.code : EXIT_FATAL;
  const message = err && err.message ? err.message : String(err);
  diagnostic(err && err.stack ? err.stack : message, stderr);
  writeStdout({ error: message }, stdout);
  return exit(code);
}
