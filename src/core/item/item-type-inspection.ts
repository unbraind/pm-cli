/**
 * @module core/item/item-type-inspection
 *
 * Reads one stored or registered item type definition of unknown shape into
 * the typed form the normalizer expects, and records what it discards
 * (pm-x17o8l). Extension registrations and schema type files share this one
 * reading, so a wrong-typed member, such as a numeric description or a
 * non-string alias, is ignored instead of failing the settings read, and
 * `pm validate` reports exactly what the registry discarded.
 */
import type {
  ItemTypeCommandOptionPolicy,
  ItemTypeDefinition,
  ItemTypeOptionDefinition,
} from "../../types/index.js";
import { parseItemExecutionRole } from "./item-type-definition.js";

/** Why a whole stored type definition is dropped. */
export type ItemTypeDefinitionDropReason = "not_an_object" | "name_empty";

/** What the registry discards from one stored type definition: the whole entry, or the members it ignores. */
export interface ItemTypeDefinitionLoss {
  /** Set when the whole definition is dropped. */
  dropped?: ItemTypeDefinitionDropReason;
  /** One line per member that is ignored while the definition is kept. */
  ignored: string[];
}

/**
 * Where a definition comes from, which decides how two members that guard
 * behaviour are read. An extension registration keeps its earlier reading:
 * an `execution_role` outside agent, human and gate is refused, and a switch
 * that is not a boolean reads as `Boolean(value)`. A schema file entry never
 * fails the settings read: an unknown role fails closed (`human`, never
 * offered for agent dispatch), and a switch that is not a boolean is ignored,
 * so `required: "false"` does not become a requirement.
 */
export type ItemTypeDefinitionSource = "extension" | "schema_file";

type StoredRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is StoredRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "a value that cannot be shown";
  }
}

/**
 * The non-blank string members of a stored list, with one ignored line per
 * other entry. A non-list, or a non-empty list without one, reads as absent: an
 * empty list is an explicit override (no create requirements), which a list
 * of wrong-typed entries never meant.
 */
function readStringList(record: StoredRecord, member: string, at: string, ignored: string[]): string[] | undefined {
  const value = record[member];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    ignored.push(`${at}${member}: is not a list`);
    return undefined;
  }
  for (const entry of value as unknown[]) {
    if (typeof entry !== "string") ignored.push(`${at}${member}: ${describeValue(entry)} is not a string`);
    else if (entry.trim().length === 0) ignored.push(`${at}${member}: ${describeValue(entry)} is blank`);
  }
  const usable = (value as unknown[]).filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return usable.length === 0 && value.length > 0 ? undefined : usable;
}

/** A stored string member, or undefined with an ignored line when it has another type. */
function readString(record: StoredRecord, member: string, at: string, ignored: string[]): string | undefined {
  const value = record[member];
  if (value === undefined || typeof value === "string") return value;
  ignored.push(`${at}${member}: is not a string`);
  return undefined;
}

/** A stored switch: a boolean as written; otherwise `Boolean(value)` for a registration, and ignored for a schema file. */
function readSwitch(record: StoredRecord, member: string, at: string, ignored: string[], source: ItemTypeDefinitionSource): boolean | undefined {
  const value = record[member];
  if (value === undefined || typeof value === "boolean") return value;
  const read = source === "extension" ? Boolean(value) : undefined;
  ignored.push(`${at}${member}: ${describeValue(value)} is not a boolean, so ${read === undefined ? "it is ignored" : `it reads as ${String(read)}`}`);
  return read;
}

/** Whether a stored name is a string with something besides whitespace, as the normalizer requires. */
function isNamed(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readOption(raw: unknown, at: string, ignored: string[], source: ItemTypeDefinitionSource): ItemTypeOptionDefinition | null {
  if (!isRecord(raw) || !isNamed(raw.key)) {
    ignored.push(`${at}: ${describeValue(raw)} is not an option with a key`);
    return null;
  }
  const prefix = `${at}.`;
  return {
    key: raw.key,
    values: readStringList(raw, "values", prefix, ignored) ?? [],
    required: readSwitch(raw, "required", prefix, ignored, source),
    aliases: readStringList(raw, "aliases", prefix, ignored),
    description: readString(raw, "description", prefix, ignored),
  };
}

function readPolicy(raw: unknown, at: string, ignored: string[], source: ItemTypeDefinitionSource): ItemTypeCommandOptionPolicy | null {
  const command = isRecord(raw) && typeof raw.command === "string" ? raw.command.trim().toLowerCase() : undefined;
  if (!isRecord(raw) || (command !== "create" && command !== "update") || !isNamed(raw.option)) {
    ignored.push(`${at}: ${describeValue(raw)} is not a create or update policy with an option`);
    return null;
  }
  const prefix = `${at}.`;
  return {
    command,
    option: raw.option,
    required: readSwitch(raw, "required", prefix, ignored, source),
    visible: readSwitch(raw, "visible", prefix, ignored, source),
    enabled: readSwitch(raw, "enabled", prefix, ignored, source),
  };
}

/**
 * The entries of a stored list of records, each read by `read`. A non-list,
 * or a non-empty list without one usable record, reads as absent: an empty
 * list would override the options or policies a type already has.
 */
function readRecordList<T>(
  record: StoredRecord,
  member: string,
  ignored: string[],
  source: ItemTypeDefinitionSource,
  read: (raw: unknown, at: string, ignored: string[], source: ItemTypeDefinitionSource) => T | null,
): T[] | undefined {
  const value = record[member];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    ignored.push(`${member}: is not a list`);
    return undefined;
  }
  const records = (value as unknown[]).flatMap((entry, index) => read(entry, `${member}[${index}]`, ignored, source) ?? []);
  return records.length === 0 && value.length > 0 ? undefined : records;
}

function readExecutionRole(record: StoredRecord, source: ItemTypeDefinitionSource, ignored: string[]): ItemTypeDefinition["execution_role"] {
  const value = record.execution_role;
  if (source === "extension" || value === undefined || value === "agent" || value === "human" || value === "gate") return parseItemExecutionRole(value);
  ignored.push(`execution_role: ${describeValue(value)} is not agent, human or gate, so the type reads as human and is never offered for agent dispatch`);
  return "human";
}

/**
 * Read one item type definition of unknown shape. The whole entry is dropped
 * only when it is not an object or its name is not a non-blank string; every
 * other wrong-typed member is ignored and reported.
 */
export function inspectItemTypeDefinition(
  raw: unknown,
  source: ItemTypeDefinitionSource,
): { definition: ItemTypeDefinition | null; loss: ItemTypeDefinitionLoss } {
  if (!isRecord(raw)) return { definition: null, loss: { dropped: "not_an_object", ignored: [] } };
  if (typeof raw.name !== "string" || raw.name.trim().length === 0) return { definition: null, loss: { dropped: "name_empty", ignored: [] } };
  const ignored: string[] = [];
  const definition: ItemTypeDefinition = {
    name: raw.name,
    description: readString(raw, "description", "", ignored),
    default_status: readString(raw, "default_status", "", ignored),
    execution_role: readExecutionRole(raw, source, ignored),
    folder: readString(raw, "folder", "", ignored),
    aliases: readStringList(raw, "aliases", "", ignored),
    required_create_fields: readStringList(raw, "required_create_fields", "", ignored),
    required_create_repeatables: readStringList(raw, "required_create_repeatables", "", ignored),
    options: readRecordList(raw, "options", ignored, source, readOption),
    command_option_policies: readRecordList(raw, "command_option_policies", ignored, source, readPolicy),
  };
  return { definition, loss: { ignored } };
}
