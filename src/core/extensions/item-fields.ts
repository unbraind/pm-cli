/**
 * @module core/extensions/item-fields
 *
 * Implements extension runtime contracts and governance for Item Fields.
 */
import type { ExtensionRegistrationRegistry } from "./loader.js";
import { normalizeItemFieldType, type KnownItemFieldType } from "./item-field-types.js";
import { EXIT_CODE, FRONT_MATTER_KEY_ORDER } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";

const reservedItemFieldNames = new Set(FRONT_MATTER_KEY_ORDER);

/** Item metadata keys extension-provided fields may never shadow, exposed without mutation methods. */
export const RESERVED_ITEM_FIELD_NAMES: ReadonlySet<string> = Object.freeze({
  get size(): number {
    return reservedItemFieldNames.size;
  },
  has(value: string): boolean {
    return reservedItemFieldNames.has(value);
  },
  entries(): SetIterator<[string, string]> {
    return reservedItemFieldNames.entries();
  },
  keys(): SetIterator<string> {
    return reservedItemFieldNames.keys();
  },
  values(): SetIterator<string> {
    return reservedItemFieldNames.values();
  },
  forEach(callback: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
    reservedItemFieldNames.forEach((value) => callback.call(thisArg, value, value, RESERVED_ITEM_FIELD_NAMES));
  },
  [Symbol.iterator](): SetIterator<string> {
    return reservedItemFieldNames.values();
  },
});

function normalizeFieldName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeFieldType(value: unknown): KnownItemFieldType | null {
  if (typeof value !== "string") {
    return null;
  }
  return normalizeItemFieldType(value);
}

function cloneFieldValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function parseFieldAssignment(raw: string): { key: string; value: string } {
  const trimmed = raw.trim();
  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0) {
    throw new PmCliError(`--field entries must use name=value syntax, received: ${raw}`, EXIT_CODE.USAGE);
  }
  // `separatorIndex > 0` guarantees a non-`=` first character on the already
  // trimmed string, so the trimmed key is always non-empty here.
  const key = trimmed.slice(0, separatorIndex).trim();
  const value = trimmed.slice(separatorIndex + 1);
  return { key, value };
}

function parseJsonFieldValue(raw: string, fieldName: string, expectedType: "array" | "object"): unknown {
  try {
    const parsed = JSON.parse(raw);
    if (expectedType === "array" && Array.isArray(parsed)) {
      return parsed;
    }
    if (expectedType === "object" && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to the typed usage error below.
  }
  throw new PmCliError(`--field ${fieldName}=... must be valid JSON ${expectedType}`, EXIT_CODE.USAGE);
}

function coerceRegisteredFieldValue(fieldName: string, fieldType: "string" | "number" | "boolean" | "array" | "object", raw: string): unknown {
  if (fieldType === "string") {
    return raw;
  }
  if (fieldType === "number") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new PmCliError(`--field ${fieldName}=... must be a number`, EXIT_CODE.USAGE);
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new PmCliError(`--field ${fieldName}=... must be a number`, EXIT_CODE.USAGE);
    }
    return parsed;
  }
  if (fieldType === "boolean") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
    throw new PmCliError(`--field ${fieldName}=... must be one of true|false|1|0|yes|no`, EXIT_CODE.USAGE);
  }
  return parseJsonFieldValue(raw, fieldName, fieldType);
}

function collectRegisteredFieldDefinitions(
  registrations: ExtensionRegistrationRegistry | null,
): Map<string, { name: string; type: "string" | "number" | "boolean" | "array" | "object" }> {
  const definitions = new Map<string, { name: string; type: "string" | "number" | "boolean" | "array" | "object" }>();
  if (!registrations) {
    return definitions;
  }
  for (const registration of registrations.item_fields) {
    for (const definition of registration.fields) {
      const fieldName = normalizeFieldName(definition.name);
      const fieldType = normalizeFieldType(definition.type);
      if (!fieldName || !fieldType) {
        continue;
      }
      const existing = definitions.get(fieldName);
      if (existing && existing.type !== fieldType) {
        throw new PmCliError(
          `Extension item field "${fieldName}" is declared with conflicting types: ${existing.type}, ${fieldType}`,
          EXIT_CODE.USAGE,
          {
            code: "extension_item_field_type_conflict",
            nextSteps: ["Make every active extension declaration for this field use the same type."],
          },
        );
      }
      definitions.set(fieldName, { name: fieldName, type: fieldType });
    }
  }
  return definitions;
}

function assertNotReservedItemFieldName(fieldName: string): void {
  if (!RESERVED_ITEM_FIELD_NAMES.has(fieldName)) {
    return;
  }
  throw new PmCliError(`Extension item field "${fieldName}" collides with reserved item metadata`, EXIT_CODE.USAGE, {
    code: "extension_item_field_reserved",
    nextSteps: ["Rename the extension item field, preferably with an extension-specific prefix."],
  });
}

/**
 * Implements collect registered item field names for the public runtime surface of this module.
 */
export function collectRegisteredItemFieldNames(registrations: ExtensionRegistrationRegistry | null): string[] {
  return [...collectRegisteredFieldDefinitions(registrations).keys()].sort((left, right) => left.localeCompare(right));
}

/**
 * Implements parse registered item field assignments for the public runtime surface of this module.
 */
export function parseRegisteredItemFieldAssignments(
  rawFields: string[] | undefined,
  registrations: ExtensionRegistrationRegistry | null,
): Record<string, unknown> {
  if (!rawFields || rawFields.length === 0) {
    return {};
  }
  const definitions = collectRegisteredFieldDefinitions(registrations);
  const values: Record<string, unknown> = {};
  for (const raw of rawFields) {
    const { key, value } = parseFieldAssignment(raw);
    const definition = definitions.get(key);
    if (!definition) {
      const known = [...definitions.keys()].sort((left, right) => left.localeCompare(right));
      throw new PmCliError(`--field ${key} is not declared by an active extension item-field registration`, EXIT_CODE.USAGE, {
        code: "extension_item_field_unknown",
        recovery: { provided_fields: known },
        nextSteps: known.length > 0
          ? [`Use one of the declared fields: ${known.join(", ")}`]
          : ["Activate an extension that calls registerItemFields before setting extension fields."],
      });
    }
    assertNotReservedItemFieldName(definition.name);
    values[definition.name] = coerceRegisteredFieldValue(definition.name, definition.type, value);
  }
  return values;
}

function isValidFieldType(value: unknown, expectedType: "string" | "number" | "boolean" | "array" | "object"): boolean {
  if (expectedType === "string") {
    return typeof value === "string";
  }
  if (expectedType === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (expectedType === "boolean") {
    return typeof value === "boolean";
  }
  if (expectedType === "array") {
    return Array.isArray(value);
  }
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedFieldValue(value: unknown, allowed: unknown[] | undefined): boolean {
  if (!allowed || allowed.length === 0) {
    return true;
  }
  return allowed.some((candidate) => Object.is(candidate, value));
}

/**
 * Implements apply registered item field defaults and validation for the public runtime surface of this module.
 */
export function applyRegisteredItemFieldDefaultsAndValidation(
  frontMatter: Record<string, unknown>,
  registrations: ExtensionRegistrationRegistry | null,
  options: { skipDefaultFields?: ReadonlySet<string> } = {},
): void {
  if (!registrations) {
    return;
  }
  collectRegisteredFieldDefinitions(registrations);
  for (const registration of registrations.item_fields) {
    for (const definition of registration.fields) {
      const fieldName = normalizeFieldName(definition.name);
      if (!fieldName) {
        continue;
      }
      assertNotReservedItemFieldName(fieldName);
      if (
        !(fieldName in frontMatter) &&
        !options.skipDefaultFields?.has(fieldName) &&
        Object.prototype.hasOwnProperty.call(definition, "default")
      ) {
        frontMatter[fieldName] = cloneFieldValue(definition.default);
      }

      const currentValue = frontMatter[fieldName];
      if (currentValue === undefined) {
        continue;
      }
      const expectedType = normalizeFieldType(definition.type);
      if (expectedType && !isValidFieldType(currentValue, expectedType)) {
        throw new TypeError(`Item field "${fieldName}" must be of type ${expectedType}`);
      }

      const allowedValues = Array.isArray(definition.values) ? definition.values : undefined;
      if (!isAllowedFieldValue(currentValue, allowedValues)) {
        throw new TypeError(`Item field "${fieldName}" must match one of the configured allowed values`);
      }
    }
  }
}
