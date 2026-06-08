import { levenshteinDistanceWithinLimit } from "../shared/levenshtein.js";

/**
 * Canonical coercion kinds accepted for extension-registered custom item fields.
 *
 * A `registerItemFields` definition declares one of these as its `type`; the
 * value is later coerced by that kind (see `coerceRegisteredFieldValue`). Keep
 * this list in lock-step with the coercion switch in `item-fields.ts`.
 */
export const KNOWN_ITEM_FIELD_TYPES = ["string", "number", "boolean", "array", "object"] as const;
export type KnownItemFieldType = (typeof KNOWN_ITEM_FIELD_TYPES)[number];

/**
 * Normalize a declared field type to its canonical kind, or `null` when the
 * value is not a known type. Matching is trim- and case-insensitive.
 */
export function normalizeItemFieldType(value: string): KnownItemFieldType | null {
  const normalized = value.trim().toLowerCase();
  return (KNOWN_ITEM_FIELD_TYPES as readonly string[]).includes(normalized)
    ? (normalized as KnownItemFieldType)
    : null;
}

/**
 * Suggest a known field type for a typo'd declaration (e.g. `"strnig"` ->
 * `"string"`), using the shared OSA Damerau–Levenshtein helper so adjacent
 * transpositions count as a single edit. Returns the first canonical type within
 * the proportional edit budget (in declaration order — the kinds are distinct
 * enough that at most one matches), or `null` when nothing is close enough.
 */
export function suggestKnownItemFieldType(value: string): KnownItemFieldType | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }
  const limit = Math.max(1, Math.floor(normalized.length * 0.34));
  for (const candidate of KNOWN_ITEM_FIELD_TYPES) {
    if (levenshteinDistanceWithinLimit(normalized, candidate, limit) !== null) {
      return candidate;
    }
  }
  return null;
}
