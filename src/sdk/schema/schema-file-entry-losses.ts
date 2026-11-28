/**
 * @module Stored status and type definitions in the schema files that the
 * registries drop or read only in part (pm-x17o8l).
 *
 * A status or type entry with a wrong-typed member (a numeric description, a
 * non-string alias, an unknown execution role) used to throw inside the
 * settings read, so every setting fell back to its default. The registries now
 * ignore such members, and this scan names each one with its file and
 * position for `pm validate --check-metadata`. It judges the stored entries
 * with the registries' own inspection, because the loaded settings no longer
 * hold what was discarded.
 */

import {
  DEFAULT_RUNTIME_SCHEMA_FILE_PATHS,
  filePathForSchemaSection,
  inspectRuntimeStatusDefinition,
  readStatusesFromSchemaFile,
  readTypeDefinitionsFromSchemaFile,
} from "../../core/schema/runtime-schema.js";
import { inspectItemTypeDefinition } from "../../core/item/item-type-inspection.js";
import type { RuntimeSchemaSettings } from "../../types/index.js";
import { collectDefinitionLosses, readConfiguredSchema, readStoredJson, trackerRelativePath } from "./field-definition-losses.js";

/** Diagnostic details and warnings for one definition kind. */
function summarize(
  kind: "status" | "type",
  rows: ReadonlyArray<{ dropped?: string }>,
  limit: number,
): { details: Record<string, unknown>; warnings: string[] } {
  if (rows.length === 0) return { details: {}, warnings: [] };
  const dropped = rows.filter((row) => row.dropped !== undefined).length;
  return {
    details: {
      [`schema_${kind}_definition_loss_count`]: rows.length,
      [`schema_${kind}_definition_losses`]: rows.slice(0, limit),
      [`schema_${kind}_definition_losses_truncated`]: rows.length > limit,
    },
    warnings: [
      ...(dropped > 0 ? [`validate_schema_${kind}_definition_dropped:${dropped}`] : []),
      ...(rows.length > dropped ? [`validate_schema_${kind}_definition_partial:${rows.length - dropped}`] : []),
    ],
  };
}

/**
 * Diagnostic rows for stored status and type definitions in the configured
 * schema files that the registries drop or read only in part.
 */
export async function scanSchemaFileEntryLosses(
  pmRoot: string,
  schema: RuntimeSchemaSettings,
  limit: number,
): Promise<{ details: Record<string, unknown>; warnings: string[] }> {
  const { configured } = await readConfiguredSchema(pmRoot, schema);
  const statusesPath = filePathForSchemaSection(pmRoot, configured.files?.statuses, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.statuses);
  const typesPath = filePathForSchemaSection(pmRoot, configured.files?.types, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.types);
  const statuses = summarize(
    "status",
    collectDefinitionLosses(trackerRelativePath(pmRoot, statusesPath), readStatusesFromSchemaFile(await readStoredJson(statusesPath)) ?? [], "id", (entry, index) => inspectRuntimeStatusDefinition(entry, index).loss),
    limit,
  );
  const types = summarize(
    "type",
    collectDefinitionLosses(trackerRelativePath(pmRoot, typesPath), readTypeDefinitionsFromSchemaFile(await readStoredJson(typesPath)) ?? [], "name", (entry) => inspectItemTypeDefinition(entry, "schema_file").loss),
    limit,
  );
  const warnings = [...statuses.warnings, ...types.warnings];
  return {
    details: {
      ...statuses.details,
      ...types.details,
      ...(warnings.length === 0
        ? {}
        : { schema_definition_loss_fix_hint: "A dropped status or type is not registered, and a definition read in part ignores the listed members. Edit or remove the listed entries in the named schema file: give every status an id and every type a name, use strings for names, descriptions, aliases and folders, and agent, human or gate for execution_role." }),
    },
    warnings,
  };
}
