#!/usr/bin/env node
/**
 * @module scripts/release/agent-evidence-consistency-control
 *
 * Proves that the evidence regressions reject thirteen real source defects using
 * disposable copies, leaving the checkout and production tracker untouched.
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runIsolatedRegressionControl } from "./isolated-regression-control.mjs";

const cases = [
  {
    sourcePath: "src/sdk/query/get.ts",
    testPath: "tests/unit/regressions/actionable-get-receipts.spec.ts",
    testName: "resolves every declared blocker without certifying missing or external references",
    before: "if (!full && item.dependencies !== undefined) {",
    after: "if (false) {",
  },
  {
    sourcePath: "src/sdk/query/get.ts",
    testPath: "tests/unit/regressions/actionable-get-receipts.spec.ts",
    testName: "canonicalizes short blocker references without double-counting their persisted full-ID edges",
    before: "targets.set(id.toLowerCase(), loaded.document.metadata);",
    after: "targets.set(located.id.toLowerCase(), loaded.document.metadata);",
  },
  {
    sourcePath: "src/sdk/query/get.ts",
    testPath: "tests/unit/regressions/actionable-get-receipts.spec.ts",
    testName: "rejects a declared blocker whose file contains another item identity",
    before: "if (loaded.document.metadata.id !== located.id) {",
    after: "if (false) {",
  },
  {
    sourcePath: "src/sdk/query/get.ts",
    testPath: "tests/unit/regressions/actionable-get-receipts.spec.ts",
    testName: "keeps nonportable legacy blocker text unresolved without reading outside item folders",
    before: '!/^(?!\\.{1,2}$)[^/\\\\:\\0]+$/u.test(id) ||',
    after: "false ||",
  },
  {
    sourcePath: "src/sdk/query/get.ts",
    testPath: "tests/unit/regressions/actionable-get-receipts.spec.ts",
    testName: "resolves every declared blocker without certifying missing or external references",
    before: "targets.set(id.toLowerCase(), loaded.document.metadata);",
    after: "void loaded;",
  },
  {
    sourcePath: "src/sdk/output-projection.ts",
    testPath: "tests/unit/regressions/actionable-get-receipts.spec.ts",
    testName: "declares only material schedule members withheld",
    before: '((name === "reminders" || name === "events") &&\n      isRecord(result.schedule) && Object.hasOwn(result.schedule, name)) ||',
    after: "false ||",
  },
  {
    sourcePath: "src/sdk/output-projection.ts",
    testPath: "tests/unit/regressions/actionable-get-receipts.spec.ts",
    testName: "distinguishes rendered linked artifacts from unselected placeholders",
    before: '(["files", "tests", "docs"].includes(name) &&\n      isRecord(result.linked) && Array.isArray(result.linked[name]) &&\n      result.linked[name].length > 0)',
    after: "false",
  },
  {
    sourcePath: "src/sdk/governance/validate-history-drift.ts",
    testName: "rejects a reread redirected",
    before: "if (document.metadata.id !== id) {",
    after: "if (false) {",
  },
  {
    sourcePath: "src/sdk/governance/validate-history-drift.ts",
    testName: "reads the corpus cache once while rechecking multiple advanced items",
    before: "const verified = await scanItemHistoryDrift(\n        pmRoot,\n        { ...document.metadata, body: document.body },\n      );",
    after: "const verified = await scanHistoryDrift(pmRoot, [{ ...document.metadata, body: document.body }]);",
  },
  {
    sourcePath: "src/sdk/governance/validate-history-drift.ts",
    testName: "rechecks an advanced source snapshot without accepting stable source corruption",
    before: "await recheckItemHistoryDrift(pmRoot, drift);",
    after: "void pmRoot;",
  },
  {
    sourcePath: "src/sdk/cli-bootstrap.ts",
    testName: "preserves annotation evidence in the public bootstrap normalizer",
    before: '["search", "comments", "notes", "learnings"].includes(commandName)',
    after: 'commandName === "search"',
  },
  {
    sourcePath: "src/cli/commander-usage.ts",
    testName: "keeps unknown-option recovery declared",
    before: "const commandName = resolveRecoveryCommandName(message, invocationArgv, rootProgram, extensionDescriptors);",
    after: "const commandName = parseBootstrapCommandName(invocationArgv);",
  },
  {
    sourcePath: "scripts/finalize-build.mjs",
    testPath: "tests/unit/scripts/runtime-compaction.spec.ts",
    testName: "compacts redundant runtime syntax",
    before: "minifySyntax: true,",
    after: "minifySyntax: false,",
  },
];
/** Execute actual safe or unsafe-source controls only for this CLI entrypoint, retaining intentional failure status. */
export async function runIfMain(filename = process.argv[1], args = process.argv.slice(2)) {
  if (filename !== fileURLToPath(import.meta.url)) return;
  const negativeControl = args.includes("--negative-control");
  assert.ok(args.every((argument) => argument === "--negative-control"), "Only --negative-control is supported");
  const results = [];
  for (const control of cases) {
    const result = await runIsolatedRegressionControl({
      testPath: "tests/unit/regressions/agent-evidence-consistency.spec.ts",
      ...control,
      extraPaths: ["tests/helpers", "dist"],
    }, negativeControl);
    assert.equal(result.exit_code, negativeControl ? 1 : 0, result.output);
    if (negativeControl) assert.match(result.output, /AssertionError/, "A control must fail a behavior assertion");
    results.push({ name: control.testName, exit_code: result.exit_code });
  }
  process.stdout.write(JSON.stringify({ negative_control: negativeControl, controls: results }) + "\n");
  process.exitCode = negativeControl ? 1 : 0;
}

await runIfMain();
