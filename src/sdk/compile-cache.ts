/**
 * @module sdk/compile-cache
 *
 * Provides a bounded, host-reusable lifecycle primitive for pm-owned Node
 * compile-cache generations.
 */
import fs from "node:fs";
import path from "node:path";

const COMPILE_CACHE_CONCURRENT_GRACE_MS = 5 * 60 * 1000;
const COMPILE_CACHE_MAX_GENERATIONS = 3;

/** Result of pruning superseded pm compile-cache generations. */
export interface CompileCachePruneResult {
  /** Generation retained for the current pm build. */
  retained: string;
  /** Deterministically sorted generation names removed from the cache root. */
  removed: string[];
}

/** Convert an optional package version into a safe compile-cache generation key. */
export function resolveCompileCacheGeneration(
  packageVersion: string | undefined,
): string {
  return (packageVersion?.trim() || "development")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\./, "_");
}

/**
 * Retain the current and recently active generations in an exclusively
 * pm-owned compile-cache root, then remove stale entries beyond the bounded
 * generation budget. A short freshness grace protects concurrently starting
 * pm versions from deleting one another's active cache directories.
 */
export function pruneCompileCacheGenerations(
  cacheRoot: string,
  currentGeneration: string,
): CompileCachePruneResult {
  const normalizedGeneration = currentGeneration.trim();
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(normalizedGeneration)) {
    throw new TypeError(
      "Compile-cache generation must be a safe non-empty filename token.",
    );
  }
  fs.mkdirSync(cacheRoot, { recursive: true });
  const currentPath = path.join(cacheRoot, normalizedGeneration);
  fs.mkdirSync(currentPath, { recursive: true });
  const touchedAt = new Date();
  fs.utimesSync(currentPath, touchedAt, touchedAt);
  const candidates = fs
    .readdirSync(cacheRoot)
    .filter((name) => name !== normalizedGeneration)
    .flatMap((name) => {
      try {
        return [
          { name, mtimeMs: fs.statSync(path.join(cacheRoot, name)).mtimeMs },
        ];
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return [];
        }
        throw error;
      }
    })
    .sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name),
    );
  const fresh = candidates.filter(
    (entry) =>
      touchedAt.getTime() - entry.mtimeMs <
      COMPILE_CACHE_CONCURRENT_GRACE_MS,
  );
  const staleRetention = Math.max(
    0,
    COMPILE_CACHE_MAX_GENERATIONS - 1 - fresh.length,
  );
  const removed = candidates
    .filter(
      (entry) =>
        touchedAt.getTime() - entry.mtimeMs >= COMPILE_CACHE_CONCURRENT_GRACE_MS,
    )
    .slice(staleRetention)
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  for (const name of removed) {
    fs.rmSync(path.join(cacheRoot, name), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  }
  return { retained: normalizedGeneration, removed };
}
