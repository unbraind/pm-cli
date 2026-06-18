/**
 * Common primitive utility functions shared across core modules.
 *
 * These reduce duplication of trivial helpers like string-presence checks,
 * error message extraction, and numeric array guards that were previously
 * duplicated in providers.ts, vector-stores.ts, lock.ts, cache.ts, and
 * several CLI command modules.
 */

/** Return a trimmed non-empty string, or `null` for non-string/blank input. */
export function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Implements to non empty string or undefined for the public runtime surface of this module.
 */
export function toNonEmptyStringOrUndefined(value: unknown): string | undefined {
  const result = toNonEmptyString(value);
  return result ?? undefined;
}

/**
 * Implements trim trailing slashes for the public runtime surface of this module.
 */
export function trimTrailingSlashes(value: string): string {
  return value.replaceAll(/\/+$/g, "");
}

/**
 * Implements check whether finite number array for the public runtime surface of this module.
 */
export function isFiniteNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

/**
 * Implements to error message for the public runtime surface of this module.
 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0 ? message : error.name;
  }
  return String(error);
}

/**
 * Parse either a finite numeric literal or a non-empty numeric string.
 * Returns `null` for unsupported input types, empty strings, and non-finite
 * numeric values.
 */
export function coerceFiniteNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value.trim())
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Implements coerce positive integer for the public runtime surface of this module.
 */
export function coercePositiveInteger(value: unknown): number | null {
  const parsed = coerceFiniteNumber(value);
  if (parsed === null || parsed <= 0 || !Number.isInteger(parsed)) {
    return null;
  }
  return parsed;
}

/**
 * Implements coerce number in range for the public runtime surface of this module.
 */
export function coerceNumberInRange(value: unknown, min: number, max: number): number | null {
  const parsed = coerceFiniteNumber(value);
  if (parsed === null || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

/**
 * Narrow a value to a plain object, returning `null` for non-objects,
 * `null`, and arrays. Returns the original reference (no clone).
 *
 * Matches the historical `asRecord` in src/cli/main.ts.
 */
export function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Narrow a value to a plain object, returning `null` only for non-objects and
 * `null` while accepting arrays (arrays are objects). Returns the original
 * reference (no clone).
 *
 * Matches the historical `asRecord` in src/core/extensions/loader.ts, which
 * intentionally omits the array guard.
 */
export function asRecordLoose(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Narrow a value to a plain object, returning an empty object for non-objects,
 * `null`, and arrays. Returns a shallow clone of the source object.
 *
 * Matches the historical `asRecord` in src/mcp/server.ts.
 */
export function asRecordClone(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? ({ ...value } as Record<string, unknown>)
    : {};
}
