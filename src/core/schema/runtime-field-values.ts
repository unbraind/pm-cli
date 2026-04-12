import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { runtimeFieldOptionTarget, type RuntimeFieldDefinitionResolved, type RuntimeFieldRegistry } from "./runtime-schema.js";

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

function resolveCandidateOptionKeys(definition: RuntimeFieldDefinitionResolved): string[] {
  return [...new Set([
    runtimeFieldOptionTarget(definition),
    toCamelToken(definition.key),
    toCamelToken(definition.cli_flag),
    ...definition.cli_aliases.map((alias) => toCamelToken(alias)),
  ])];
}

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
  throw new PmCliError(`${label} must be one of true|false|1|0|yes|no`, EXIT_CODE.USAGE);
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

export function coerceRuntimeFieldValue(
  definition: RuntimeFieldDefinitionResolved,
  rawValue: unknown,
  labelOverride?: string,
): unknown {
  const label = labelOverride ?? `--${definition.cli_flag}`;
  if (definition.repeatable || definition.type === "string_array") {
    const values = normalizeStringArrayValue(rawValue);
    if (definition.type === "number") {
      return values.map((value) => parseNumberValue(value, label));
    }
    if (definition.type === "boolean") {
      return values.map((value) => parseBooleanValue(value, label));
    }
    return values;
  }

  const scalarRaw = Array.isArray(rawValue) ? rawValue[rawValue.length - 1] : rawValue;
  if (scalarRaw === undefined) {
    return undefined;
  }
  if (definition.type === "number") {
    return parseNumberValue(scalarRaw, label);
  }
  if (definition.type === "boolean") {
    return parseBooleanValue(scalarRaw, label);
  }
  return typeof scalarRaw === "string" ? scalarRaw : String(scalarRaw);
}

function shouldRequireFieldOnCreate(definition: RuntimeFieldDefinitionResolved, itemTypeName: string | undefined): boolean {
  if (!definition.required && !definition.required_on_create) {
    return false;
  }
  if (definition.required_types.length === 0) {
    return true;
  }
  if (!itemTypeName) {
    return false;
  }
  return definition.required_types.map((value) => value.toLowerCase()).includes(itemTypeName.trim().toLowerCase());
}

export function collectRuntimeCreateFieldValues(
  options: Record<string, unknown>,
  fieldRegistry: RuntimeFieldRegistry,
  itemTypeName: string | undefined,
): { values: Record<string, unknown>; missing_required_flags: string[] } {
  const values: Record<string, unknown> = {};
  const missingRequiredFlags: string[] = [];
  for (const definition of fieldRegistry.command_to_fields.get("create") ?? []) {
    const rawValue = readRuntimeFieldOptionValue(options, definition);
    if (rawValue === undefined) {
      if (shouldRequireFieldOnCreate(definition, itemTypeName)) {
        missingRequiredFlags.push(`--${definition.cli_flag}`);
      }
      continue;
    }
    values[definition.front_matter_key] = coerceRuntimeFieldValue(definition, rawValue);
  }
  return {
    values,
    missing_required_flags: [...new Set(missingRequiredFlags)].sort((left, right) => left.localeCompare(right)),
  };
}

export function collectRuntimeUpdateFieldValues(
  options: Record<string, unknown>,
  fieldRegistry: RuntimeFieldRegistry,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const definition of fieldRegistry.command_to_fields.get("update") ?? []) {
    const rawValue = readRuntimeFieldOptionValue(options, definition);
    if (rawValue === undefined) {
      continue;
    }
    values[definition.front_matter_key] = coerceRuntimeFieldValue(definition, rawValue);
  }
  return values;
}
