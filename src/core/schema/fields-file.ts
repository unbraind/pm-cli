/**
 * @module core/schema/fields-file
 *
 * Resolves configurable schema, fields, statuses, and workflows for Fields File.
 */
import {
  RUNTIME_FIELD_COMMAND_VALUES,
  RUNTIME_FIELD_TYPE_VALUES,
} from "../../types/index.js";
import type {
  RuntimeFieldCommand,
  RuntimeFieldDefinition,
  RuntimeFieldType,
} from "../../types/index.js";
import { ITEM_METADATA_KEY_ORDER } from "../shared/constants.js";

export type {
  RuntimeFieldCommand,
  RuntimeFieldDefinition,
  RuntimeFieldType,
} from "../../types/index.js";

/**
 * Pure logic for the `pm schema add-field` / `pm schema remove-field` commands
 * and the `list-fields` / `show-field` inspectors. The CLI command file
 * (schema.ts) owns IO/governance; everything testable and side-effect-free lives
 * here so it can be coverage-gated to 100%.
 *
 * Custom fields persist at `.agents/pm/schema/fields.json` under the shape
 * `{ fields: RuntimeFieldDefinition[] }`. The runtime merge layer
 * (loadRuntimeSchemaFromOptionalFiles) reads that file and dynamically registers
 * a CLI flag per field on create/update/list/search/context, so this module only
 * has to manage the persisted entries; it never duplicates the registration.
 */

const RUNTIME_FIELD_TYPE_SET = new Set<string>(RUNTIME_FIELD_TYPE_VALUES);
const RUNTIME_FIELD_COMMAND_SET = new Set<string>(RUNTIME_FIELD_COMMAND_VALUES);

/** Built-in item-metadata field names a custom field key must never shadow. A custom key that collides with one of these would let `pm create --<key>` write over reserved metadata, so add-field rejects them up front (symmetric with the built-in-type guard in item-types-file.ts). */
export const BUILTIN_FIELD_KEYS: ReadonlySet<string> = new Set([
  ...ITEM_METADATA_KEY_ORDER.filter((key) => key !== "severity"),
  "id",
  "title",
  "type",
  "status",
  "priority",
  "tags",
  "assignee",
  "parent",
  "description",
  "body",
  "created_at",
  "updated_at",
  "closed_at",
  "author",
  "deadline",
  "estimate",
  "sprint",
  "release",
  "risk",
  "confidence",
  "reviewer",
  "resolution",
  "expected",
  "actual",
]);

/** The default commands a field is wired onto when `--commands` is omitted, matching the runtime default in runtime-schema.ts (normalizeRuntimeFieldDefinition). */
const DEFAULT_FIELD_COMMANDS: RuntimeFieldCommand[] = ["create", "update"];

/** The shape persisted at `.agents/pm/schema/fields.json`. */
export interface FieldsFile {
  /** Value that configures or reports fields for this contract. */
  fields: RuntimeFieldDefinition[];
}

/** Documents the raw add field input payload exchanged by command, SDK, and package integrations. */
export interface RawAddFieldInput {
  /** Value that configures or reports key for this contract. */
  key: string | undefined;
  /** Schema type that determines the shape and validation rules for this value. */
  type?: string;
  /** Value that configures or reports commands for this contract. */
  commands?: string[];
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Value that configures or reports cli flag for this contract. */
  cliFlag?: string;
  /** Value that configures or reports aliases for this contract. */
  aliases?: string[];
  /** Value that configures or reports required for this contract. */
  required?: boolean;
  /** Value that configures or reports required on create for this contract. */
  requiredOnCreate?: boolean;
  /** Value that configures or reports allow unset for this contract. */
  allowUnset?: boolean;
  /** Value that configures or reports required types for this contract. */
  requiredTypes?: string[];
}

/** Documents the normalized add field input payload exchanged by command, SDK, and package integrations. */
export interface NormalizedAddFieldInput {
  /** Value that configures or reports key for this contract. */
  key: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type: RuntimeFieldType;
  /** Value that configures or reports commands for this contract. */
  commands: RuntimeFieldCommand[];
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Value that configures or reports cli flag for this contract. */
  cliFlag?: string;
  /** Value that configures or reports cli aliases for this contract. */
  cliAliases: string[];
  /** Value that configures or reports required for this contract. */
  required: boolean;
  /** Value that configures or reports required on create for this contract. */
  requiredOnCreate: boolean;
  /** Value that configures or reports allow unset for this contract. */
  allowUnset: boolean;
  /** Value that configures or reports required types for this contract. */
  requiredTypes: string[];
}

/** Documents the upsert field result payload exchanged by command, SDK, and package integrations. */
export interface UpsertFieldResult {
  /** Value that configures or reports file for this contract. */
  file: FieldsFile;
  /** The definition as stored after the upsert. */
  definition: RuntimeFieldDefinition;
  /** True when an existing definition with the same (normalized) key was replaced. */
  replaced: boolean;
}

/** Documents the remove field result payload exchanged by command, SDK, and package integrations. */
export interface RemoveFieldResult {
  /** Value that configures or reports file for this contract. */
  file: FieldsFile;
  /** True when a matching definition existed and was dropped from the file. */
  removed: boolean;
  /** The removed definition, when one matched the requested key. */
  definition?: RuntimeFieldDefinition;
}

/** Normalizes a field key using the same rule as runtime-schema.ts: lowercase and collapse any run of whitespace/hyphens into a single underscore. */
export function normalizeFieldKey(value: unknown): string {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replaceAll(/[\s-]+/g, "_")
    : "";
}

/** Normalizes a CLI flag token: strip a leading `--`, lowercase, and collapse whitespace/underscore runs to a single hyphen (matches normalizeCliToken in runtime-schema.ts). */
function normalizeCliToken(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const collapsed = value
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_]+/g, "-");
  return collapsed.startsWith("--") ? collapsed.slice(2) : collapsed;
}

function keyToDefaultCliFlag(key: string): string {
  return key.replaceAll("_", "-");
}

function dedupeCliTokens(values: Iterable<string>, exclude: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const token = normalizeCliToken(value);
    if (token.length > 0 && token !== exclude) {
      seen.add(token);
    }
  }
  return [...seen].sort((left, right) => left.localeCompare(right));
}

function dedupeStringList(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      seen.add(trimmed);
    }
  }
  return [...seen].sort((left, right) => left.localeCompare(right));
}

/** Normalizes the command allow-list stored for a custom field definition. */
function normalizeFieldCommands(
  rawCommands: string[] | undefined,
): RuntimeFieldCommand[] {
  const seen = new Set<string>();
  const normalized: RuntimeFieldCommand[] = [];
  for (const rawCommand of rawCommands ?? []) {
    const command = rawCommand.trim().toLowerCase();
    if (command.length === 0) {
      continue;
    }
    if (!RUNTIME_FIELD_COMMAND_SET.has(command)) {
      throw new Error(
        `Invalid field command "${rawCommand}". Allowed: ${RUNTIME_FIELD_COMMAND_VALUES.join(", ")}.`,
      );
    }
    if (!seen.has(command)) {
      seen.add(command);
      normalized.push(command as RuntimeFieldCommand);
    }
  }
  return rawCommands === undefined || normalized.length === 0
    ? [...DEFAULT_FIELD_COMMANDS]
    : normalized;
}

/** Validates and normalizes raw add-field CLI input. Throws a plain Error with a stable message when the key is missing/empty, collides with a built-in field, or carries an invalid type/command; the CLI layer maps these to PmCliError exit codes. A `string_array` type implies a repeatable field downstream (runtime-schema.ts derives `repeatable`), so no separate repeatable flag is exposed. */
export function normalizeAddFieldInput(
  raw: RawAddFieldInput,
): NormalizedAddFieldInput {
  const key = normalizeFieldKey(raw.key);
  if (key.length === 0) {
    throw new Error("Field key must not be empty.");
  }
  if (BUILTIN_FIELD_KEYS.has(key)) {
    throw new Error(
      `Cannot define custom field "${key}": custom schema field "${key}" collides with built-in item metadata "${key}". Rename the custom field with a project-specific prefix. Reserved fields: ${[...BUILTIN_FIELD_KEYS].sort((left, right) => left.localeCompare(right)).join(", ")}.`,
    );
  }

  const typeCandidate =
    typeof raw.type === "string" && raw.type.trim().length > 0
      ? raw.type.trim().toLowerCase()
      : "string";
  if (!RUNTIME_FIELD_TYPE_SET.has(typeCandidate)) {
    throw new Error(
      `Invalid field type "${raw.type}". Allowed: ${RUNTIME_FIELD_TYPE_VALUES.join(", ")}.`,
    );
  }
  const type = typeCandidate as RuntimeFieldType;

  const commands = normalizeFieldCommands(raw.commands);

  const cliFlagToken = normalizeCliToken(raw.cliFlag);
  const cliFlag =
    cliFlagToken.length > 0 && cliFlagToken !== keyToDefaultCliFlag(key)
      ? cliFlagToken
      : undefined;
  const effectiveFlag = cliFlag ?? keyToDefaultCliFlag(key);
  const cliAliases = dedupeCliTokens(raw.aliases ?? [], effectiveFlag);

  const description = raw.description?.trim();
  return {
    key,
    type,
    commands,
    description:
      description && description.length > 0 ? description : undefined,
    cliFlag,
    cliAliases,
    required: raw.required === true,
    requiredOnCreate: raw.requiredOnCreate === true,
    // allow_unset defaults to true (omitted) and is only persisted when an
    // operator explicitly disables it with --no-allow-unset (allowUnset === false).
    allowUnset: raw.allowUnset !== false,
    requiredTypes: dedupeStringList(raw.requiredTypes),
  };
}

function selectFieldsArray(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.fields)) {
    return record.fields;
  }
  if (Array.isArray(record.definitions)) {
    return record.definitions;
  }
  return undefined;
}

function extractFieldDefinitions(parsed: unknown): RuntimeFieldDefinition[] {
  const candidate = selectFieldsArray(parsed);
  if (!candidate) {
    return [];
  }
  const definitions: RuntimeFieldDefinition[] = [];
  for (const entry of candidate) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.key !== "string" || record.key.trim().length === 0) {
      continue;
    }
    definitions.push(record as unknown as RuntimeFieldDefinition);
  }
  return definitions;
}

/** Coerces an arbitrary parsed value from fields.json into a FieldsFile. Accepts the canonical `{ fields: [...] }` shape, a bare array, or a `{ definitions: [...] }` form, and tolerates a missing/invalid file by returning an empty fields list. */
export function parseFieldsFile(raw: string | null | undefined): FieldsFile {
  if (raw === null || raw === undefined || raw.trim().length === 0) {
    return { fields: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("schema/fields.json contains invalid JSON.");
  }
  return { fields: extractFieldDefinitions(parsed) };
}

/** Serializes the fields file with a trailing newline (matches the rest of the schema scaffold files written by pm). */
export function serializeFieldsFile(file: FieldsFile): string {
  return `${JSON.stringify({ fields: file.fields }, null, 2)}\n`;
}

/** Idempotent UPSERT of a custom field into the parsed file. Matching is by normalized key. When a definition already exists, the supplied input fully replaces its add-field-managed attributes (type/commands/description/flags/ required flags) while preserving any unrelated keys the file may carry; any `metadata_key` already stored is preserved so existing item data keeps mapping to the same item-metadata column. */
export function upsertField(
  file: FieldsFile,
  input: NormalizedAddFieldInput,
): UpsertFieldResult {
  // Match by normalized key. A hand-authored file may carry more than one entry
  // for the same key, so drop ALL matches and re-insert a single merged result
  // (collapsing duplicates) rather than only rewriting the first occurrence. The
  // first existing match seeds preserved attributes (e.g. metadata_key).
  const existing = file.fields.find(
    (definition) => normalizeFieldKey(definition.key) === input.key,
  );
  const replaced = existing !== undefined;
  const fields = file.fields.filter(
    (definition) => normalizeFieldKey(definition.key) !== input.key,
  );

  const next: RuntimeFieldDefinition = {
    ...existing,
    key: input.key,
    type: input.type,
    commands: [...input.commands],
  };
  applyOptionalString(next, "description", input.description);
  applyOptionalString(next, "cli_flag", input.cliFlag);
  if (input.cliAliases.length > 0) {
    next.cli_aliases = [...input.cliAliases];
  } else {
    delete next.cli_aliases;
  }
  applyBooleanFlag(next, "required", input.required);
  applyBooleanFlag(next, "required_on_create", input.requiredOnCreate);
  // allow_unset defaults true; only persist the explicit false override.
  if (input.allowUnset === false) {
    next.allow_unset = false;
  } else {
    delete next.allow_unset;
  }
  if (input.requiredTypes.length > 0) {
    next.required_types = [...input.requiredTypes];
  } else {
    delete next.required_types;
  }

  fields.push(next);
  fields.sort((left, right) =>
    normalizeFieldKey(left.key).localeCompare(normalizeFieldKey(right.key)),
  );

  return {
    file: { fields },
    definition: next,
    replaced,
  };
}

/** Removes a custom field definition from the parsed file by key (normalized). Throws a plain Error when `key` is empty. Returns `removed: false` when no matching definition exists so the CLI layer can treat the call as an idempotent no-op. */
export function removeField(
  file: FieldsFile,
  key: string | undefined,
): RemoveFieldResult {
  const normalizedKey = normalizeFieldKey(key);
  if (normalizedKey.length === 0) {
    throw new Error("Field key must not be empty.");
  }
  // Remove ALL matches (a hand-authored file may carry duplicate entries for the
  // same normalized key) so no stale duplicate survives the removal.
  const removed: RuntimeFieldDefinition[] = [];
  const fields = file.fields.filter((definition) => {
    if (normalizeFieldKey(definition.key) === normalizedKey) {
      removed.push(definition);
      return false;
    }
    return true;
  });
  if (removed.length === 0) {
    return { file: { fields }, removed: false };
  }
  return { file: { fields }, removed: true, definition: removed[0] };
}

function applyOptionalString(
  definition: RuntimeFieldDefinition,
  key: string,
  value: string | undefined,
): void {
  const record = definition as unknown as Record<string, unknown>;
  if (value !== undefined && value.length > 0) {
    record[key] = value;
  } else {
    delete record[key];
  }
}

function applyBooleanFlag(
  definition: RuntimeFieldDefinition,
  key: string,
  value: boolean,
): void {
  const record = definition as unknown as Record<string, unknown>;
  if (value) {
    record[key] = true;
  } else {
    delete record[key];
  }
}
