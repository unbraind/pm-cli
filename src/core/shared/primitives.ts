/**
 * Common primitive utility functions shared across core modules.
 *
 * These reduce duplication of trivial helpers like string-presence checks,
 * error message extraction, and numeric array guards that were previously
 * duplicated in providers.ts, vector-stores.ts, lock.ts, cache.ts, and
 * several CLI command modules.
 */

export function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function toNonEmptyStringOrUndefined(value: unknown): string | undefined {
  const result = toNonEmptyString(value);
  return result ?? undefined;
}

export function trimTrailingSlashes(value: string): string {
  return value.replaceAll(/\/+$/g, "");
}

export function isFiniteNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0 ? message : error.name;
  }
  return String(error);
}
