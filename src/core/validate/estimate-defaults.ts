/**
 * Per-type default estimate resolution for `pm validate --auto-fix` (GH-212).
 *
 * When an item is missing `estimated_minutes`, the auto-fix path backfills a
 * config-driven default based on the item's type. This module is the pure
 * resolution layer: given an item type and an optional settings-derived override
 * map, it returns the default estimate in minutes. The planning + apply path is
 * wired separately by the validate command.
 *
 * Pure module: no filesystem access, no heavy imports. Bad input is never
 * thrown on — invalid override entries are dropped, not errored (mirrors the
 * deterministic, non-throwing style of stale-file-classification.ts).
 */

/** Built-in per-type default estimates in MINUTES used by `pm validate --auto-fix` (GH-212) to backfill missing `estimated_minutes`. Keys are canonical built-in type names. Lookups are case-insensitive (see resolveEstimateDefaultMinutes). */
export const DEFAULT_ESTIMATE_MINUTES_BY_TYPE: Readonly<
  Record<string, number>
> = {
  Epic: 2880,
  Feature: 480,
  Story: 480,
  Milestone: 2880,
  Task: 120,
  Issue: 60,
  Bug: 60,
  Chore: 30,
  Decision: 15,
  Plan: 120,
};

/** Fallback when neither overrides nor the built-in map have the type. */
export const FALLBACK_ESTIMATE_MINUTES = 120;

/** A value is honored only when it is a finite number strictly greater than zero. */
function isHonoredMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Build a case-insensitive lookup keyed by lowercased type name. When two source keys collide case-insensitively, last-wins (later entries overwrite earlier ones); callers normalize overrides up front so collisions are rare. */
function toLowercasedLookup(
  source: Readonly<Record<string, number>>,
): Map<string, number> {
  const lookup = new Map<string, number>();
  for (const [key, value] of Object.entries(source)) {
    lookup.set(key.toLowerCase(), value);
  }
  return lookup;
}

/** Built-in lookup is type-static, so build the lowercased index once. */
const BUILTIN_LOWERCASED_LOOKUP = toLowercasedLookup(
  DEFAULT_ESTIMATE_MINUTES_BY_TYPE,
);

/** Cache lowercased override lookups keyed on the override object reference so a backfill that resolves once per item does not rebuild the same Map each call. A WeakMap keeps this allocation-free for callers that reuse one normalized settings map across the whole run. */
const OVERRIDE_LOOKUP_CACHE = new WeakMap<
  Readonly<Record<string, number>>,
  Map<string, number>
>();

function lowercasedOverrideLookup(
  overrides: Readonly<Record<string, number>>,
): Map<string, number> {
  const cached = OVERRIDE_LOOKUP_CACHE.get(overrides);
  if (cached) {
    return cached;
  }
  const lookup = toLowercasedLookup(overrides);
  OVERRIDE_LOOKUP_CACHE.set(overrides, lookup);
  return lookup;
}

/** Resolve the default estimated-minutes for an item type. Precedence: overrides (case-insensitive key match) > DEFAULT_ESTIMATE_MINUTES_BY_TYPE (case-insensitive) > FALLBACK_ESTIMATE_MINUTES. - `type` undefined/empty -> FALLBACK. - Only finite values > 0 are honored from overrides/defaults; a non-positive or non-finite override value is ignored and resolution continues to the next tier. - Returned value is a positive integer (floor of the resolved value). */
export function resolveEstimateDefaultMinutes(
  type: string | undefined,
  overrides?: Readonly<Record<string, number>>,
): number {
  const key = (type ?? "").trim().toLowerCase();
  if (key.length === 0) {
    return FALLBACK_ESTIMATE_MINUTES;
  }

  if (overrides) {
    const overrideValue = lowercasedOverrideLookup(overrides).get(key);
    if (isHonoredMinutes(overrideValue)) {
      return Math.floor(overrideValue);
    }
  }

  const builtinValue = BUILTIN_LOWERCASED_LOOKUP.get(key);
  if (isHonoredMinutes(builtinValue)) {
    return Math.floor(builtinValue);
  }

  return FALLBACK_ESTIMATE_MINUTES;
}

/** Validate + normalize a raw `validation.estimate_defaults_by_type` settings object into a clean Record<string, number> of positive integers, dropping invalid entries. Used so the pure resolver always receives a sane override map. Returns {} for undefined/null/non-object input. Trims keys; ignores empty keys and non-positive / non-finite / non-number values. Floors values to integers. */
export function normalizeEstimateDefaultOverrides(
  raw: unknown,
): Record<string, number> {
  const normalized: Record<string, number> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return normalized;
  }

  for (const [rawKey, rawValue] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const key = rawKey.trim();
    if (key.length === 0 || !isHonoredMinutes(rawValue)) {
      continue;
    }
    normalized[key] = Math.floor(rawValue);
  }

  return normalized;
}
