import { parseOptionalNumber } from "../../core/item/parse.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { splitCommaList } from "../../core/shared/split-comma-list.js";
import { STRUCTURED_LINKED_TEST_KEYS } from "./linked-test-entry.js";
import { SCOPE_VALUES } from "../../types/index.js";
import type { LinkedTest, LinkScope } from "../../types/index.js";

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

/**
 * Strict JSON linked-test entry parsing for `pm test --add-json` (pm-vcr2).
 *
 * Accepts a JSON object or array of objects whose keys match the structured
 * linked-test fields. Unlike `--add` CSV parsing, command strings are stored
 * verbatim: commas, nested quotes, `--` separators, and shell variables like
 * `$tmp` survive byte-identically.
 */

const LINKED_TEST_JSON_KEY_SET = new Set<string>(STRUCTURED_LINKED_TEST_KEYS);

type JsonRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeJsonEntryKeys(entry: JsonRecord, fail: (message: string) => PmCliError): JsonRecord {
  const normalized: JsonRecord = {};
  const unknownKeys: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    const normalizedKey = key.toLowerCase();
    if (!LINKED_TEST_JSON_KEY_SET.has(normalizedKey)) {
      unknownKeys.push(key);
      continue;
    }
    if (normalizedKey in normalized) {
      throw fail(`provides key "${key}" more than once after case normalization`);
    }
    normalized[normalizedKey] = value;
  }
  if (unknownKeys.length > 0) {
    throw fail(
      `does not recognize key${unknownKeys.length > 1 ? "s" : ""} ${unknownKeys.map((key) => `"${key}"`).join(", ")}. Allowed keys: ${STRUCTURED_LINKED_TEST_KEYS.join(", ")}.`,
    );
  }
  return normalized;
}

function readJsonEntryString(entry: JsonRecord, key: string, fail: (message: string) => PmCliError): string | undefined {
  const value = entry[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw fail(`field "${key}" must be a JSON string`);
  }
  return value;
}

function readJsonEntryStringList(entry: JsonRecord, key: string, fail: (message: string) => PmCliError): string[] | undefined {
  const value = entry[key];
  if (value === undefined) {
    return undefined;
  }
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) {
    throw fail(`field "${key}" must be a string or an array of strings`);
  }
  const values = (list as string[]).filter((item) => item.length > 0);
  return values.length > 0 ? values : undefined;
}

function readJsonEntryRegexList(entry: JsonRecord, key: string, fail: (message: string) => PmCliError): string[] | undefined {
  const values = readJsonEntryStringList(entry, key, fail);
  if (!values) {
    return undefined;
  }
  for (const pattern of values) {
    try {
      new RegExp(pattern, "m");
    } catch (error: unknown) {
      throw fail(
        /* c8 ignore next -- RegExp only throws SyntaxError (an Error); String(error) fallback is defensive. */
        `field "${key}" includes invalid regex "${pattern}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return values;
}

function readJsonEntryNumber(value: unknown, key: string, fail: (message: string) => PmCliError): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (typeof value === "boolean" || !Number.isFinite(parsed)) {
    throw fail(`field "${key}" must be a finite number (or numeric string)`);
  }
  return parsed;
}

function readJsonEntryTimeoutSeconds(entry: JsonRecord, fail: (message: string) => PmCliError): number | undefined {
  const timeoutSecondsRaw = entry.timeout_seconds;
  const timeoutAliasRaw = entry.timeout;
  if (timeoutSecondsRaw === undefined && timeoutAliasRaw === undefined) {
    return undefined;
  }
  const timeoutSeconds = timeoutSecondsRaw === undefined ? undefined : readJsonEntryNumber(timeoutSecondsRaw, "timeout_seconds", fail);
  const timeoutAlias = timeoutAliasRaw === undefined ? undefined : readJsonEntryNumber(timeoutAliasRaw, "timeout", fail);
  if (timeoutSeconds !== undefined && timeoutAlias !== undefined && timeoutSeconds !== timeoutAlias) {
    throw fail("timeout and timeout_seconds must match when both are provided");
  }
  return Math.floor(timeoutSeconds ?? (timeoutAlias as number));
}

function readJsonEntryScope(entry: JsonRecord, fail: (message: string) => PmCliError): LinkScope {
  const value = readJsonEntryString(entry, "scope", fail);
  if (value === undefined) {
    return "project";
  }
  if (!(SCOPE_VALUES as readonly string[]).includes(value)) {
    throw fail(`field "scope" must be one of: ${SCOPE_VALUES.join(", ")}`);
  }
  return value as LinkScope;
}

function readJsonEntryEnvSet(entry: JsonRecord, fail: (message: string) => PmCliError): Record<string, string> | undefined {
  const value = entry.env_set;
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw fail('field "env_set" must be a JSON object mapping environment names to string values');
  }
  const envSet: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "string") {
      throw fail(`field "env_set" value for "${key}" must be a string`);
    }
    if (!LINKED_TEST_ENV_NAME_PATTERN.test(key)) {
      throw fail(`field "env_set" key "${key}" is invalid`);
    }
    if (LINKED_TEST_PROTECTED_ENV_KEYS.has(key.toUpperCase())) {
      throw fail(`field "env_set" key "${key}" is reserved for sandbox safety`);
    }
    envSet[key] = entryValue;
  }
  return Object.keys(envSet).length > 0 ? envSet : undefined;
}

function readJsonEntryEnvClear(entry: JsonRecord, fail: (message: string) => PmCliError): string[] | undefined {
  const keys = readJsonEntryStringList(entry, "env_clear", fail);
  if (!keys) {
    return undefined;
  }
  for (const key of keys) {
    if (!LINKED_TEST_ENV_NAME_PATTERN.test(key)) {
      throw fail(`field "env_clear" key "${key}" is invalid`);
    }
    if (LINKED_TEST_PROTECTED_ENV_KEYS.has(key.toUpperCase())) {
      throw fail(`field "env_clear" key "${key}" is reserved for sandbox safety`);
    }
  }
  return keys;
}

function readJsonEntryBoolean(entry: JsonRecord, key: string, fail: (message: string) => PmCliError): boolean | undefined {
  const value = entry[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw fail(`field "${key}" must be a JSON boolean (true or false)`);
  }
  return value;
}

function readJsonEntryMinLines(entry: JsonRecord, fail: (message: string) => PmCliError): number | undefined {
  const value = entry.assert_stdout_min_lines;
  if (value === undefined) {
    return undefined;
  }
  const parsed = readJsonEntryNumber(value, "assert_stdout_min_lines", fail);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw fail('field "assert_stdout_min_lines" must be an integer >= 0');
  }
  return parsed;
}

function readJsonEntryEqualsMap(entry: JsonRecord, fail: (message: string) => PmCliError): Record<string, string> | undefined {
  const value = entry.assert_json_field_equals;
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw fail('field "assert_json_field_equals" must be a JSON object mapping field paths to expected values');
  }
  const values: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (key.trim().length === 0) {
      throw fail('field "assert_json_field_equals" keys must be non-empty field paths');
    }
    if (typeof entryValue !== "string" && typeof entryValue !== "number" && typeof entryValue !== "boolean") {
      throw fail(`field "assert_json_field_equals" value for "${key}" must be a string, number, or boolean`);
    }
    values[key] = String(entryValue);
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

function readJsonEntryGteMap(entry: JsonRecord, fail: (message: string) => PmCliError): Record<string, number> | undefined {
  const value = entry.assert_json_field_gte;
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw fail('field "assert_json_field_gte" must be a JSON object mapping field paths to numeric minimums');
  }
  const values: Record<string, number> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (key.trim().length === 0) {
      throw fail('field "assert_json_field_gte" keys must be non-empty field paths');
    }
    values[key] = readJsonEntryNumber(entryValue, `assert_json_field_gte.${key}`, fail);
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

function parseLinkedTestJsonEntry(rawEntry: unknown, label: string, optionName: string): LinkedTest {
  const fail = (message: string): PmCliError => new PmCliError(`${optionName} ${label} ${message}`, EXIT_CODE.USAGE);
  if (!isPlainObject(rawEntry)) {
    throw fail(`must be a JSON object with linked-test fields. Allowed keys: ${STRUCTURED_LINKED_TEST_KEYS.join(", ")}.`);
  }
  const entry = normalizeJsonEntryKeys(rawEntry, fail);
  const commandValue = readJsonEntryString(entry, "command", fail);
  const cmdAlias = readJsonEntryString(entry, "cmd", fail);
  if (commandValue !== undefined && cmdAlias !== undefined && commandValue !== cmdAlias) {
    throw fail("command and cmd must match when both are provided");
  }
  const command = commandValue ?? cmdAlias;
  if (command === undefined || command.trim().length === 0) {
    throw fail('requires a non-empty "command" string');
  }
  const pathValue = readJsonEntryString(entry, "path", fail);
  const pmContextModeValue = readJsonEntryString(entry, "pm_context_mode", fail);
  if (pmContextModeValue !== undefined && !(LINKED_TEST_PM_CONTEXT_MODE_VALUES as readonly string[]).includes(pmContextModeValue)) {
    throw fail(`field "pm_context_mode" must be one of: ${LINKED_TEST_PM_CONTEXT_MODE_VALUES.join(", ")}`);
  }
  const noteValue = readJsonEntryString(entry, "note", fail);
  return {
    command,
    path: pathValue !== undefined && pathValue.length > 0 ? pathValue : undefined,
    scope: readJsonEntryScope(entry, fail),
    timeout_seconds: readJsonEntryTimeoutSeconds(entry, fail),
    pm_context_mode: pmContextModeValue as LinkedTest["pm_context_mode"],
    env_set: readJsonEntryEnvSet(entry, fail),
    env_clear: readJsonEntryEnvClear(entry, fail),
    shared_host_safe: readJsonEntryBoolean(entry, "shared_host_safe", fail),
    assert_stdout_contains: readJsonEntryStringList(entry, "assert_stdout_contains", fail),
    assert_stdout_regex: readJsonEntryRegexList(entry, "assert_stdout_regex", fail),
    assert_stderr_contains: readJsonEntryStringList(entry, "assert_stderr_contains", fail),
    assert_stderr_regex: readJsonEntryRegexList(entry, "assert_stderr_regex", fail),
    assert_stdout_min_lines: readJsonEntryMinLines(entry, fail),
    assert_json_field_equals: readJsonEntryEqualsMap(entry, fail),
    assert_json_field_gte: readJsonEntryGteMap(entry, fail),
    note: noteValue !== undefined && noteValue.trim().length > 0 ? noteValue.trim() : undefined,
  };
}

export function parseLinkedTestJsonEntries(raw: string, optionName: string): LinkedTest[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new PmCliError(
      `${optionName} requires a JSON object or array of objects describing linked-test entries`,
      EXIT_CODE.USAGE,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error: unknown) {
    throw new PmCliError(
      /* c8 ignore next -- JSON.parse only throws SyntaxError (an Error); String(error) fallback is defensive. */
      `${optionName} value is not valid JSON: ${error instanceof Error ? error.message : String(error)}. Provide a JSON object or array of objects, e.g. '{"command":"node scripts/check.js --flag value, with commas","timeout_seconds":120}'.`,
      EXIT_CODE.USAGE,
    );
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length === 0) {
    throw new PmCliError(`${optionName} array must include at least one linked-test entry object`, EXIT_CODE.USAGE);
  }
  return entries.map((entry, index) =>
    parseLinkedTestJsonEntry(entry, entries.length > 1 ? `entry ${index + 1}` : "entry", optionName),
  );
}
