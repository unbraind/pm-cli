/**
 * Classification of stale linked paths reported by `pm validate --check-files`.
 *
 * A linked file path that no longer exists is either:
 * - `moved`: a file with the same basename still exists elsewhere in the
 *   scanned candidate set — the candidates are reported so an agent can relink
 *   the item to the new location instead of dropping the link, or
 * - `deleted`: no candidate with that basename exists anywhere in the scan,
 *   so the link points at content that is gone and pruning it is safe.
 *
 * Pure module (pm-0v2m / GH-184): no filesystem access — callers pass the
 * already-collected candidate file list from the files check scan.
 */

/** Classification labels for linked paths that no longer exist on disk. */
export type StaleLinkedPathClassification = "moved" | "deleted";

/**
 * Documents the classified stale linked path payload exchanged by command, SDK, and package integrations.
 */
export interface ClassifiedStaleLinkedPath {
  /** Normalized workspace-relative stale linked path. */
  path: string;
  classification: StaleLinkedPathClassification;
  /**
   * Candidate new locations (same basename, different path), sorted and capped
   * at `candidateLimit`. Empty for `deleted`.
   */
  candidates: string[];
  /** True when more candidates existed than `candidateLimit` allowed. */
  candidates_truncated: boolean;
}

export const DEFAULT_STALE_PATH_CANDIDATE_LIMIT = 3;

function basenameOf(relativePath: string): string {
  const lastSlash = Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\"));
  return lastSlash === -1 ? relativePath : relativePath.slice(lastSlash + 1);
}

/**
 * Classify each stale (missing) linked path as `moved` or `deleted` by
 * matching its basename against the candidate file list. Output preserves the
 * input order of `stalePaths` (callers pass an already-sorted unique list).
 * A candidate equal to the stale path itself never matches (the path is known
 * missing; an identical candidate would be self-referential noise).
 */
export function classifyStaleLinkedPaths(
  stalePaths: readonly string[],
  candidateFiles: readonly string[],
  candidateLimit: number = DEFAULT_STALE_PATH_CANDIDATE_LIMIT,
): ClassifiedStaleLinkedPath[] {
  const limit = Number.isFinite(candidateLimit) && candidateLimit >= 1 ? Math.floor(candidateLimit) : DEFAULT_STALE_PATH_CANDIDATE_LIMIT;
  const candidatesByBasename = new Map<string, string[]>();
  for (const candidate of candidateFiles) {
    const basename = basenameOf(candidate);
    if (basename.length === 0) {
      continue;
    }
    const bucket = candidatesByBasename.get(basename);
    if (bucket) {
      bucket.push(candidate);
    } else {
      candidatesByBasename.set(basename, [candidate]);
    }
  }

  return stalePaths.map((stalePath) => {
    const matches = (candidatesByBasename.get(basenameOf(stalePath)) ?? [])
      .filter((candidate) => candidate !== stalePath)
      .sort((left, right) => left.localeCompare(right));
    if (matches.length === 0) {
      return {
        path: stalePath,
        classification: "deleted" as const,
        candidates: [],
        candidates_truncated: false,
      };
    }
    return {
      path: stalePath,
      classification: "moved" as const,
      candidates: matches.slice(0, limit),
      candidates_truncated: matches.length > limit,
    };
  });
}

/**
 * Render compact `<path>:moved:<top-candidate>` / `<path>:deleted` rows for
 * the files check details (token-efficient counterpart to the full
 * classification objects).
 */
export function summarizeStaleLinkedPathClassifications(classified: readonly ClassifiedStaleLinkedPath[]): string[] {
  return classified.map((entry) =>
    entry.classification === "moved" ? `${entry.path}:moved:${entry.candidates[0]}` : `${entry.path}:deleted`,
  );
}
