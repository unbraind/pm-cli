#!/usr/bin/env node

/**
 * Enforce exact repository coverage from Vitest's JSON summary.
 *
 * Percentage formatting can round a non-zero uncovered count to 100%. This
 * gate compares integer covered and total counts instead, reports every
 * deficient file and metric, and is shared by local and hosted coverage runs.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCoverageDeficits } from "../../dist/sdk/governance/coverage-assurance.js";

export { findCoverageDeficits };

/** Load the report, enforce exact coverage, and emit actionable failures. */
export function main(
  summaryPath = path.resolve("coverage", "coverage-summary.json"),
) {
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const deficits = findCoverageDeficits(summary);
  if (deficits.length === 0) {
    console.log(
      "Exact coverage gate passed: 100/100/100/100 with zero uncovered counts.",
    );
    return;
  }
  console.error("Exact coverage gate failed; uncovered source counts remain:");
  for (const deficit of deficits) {
    console.error(
      `- ${deficit.file}: ${deficit.metric} ${deficit.covered}/${deficit.total} (${deficit.uncovered} uncovered)`,
    );
  }
  process.exitCode = 1;
}

/** Run only when invoked as the Node entrypoint. */
export function runIfMain(candidate = process.argv[1]) {
  if (candidate && path.resolve(candidate) === fileURLToPath(import.meta.url)) {
    main();
  }
}

runIfMain();
