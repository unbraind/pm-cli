import { coerceRuntimeFieldValue, readRuntimeFieldOptionValue } from "./runtime-field-values.js";
import type { RuntimeFieldCommand, RuntimeFieldRegistry } from "./runtime-schema.js";
import { stableValueEquals } from "../shared/serialization.js";

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableValueEquals(left, right);
}

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
