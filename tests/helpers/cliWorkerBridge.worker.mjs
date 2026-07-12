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
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Lazily imported dist main module (imported once per worker lifetime). */
let distMainPromise = null;

/** Same-graph core extensions module, for post-invocation taint inspection. */
let distExtensionsPromise = null;

/**
 * Sticky flag: once an invocation may have mutated the module-level commander
 * program (dynamic extension commands/flags or workspace-defined runtime
 * schema fields), every later invocation in this worker is suspect and the
 * bridge must not reuse the worker for the next test context.
 */
let programTainted = false;

/**
 * Args that mutate extension/schema topology. Mostly redundant with the
 * directory/registration signals below, but they close ordering gaps such as
 * an uninstall that empties the extensions directory AFTER its own bootstrap
 * already registered the extension's dynamic paths on the program.
 */
const TAINTING_COMMAND_TOKENS = new Set(["install", "uninstall", "extension", "schema"]);

/**
 * True when the directory exists and contains at least one entry. A pristine
 * default-init workspace has an EMPTY `extensions/` directory, so any content
 * — regardless of how it arrived (extension install, `init --install`,
 * direct fixture writes) — means dynamic extension paths may have been
 * registered on the shared commander program during this invocation.
 */
function directoryHasEntries(directoryPath) {
  try {
    return fs.readdirSync(directoryPath).length > 0;
  } catch {
    return false;
  }
}

/**
 * True when the env value names a workspace whose `extensions/` directory has
 * any content — a pristine default-init workspace keeps it empty.
 */
function workspaceHasExtensionContent(workspacePath) {
  return (
    typeof workspacePath === "string" &&
    workspacePath.length > 0 &&
    directoryHasEntries(path.join(workspacePath, "extensions"))
  );
}

/**
 * True when the invocation left non-empty active extension registrations
 * behind (the runPmCli entry reset only clears them at the NEXT invocation).
 * Treats inspection failure as tainted — reuse must be provably safe.
 */
async function invocationLeftExtensionRegistrations(workspaceRoot) {
  try {
    if (distExtensionsPromise === null) {
      const extensionsModulePath = path.resolve(workspaceRoot, "dist/core/extensions/index.js");
      distExtensionsPromise = import(pathToFileURL(extensionsModulePath).href);
    }
    const extensions = await distExtensionsPromise;
    const registrations = extensions.getActiveExtensionRegistrations?.();
    if (registrations === null || registrations === undefined) {
      return false;
    }
    return Object.values(registrations).some((entries) => Array.isArray(entries) && entries.length > 0);
  } catch {
    return true;
  }
}

/**
 * True when workspace settings define custom item types, which register
 * runtime schema field flags on the shared program. CLI-driven schema changes
 * are caught by the "schema" argv token; this catches direct settings writes
 * (tests/helpers/pmWorkspace.ts writeItemTypeDefinitions). The default
 * settings `schema` pointer block is present in every workspace and is
 * deliberately NOT a taint signal.
 */
function workspaceDefinesCustomItemTypes(pmPath) {
  if (typeof pmPath !== "string" || pmPath.length === 0) {
    return false;
  }
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(pmPath, "settings.json"), "utf8"));
    const typeDefinitions = settings?.item_types?.definitions;
    return Array.isArray(typeDefinitions) && typeDefinitions.length > 0;
  } catch {
    return false;
  }
}

/**
 * Detect whether the finished invocation could have registered dynamic
 * commands, extension flags, or runtime schema field flags on the shared
 * commander program. Signals, all route-independent: extension content in the
 * project or global workspace, active extension registrations left by the
 * invocation, extension/schema-mutating argv, and workspace settings defining
 * custom item types.
 */
async function detectProgramTaint(request) {
  const firstCommandToken = request.args.find((token) => !token.startsWith("-"));
  if (firstCommandToken !== undefined && TAINTING_COMMAND_TOKENS.has(firstCommandToken)) {
    return true;
  }
  if (workspaceHasExtensionContent(request.env.PM_PATH) || workspaceHasExtensionContent(request.env.PM_GLOBAL_PATH)) {
    return true;
  }
  if (await invocationLeftExtensionRegistrations(request.workspaceRoot)) {
    return true;
  }
  return workspaceDefinesCustomItemTypes(request.env.PM_PATH);
}

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
    .then(async (result) => {
      if (!programTainted) {
        programTainted = await detectProgramTaint(request);
      }
      port.postMessage({ ok: true, result, tainted: programTainted });
    })
    .catch((error) => {
      programTainted = true;
      port.postMessage({
        ok: false,
        errorMessage: error instanceof Error ? error.message : String(error),
        tainted: true,
      });
    })
    .finally(() => {
      port.close();
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
    });
});
