/** @module cli/option-values Shared normalization for repeatable Commander option values. */

/** Preserve collected arrays and legacy scalar values, leaving absent options undefined. */
export function stringArrayOption(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") return [value];
  return undefined;
}
