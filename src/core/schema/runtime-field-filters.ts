/**
 * @module core/schema/runtime-field-filters
 *
 * Resolves configurable schema, fields, statuses, and workflows for Runtime Field Filters.
 */
import { coerceRuntimeFieldValue, readRuntimeFieldOptionValue } from "./runtime-field-values.js";
import type { RuntimeFieldCommand, RuntimeFieldRegistry } from "./runtime-schema.js";
import { stableValueEquals } from "../shared/serialization.js";

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableValueEquals(left, right);
}

/**
 * Implements collect runtime filter values for the public runtime surface of this module.
 */
export function collectRuntimeFilterValues(
  options: Record<string, unknown>,
  fieldRegistry: RuntimeFieldRegistry,
  command: RuntimeFieldCommand,
): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  for (const definition of fieldRegistry.command_to_fields.get(command) ?? []) {
    const rawValue = readRuntimeFieldOptionValue(options, definition);
    if (rawValue === undefined) {
      continue;
    }
    filters[definition.metadata_key] = coerceRuntimeFieldValue(definition, rawValue);
  }
  return filters;
}

/**
 * Implements matches runtime filters for the public runtime surface of this module.
 */
export function matchesRuntimeFilters(item: Record<string, unknown>, filters: Record<string, unknown>): boolean {
  for (const [fieldKey, expectedValue] of Object.entries(filters)) {
    const actualValue = item[fieldKey];
    if (Array.isArray(expectedValue)) {
      if (Array.isArray(actualValue)) {
        const normalizedActual = actualValue.map((value) => String(value));
        const normalizedExpected = expectedValue.map((value) => String(value));
        if (!normalizedExpected.every((value) => normalizedActual.includes(value))) {
          return false;
        }
        continue;
      }
      if (!valuesEqual(actualValue, expectedValue[expectedValue.length - 1])) {
        return false;
      }
      continue;
    }
    if (!valuesEqual(actualValue, expectedValue)) {
      return false;
    }
  }
  return true;
}
