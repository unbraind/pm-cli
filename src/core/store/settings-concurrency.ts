/**
 * @module core/store/settings-concurrency
 *
 * Reconciles edits to a settings snapshot with the latest locked document.
 */
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { stableValueEquals } from "../shared/serialization.js";

/** Recognize JSON objects whose keys can be reconciled independently. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Preserve concurrent edits to untouched leaves. Arrays and scalar values are
 * indivisible: incompatible edits to the same leaf refuse the entire write.
 * Error receipts contain a key path, never the potentially secret values.
 */
export function reconcileSettingsSnapshot(
  baseline: unknown,
  proposed: unknown,
  current: unknown,
  segments: readonly string[] = [],
): unknown {
  if (stableValueEquals(baseline, proposed)) return current;
  if (stableValueEquals(baseline, current) || stableValueEquals(proposed, current)) {
    return proposed;
  }
  if ((baseline === undefined || isRecord(baseline)) && isRecord(proposed) && isRecord(current)) {
    const before = baseline ?? {};
    const keys = new Set([...Object.keys(before), ...Object.keys(proposed), ...Object.keys(current)]);
    return Object.fromEntries([...keys].flatMap((key) => {
      const merged = reconcileSettingsSnapshot(
        Object.hasOwn(before, key) ? before[key] : undefined,
        Object.hasOwn(proposed, key) ? proposed[key] : undefined,
        Object.hasOwn(current, key) ? current[key] : undefined,
        [...segments, key],
      );
      return merged === undefined ? [] : [[key, merged]];
    }));
  }
  throw new PmCliError(
    `Settings changed concurrently at ${segments.join(".") || "<root>"}; read the latest settings and reapply the intended change.`,
    EXIT_CODE.CONFLICT,
    {
      reason: "stale_settings_snapshot",
      required: "Read a fresh settings snapshot and reapply the intended change.",
      why: "Another writer changed the same setting after this snapshot was read.",
      examples: ["pm config project export --json"],
      nextSteps: ["Read the current settings, then retry the original config operation."],
    },
  );
}
