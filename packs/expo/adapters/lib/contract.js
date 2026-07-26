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
//
// A top-level `uncaughtException`/`unhandledRejection` net is installed on
// `errorSource` (the real `process` by default) for the duration of this
// call: a handler that fires-and-forgets a rejecting promise, or any other
// genuinely uncaught throw, would otherwise crash the process with a bare
// stack trace on stderr and *nothing* on stdout — core's retry scripts
// expect exit 0/10/20 with a JSON body on every path, including a crash
// path. `errorSource` is injectable — separately from `exit` et al. —
// specifically so tests can simulate one of these events (`errorSource.emit(...)`)
// without raising a *real* process-level uncaughtException, which the test
// runner's own crash detection would otherwise attribute to the test itself
// regardless of this net. `settleOnce` guards every exit path (including the
// net) so a race between the net and the handler's own completion can never
// produce two responses. The net is torn down again once this invocation
// settles, so it never leaks a listener into whatever calls runMain next
// (tests call it many times in one process).
export async function runMain({
  interfaceName,
  interfaceVersion = "1",
  handlers,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  exit = process.exit,
  errorSource = process,
}) {
  let settled = false;
  const settleOnce = (fn) => {
    if (settled) return;
    settled = true;
    fn();
  };
  const onUncaught = (err) => settleOnce(() => fail(err, stdout, stderr, exit));
  errorSource.on("uncaughtException", onUncaught);
  errorSource.on("unhandledRejection", onUncaught);

  try {
    let request;
    try {
      request = await readStdinJSON(stdin);
    } catch (err) {
      settleOnce(() => fail(err, stdout, stderr, exit));
      return;
    }

    const op = request.op;
    if (op === "describe") {
      settleOnce(() => {
        writeStdout(describeResponse(interfaceName, interfaceVersion), stdout);
        exit(EXIT_OK);
      });
      return;
    }

    const handler = handlers?.[op];
    if (typeof handler !== "function") {
      settleOnce(() => fail(fatal(`unknown op: ${JSON.stringify(op)}`), stdout, stderr, exit));
      return;
    }

    try {
      const response = await handler(request);
      settleOnce(() => {
        writeStdout(response, stdout);
        exit(EXIT_OK);
      });
    } catch (err) {
      settleOnce(() => fail(err, stdout, stderr, exit));
    }
  } finally {
    errorSource.off("uncaughtException", onUncaught);
    errorSource.off("unhandledRejection", onUncaught);
  }
}

function fail(err, stdout, stderr, exit) {
  const code = err instanceof AdapterError ? err.code : EXIT_FATAL;
  const message = err && err.message ? err.message : String(err);
  diagnostic(err && err.stack ? err.stack : message, stderr);
  writeStdout({ error: message }, stdout);
  return exit(code);
}
