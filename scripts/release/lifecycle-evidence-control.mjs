#!/usr/bin/env node

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runIsolatedRegressionControl } from "./isolated-regression-control.mjs";

const controls = {
  "claim-receipts": {
    sourcePath: "src/sdk/lifecycle/mcp-actions.ts",
    testPath: "tests/unit/commands/claim-receipts.spec.ts",
    testName: "shares MCP projection",
    before: 'return projectMutationResult(result, {\n    changedFields,\n    compactEnvelope: changedFields === "compact" && !idOnly,',
    after: 'return projectMutationResult(result, {\n    changedFields,\n    compactEnvelope: false,',
    extraPaths: ["tests/helpers", "dist"],
  },
  "update-coverage": {
    sourcePath: "src/sdk/extension/doctor.ts",
    testPath: "tests/unit/extensions/extension-update-coverage.spec.ts",
    testName: "reports skipped_non_github as incomplete",
    before: 'const updateHealthCoverage = updateHealthPartial ? "partial" : "full";',
    after: 'const updateHealthCoverage = "full";',
  },
};

/** Prove compact-claim and freshness regressions reject real source mutations in isolated copies. */
export async function runLifecycleEvidenceControl(control = "claim-receipts", negativeControl = false) {
  assert.ok(Object.hasOwn(controls, control), "Unknown lifecycle evidence control");
  return runIsolatedRegressionControl(controls[control], negativeControl);
}

/** Run a selected control without translating an intentional failing verdict into success. */
export async function runIfMain(filename = process.argv[1], args = process.argv.slice(2)) {
  if (filename !== fileURLToPath(import.meta.url)) return;
  const result = await runLifecycleEvidenceControl(args.includes("--update-coverage") ? "update-coverage" : "claim-receipts", args.includes("--negative-control"));
  process.stdout.write(result.output);
  process.exitCode = result.exit_code;
}

await runIfMain();
