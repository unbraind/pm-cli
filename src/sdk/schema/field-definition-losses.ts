/**
 * @module Stored custom field definitions the runtime field registry drops or
 * reads only in part (pm-x9r2h3).
 *
 * The registry skips a definition whose key or flag normalizes to nothing,
 * whose value schema is invalid or which is not an object, and it ignores a
 * blank alias, an unknown type or command and a non-string description. The
 * field then stops working, or works differently, and nothing else reports
 * it: every other diagnostic reads the resolved registry, where the
 * definition is already gone. This scan reads the stored entries themselves,
 * inline in settings.json and in the schema fields file, and judges each one
 * with the registry's own inspection.
 */

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_RUNTIME_SCHEMA_FILE_PATHS,
  filePathForSchemaSection,
  inspectRuntimeFieldDefinition,
  readFieldsFromSchemaFile,
  type RuntimeFieldDefinitionDropReason,
} from "../../core/schema/runtime-schema.js";
import { getSettingsPath } from "../../core/store/paths.js";
import { validateSettings } from "../../core/store/settings-validator.js";
import type { RuntimeSchemaSettings } from "../../types/index.js";

/** One stored field definition the registry drops whole or reads only in part. */
export interface FieldDefinitionLossRow {
  /** Where the definition is stored, relative to the tracker root. */
  source: string;
  /** Position of the definition in its stored list. */
  index: number;
  /** The stored key as written, or null when it is not a string. */
  key: string | null;
  /** Why the registry drops the whole definition. */
  dropped?: RuntimeFieldDefinitionDropReason;
  /** Members the registry ignores while it keeps the definition. */
  ignored?: string[];
}

/**
 * Parse a stored JSON document, or undefined when it is absent, not a regular file (a directory, a named pipe),
 * unreadable or not JSON; the settings read reports those cases, and the metadata check keeps scanning the other
 * source.
 */
export async function readStoredJson(filePath: string): Promise<unknown> {
  try {
    // A non-blocking open and a descriptor check: a named pipe at a configured path must not stall a settings
    // writer that holds the workspace lock. Links are followed, as the settings read follows them.
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      return (await handle.stat()).isFile() ? (JSON.parse(await handle.readFile("utf8")) as unknown) : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * The inline `schema.fields` list as the settings read admits it: settings validation strips members it does
 * not know (an inline `value_schema`) before the registry sees the entry, and a document it refuses is replaced
 * by defaults, so such a document contributes no rows here.
 */
function readInlineSchema(settings: unknown): Partial<RuntimeSchemaSettings> | undefined {
  const validated = validateSettings(settings);
  return validated.success ? (validated.data.schema as Partial<RuntimeSchemaSettings> | undefined) : undefined;
}

/** The definitions stored in the schema fields file the given schema configures, in any accepted file shape. */
export async function readFieldsFileDefinitions(pmRoot: string, schema: Partial<Pick<RuntimeSchemaSettings, "files">> | undefined): Promise<unknown[]> {
  const fieldsPath = filePathForSchemaSection(pmRoot, schema?.files?.fields, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.fields);
  return readFieldsFromSchemaFile(await readStoredJson(fieldsPath)) ?? [];
}

/** What a registry's own inspection discards from one stored definition. */
export interface StoredDefinitionLoss {
  /** Why the whole definition is dropped, when it is. */
  dropped?: string;
  /** Members ignored while the definition is kept. */
  ignored: string[];
}

/**
 * Judge each stored definition with the registry's own inspection and keep the
 * ones it changes, naming each by its stored identity member (`key`, `id`,
 * `name`) as written, or null when that member is not a string.
 */
export function collectDefinitionLosses<Member extends string>(
  source: string,
  definitions: readonly unknown[],
  member: Member,
  inspect: (definition: unknown, index: number) => StoredDefinitionLoss,
): Array<{ source: string; index: number; dropped?: string; ignored?: string[] } & Record<Member, string | null>> {
  return definitions.flatMap((definition, index) => {
    const loss = inspect(definition, index);
    if (loss.dropped === undefined && loss.ignored.length === 0) return [];
    const stored = (definition as Record<string, unknown> | null)?.[member];
    return [{
      source,
      index,
      [member]: typeof stored === "string" ? stored : null,
      ...(loss.dropped === undefined ? {} : { dropped: loss.dropped }),
      ...(loss.ignored.length === 0 ? {} : { ignored: loss.ignored }),
    } as { source: string; index: number; dropped?: string; ignored?: string[] } & Record<Member, string | null>];
  });
}

/** Judge each stored field definition with the field registry's own inspection. */
function collectLosses(source: string, definitions: readonly unknown[]): FieldDefinitionLossRow[] {
  return collectDefinitionLosses(source, definitions, "key", (definition) => inspectRuntimeFieldDefinition(definition).loss) as FieldDefinitionLossRow[];
}

/**
 * The stored inline schema, and the schema whose `files` name the schema files: the stored one when it sets
 * them, else the loaded one (whose hydration may have fallen back to defaults).
 */
export async function readConfiguredSchema(
  pmRoot: string,
  schema: RuntimeSchemaSettings,
): Promise<{ inline: Partial<RuntimeSchemaSettings> | undefined; configured: Partial<RuntimeSchemaSettings> }> {
  const inline = readInlineSchema(await readStoredJson(getSettingsPath(pmRoot)));
  return { inline, configured: inline?.files === undefined ? schema : inline };
}

/** A schema file path relative to the tracker root, with forward slashes. */
export function trackerRelativePath(pmRoot: string, filePath: string): string {
  return path.relative(pmRoot, filePath).split(path.sep).join("/");
}

/**
 * Diagnostic rows for stored field definitions the registry drops or reads
 * only in part, for `pm validate --check-metadata`. The schema carries the
 * configured fields-file path; the stored entries are read from disk because
 * the loaded settings no longer hold what the registry dropped.
 */
export async function scanFieldDefinitionLosses(
  pmRoot: string,
  schema: RuntimeSchemaSettings,
  limit: number,
): Promise<{ details: Record<string, unknown>; warnings: string[] }> {
  // The stored settings name the fields file; the loaded schema is defaults when its hydration failed.
  const { inline, configured } = await readConfiguredSchema(pmRoot, schema);
  const fieldsPath = filePathForSchemaSection(pmRoot, configured.files?.fields, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.fields);
  const rows = [
    ...collectLosses("settings.json", inline?.fields ?? []),
    ...collectLosses(trackerRelativePath(pmRoot, fieldsPath), await readFieldsFileDefinitions(pmRoot, configured)),
  ];
  if (rows.length === 0) return { details: {}, warnings: [] };
  const dropped = rows.filter((row) => row.dropped !== undefined).length;
  return {
    details: {
      schema_field_definition_loss_count: rows.length,
      schema_field_definition_losses: rows.slice(0, limit),
      schema_field_definition_losses_truncated: rows.length > limit,
      schema_field_definition_loss_fix_hint: "A dropped definition registers no option and a field read in part ignores the listed members. Re-register a file-backed field with valid values: pm schema add-field <key> --cli-flag <flag> --alias <alias> --commands <commands>. add-field replaces the type, commands, description, flag, aliases and requirement settings it is given but keeps value_schema, metadata_key, front_matter_key and repeatable, so edit or remove those members in the fields file. Edit or remove an entry stored inline in settings.json there.",
    },
    warnings: [
      ...(dropped > 0 ? [`validate_schema_field_definition_dropped:${dropped}`] : []),
      ...(rows.length > dropped ? [`validate_schema_field_definition_partial:${rows.length - dropped}`] : []),
    ],
  };
}
