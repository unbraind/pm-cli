/**
 * Worker-thread side of the synchronous CLI bridge used by the test suite.
 *
 * Imports the built `dist/cli/main.js` bundle exactly once per worker and then
 * executes every requested CLI invocation in-process: apply the caller's
 * environment, patch `process.argv` and the stdio writers, run `runPmCli`,
 * and post the captured result back over the per-call `MessagePort` before
 * waking the blocked main thread via `Atomics.notify`.
 *
 * This removes the per-invocation `spawnSync(node dist/cli.js …)` boot tax
 * (fresh Node process + full ESM bundle load per call) that dominated the
 * suite runtime, while preserving the CLI's observable contract: exit code,
 * stdout, stderr. Calls that need real process semantics (stdin input or a
 * different working directory) never reach this worker — the main-thread
 * bridge routes them to the spawn runner instead.
 */
import { parentPort } from "node:worker_threads";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Lazily imported dist main module (imported once per worker lifetime). */
let distMainPromise = null;

/**
 * Import the built CLI entry module once and memoize it for the lifetime of
 * this worker. Module-level caches inside the bundle are keyed by workspace
 * path (`PM_PATH`), and every test uses a fresh temp workspace, so reusing
 * one module instance across invocations does not leak state between tests.
 */
function loadDistMain(workspaceRoot) {
  if (distMainPromise === null) {
    const mainModulePath = path.resolve(workspaceRoot, "dist/cli/main.js");
    distMainPromise = import(pathToFileURL(mainModulePath).href);
  }
  return distMainPromise;
}

/**
 * Normalize a stdio chunk written through the patched writer into a string.
 */
function chunkToString(chunk, encoding) {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString(encoding ?? "utf8");
  }
  if (chunk === undefined || chunk === null) {
    return "";
  }
  return String(chunk);
}

/**
 * Build a `process.stdout.write`-compatible writer that appends chunks to an
 * accumulator via `sink` while honoring the optional encoding/callback forms.
 */
function createCapturingWriter(sink) {
  return (chunk, encoding, callback) => {
    const normalizedEncoding = typeof encoding === "string" ? encoding : undefined;
    sink(chunkToString(chunk, normalizedEncoding));
    if (typeof encoding === "function") {
      encoding();
    } else if (typeof callback === "function") {
      callback();
    }
    return true;
  };
}

/**
 * Replace this worker's environment with the caller-provided snapshot and
 * return a restore function. The snapshot is applied wholesale so the CLI
 * sees exactly the environment the spawn runner would have provided.
 */
function applyEnvironmentSnapshot(env) {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (!(key in env)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  };
}

/**
 * Run one CLI invocation in-process and capture its observable outcome.
 */
async function executeCliInvocation(request) {
  const loaded = await loadDistMain(request.workspaceRoot);
  if (typeof loaded.runPmCli !== "function") {
    return {
      status: 1,
      stdout: "",
      stderr: "dist main module does not export runPmCli",
      errorMessage: "dist main module does not export runPmCli",
    };
  }

  let stdout = "";
  let stderr = "";
  let status;
  let errorMessage;

  const restoreEnv = applyEnvironmentSnapshot(request.env);
  const previousArgv = process.argv;
  const previousExitCode = process.exitCode;
  const previousStdoutWrite = process.stdout.write;
  const previousStderrWrite = process.stderr.write;
  const previousExit = process.exit;

  try {
    process.argv = [
      process.argv[0],
      path.resolve(request.workspaceRoot, "dist/cli.js"),
      ...request.args,
    ];
    process.exitCode = undefined;
    // A freshly spawned `pm` process self-derives PM_CLI_PACKAGE_ROOT at
    // module init (cli/main.ts top level). The worker imports the bundle only
    // once, so replicate that per invocation: without it, package handlers
    // (guide-shell, calendar, beads, …) cannot locate the core SDK runtime.
    if (typeof process.env.PM_CLI_PACKAGE_ROOT !== "string" || process.env.PM_CLI_PACKAGE_ROOT.trim().length === 0) {
      process.env.PM_CLI_PACKAGE_ROOT = request.workspaceRoot;
    }
    // A real `process.exit` inside a worker kills only this thread while the
    // main thread stays blocked in `Atomics.wait` — convert it into a
    // catchable error instead (the CLI itself never calls it; commander is
    // configured with exitOverride, so this is a last-resort guard).
    process.exit = (code) => {
      process.exitCode = typeof code === "number" ? code : (process.exitCode ?? 0);
      throw new Error(`process.exit(${String(code ?? "")}) intercepted by cli worker bridge`);
    };
    process.stdout.write = createCapturingWriter((text) => {
      stdout += text;
    });
    process.stderr.write = createCapturingWriter((text) => {
      stderr += text;
    });

    await loaded.runPmCli(request.args);
    status = process.exitCode ?? 0;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    status = process.exitCode ?? 1;
  } finally {
    process.exit = previousExit;
    process.stdout.write = previousStdoutWrite;
    process.stderr.write = previousStderrWrite;
    process.argv = previousArgv;
    process.exitCode = previousExitCode;
    restoreEnv();
  }

  return { status, stdout, stderr, errorMessage };
}

parentPort.on("message", (message) => {
  const { port, signal, request } = message;
  void executeCliInvocation(request)
    .then((result) => {
      port.postMessage({ ok: true, result });
    })
    .catch((error) => {
      port.postMessage({
        ok: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      port.close();
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
    });
});
