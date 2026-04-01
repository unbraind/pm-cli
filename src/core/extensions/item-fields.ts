import type { ExtensionRegistrationRegistry } from "./loader.js";

function normalizeFieldName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeFieldType(value: unknown): "string" | "number" | "boolean" | "array" | "object" | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "string" ||
    normalized === "number" ||
    normalized === "boolean" ||
    normalized === "array" ||
    normalized === "object"
  ) {
    return normalized;
  }
  return null;
}

function cloneFieldValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
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

export function applyRegisteredItemFieldDefaultsAndValidation(
  frontMatter: Record<string, unknown>,
  registrations: ExtensionRegistrationRegistry | null,
): void {
  if (!registrations) {
    return;
  }
  for (const registration of registrations.item_fields) {
    for (const definition of registration.fields) {
      const fieldName = normalizeFieldName(definition.name);
      if (!fieldName) {
        continue;
      }
      if (!(fieldName in frontMatter) && Object.prototype.hasOwnProperty.call(definition, "default")) {
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
