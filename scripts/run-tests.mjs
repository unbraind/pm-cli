#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withBuildLease } from "./build-lease.mjs";
import { registerTempCleanup } from "./temp-lifecycle.mjs";

const MODE_TO_VITEST_ARGS = {
  test: [],
  mutation: [],
  coverage: ["--coverage"],
  "coverage-shard": ["--coverage"],
};
let activeChild;
let execution;
let interrupted = false;

/** Validate the requested test mode before allocating disposable tracker roots. */
function resolveMode(argv) {
  const mode = (argv[2] ?? "test").toLowerCase();
  if (!(mode in MODE_TO_VITEST_ARGS)) {
    return { ok: false, mode };
  }

  return { ok: true, mode };
}

/** Await process closure, retaining operation errors until the child stops using its workspace. */
function runChild(command, args, env) {
  if (interrupted) return Promise.reject(new Error("Test execution interrupted before the next stage."));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });
    activeChild = child;
    let failure;
    // Failed signals can emit error while the process remains alive. Even a
    // failed spawn emits close, so neither case may release the workspace early.
    child.on("error", (error) => { failure = { error }; });
    child.on("close", (code, signal) => {
      activeChild = undefined;
      if (failure) {
        reject(failure.error);
        return;
      }
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

/** Stop the active stage before cleanup; an unresponsive child retains its workspace. */
async function stopActiveChild() {
  interrupted = true;
  // Await the runner's finally blocks too: deleting its root before the build
  // lease is released would turn an ordinary interrupt into an abandoned lease.
  const completion = execution.then(() => true, () => true);
  activeChild?.kill("SIGTERM");
  let timeout;
  try {
    const stopped = await Promise.race([
      completion,
      new Promise((resolve) => { timeout = setTimeout(resolve, 5000, false); }),
    ]);
    if (!stopped) throw new Error("Test child did not close within 5000ms; workspace retained.");
  } finally {
    clearTimeout(timeout);
  }
}

/** Reject scratch directories whose ancestry could expose the real workspace tracker to tests. */
function assertExternalTemporaryDirectory() {
  const relative = path.relative(
    realpathSync(process.cwd()),
    realpathSync(tmpdir()),
  );
  if (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  ) {
    throw new Error(
      "Test temporary directory is inside the workspace. Set TMPDIR (or TEMP/TMP on Windows) to an existing directory outside the checkout.",
    );
  }
}

/** Execute validation while its caller retains the build lease and isolated tracker environment. */
async function runValidation(mode, normalizedVitestArgs, env, vitestEntry) {
  if (existsSync(path.join(process.cwd(), ".cache", "build-incomplete"))) {
    throw new Error("Incomplete dist generation; run pnpm build before prebuilt validation.");
  }
  if (mode === "mutation") {
    if (normalizedVitestArgs.length > 0) throw new Error("Mutation policy cannot be overridden with runner arguments.");
    process.exitCode = await runChild(process.execPath, [
      "--input-type=module", "--eval",
      'import { main } from "./scripts/release/sdk-mutation.mjs"; console.log(JSON.stringify(await main()));',
    ], env);
    return;
  }
  const vitestExitCode = await runChild(
    process.execPath,
    [
      vitestEntry,
      "run",
      ...MODE_TO_VITEST_ARGS[mode],
      ...normalizedVitestArgs,
    ],
    env,
  );

  if (mode !== "coverage") {
    process.exitCode = vitestExitCode;
    return;
  }

  const coverageGateExitCode = await runChild(
    process.execPath,
    [
      path.join(
        process.cwd(),
        "scripts",
        "release",
        "coverage-threshold-gate.mjs",
      ),
    ],
    env,
  );
  if (vitestExitCode !== 0 && coverageGateExitCode !== 0) {
    console.error(
      "Test execution and exact coverage both failed (combined verdict).",
    );
    process.exitCode = 3;
  } else if (vitestExitCode !== 0) {
    console.error("Test execution failed; exact coverage still passed.");
    process.exitCode = 1;
  } else if (coverageGateExitCode !== 0) {
    console.error("Tests passed; exact coverage failed.");
    process.exitCode = 2;
  } else {
    process.exitCode = 0;
  }
}

/**
 * Build and execute the requested Vitest mode in disposable tracker roots.
 *
 * Every child receives an explicit external-Sentry opt-out so negative test
 * fixtures cannot escape the repository boundary, even when the parent shell
 * is configured for production observability.
 */
async function run() {
  const resolved = resolveMode(process.argv);
  if (!resolved.ok) {
    console.error(
      `Invalid mode "${resolved.mode}". Use "test", "coverage", "coverage-shard", or "mutation".`,
    );
    process.exitCode = 2;
    return;
  }

  // Fixtures discover Git and tracker roots through ancestors. A disposable
  // directory inside this workspace therefore cannot provide test isolation.
  try {
    assertExternalTemporaryDirectory();
  } catch (error) {
    console.error(`Unsafe test temporary directory: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "pm-cli-tests-"));
  const releaseCleanup = registerTempCleanup(tempRoot, { shutdown: stopActiveChild });
  const pmPath = path.join(tempRoot, "project", ".agents", "pm");
  const pmGlobalPath = path.join(tempRoot, "global");
  const vitestEntry = path.join(
    process.cwd(),
    "node_modules",
    "vitest",
    "vitest.mjs",
  );
  const passthroughArgs = process.argv.slice(3);
  const normalizedVitestArgs =
    passthroughArgs[0] === "--" ? passthroughArgs.slice(1) : passthroughArgs;
  // CLI reporter selection replaces the config list (including in coverage
  // shards), so retain the contract gate beside every explicitly chosen reporter.
  if (normalizedVitestArgs.some((arg) => arg === "--reporter" || arg.startsWith("--reporter="))) {
    normalizedVitestArgs.push(`--reporter=${path.join(process.cwd(), "scripts", "mcp-contract-reporter.mts")}`);
  }
  const skipBuild = process.env.PM_RUN_TESTS_SKIP_BUILD === "1";

  try {
    const baseEnv = {
      ...process.env,
      PM_PATH: pmPath,
      PM_GLOBAL_PATH: pmGlobalPath,
      PM_SENTRY_DISABLED: "1",
      ...(resolved.mode === "mutation" ? { PM_MUTATION_TEMP_ROOT: tempRoot, PM_TELEMETRY_DISABLED: "1", PM_AGENT_PROBES: "0" } : {}),
    };
    delete baseEnv.PM_CLI_PACKAGE_ROOT;
    delete baseEnv.PM_SOURCE_PM_PATH;
    delete baseEnv.PM_SOURCE_WORKSPACE_ROOT;

    if (!skipBuild) {
      const buildExitCode = await runChild(process.execPath, [path.join(process.cwd(), "scripts", "build.mjs")], baseEnv);

      if (buildExitCode !== 0) {
        process.exitCode = buildExitCode;
        return;
      }
    }

    await withBuildLease(process.cwd(), (lease) => runValidation(
      resolved.mode, normalizedVitestArgs, { ...baseEnv, PM_BUILD_CONSUMER_LEASE: lease }, vitestEntry,
    ), { inherited: process.env.PM_BUILD_CONSUMER_LEASE });

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to run sandboxed tests: ${message}`);
    process.exitCode = 1;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    releaseCleanup();
  }
}

execution = run();
await execution;
