#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MODE_TO_VITEST_ARGS = {
  test: [],
  coverage: ["--coverage"],
};

function resolveMode(argv) {
  const mode = (argv[2] ?? "test").toLowerCase();
  if (!(mode in MODE_TO_VITEST_ARGS)) {
    return { ok: false, mode };
  }

  return { ok: true, mode };
}

async function run() {
  const resolved = resolveMode(process.argv);
  if (!resolved.ok) {
    console.error(`Invalid mode "${resolved.mode}". Use "test" or "coverage".`);
    process.exitCode = 2;
    return;
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "pm-cli-tests-"));
  const pmPath = path.join(tempRoot, "project", ".agents", "pm");
  const pmGlobalPath = path.join(tempRoot, "global");
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
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

    if (!skipBuild) {
      const buildExitCode = await new Promise((resolve, reject) => {
        const child = spawn(pnpmCommand, ["build"], {
          cwd: process.cwd(),
          env: baseEnv,
          stdio: "inherit",
        });

        child.on("error", reject);
        child.on("close", (code, signal) => {
          if (signal) {
            resolve(1);
            return;
          }
          resolve(code ?? 1);
        });
      });

      if (buildExitCode !== 0) {
        process.exitCode = buildExitCode;
        return;
      }
    }

    const vitestExitCode = await new Promise((resolve, reject) => {
      const child = spawn(
        pnpmCommand,
        ["exec", "vitest", "run", ...MODE_TO_VITEST_ARGS[resolved.mode], ...normalizedVitestArgs],
        {
          cwd: process.cwd(),
          env: baseEnv,
          stdio: "inherit",
        },
      );

      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (signal) {
          resolve(1);
          return;
        }
        resolve(code ?? 1);
      });
    });

    process.exitCode = vitestExitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to run sandboxed tests: ${message}`);
    process.exitCode = 1;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await run();
