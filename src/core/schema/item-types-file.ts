import { BUILTIN_ITEM_TYPE_VALUES } from "../../types/index.js";
import type { ItemTypeDefinition } from "../../types/index.js";

export type { ItemTypeDefinition } from "../../types/index.js";

/**
 * Pure logic for the `pm schema add-type` command and the create/update
 * invalid-type discoverability hint. The CLI command file (schema.ts) handles
 * IO/governance; everything testable and side-effect-free lives here so it can
 * be coverage-gated to 100%.
 */

const BUILTIN_NAME_LOOKUP = new Map<string, string>(
  BUILTIN_ITEM_TYPE_VALUES.map((name) => [name.toLowerCase(), name]),
);

/**
 * The shape persisted at `.agents/pm/schema/types.json`.
 */
export interface ItemTypesFile {
  definitions: ItemTypeDefinition[];
}

export interface NormalizedAddTypeInput {
  name: string;
  description?: string;
  defaultStatus?: string;
  folder?: string;
  aliases: string[];
}

export interface RawAddTypeInput {
  name: string | undefined;
  description?: string;
  defaultStatus?: string;
  folder?: string;
  aliases?: string[];
}

export interface UpsertItemTypeResult {
  file: ItemTypesFile;
  /** The definition as stored after the upsert (existing fields preserved). */
  definition: ItemTypeDefinition;
  /** True when an existing definition with the same (case-insensitive) name was replaced. */
  replaced: boolean;
}

export interface RemoveItemTypeResult {
  file: ItemTypesFile;
  /** True when a matching definition existed and was dropped from the file. */
  removed: boolean;
  /** The removed definition, when one matched (case-insensitively) the requested name. */
  definition?: ItemTypeDefinition;
}

/**
 * Returns the canonical built-in name when `name` collides (case-insensitively)
 * with a reserved built-in item type, otherwise undefined.
 */
export function matchBuiltinTypeName(name: string): string | undefined {
  return BUILTIN_NAME_LOOKUP.get(name.trim().toLowerCase());
}

/**
 * Coerces a persisted `aliases` value into a string array, tolerating malformed
 * data (a non-array, or an array containing non-string entries) without throwing
 * or exploding a stray string into character aliases.
 */
function coerceAliasArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Escapes a value for safe interpolation inside a double-quoted shell string so
 * suggested copy-pasteable commands stay well-formed for names containing
 * `"`, `` ` ``, `$`, or `\`.
 */
export function escapeForDoubleQuotes(value: string): string {
  return value.replace(/[\\"`$]/g, (char) => `\\${char}`);
}

function dedupeAliases(values: Iterable<string>): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, trimmed);
    }
  }
  return [...seen.values()].sort((left, right) => left.localeCompare(right));
}

/**
 * Validates and normalizes raw add-type CLI input. Throws a plain Error with a
 * stable message when the name is missing/empty or collides with a built-in;
 * the CLI layer maps these to PmCliError exit codes.
 */
export function normalizeAddTypeInput(raw: RawAddTypeInput): NormalizedAddTypeInput {
  const name = (raw.name ?? "").trim();
  if (name.length === 0) {
    throw new Error("Type name must not be empty.");
  }
  const builtinMatch = matchBuiltinTypeName(name);
  if (builtinMatch) {
    throw new Error(
      `Cannot redefine built-in item type "${builtinMatch}". Built-in types are reserved: ${BUILTIN_ITEM_TYPE_VALUES.join(", ")}.`,
    );
  }
  const description = raw.description?.trim();
  const defaultStatus = raw.defaultStatus?.trim();
  const folder = raw.folder?.trim();
  const aliases = dedupeAliases(raw.aliases ?? []);
  for (const alias of aliases) {
    const aliasBuiltin = matchBuiltinTypeName(alias);
    if (aliasBuiltin) {
      throw new Error(
        `Alias "${alias}" collides with built-in item type "${aliasBuiltin}". Built-in types are reserved: ${BUILTIN_ITEM_TYPE_VALUES.join(", ")}.`,
      );
    }
  }
  return {
    name,
    description: description && description.length > 0 ? description : undefined,
    defaultStatus: defaultStatus && defaultStatus.length > 0 ? defaultStatus : undefined,
    folder: folder && folder.length > 0 ? folder : undefined,
    aliases,
  };
}

/**
 * Throws when the requested name or any alias collides (case-insensitively)
 * with the canonical name or an alias of a DIFFERENT existing definition.
 * Such collisions would make `pm create`/`pm update --type` resolve
 * ambiguously (the runtime registry keys a single lowercase alias map), so
 * they are rejected. Tokens belonging to the same-named definition being
 * upserted are ignored, keeping re-runs idempotent.
 */
export function assertAliasesAvailable(input: NormalizedAddTypeInput, existing: ItemTypesFile): void {
  const selfLower = input.name.toLowerCase();
  const taken = new Map<string, string>();
  for (const definition of existing.definitions) {
    if (typeof definition.name !== "string") {
      continue;
    }
    const definitionName = definition.name.trim();
    if (definitionName.length === 0 || definitionName.toLowerCase() === selfLower) {
      continue;
    }
    taken.set(definitionName.toLowerCase(), definitionName);
    for (const alias of coerceAliasArray(definition.aliases)) {
      if (alias.trim().length > 0) {
        taken.set(alias.trim().toLowerCase(), definitionName);
      }
    }
  }
  const nameOwner = taken.get(selfLower);
  if (nameOwner) {
    throw new Error(`Type name "${input.name}" collides with an alias of existing item type "${nameOwner}".`);
  }
  for (const alias of input.aliases) {
    const owner = taken.get(alias.toLowerCase());
    if (owner) {
      throw new Error(`Alias "${alias}" already maps to existing item type "${owner}".`);
    }
  }
}

/**
 * Coerces an arbitrary parsed value from types.json into an ItemTypesFile.
 * Accepts the canonical `{ definitions: [...] }` shape, a bare array of
 * definitions, or a nested `{ item_types: { definitions: [...] } }` form, and
 * tolerates a missing/invalid file by returning an empty definitions list.
 */
export function parseItemTypesFile(raw: string | null | undefined): ItemTypesFile {
  if (raw === null || raw === undefined || raw.trim().length === 0) {
    return { definitions: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("schema/types.json contains invalid JSON.");
  }
  return { definitions: extractDefinitions(parsed) };
}

function extractDefinitions(parsed: unknown): ItemTypeDefinition[] {
  const candidate = selectDefinitionsArray(parsed);
  if (!candidate) {
    return [];
  }
  const definitions: ItemTypeDefinition[] = [];
  for (const entry of candidate) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.trim().length === 0) {
      continue;
    }
    definitions.push(record as unknown as ItemTypeDefinition);
  }
  return definitions;
}

function selectDefinitionsArray(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.definitions)) {
    return record.definitions;
  }
  if (typeof record.item_types === "object" && record.item_types !== null) {
    const nested = record.item_types as Record<string, unknown>;
    if (Array.isArray(nested.definitions)) {
      return nested.definitions;
    }
  }
  return undefined;
}

/**
 * Idempotent UPSERT of a custom item type into the parsed file. Matching is
 * case-insensitive by name. When a definition already exists, fields supplied
 * in `input` override the previous values; aliases are merged (deduped); other
 * fields not addressed by add-type flags are preserved untouched.
 */
export function upsertItemType(file: ItemTypesFile, input: NormalizedAddTypeInput): UpsertItemTypeResult {
  const lowerName = input.name.toLowerCase();
  const definitions = file.definitions.slice();
  const existingIndex = definitions.findIndex(
    (definition) => typeof definition.name === "string" && definition.name.trim().toLowerCase() === lowerName,
  );
  const existing = existingIndex >= 0 ? definitions[existingIndex] : undefined;

  const mergedAliases = dedupeAliases([...coerceAliasArray(existing?.aliases), ...input.aliases]);

  const next: ItemTypeDefinition = {
    ...(existing ?? {}),
    name: input.name,
  };
  if (input.folder !== undefined) {
    next.folder = input.folder;
  }
  if (mergedAliases.length > 0) {
    next.aliases = mergedAliases;
  } else if (next.aliases !== undefined) {
    delete next.aliases;
  }
  applyAttribute(next, "description", input.description);
  applyAttribute(next, "default_status", input.defaultStatus);

  if (existingIndex >= 0) {
    definitions[existingIndex] = next;
  } else {
    definitions.push(next);
  }
  definitions.sort((left, right) => left.name.localeCompare(right.name));

  return {
    file: { definitions },
    definition: next,
    replaced: existingIndex >= 0,
  };
}

/**
 * Removes a custom item type definition from the parsed file by name
 * (case-insensitive). Throws a plain Error when `name` is empty or collides
 * with a reserved built-in type (built-ins are not stored in the file and must
 * never be deletable). Returns `removed: false` when no matching custom
 * definition exists so the CLI layer can treat the call as an idempotent no-op.
 */
export function removeItemType(file: ItemTypesFile, name: string | undefined): RemoveItemTypeResult {
  const trimmed = (name ?? "").trim();
  if (trimmed.length === 0) {
    throw new Error("Type name must not be empty.");
  }
  const builtinMatch = matchBuiltinTypeName(trimmed);
  if (builtinMatch) {
    throw new Error(
      `Cannot remove built-in item type "${builtinMatch}". Built-in types are reserved: ${BUILTIN_ITEM_TYPE_VALUES.join(", ")}.`,
    );
  }
  const lowerName = trimmed.toLowerCase();
  const definitions = file.definitions.slice();
  const existingIndex = definitions.findIndex(
    (definition) => typeof definition.name === "string" && definition.name.trim().toLowerCase() === lowerName,
  );
  if (existingIndex < 0) {
    return { file: { definitions }, removed: false };
  }
  const [definition] = definitions.splice(existingIndex, 1);
  return { file: { definitions }, removed: true, definition };
}

function applyAttribute(definition: ItemTypeDefinition, key: string, value: string | undefined): void {
  const record = definition as unknown as Record<string, unknown>;
  if (value !== undefined) {
    record[key] = value;
  }
}

/**
 * Serializes the item types file with a trailing newline (matches the rest of
 * the schema scaffold files written by pm).
 */
export function serializeItemTypesFile(file: ItemTypesFile): string {
  return `${JSON.stringify({ definitions: file.definitions }, null, 2)}\n`;
}

/**
 * Appends a discoverable hint to the "Invalid type" error so agents learn that
 * custom types exist and how to register one. Quotes are chosen so the printed
 * line is copy-pasteable as a shell command.
 */
export function buildInvalidTypeHint(name: string): string {
  const safeName = name.trim().length > 0 ? name.trim() : name;
  return `To register a custom type, run: pm schema add-type "${escapeForDoubleQuotes(safeName)}" (writes .agents/pm/schema/types.json).`;
}

/**
 * Builds the full invalid-type error message used by create/update: the
 * existing "Invalid type ... Allowed: ..." line plus the discoverable hint.
 */
export function buildInvalidTypeError(name: string, allowedTypes: readonly string[]): string {
  return `Invalid type value "${name}". Allowed: ${allowedTypes.join(", ")}. ${buildInvalidTypeHint(name)}`;
}
