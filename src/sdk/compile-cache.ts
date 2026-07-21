/**
 * @module sdk/compile-cache
 *
 * Provides a bounded, host-reusable lifecycle primitive for pm-owned Node
 * compile-cache generations.
 */
import fs from "node:fs";
import path from "node:path";

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
  return (packageVersion ?? "development").replace(
    /[^a-zA-Z0-9._-]/g,
    "_",
  );
}

/**
 * Remove every superseded entry from an exclusively pm-owned compile-cache
 * root while retaining the current generation. Callers choose the generation
 * key, normally the installed pm package version, so repeated upgrades never
 * accumulate unbounded Node bytecode caches.
 */
export function pruneCompileCacheGenerations(
  cacheRoot: string,
  currentGeneration: string,
): CompileCachePruneResult {
  const normalizedGeneration = currentGeneration.trim();
  if (
    normalizedGeneration.length === 0 ||
    path.basename(normalizedGeneration) !== normalizedGeneration
  ) {
    throw new TypeError(
      "Compile-cache generation must be a non-empty path basename.",
    );
  }
  fs.mkdirSync(cacheRoot, { recursive: true });
  const removed = fs
    .readdirSync(cacheRoot)
    .filter((name) => name !== normalizedGeneration)
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
