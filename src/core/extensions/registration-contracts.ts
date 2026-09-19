/**
 * @module core/extensions/registration-contracts
 * Validates contributed command, flag, schema and profile definitions before registration.
 */
import type {
  ProjectProfileDefinition
} from "../profile/profile-presets.js";
import {
  type ExtensionCommandArgumentDefinition,
  type FlagDefinition
} from "./extension-types.js";
import {
  describeExtensionLongFlagFailure,
  findExtensionFlagTokenFailure,
} from "./flag-definition-validation.js";
import {
  flattenFlagListValue,
  isFlagDefaultValueCoercible,
  resolveFlagValueKind,
} from "./flag-value-types.js";
import {
  KNOWN_ITEM_FIELD_TYPES,
  normalizeItemFieldType,
  suggestKnownItemFieldType,
} from "./item-field-types.js";
import {
  asRegistrationRecord,
  assertOptionalBooleanField,
  assertOptionalFlagDefaultField,
  assertOptionalStringArrayField,
  assertOptionalStringField
} from "./registration-validation.js";
import {
  assertNonEmptyRegistrationString,
  normalizeRegistrationRecordList
} from "./registration-values.js";

const FLAG_DEFINITION_KEYS = new Set([
  "default",
  "description",
  "enabled",
  "list",
  "long",
  "repeatable",
  "required",
  "short",
  "type",
  "value_name",
  "value_type",
  "visible",
]);

/** Normalize registration records and expand the repeatable alias into the canonical list flag property. */
function normalizeFlagDefinitions(
  name: string,
  value: unknown,
): FlagDefinition[] {
  return normalizeRegistrationRecordList(name, value).map((record) => {
    if (record.repeatable === true) {
      record.list = true;
    }
    return record as FlagDefinition;
  });
}

/** Canonicalize an explicit action name to a lowercase dashed token before checking that it is nonempty. */
function normalizeCommandActionName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Derive an action from the command path or reject an invalid explicit action before registration. */
function resolveCommandDefinitionAction(
  commandPath: string,
  action: unknown,
): string {
  if (action === undefined) {
    return commandPath.replace(/\s+/g, "-");
  }
  if (typeof action !== "string" || action.trim().length === 0) {
    throw new TypeError(
      "registerCommand definition.action must be a non-empty string when provided",
    );
  }
  const normalized = normalizeCommandActionName(action);
  if (normalized.length === 0) {
    throw new TypeError(
      "registerCommand definition.action must contain alphanumeric characters",
    );
  }
  return normalized;
}

/** Validate positional argument records and enforce that at most one variadic argument appears last. */
function normalizeCommandDefinitionArguments(
  value: unknown,
): ExtensionCommandArgumentDefinition[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError(
      "registerCommand definition.arguments must be an array when provided",
    );
  }
  const normalized: ExtensionCommandArgumentDefinition[] = [];
  for (const [index, entry] of value.entries()) {
    const record = asRegistrationRecord(
      `registerCommand definition.arguments[${index}]`,
      entry,
    );
    const name = assertNonEmptyRegistrationString(
      `registerCommand definition.arguments[${index}].name`,
      record.name,
    );
    assertOptionalBooleanField(
      `registerCommand definition.arguments[${index}].required`,
      record.required,
    );
    assertOptionalBooleanField(
      `registerCommand definition.arguments[${index}].variadic`,
      record.variadic,
    );
    assertOptionalStringField(
      `registerCommand definition.arguments[${index}].description`,
      record.description,
    );
    if (name.includes(" ")) {
      throw new TypeError(
        `registerCommand definition.arguments[${index}].name must not contain spaces`,
      );
    }
    const definition: ExtensionCommandArgumentDefinition = {
      name,
    };
    if (record.required === true) {
      definition.required = true;
    }
    if (record.variadic === true) {
      definition.variadic = true;
    }
    if (typeof record.description === "string") {
      definition.description = record.description.trim();
    }
    normalized.push(definition);
  }

  const variadicIndexes = normalized
    .map((argument, index) => (argument.variadic ? index : -1))
    .filter((index) => index >= 0);
  if (variadicIndexes.length > 1) {
    throw new TypeError(
      "registerCommand definition.arguments supports at most one variadic argument",
    );
  }
  if (
    variadicIndexes.length === 1 &&
    variadicIndexes[0] !== normalized.length - 1
  ) {
    throw new TypeError(
      "registerCommand definition.arguments variadic argument must be the final argument",
    );
  }

  return normalized;
}

/** Reject unknown flag properties, invalid tokens, inconsistent repeatability and defaults incompatible with the declared value type. */
function validateFlagDefinitions(flags: unknown): void {
  if (!Array.isArray(flags)) {
    throw new TypeError(
      "registerFlags flags requires an array of object definitions",
    );
  }
  for (const [index, raw] of flags.entries()) {
    const record = asRegistrationRecord(`registerFlags flags[${index}]`, raw);
    const unknownKeys = Object.keys(record)
      .filter((key) => !FLAG_DEFINITION_KEYS.has(key))
      .sort((left, right) => left.localeCompare(right));
    if (unknownKeys.length > 0) {
      throw new TypeError(
        `registerFlags flags[${index}] contains unknown field(s): ${unknownKeys.join(", ")}`,
      );
    }
    const long = record.long;
    const short = record.short;
    if (long === undefined && short === undefined) {
      throw new TypeError(
        `registerFlags flags[${index}] requires at least one of long or short`,
      );
    }
    assertOptionalStringField(`registerFlags flags[${index}].long`, long);
    assertOptionalStringField(`registerFlags flags[${index}].short`, short);
    const tokenFinding = findExtensionFlagTokenFailure(long, short);
    if (tokenFinding !== null) {
      throw new TypeError(
        `registerFlags flags[${index}] ${describeExtensionLongFlagFailure(tokenFinding.token, tokenFinding.failure)}`,
      );
    }
    assertOptionalStringField(
      `registerFlags flags[${index}].value_name`,
      record.value_name,
    );
    assertOptionalStringField(
      `registerFlags flags[${index}].description`,
      record.description,
    );
    assertOptionalBooleanField(
      `registerFlags flags[${index}].required`,
      record.required,
    );
    assertOptionalBooleanField(
      `registerFlags flags[${index}].enabled`,
      record.enabled,
    );
    assertOptionalBooleanField(
      `registerFlags flags[${index}].visible`,
      record.visible,
    );
    assertOptionalBooleanField(
      `registerFlags flags[${index}].list`,
      record.list,
    );
    assertOptionalBooleanField(
      `registerFlags flags[${index}].repeatable`,
      record.repeatable,
    );
    if (
      record.list !== undefined &&
      record.repeatable !== undefined &&
      record.list !== record.repeatable
    ) {
      throw new TypeError(
        `registerFlags flags[${index}].list and repeatable must match when both are provided`,
      );
    }
    assertOptionalFlagDefaultField(
      `registerFlags flags[${index}].default`,
      record.default,
    );
    if (
      Array.isArray(record.default) &&
      record.list !== true &&
      record.repeatable !== true
    ) {
      throw new TypeError(
        `registerFlags flags[${index}].default cannot be an array unless list is true.`,
      );
    }
    assertFlagValueTypeAndDefault(`registerFlags flags[${index}]`, record);
  }
}

/** Reject a declared `value_type`/`type` that is not a known flag value kind, and a `default` whose value(s) would not cleanly coerce under that kind — so the typed-flag contract is enforced at registration instead of silently leaving an untyped value to surface at use time. */
function assertFlagValueTypeAndDefault(
  label: string,
  record: Record<string, unknown>,
): void {
  const declaredType =
    (typeof record.value_type === "string" ? record.value_type : undefined) ??
    (typeof record.type === "string" ? record.type : undefined);
  if (declaredType === undefined) {
    return;
  }
  const kind = resolveFlagValueKind(declaredType);
  if (kind === null) {
    throw new TypeError(
      `${label} value_type "${declaredType}" is not a known flag value type (expected one of: string, number, boolean).`,
    );
  }
  if (record.default === undefined) {
    return;
  }
  // For list flags, validate the default exactly as the runtime will see it —
  // comma-joined strings and nested arrays are flattened first — so a valid
  // default like `value_type: "number", default: "10,20"` is not wrongly rejected.
  const defaults =
    record.list === true || record.repeatable === true
      ? flattenFlagListValue(record.default)
      : [record.default];
  for (const [defaultIndex, defaultValue] of defaults.entries()) {
    if (
      !isFlagDefaultValueCoercible(
        defaultValue as string | number | boolean,
        kind,
      )
    ) {
      const suffix =
        defaults.length > 1 ? `default[${defaultIndex}]` : "default";
      throw new TypeError(
        `${label}.${suffix} (${JSON.stringify(defaultValue)}) is not coercible to ${kind}.`,
      );
    }
  }
}

/** Validate custom field names and types, including typo guidance, before fields enter the runtime schema. */
function validateItemFieldDefinitions(fields: unknown): void {
  if (!Array.isArray(fields)) {
    throw new TypeError(
      "registerItemFields fields requires an array of object definitions",
    );
  }
  for (const [index, raw] of fields.entries()) {
    const record = asRegistrationRecord(
      `registerItemFields fields[${index}]`,
      raw,
    );
    assertNonEmptyRegistrationString(
      `registerItemFields fields[${index}].name`,
      record.name,
    );
    const fieldType = assertNonEmptyRegistrationString(
      `registerItemFields fields[${index}].type`,
      record.type,
    );
    if (normalizeItemFieldType(fieldType) === null) {
      const suggestion = suggestKnownItemFieldType(fieldType);
      const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
      throw new TypeError(
        `registerItemFields fields[${index}].type "${fieldType}" is not a known field type ` +
          `(expected one of: ${KNOWN_ITEM_FIELD_TYPES.join(", ")}).${hint}`,
      );
    }
    assertOptionalBooleanField(
      `registerItemFields fields[${index}].optional`,
      record.optional,
    );
  }
}

/** Validate the optional command-specific visibility and requirement policies of one extension item type. */
function validateItemTypeCommandOptionPolicies(
  typeIndex: number,
  value: unknown,
): void {
  if (value === undefined) {
    return;
  }
  const label = `registerItemTypes types[${typeIndex}].command_option_policies`;
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array when provided`);
  }
  for (const [policyIndex, rawPolicy] of value.entries()) {
    const at = `${label}[${policyIndex}]`;
    const policy = asRegistrationRecord(at, rawPolicy);
    assertNonEmptyRegistrationString(`${at}.command`, policy.command);
    assertNonEmptyRegistrationString(`${at}.option`, policy.option);
    assertOptionalBooleanField(`${at}.enabled`, policy.enabled);
    assertOptionalBooleanField(`${at}.required`, policy.required);
    assertOptionalBooleanField(`${at}.visible`, policy.visible);
  }
}

/** Validate the optional custom option vocabulary of one extension item type. */
function validateItemTypeOptions(typeIndex: number, value: unknown): void {
  if (value === undefined) {
    return;
  }
  const label = `registerItemTypes types[${typeIndex}].options`;
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array when provided`);
  }
  for (const [optionIndex, rawOption] of value.entries()) {
    const at = `${label}[${optionIndex}]`;
    const option = asRegistrationRecord(at, rawOption);
    assertNonEmptyRegistrationString(`${at}.key`, option.key);
    assertOptionalStringArrayField(`${at}.values`, option.values);
    assertOptionalBooleanField(`${at}.required`, option.required);
    assertOptionalStringArrayField(`${at}.aliases`, option.aliases);
  }
}

/** Check custom item type metadata, creation requirements and command option policies before registration. */
function validateItemTypeDefinitions(types: unknown): void {
  if (!Array.isArray(types)) {
    throw new TypeError(
      "registerItemTypes types requires an array of object definitions",
    );
  }
  for (const [typeIndex, raw] of types.entries()) {
    const at = `registerItemTypes types[${typeIndex}]`;
    const record = asRegistrationRecord(at, raw);
    assertNonEmptyRegistrationString(`${at}.name`, record.name);
    assertOptionalStringField(`${at}.folder`, record.folder);
    assertOptionalStringArrayField(`${at}.aliases`, record.aliases);
    assertOptionalStringArrayField(
      `${at}.required_create_fields`,
      record.required_create_fields,
    );
    assertOptionalStringArrayField(
      `${at}.required_create_repeatables`,
      record.required_create_repeatables,
    );
    validateItemTypeCommandOptionPolicies(
      typeIndex,
      record.command_option_policies,
    );
    validateItemTypeOptions(typeIndex, record.options);
  }
}

/** Validate optional migration metadata and ensure a supplied migration runner is callable. */
function validateMigrationDefinition(definition: unknown): void {
  const record = asRegistrationRecord(
    "registerMigration definition",
    definition,
  );
  if (record.id !== undefined && typeof record.id !== "string") {
    throw new TypeError(
      "registerMigration definition.id must be a string when provided",
    );
  }
  if (
    record.description !== undefined &&
    typeof record.description !== "string"
  ) {
    throw new TypeError(
      "registerMigration definition.description must be a string when provided",
    );
  }
  if (record.status !== undefined && typeof record.status !== "string") {
    throw new TypeError(
      "registerMigration definition.status must be a string when provided",
    );
  }
  assertOptionalBooleanField(
    "registerMigration definition.mandatory",
    record.mandatory,
  );
  if (record.run !== undefined && typeof record.run !== "function") {
    throw new TypeError(
      "registerMigration definition.run must be a function when provided",
    );
  }
}

/**
 * The seven array-valued dimensions a {@link ProjectProfileDefinition} stages.
 * Each is "optional-by-emptiness": an omitted dimension normalizes to an empty
 * array so the profile planner can iterate every dimension unconditionally.
 */
const PROJECT_PROFILE_DIMENSIONS = [
  "types",
  "statuses",
  "fields",
  "workflows",
  "config",
  "templates",
  "packages",
] as const;

type ProjectProfileDimension = (typeof PROJECT_PROFILE_DIMENSIONS)[number];

/** Dimension-specific profile entry validators used after the common object-shape boundary. */
const PROJECT_PROFILE_ENTRY_VALIDATORS: Partial<
  Record<
    ProjectProfileDimension,
    (at: string, entry: Record<string, unknown>) => void
  >
> = {
  types: (at, entry) => {
    if (entry.name !== undefined && typeof entry.name !== "string") {
      throw new TypeError(`${at}.name must be a string when provided`);
    }
  },
  workflows: (at, entry) => {
    if (typeof entry.type !== "string") {
      throw new TypeError(`${at}.type must be a string`);
    }
    if (!Array.isArray(entry.allowed_transitions)) {
      throw new TypeError(`${at}.allowed_transitions must be an array`);
    }
    for (const [pairIndex, pair] of entry.allowed_transitions.entries()) {
      if (!Array.isArray(pair)) {
        throw new TypeError(
          `${at}.allowed_transitions[${pairIndex}] must be a [from, to] array`,
        );
      }
    }
  },
  templates: (at, entry) => {
    if (typeof entry.name !== "string") {
      throw new TypeError(`${at}.name must be a string`);
    }
    if (
      typeof entry.options !== "object" ||
      entry.options === null ||
      Array.isArray(entry.options)
    ) {
      throw new TypeError(`${at}.options must be an object`);
    }
  },
  packages: (at, entry) => {
    if (typeof entry.spec !== "string") {
      throw new TypeError(`${at}.spec must be a string`);
    }
  },
};

/** Reject malformed profile dimensions and entries before downstream planners dereference their schema properties. */
function validateProjectProfileDefinition(profile: unknown): void {
  const record = asRegistrationRecord("registerProfile profile", profile);
  assertNonEmptyRegistrationString("registerProfile profile.name", record.name);
  assertNonEmptyRegistrationString(
    "registerProfile profile.title",
    record.title,
  );
  if (record.summary !== undefined && typeof record.summary !== "string") {
    throw new TypeError(
      "registerProfile profile.summary must be a string when provided",
    );
  }
  for (const dimension of PROJECT_PROFILE_DIMENSIONS) {
    const value = record[dimension];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value)) {
      throw new TypeError(
        `registerProfile profile.${dimension} must be an array when provided`,
      );
    }
    // Each dimension entry must be a non-null object: a primitive or null entry
    // (e.g. `statuses: [null]`, `types: [42]`) survives an array-only check but
    // crashes the profile planner and `pm profile show` when they read `entry.id`
    // / `entry.key` / `entry.type` later. Reject it at the registration boundary.
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new TypeError(
          `registerProfile profile.${dimension}[${index}] must be an object`,
        );
      }
      // Beyond "is an object", validate the specific field shapes consumers
      // dereference so a type-violating entry can never crash the planner, the
      // `pm profile` surfaces, or describeProjectProfile downstream.
      PROJECT_PROFILE_ENTRY_VALIDATORS[dimension]?.(
        `registerProfile profile.${dimension}[${index}]`,
        entry as Record<string, unknown>,
      );
    }
  }
}

/**
 * Fills an already-validated profile snapshot's optional surfaces — an absent
 * `summary` becomes an empty string and every omitted dimension an empty array —
 * so the stored definition always has the full {@link ProjectProfileDefinition}
 * shape the profile planner and `pm profile` resolution rely on. It runs after
 * validation on the cloned snapshot, so it only ever supplies missing defaults
 * and never has to coerce an invalid type (those are already rejected).
 */
function applyProjectProfileDefaults(
  profile: Record<string, unknown>,
): ProjectProfileDefinition {
  if (profile.summary === undefined) {
    profile.summary = "";
  }
  for (const dimension of PROJECT_PROFILE_DIMENSIONS) {
    if (profile[dimension] === undefined) {
      profile[dimension] = [];
    }
  }
  return profile as unknown as ProjectProfileDefinition;
}

export { applyProjectProfileDefaults,assertFlagValueTypeAndDefault,normalizeCommandDefinitionArguments,normalizeFlagDefinitions,resolveCommandDefinitionAction,validateFlagDefinitions,validateItemFieldDefinitions,validateItemTypeDefinitions,validateMigrationDefinition,validateProjectProfileDefinition };
