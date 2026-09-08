#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const sourcePath = "src/sdk/extension/install-plan.ts";
const testPath = "tests/unit/extensions/extension-install-plan.spec.ts";

/** Run the real entry-limit regression against an isolated baseline or an unsafe completeness mutant. */
export async function runInstallPlanControl(negativeControl = false) {
  const root = await mkdtemp(path.join(tmpdir(), "pm-install-plan-control-"));
  try {
    for (const entry of ["src", "scripts", "packages", "config", "package.json", "tsconfig.json", "vitest.config.ts"]) {
      await cp(path.join(repository, entry), path.join(root, entry), { recursive: true });
    }
    await mkdir(path.dirname(path.join(root, testPath)), { recursive: true });
    await cp(path.join(repository, testPath), path.join(root, testPath));
    await symlink(path.join(repository, "node_modules"), path.join(root, "node_modules"), "junction");
    if (negativeControl) {
      const filename = path.join(root, sourcePath);
      const source = await readFile(filename, "utf8");
      const before = 'plan.complete = false;\n      plan.stop_reason = "entry_limit";';
      assert.equal(source.split(before).length, 2, "The entry-limit mutant must match exactly once");
      await writeFile(filename, source.replace(before, 'plan.complete = true;\n      plan.stop_reason = "entry_limit";'));
    }
    const result = spawnSync(process.execPath, ["scripts/run-tests.mjs", "test", "--", testPath, "-t", "measures external snapshots", "--reporter=verbose"], {
      cwd: root,
      env: { ...process.env, PM_RUN_TESTS_SKIP_BUILD: "1", PM_SENTRY_DISABLED: "1" },
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.error, undefined, "The control must execute the regression test");
    assert.match(result.stdout + result.stderr, /measures external snapshots/, "The selected test must run");
    assert.ok(result.status === 0 || result.status === 1, "The test must produce a normal pass/fail verdict");
    return { negative_control: negativeControl, exit_code: result.status, output: result.stdout + result.stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Preserve the test verdict at the command boundary; an effective negative control exits one. */
export async function runIfMain(filename = process.argv[1], args = process.argv.slice(2)) {
  if (filename !== fileURLToPath(import.meta.url)) return;
  const result = await runInstallPlanControl(args.includes("--negative-control"));
  process.stdout.write(result.output);
  process.exitCode = result.exit_code;
}

await runIfMain();
