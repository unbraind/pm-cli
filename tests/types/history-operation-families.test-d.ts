import type { SchemaEvolutionMigrationRequest } from "../../src/sdk/schema-migration.js";

/** Compile-time exhaustive forward identities, also exercised by the runtime vocabulary gate. */
export const HISTORY_SCHEMA_MIGRATION_OPERATIONS = {
  "rename-type": "schema_rename_type",
  "rename-field": "schema_rename_field",
  "remap-status": "schema_remap_status",
} satisfies Record<SchemaEvolutionMigrationRequest["kind"], string>;
