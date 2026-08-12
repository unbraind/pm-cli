#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MODE_TO_VITEST_ARGS = {
  test: [],
  coverage: ["--coverage"],
  "coverage-shard": ["--coverage"],
};

function resolveMode(argv) {
  const mode = (argv[2] ?? "test").toLowerCase();
  if (!(mode in MODE_TO_VITEST_ARGS)) {
    return { ok: false, mode };
  }

  return { ok: true, mode };
}

function runChild(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

async function run() {
  const resolved = resolveMode(process.argv);
  if (!resolved.ok) {
    console.error(
      `Invalid mode "${resolved.mode}". Use "test", "coverage", or "coverage-shard".`,
    );
    process.exitCode = 2;
    return;
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "pm-cli-tests-"));
  const pmPath = path.join(tempRoot, "project", ".agents", "pm");
  const pmGlobalPath = path.join(tempRoot, "global");
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const vitestEntry = path.join(
    process.cwd(),
    "node_modules",
    "vitest",
    "vitest.mjs",
  );
  const passthroughArgs = process.argv.slice(3);
  const normalizedVitestArgs =
    passthroughArgs[0] === "--" ? passthroughArgs.slice(1) : passthroughArgs;
  const skipBuild = process.env.PM_RUN_TESTS_SKIP_BUILD === "1";

  try {
    const baseEnv = {
      ...process.env,
      PM_PATH: pmPath,
      PM_GLOBAL_PATH: pmGlobalPath,
    };
    delete baseEnv.PM_CLI_PACKAGE_ROOT;
    delete baseEnv.PM_SOURCE_PM_PATH;
    delete baseEnv.PM_SOURCE_WORKSPACE_ROOT;

    if (!skipBuild) {
      const buildExitCode = await runChild(pnpmCommand, ["build"], baseEnv);

      if (buildExitCode !== 0) {
        process.exitCode = buildExitCode;
        return;
      }
    }

    const vitestExitCode = await runChild(
      process.execPath,
      [
        vitestEntry,
        "run",
        ...MODE_TO_VITEST_ARGS[resolved.mode],
        ...normalizedVitestArgs,
      ],
      baseEnv,
    );

    if (resolved.mode !== "coverage") {
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
      baseEnv,
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to run sandboxed tests: ${message}`);
    process.exitCode = 1;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await run();
