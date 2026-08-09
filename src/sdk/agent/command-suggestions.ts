/**
 * @module sdk/command-suggestions
 *
 * Provides deterministic, agent-oriented command suggestion ranking. Semantic
 * verb aliases rank first, bounded edit distance second, and substring matches
 * last so `log` never prefers `catalog` over item history commands.
 */
import { levenshteinDistanceWithinLimit } from "../../core/shared/levenshtein.js";

const COMMAND_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  add: ["create", "append"],
  fetch: ["get"],
  inspect: ["get", "health"],
  log: ["history", "comments", "notes"],
  ls: ["list"],
  pause: ["release"],
  read: ["get"],
  remove: ["delete"],
  rm: ["delete"],
  show: ["get"],
};

/** Score one command path for a guessed command token; lower is better. */
export function scoreCommandPathMatch(
  commandPath: string,
  queryToken: string,
): number {
  const normalizedPath = commandPath.trim().toLowerCase();
  const normalizedToken = queryToken.trim().toLowerCase();
  if (normalizedToken.length === 0) return Number.POSITIVE_INFINITY;
  const segments = normalizedPath.split(" ");
  const semanticIndex =
    COMMAND_SYNONYMS[normalizedToken]?.indexOf(normalizedPath);
  if (semanticIndex !== undefined && semanticIndex >= 0) return semanticIndex;
  if (normalizedPath === normalizedToken) return 10;
  if (segments.includes(normalizedToken)) return 11;
  if (segments.some((segment) => segment.startsWith(normalizedToken)))
    return 12;
  const maxDistance = normalizedToken.length >= 5 ? 2 : 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const segment of segments) {
    const distance = levenshteinDistanceWithinLimit(
      segment,
      normalizedToken,
      maxDistance,
    );
    if (distance !== null) bestDistance = Math.min(bestDistance, distance);
  }
  if (Number.isFinite(bestDistance)) return 20 + bestDistance;
  if (normalizedPath.includes(normalizedToken)) return 30;
  return Number.POSITIVE_INFINITY;
}

/** Rank available command paths for one guessed token. */
export function rankCommandPaths(
  commandPaths: string[],
  queryToken: string,
): string[] {
  return commandPaths
    .map((path) => ({ path, score: scoreCommandPathMatch(path, queryToken) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) =>
      left.score !== right.score
        ? left.score - right.score
        : left.path.localeCompare(right.path),
    )
    .map((entry) => entry.path);
}
