/**
 * @module sdk/context/recency
 *
 * Canonicalizes the absolute timestamps used as durable context-recency
 * coordinates without accepting relative or host-local date-time values.
 */
import {
  isMillisecondPrecisionRfc3339DateTime,
  resolveIsoOrRelative,
} from "../../core/shared/time.js";

/** Deterministic oldest coordinate used when legacy creation metadata is invalid. */
export const CONTEXT_RECENCY_EPOCH = "1970-01-01T00:00:00.000Z";

/**
 * Canonicalize a calendar-valid RFC 3339 instant or legacy date-only value.
 * Compact dates remain compatible with legacy metadata, while sub-millisecond
 * instants and host-local date-times are rejected because they cannot round-trip
 * losslessly and deterministically.
 */
export function canonicalizeContextRecencyCoordinate(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    !isMillisecondPrecisionRfc3339DateTime(trimmed) &&
    !/^\d{4}(?:-?\d{2}){2}$/u.test(trimmed)
  ) {
    return null;
  }
  try {
    return resolveIsoOrRelative(
      trimmed,
      new Date(Number.NaN),
      "context signal recency coordinate",
    );
  } catch {
    return null;
  }
}
