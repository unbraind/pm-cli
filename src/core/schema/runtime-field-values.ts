/**
 * @module core/schema/runtime-field-values
 *
 * Resolves configurable schema, fields, statuses, and workflows for Runtime Field Values.
 */
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { stableStringify } from "../shared/serialization.js";
import { isRfc3339DateTime } from "../shared/time.js";
import {
  runtimeFieldOptionTarget,
  type RuntimeFieldDefinitionResolved,
  type RuntimeFieldRegistry,
} from "./runtime-schema.js";
import type { RuntimeFieldValueSchema } from "../../types/index.js";

const MAX_VALUE_SCHEMA_DEPTH = 16;

function toCamelToken(value: string): string {
  const segments = value
    .trim()
    .replaceAll(/[^A-Za-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
  if (segments.length === 0) {
    return value;
  }
  const [first, ...rest] = segments;
  return `${first}${rest.map((segment) => `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`).join("")}`;
}

function resolveCandidateOptionKeys(
  definition: RuntimeFieldDefinitionResolved,
): string[] {
  return [
    ...new Set([
      runtimeFieldOptionTarget(definition),
      toCamelToken(definition.key),
      toCamelToken(definition.cli_flag),
      ...definition.cli_aliases.map((alias) => toCamelToken(alias)),
    ]),
  ];
}

/** Implements read runtime field option value for the public runtime surface of this module. */
export function readRuntimeFieldOptionValue(
  options: Record<string, unknown>,
  definition: RuntimeFieldDefinitionResolved,
): unknown {
  for (const candidateKey of resolveCandidateOptionKeys(definition)) {
    if (!Object.hasOwn(options, candidateKey)) {
      continue;
    }
    const value = options[candidateKey];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function normalizeStringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => normalizeStringArrayValue(entry))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\n|]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [String(value).trim()].filter((entry) => entry.length > 0);
}

function parseBooleanValue(raw: unknown, label: string): boolean {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "number") {
    if (raw === 1) {
      return true;
    }
    if (raw === 0) {
      return false;
    }
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }
  throw new PmCliError(
    `${label} must be one of true|false|1|0|yes|no`,
    EXIT_CODE.USAGE,
  );
}

function parseNumberValue(raw: unknown, label: string): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  const candidate = typeof raw === "string" ? raw.trim() : String(raw);
  const parsed = Number(candidate);
  if (!Number.isFinite(parsed)) {
    throw new PmCliError(`${label} must be a number`, EXIT_CODE.USAGE);
  }
  return parsed;
}

function parseJsonContainerValue(
  raw: unknown,
  label: string,
  expectedType: "array" | "object",
): unknown {
  const parsed =
    typeof raw === "string"
      ? (() => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return undefined;
          }
        })()
      : raw;
  if (
    (expectedType === "array" && Array.isArray(parsed)) ||
    (expectedType === "object" &&
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed))
  ) {
    return parsed;
  }
  throw new PmCliError(
    `${label} must be valid JSON ${expectedType}`,
    EXIT_CODE.USAGE,
  );
}

function valueMatchesSchemaType(
  value: unknown,
  type: RuntimeFieldValueSchema["type"],
): boolean {
  if (type === undefined) return true;
  if (type === "array") return Array.isArray(value);
  if (type === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  return typeof value === type;
}

function runtimeFieldPrimitiveSchemaError(
  value: unknown,
  schema: RuntimeFieldValueSchema,
  path: string,
): string | undefined {
  if (
    schema.const !== undefined &&
    stableStringify(value) !== stableStringify(schema.const)
  ) {
    return `${path} must equal ${stableStringify(schema.const)}`;
  }
  if (
    schema.enum !== undefined &&
    !schema.enum.some(
      (candidate) => stableStringify(candidate) === stableStringify(value),
    )
  ) {
    return `${path} must be one of ${schema.enum.map((entry) => stableStringify(entry)).join("|")}`;
  }
  if (!valueMatchesSchemaType(value, schema.type)) {
    return `${path} must match configured type ${String(schema.type)}`;
  }
  if (typeof value === "string") {
    if (schema.min_length !== undefined && value.length < schema.min_length) {
      return `${path} must contain at least ${schema.min_length} characters`;
    }
    if (schema.format === "date-time" && !isRfc3339DateTime(value)) {
      return `${path} must be an RFC 3339 date-time`;
    }
  }
  return undefined;
}

function runtimeFieldArraySchemaError(
  value: unknown,
  schema: RuntimeFieldValueSchema,
  path: string,
  depth: number,
): string | undefined {
  if (!Array.isArray(value)) return undefined;
  if (schema.min_items !== undefined && value.length < schema.min_items) {
    return `${path} must contain at least ${schema.min_items} items`;
  }
  if (!schema.items) return undefined;
  for (const [index, entry] of value.entries()) {
    const error = runtimeFieldSchemaError(
      entry,
      schema.items,
      `${path}[${index}]`,
      depth + 1,
    );
    if (error) return error;
  }
  return undefined;
}

function runtimeFieldObjectSchemaError(
  value: unknown,
  schema: RuntimeFieldValueSchema,
  path: string,
  depth: number,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(record, key)) return `${path}.${key} is required`;
  }
  for (const [key, entry] of Object.entries(record)) {
    const propertySchema = schema.properties?.[key];
    if (!propertySchema) {
      if (schema.additional_properties === false)
        return `${path}.${key} is not allowed`;
      continue;
    }
    const error = runtimeFieldSchemaError(
      entry,
      propertySchema,
      `${path}.${key}`,
      depth + 1,
    );
    if (error) return error;
  }
  return undefined;
}

/** Return the first semantic schema mismatch without mutating the input value. */
function runtimeFieldSchemaError(
  value: unknown,
  schema: RuntimeFieldValueSchema,
  path: string,
  depth = 0,
): string | undefined {
  if (depth > MAX_VALUE_SCHEMA_DEPTH)
    return `${path} value schema exceeds maximum depth`;
  const directError = runtimeFieldPrimitiveSchemaError(value, schema, path);
  if (directError) return directError;
  const arrayError = runtimeFieldArraySchemaError(value, schema, path, depth);
  if (arrayError) return arrayError;
  const objectError = runtimeFieldObjectSchemaError(value, schema, path, depth);
  if (objectError) return objectError;
  if (!schema.one_of) return undefined;
  let matches = 0;
  for (const candidate of schema.one_of) {
    if (
      runtimeFieldSchemaError(value, candidate, path, depth + 1) === undefined
    ) {
      matches += 1;
      if (matches > 1) break;
    }
  }
  return matches === 1
    ? undefined
    : `${path} must match exactly one configured schema variant`;
}

function validateRuntimeFieldValue(
  definition: RuntimeFieldDefinitionResolved,
  value: unknown,
  label: string,
): unknown {
  if (!definition.value_schema || value === undefined) return value;
  const error = runtimeFieldSchemaError(value, definition.value_schema, label);
  if (error) throw new PmCliError(error, EXIT_CODE.USAGE);
  return value;
}

/** Implements coerce runtime field value for the public runtime surface of this module. */
export function coerceRuntimeFieldValue(
  definition: RuntimeFieldDefinitionResolved,
  rawValue: unknown,
  labelOverride?: string,
): unknown {
  const label = labelOverride ?? `--${definition.cli_flag}`;
  if (definition.type === "array" || definition.type === "object") {
    const containerRaw = Array.isArray(rawValue)
      ? rawValue[rawValue.length - 1]
      : rawValue;
    if (containerRaw === undefined) {
      return undefined;
    }
    return validateRuntimeFieldValue(
      definition,
      parseJsonContainerValue(containerRaw, label, definition.type),
      label,
    );
  }
  if (definition.repeatable || definition.type === "string_array") {
    const values = normalizeStringArrayValue(rawValue);
    if (definition.type === "number") {
      return validateRuntimeFieldValue(
        definition,
        values.map((value) => parseNumberValue(value, label)),
        label,
      );
    }
    if (definition.type === "boolean") {
      return validateRuntimeFieldValue(
        definition,
        values.map((value) => parseBooleanValue(value, label)),
        label,
      );
    }
    return validateRuntimeFieldValue(definition, values, label);
  }

  const scalarRaw = Array.isArray(rawValue)
    ? rawValue[rawValue.length - 1]
    : rawValue;
  if (scalarRaw === undefined) {
    return undefined;
  }
  if (definition.type === "number") {
    return validateRuntimeFieldValue(
      definition,
      parseNumberValue(scalarRaw, label),
      label,
    );
  }
  if (definition.type === "boolean") {
    return validateRuntimeFieldValue(
      definition,
      parseBooleanValue(scalarRaw, label),
      label,
    );
  }
  return validateRuntimeFieldValue(
    definition,
    typeof scalarRaw === "string" ? scalarRaw : String(scalarRaw),
    label,
  );
}

function shouldRequireFieldOnCreate(
  definition: RuntimeFieldDefinitionResolved,
  itemTypeName: string | undefined,
): boolean {
  if (!definition.required && !definition.required_on_create) {
    return false;
  }
  if (definition.required_types.length === 0) {
    return true;
  }
  if (!itemTypeName) {
    return false;
  }
  return definition.required_types
    .map((value) => value.toLowerCase())
    .includes(itemTypeName.trim().toLowerCase());
}

/** Implements collect runtime create field values for the public runtime surface of this module. */
export function collectRuntimeCreateFieldValues(
  options: Record<string, unknown>,
  fieldRegistry: RuntimeFieldRegistry,
  itemTypeName: string | undefined,
): { values: Record<string, unknown>; missing_required_flags: string[] } {
  const values: Record<string, unknown> = {};
  const missingRequiredFlags: string[] = [];
  for (const definition of fieldRegistry.command_to_fields.get("create") ??
    []) {
    const rawValue = readRuntimeFieldOptionValue(options, definition);
    if (rawValue === undefined) {
      if (shouldRequireFieldOnCreate(definition, itemTypeName)) {
        missingRequiredFlags.push(`--${definition.cli_flag}`);
      }
      continue;
    }
    values[definition.metadata_key] = coerceRuntimeFieldValue(
      definition,
      rawValue,
    );
  }
  return {
    values,
    missing_required_flags: [...new Set(missingRequiredFlags)].sort(
      (left, right) => left.localeCompare(right),
    ),
  };
}

/** Implements collect runtime update field values for the public runtime surface of this module. */
export function collectRuntimeUpdateFieldValues(
  options: Record<string, unknown>,
  fieldRegistry: RuntimeFieldRegistry,
  commands: Array<"update" | "update_many"> | null | undefined = ["update"],
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const definitions = (commands ?? ["update"]).flatMap(
    (command) => fieldRegistry.command_to_fields.get(command) ?? [],
  );
  const seen = new Set<string>();
  for (const definition of definitions) {
    const rawValue = readRuntimeFieldOptionValue(options, definition);
    if (rawValue === undefined) {
      continue;
    }
    if (seen.has(definition.metadata_key)) {
      continue;
    }
    seen.add(definition.metadata_key);
    values[definition.metadata_key] = coerceRuntimeFieldValue(
      definition,
      rawValue,
    );
  }
  return values;
}
