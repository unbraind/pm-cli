#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { runIsolatedRegressionControl } from "./isolated-regression-control.mjs";

/** Run the real entry-limit regression against an isolated baseline or an unsafe completeness mutant. */
export async function runInstallPlanControl(negativeControl = false) {
  return runIsolatedRegressionControl({
    sourcePath: "src/sdk/extension/install-plan.ts",
    testPath: "tests/unit/extensions/extension-install-plan.spec.ts",
    testName: "measures external snapshots",
    before: 'plan.complete = false;\n      plan.stop_reason = "entry_limit";',
    after: 'plan.complete = true;\n      plan.stop_reason = "entry_limit";',
  }, negativeControl);
}

/** Preserve the test verdict at the command boundary; an effective negative control exits one. */
export async function runIfMain(filename = process.argv[1], args = process.argv.slice(2)) {
  if (filename !== fileURLToPath(import.meta.url)) return;
  const result = await runInstallPlanControl(args.includes("--negative-control"));
  process.stdout.write(result.output);
  process.exitCode = result.exit_code;
}

await runIfMain();
