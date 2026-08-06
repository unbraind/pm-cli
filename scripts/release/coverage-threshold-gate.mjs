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

const COVERAGE_METRICS = ["lines", "branches", "functions", "statements"];

/** Return exact uncovered counts for every file and required metric. */
export function findCoverageDeficits(summary) {
  if (
    typeof summary !== "object" ||
    summary === null ||
    Array.isArray(summary)
  ) {
    throw new TypeError("Coverage summary must be a JSON object.");
  }
  if (!("total" in summary)) {
    throw new TypeError("Coverage summary is missing the total entry.");
  }
  const deficits = [];
  for (const [file, entry] of Object.entries(summary)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`Coverage entry for ${file} must be an object.`);
    }
    for (const metric of COVERAGE_METRICS) {
      const counts = entry[metric];
      if (
        typeof counts !== "object" ||
        counts === null ||
        typeof counts.covered !== "number" ||
        typeof counts.total !== "number" ||
        !Number.isInteger(counts.covered) ||
        !Number.isInteger(counts.total) ||
        counts.covered < 0 ||
        counts.total < counts.covered
      ) {
        throw new TypeError(
          `Coverage entry ${file} has invalid ${metric} counts.`,
        );
      }
      const uncovered = counts.total - counts.covered;
      if (uncovered > 0) {
        deficits.push({
          file,
          metric,
          uncovered,
          covered: counts.covered,
          total: counts.total,
        });
      }
    }
  }
  return deficits;
}

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
