/**
 * @module sdk/governance/coverage-assurance
 *
 * Provides exact integer coverage assurance for repository and package gates.
 */

/** Coverage metrics required by the exact repository quality contract. */
export const PM_EXACT_COVERAGE_METRICS = [
  "lines",
  "branches",
  "functions",
  "statements",
] as const;

/** Required exact coverage metric. */
export type PmExactCoverageMetric = (typeof PM_EXACT_COVERAGE_METRICS)[number];

/** One exact uncovered-count finding. */
export interface PmCoverageDeficit {
  /** Coverage summary entry or source filename. */
  file: string;
  /** Deficient required metric. */
  metric: PmExactCoverageMetric;
  /** Integer statements or paths not covered. */
  uncovered: number;
  /** Exact covered count. */
  covered: number;
  /** Exact total count. */
  total: number;
}

/** Require a coverage report entry to expose an object-shaped metric map. */
function assertCoverageEntry(
  file: string,
  entry: unknown,
): asserts entry is Record<string, unknown> {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new TypeError(`Coverage entry for ${file} must be an object.`);
  }
}

/** Return exact validated counts for one required metric. */
function coverageCounts(
  file: string,
  metric: PmExactCoverageMetric,
  value: unknown,
): { covered: number; total: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Coverage entry ${file} has invalid ${metric} counts.`);
  }
  const counts = value as Record<string, unknown>;
  if (
    typeof counts.covered !== "number" ||
    typeof counts.total !== "number" ||
    !Number.isInteger(counts.covered) ||
    !Number.isInteger(counts.total) ||
    counts.covered < 0 ||
    counts.total < counts.covered
  ) {
    throw new TypeError(`Coverage entry ${file} has invalid ${metric} counts.`);
  }
  return { covered: counts.covered, total: counts.total };
}

/** Return exact uncovered counts for every summary entry and required metric. */
export function findCoverageDeficits(summary: unknown): PmCoverageDeficit[] {
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
  const deficits: PmCoverageDeficit[] = [];
  for (const [file, entry] of Object.entries(summary)) {
    assertCoverageEntry(file, entry);
    for (const metric of PM_EXACT_COVERAGE_METRICS) {
      const counts = coverageCounts(file, metric, entry[metric]);
      const uncovered = counts.total - counts.covered;
      if (uncovered > 0) {
        deficits.push({ file, metric, uncovered, ...counts });
      }
    }
  }
  return deficits;
}
