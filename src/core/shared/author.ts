/**
 * @module core/shared/author
 *
 * Provides shared primitives and utilities for Author.
 */
/**
 * Resolves the effective mutation author from explicit input, environment defaults, and fallback settings.
 */
export function resolveAuthor(candidate: string | undefined, fallback: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? fallback;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}
