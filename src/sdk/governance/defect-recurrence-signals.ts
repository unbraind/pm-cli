/**
 * @module sdk/defect-recurrence-signals
 *
 * Keeps the recurrence index's PM-item projection shared with transport caches
 * without exposing internal full-record serialization as an invalidation rule.
 */
import type { AssuranceItemRecord } from "./assurance.js";
import type { DefectChangeRiskInput } from "./defect-recurrence.js";

/** Project one PM item to exactly the signals consumed by recurrence indexing. */
export function defectRecurrenceItemSignals(
  item: AssuranceItemRecord,
): DefectChangeRiskInput {
  return {
    files: (Array.isArray(item.files) ? item.files : []).flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        return [];
      const value = (entry as { path?: unknown }).path;
      return typeof value === "string" ? [value] : [];
    }),
    package_names: Array.isArray(item.package_names)
      ? item.package_names.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    item_ids: [item.id],
    tags: Array.isArray(item.tags)
      ? item.tags.filter((value): value is string => typeof value === "string")
      : [],
    error_codes: Array.isArray(item.error_codes)
      ? item.error_codes.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  };
}
