#!/usr/bin/env node

import { registerTempCleanup } from "../temp-lifecycle.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));

/** Execute one real regression against disposable source without blocking other isolated controls; reject infrastructure failures and retain bounded output, timeout and exact source-mutant checks. */
export async function runIsolatedRegressionControl({ sourcePath, testPath, testName, before, after, extraPaths = [] }, negativeControl) {
  const root = await mkdtemp(path.join(tmpdir(), "pm-regression-control-"));
  const releaseCleanup = registerTempCleanup(root);
  try {
    for (const entry of ["src", "scripts", "packages", "config", "package.json", "tsconfig.json", "vitest.config.ts", ...extraPaths]) {
      await cp(path.join(repository, entry), path.join(root, entry), { recursive: true });
    }
    await mkdir(path.dirname(path.join(root, testPath)), { recursive: true });
    await cp(path.join(repository, testPath), path.join(root, testPath));
    await symlink(path.join(repository, "node_modules"), path.join(root, "node_modules"), "junction");
    if (negativeControl) {
      const filename = path.join(root, sourcePath);
      const source = await readFile(filename, "utf8");
      assert.equal(source.split(before).length, 2, "The source mutant must match exactly once");
      await writeFile(filename, source.replace(before, after));
    }
    const result = await new Promise((resolve, reject) => {
      execFile(process.execPath, ["scripts/run-tests.mjs", "test", "--", testPath, "-t", testName, "--reporter=verbose"], {
        cwd: root,
        // This disposable checkout owns a separate lease from the parent test run.
        env: { ...process.env, PM_BUILD_CONSUMER_LEASE: "", PM_RUN_TESTS_SKIP_BUILD: "1", PM_SENTRY_DISABLED: "1" },
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error && !(error.code === 1 && !error.killed && !error.signal)) {
          reject(error);
          return;
        }
        resolve({ exit_code: error?.code ?? 0, output: stdout + stderr });
      });
    });
    assert.ok(result.output.includes(testName), "The selected test must run");
    return { negative_control: negativeControl, ...result };
  } finally {
    await rm(root, { recursive: true, force: true });
    releaseCleanup();
  }
}
