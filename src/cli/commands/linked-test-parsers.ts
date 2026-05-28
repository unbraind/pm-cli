import { parseOptionalNumber } from "../../core/item/parse.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { splitCommaList } from "../../core/shared/split-comma-list.js";
import type { LinkedTest } from "../../types/index.js";

/**
 * Shared linked-test field parsers used by the `create` and `test` commands.
 *
 * Extracted verbatim from create.ts and test.ts (pm-why9). The two copies were
 * byte-identical apart from their empty-input guard: create called these with
 * raw (untrimmed) values and used `if (!normalized)`; test called them with
 * pre-`.trim()`-ed values and used `if (!raw || raw.trim().length === 0)`.
 *
 * Both reduce to the same observable behaviour when the guard is the plain
 * falsy check used here: create's call sites still pass untrimmed values
 * (behaviour preserved exactly), and test's call sites pre-trim so a
 * whitespace-only value collapses to "" and is rejected by `!raw` exactly as
 * before. Error strings and parsing semantics are identical to both originals.
 */

export const LINKED_TEST_PROTECTED_ENV_KEYS = new Set(["PM_PATH", "PM_GLOBAL_PATH", "FORCE_COLOR"]);
export const LINKED_TEST_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const LINKED_TEST_PM_CONTEXT_MODE_VALUES = ["schema", "tracker", "auto"] as const;
export type LinkedTestPmContextMode = (typeof LINKED_TEST_PM_CONTEXT_MODE_VALUES)[number];

export function parseLinkedTestEnvSet(raw: string | undefined, optionName: string): Record<string, string> | undefined {
  if (!raw) {
    return undefined;
  }
  const assignments = raw
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (assignments.length === 0) {
    throw new PmCliError(`${optionName} env_set must include at least one KEY=VALUE assignment`, EXIT_CODE.USAGE);
  }
  const envSet: Record<string, string> = {};
  for (const assignment of assignments) {
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex <= 0) {
      throw new PmCliError(
        `${optionName} env_set entries must use KEY=VALUE and be separated by semicolons. Example: env_set=PORT=0;PLAYWRIGHT_BASE_URL=http://127.0.0.1:4173`,
        EXIT_CODE.USAGE,
      );
    }
    const key = assignment.slice(0, separatorIndex).trim();
    const value = assignment.slice(separatorIndex + 1);
    if (!LINKED_TEST_ENV_NAME_PATTERN.test(key)) {
      throw new PmCliError(`${optionName} env_set key "${key}" is invalid`, EXIT_CODE.USAGE);
    }
    if (LINKED_TEST_PROTECTED_ENV_KEYS.has(key.toUpperCase())) {
      throw new PmCliError(`${optionName} env_set key "${key}" is reserved for sandbox safety`, EXIT_CODE.USAGE);
    }
    envSet[key] = value;
  }
  /* c8 ignore start -- envSet always has >=1 key here (assignments is non-empty and each adds one); the undefined branch is defensive. */
  return Object.keys(envSet).length > 0 ? envSet : undefined;
  /* c8 ignore stop */
}

export function parseLinkedTestEnvClear(raw: string | undefined, optionName: string): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const keys = splitCommaList(raw, { separators: /[;,\n]/ });
  if (keys.length === 0) {
    throw new PmCliError(`${optionName} env_clear must include at least one environment variable name`, EXIT_CODE.USAGE);
  }
  for (const key of keys) {
    if (!LINKED_TEST_ENV_NAME_PATTERN.test(key)) {
      throw new PmCliError(`${optionName} env_clear key "${key}" is invalid`, EXIT_CODE.USAGE);
    }
    if (LINKED_TEST_PROTECTED_ENV_KEYS.has(key.toUpperCase())) {
      throw new PmCliError(`${optionName} env_clear key "${key}" is reserved for sandbox safety`, EXIT_CODE.USAGE);
    }
  }
  return keys;
}

export function parseLinkedTestBoolean(raw: string | undefined, optionName: string, fieldLabel: string): boolean | undefined {
  if (!raw) {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  if (value === "false" || value === "0" || value === "no") {
    return false;
  }
  throw new PmCliError(`${optionName} ${fieldLabel} must be one of true|false|1|0|yes|no`, EXIT_CODE.USAGE);
}

export function parseLinkedTestContextMode(
  raw: string | undefined,
  optionName: string,
): LinkedTest["pm_context_mode"] | undefined {
  if (!raw) {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if ((LINKED_TEST_PM_CONTEXT_MODE_VALUES as readonly string[]).includes(value)) {
    return value as LinkedTest["pm_context_mode"];
  }
  throw new PmCliError(
    `${optionName} pm_context_mode must be one of: ${LINKED_TEST_PM_CONTEXT_MODE_VALUES.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

export function parseLinkedTestStringList(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const values = splitCommaList(raw, { separators: /[;\n]/ });
  return values.length > 0 ? values : undefined;
}

export function parseLinkedTestRegexList(raw: string | undefined, optionName: string, fieldLabel: string): string[] | undefined {
  const values = parseLinkedTestStringList(raw);
  if (!values || values.length === 0) {
    return undefined;
  }
  for (const pattern of values) {
    try {
      // Validate regex syntax early so malformed assertions fail at parse time.
      // User-provided, per-item patterns only run during local CLI validation.
      new RegExp(pattern, "m");
    } catch (error: unknown) {
      throw new PmCliError(
        /* c8 ignore next -- RegExp only throws SyntaxError (an Error); String(error) fallback is defensive. */
        `${optionName} ${fieldLabel} includes invalid regex "${pattern}": ${error instanceof Error ? error.message : String(error)}`,
        EXIT_CODE.USAGE,
      );
    }
  }
  return values;
}

export function parseLinkedTestMinLines(raw: string | undefined, optionName: string): number | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = parseOptionalNumber(raw, "assert_stdout_min_lines");
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PmCliError(`${optionName} assert_stdout_min_lines must be an integer >= 0`, EXIT_CODE.USAGE);
  }
  return parsed;
}

export function parseLinkedTestAssertionEqualsMap(raw: string | undefined, optionName: string): Record<string, string> | undefined {
  if (!raw) {
    return undefined;
  }
  const assignments = raw
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (assignments.length === 0) {
    throw new PmCliError(`${optionName} assert_json_field_equals must include at least one path=value assignment`, EXIT_CODE.USAGE);
  }
  const values: Record<string, string> = {};
  for (const assignment of assignments) {
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex <= 0) {
      throw new PmCliError(
        `${optionName} assert_json_field_equals entries must use path=value and be separated by semicolons`,
        EXIT_CODE.USAGE,
      );
    }
    const key = assignment.slice(0, separatorIndex).trim();
    const value = assignment.slice(separatorIndex + 1).trim();
    if (key.length === 0 || value.length === 0) {
      throw new PmCliError(`${optionName} assert_json_field_equals entries must include non-empty path and value`, EXIT_CODE.USAGE);
    }
    values[key] = value;
  }
  /* c8 ignore start -- values always has >=1 key here (assignments is non-empty and each adds one); the undefined branch is defensive. */
  return Object.keys(values).length > 0 ? values : undefined;
  /* c8 ignore stop */
}

export function parseLinkedTestAssertionGteMap(raw: string | undefined, optionName: string): Record<string, number> | undefined {
  if (!raw) {
    return undefined;
  }
  const assignments = raw
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (assignments.length === 0) {
    throw new PmCliError(`${optionName} assert_json_field_gte must include at least one path=value assignment`, EXIT_CODE.USAGE);
  }
  const values: Record<string, number> = {};
  for (const assignment of assignments) {
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex <= 0) {
      throw new PmCliError(
        `${optionName} assert_json_field_gte entries must use path=value and be separated by semicolons`,
        EXIT_CODE.USAGE,
      );
    }
    const key = assignment.slice(0, separatorIndex).trim();
    const valueRaw = assignment.slice(separatorIndex + 1).trim();
    if (key.length === 0 || valueRaw.length === 0) {
      throw new PmCliError(`${optionName} assert_json_field_gte entries must include non-empty path and value`, EXIT_CODE.USAGE);
    }
    const value = Number.parseFloat(valueRaw);
    if (!Number.isFinite(value)) {
      throw new PmCliError(`${optionName} assert_json_field_gte value for "${key}" must be numeric`, EXIT_CODE.USAGE);
    }
    values[key] = value;
  }
  /* c8 ignore start -- values always has >=1 key here (assignments is non-empty and each adds one); the undefined branch is defensive. */
  return Object.keys(values).length > 0 ? values : undefined;
  /* c8 ignore stop */
}
