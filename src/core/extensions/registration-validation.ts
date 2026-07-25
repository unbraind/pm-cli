/**
 * @module core/extensions/registration-validation
 *
 * Provides shared validation helpers for extension registration records.
 */

/** Require an extension registration value to be a plain object record. */
export function asRegistrationRecord(
  name: string,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} requires an object definition`);
  }
  return value as Record<string, unknown>;
}

/** Validate an optional boolean registration field. */
export function assertOptionalBooleanField(
  name: string,
  value: unknown,
): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean when provided`);
  }
}

/** Validate an optional non-empty string registration field. */
export function assertOptionalStringField(
  name: string,
  value: unknown,
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string when provided`);
  }
}

/** Validate a scalar or scalar-array default accepted by extension flags. */
export function assertOptionalFlagDefaultField(
  name: string,
  value: unknown,
): void {
  if (value === undefined) {
    return;
  }
  const isScalar = (candidate: unknown): boolean =>
    typeof candidate === "string" ||
    typeof candidate === "number" ||
    typeof candidate === "boolean";
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      if (!isScalar(item)) {
        throw new TypeError(
          `${name}[${index}] must be a string, number, or boolean`,
        );
      }
    }
    return;
  }
  if (!isScalar(value)) {
    throw new TypeError(
      `${name} must be a string, number, or boolean, or an array of these when provided`,
    );
  }
}

/** Validate an optional array containing only non-empty strings. */
export function assertOptionalStringArrayField(
  name: string,
  value: unknown,
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new TypeError(
      `${name} must be an array of non-empty strings when provided`,
    );
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new TypeError(`${name}[${index}] must be a non-empty string`);
    }
  }
}

/** Normalize an optional string array by trimming and preserving first occurrence order. */
export function normalizeOptionalStringArrayField(
  name: string,
  value: unknown,
): string[] {
  assertOptionalStringArrayField(name, value);
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}
