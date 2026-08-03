/**
 * @module sdk/query/multi-value-filters
 *
 * Provides reusable, presentation-neutral parsing for OR-composed query filters.
 */
import { resolveTypeName, type ItemTypeRegistry } from "../../core/item/type-registry.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import type { ItemType } from "../../types/index.js";
import { parsePriority } from "./parsers.js";

/** Options for parsing one repeatable or comma-separated query-filter value. */
export interface MultiValueFilterOptions {
  /** User-facing flag spelling included in validation errors. */
  label: string;
  /** Normalize each decoded token before de-duplication. */
  normalize?: (value: string) => string;
}

/**
 * Parses a comma-separated OR filter while supporting `\,` for a literal comma
 * and `\\` for a literal backslash. Empty values are rejected so scripts fail
 * before loading tracker data instead of silently matching an unintended scope.
 */
export function parseMultiValueFilter(
  raw: string | undefined,
  options: MultiValueFilterOptions,
): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const decoded: string[] = [];
  let current = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (character === "\\") {
      const next = raw[index + 1];
      if (next === "," || next === "\\") {
        current += next;
        index += 1;
        continue;
      }
      current += character;
      continue;
    }
    if (character === ",") {
      decoded.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  decoded.push(current);
  const values = decoded.map((value) => value.trim());
  if (values.some((value) => value.length === 0)) {
    throw new PmCliError(
      `${options.label} requires at least one non-empty value`,
      EXIT_CODE.USAGE,
    );
  }
  const normalized = values.map(
    (value) => options.normalize?.(value) ?? value,
  );
  return [...new Set(normalized)];
}

/** Parses a free-form string OR filter into a membership set. */
export function parseStringFilterSet(
  raw: string | undefined,
  options: MultiValueFilterOptions,
): Set<string> | undefined {
  const values = parseMultiValueFilter(raw, options);
  return values === undefined ? undefined : new Set(values);
}

/** Resolves every requested type token through the active runtime type registry. */
export function parseTypeFilterSet(
  raw: string | undefined,
  typeRegistry: ItemTypeRegistry,
  label = "--type",
): Set<ItemType> | undefined {
  const values = parseMultiValueFilter(raw, { label });
  if (values === undefined) {
    return undefined;
  }
  const resolved = values.map((value) => {
    const type = resolveTypeName(value, typeRegistry);
    if (!type) {
      throw new PmCliError(
        `${label} filter token "${value}" must be one of ${typeRegistry.types.join("|")}`,
        EXIT_CODE.USAGE,
      );
    }
    return type;
  });
  return new Set(resolved);
}

/** Validates every requested priority token and returns its numeric membership set. */
export function parsePriorityFilterSet(
  raw: string | undefined,
  label = "--priority",
): Set<number> | undefined {
  const values = parseMultiValueFilter(raw, { label });
  if (values === undefined) {
    return undefined;
  }
  return new Set(
    values.map((value) => parsePriority(value, label)!),
  );
}
