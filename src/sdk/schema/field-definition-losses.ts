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

import path from "node:path";
import { readFileIfExists } from "../../core/fs/fs-utils.js";
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
 * Parse a stored JSON document, or undefined when it is absent, unreadable (a directory, a permission refusal)
 * or not JSON; the settings read reports those cases, and the metadata check keeps scanning the other source.
 */
async function readStoredJson(filePath: string): Promise<unknown> {
  try {
    const raw = await readFileIfExists(filePath);
    return raw === null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * The inline `schema.fields` list as the settings read admits it: settings validation strips members it does
 * not know (an inline `value_schema`) before the registry sees the entry, and a document it refuses is replaced
 * by defaults, so such a document contributes no rows here.
 */
function readInlineFieldDefinitions(settings: unknown): unknown[] {
  const validated = validateSettings(settings);
  return validated.success ? (validated.data.schema?.fields ?? []) : [];
}

/** The definitions stored in the schema fields file the given schema configures, in any accepted file shape. */
export async function readFieldsFileDefinitions(pmRoot: string, schema: Pick<RuntimeSchemaSettings, "files"> | undefined): Promise<unknown[]> {
  const fieldsPath = filePathForSchemaSection(pmRoot, schema?.files?.fields, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.fields);
  return readFieldsFromSchemaFile(await readStoredJson(fieldsPath)) ?? [];
}

/** Judge each stored definition with the registry's own inspection and keep the ones it changes. */
function collectLosses(source: string, definitions: readonly unknown[]): FieldDefinitionLossRow[] {
  return definitions.flatMap((definition, index) => {
    const { loss } = inspectRuntimeFieldDefinition(definition);
    if (loss.dropped === undefined && loss.ignored.length === 0) return [];
    const storedKey = (definition as { key?: unknown } | null)?.key;
    return [{
      source,
      index,
      key: typeof storedKey === "string" ? storedKey : null,
      ...(loss.dropped === undefined ? {} : { dropped: loss.dropped }),
      ...(loss.ignored.length === 0 ? {} : { ignored: loss.ignored }),
    }];
  });
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
  const fieldsPath = filePathForSchemaSection(pmRoot, schema.files.fields, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.fields);
  const rows = [
    ...collectLosses("settings.json", readInlineFieldDefinitions(await readStoredJson(getSettingsPath(pmRoot)))),
    ...collectLosses(path.relative(pmRoot, fieldsPath).split(path.sep).join("/"), await readFieldsFileDefinitions(pmRoot, schema)),
  ];
  if (rows.length === 0) return { details: {}, warnings: [] };
  const dropped = rows.filter((row) => row.dropped !== undefined).length;
  return {
    details: {
      schema_field_definition_loss_count: rows.length,
      schema_field_definition_losses: rows.slice(0, limit),
      schema_field_definition_losses_truncated: rows.length > limit,
      schema_field_definition_loss_fix_hint: "A dropped definition registers no option and a field read in part ignores the listed members. Re-register a file-backed field with valid values: pm schema add-field <key> --cli-flag <flag> --alias <alias> --commands <commands>. add-field keeps a stored value_schema, so for value_schema_invalid edit or remove that value_schema in the fields file. Edit or remove an entry stored inline in settings.json there.",
    },
    warnings: [
      ...(dropped > 0 ? [`validate_schema_field_definition_dropped:${dropped}`] : []),
      ...(rows.length > dropped ? [`validate_schema_field_definition_partial:${rows.length - dropped}`] : []),
    ],
  };
}
