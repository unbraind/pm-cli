/**
 * @module sdk/schema
 *
 * Owns typed schema customization primitives shared by SDK, CLI, and MCP consumers.
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  pathExists,
  readFileIfExists,
} from "../core/fs/fs-utils.js";
import { writeWorkspaceJsonWithHistory } from "../core/history/workspace-history.js";
import { acquireLock } from "../core/lock/lock.js";
import { refreshMergeAttributeFenceIfInstalled } from "./merge/install.js";
import {
  assertAliasesAvailable,
  assertTypeFolderAvailable,
  buildInvalidTypeHint,
  escapeForDoubleQuotes,
  normalizeAddTypeInput,
  parseItemTypesFile,
  removeItemType,
  serializeItemTypesFile,
  upsertItemType,
  type ItemTypeDefinition,
} from "../core/schema/item-types-file.js";
import {
  assertStatusTokensAvailable,
  BUILTIN_STATUS_IDS,
  normalizeAddStatusInput,
  normalizeStatusToken,
  parseStatusDefsFile,
  removeStatusDef,
  serializeStatusDefsFile,
  upsertStatusDef,
  type RuntimeStatusDefinition,
} from "../core/schema/status-defs-file.js";
import {
  normalizeAddFieldInput,
  normalizeFieldKey,
  parseFieldsFile,
  removeField,
  serializeFieldsFile,
  upsertField,
  type RuntimeFieldDefinition,
} from "../core/schema/fields-file.js";
import {
  normalizeTypePresetName,
  resolveTypePresetDefinitions,
  TYPE_PRESET_NAMES,
  type TypePresetName,
} from "../core/schema/type-presets.js";
import {
  inferTypesFromTitles,
  type InferredTypeCandidate,
} from "../core/schema/type-inference.js";
import {
  DEFAULT_RUNTIME_SCHEMA_FILE_PATHS,
  filePathForSchemaSection,
  normalizeRuntimeSchemaSettings,
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
} from "../core/schema/runtime-schema.js";
import {
  resolveItemTypeRegistry,
  toDefaultFolder,
  type ResolvedItemTypeDefinition,
} from "../core/item/type-registry.js";
import { listAllItemMetadataLight } from "../core/store/item-store.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import type { PmSettings } from "../types/index.js";
import { PmCliError } from "../core/shared/errors.js";
import { nowIso } from "../core/shared/time.js";
import {
  getActiveExtensionRegistrations,
  runActiveOnWriteHooks,
} from "../core/extensions/index.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import {
  readSettings,
  resolveGovernanceKnobs,
} from "../core/store/settings.js";

/** Public contract for schema subcommands, shared by SDK and presentation-layer consumers. */
export const SCHEMA_SUBCOMMANDS = [
  "add-type",
  "remove-type",
  "add-status",
  "remove-status",
  "add-field",
  "remove-field",
  "list-fields",
  "show-field",
  "apply-preset",
  "list",
  "show",
  "show-status",
  "rename-type",
  "rename-field",
  "remap-status",
] as const;
/** Restricts schema subcommand values accepted by command, SDK, and storage contracts. */
export type SchemaSubcommand = (typeof SCHEMA_SUBCOMMANDS)[number];

export {
  formatSchemaEvolutionMigrationHuman,
  planSchemaEvolutionMigration,
  runSchemaEvolutionMigration,
  type PlanSchemaEvolutionMigrationOptions,
  type RunSchemaEvolutionMigrationOptions,
  type SchemaEvolutionFieldChange,
  type SchemaEvolutionItemPlan,
  type SchemaEvolutionMigrationPlan,
  type SchemaEvolutionMigrationRequest,
  type SchemaEvolutionMigrationResult,
} from "./schema-migration.js";

const SCHEMA_TYPES_LOCK_ID = "schema-types";
const SCHEMA_STATUSES_LOCK_ID = "schema-statuses";
const SCHEMA_FIELDS_LOCK_ID = "schema-fields";

function writeAuditedSchemaFile(params: {
  pmRoot: string;
  filePath: string;
  raw: string;
  op: string;
  author: string;
  settings: PmSettings;
}): Promise<boolean> {
  return writeWorkspaceJsonWithHistory({
    pmRoot: params.pmRoot,
    filePath: params.filePath,
    raw: params.raw,
    op: params.op,
    author: params.author,
    lockTtlSeconds: params.settings.locks.ttl_seconds,
    lockWaitMs: params.settings.locks.wait_ms,
  });
}

/** Documents the schema add type command options payload exchanged by command, SDK, and package integrations. */
export interface SchemaAddTypeCommandOptions {
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Default status id newly created items of this type receive. */
  defaultStatus?: string;
  /** Value that configures or reports folder for this contract. */
  folder?: string;
  /** Value that configures or reports alias for this contract. */
  alias?: string[];
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the schema remove type command options payload exchanged by command, SDK, and package integrations. */
export interface SchemaRemoveTypeCommandOptions {
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the schema add status command options payload exchanged by command, SDK, and package integrations. */
export interface SchemaAddStatusCommandOptions {
  /** Value that configures or reports role for this contract. */
  role?: string[];
  /** Value that configures or reports alias for this contract. */
  alias?: string[];
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Value that configures or reports order for this contract. */
  order?: number;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the schema remove status command options payload exchanged by command, SDK, and package integrations. */
export interface SchemaRemoveStatusCommandOptions {
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the schema add type result payload exchanged by command, SDK, and package integrations. */
export interface SchemaAddTypeResult {
  /** Value that configures or reports action for this contract. */
  action: "add-type";
  /** Value that configures or reports registered for this contract. */
  registered: boolean;
  /** Value that configures or reports replaced for this contract. */
  replaced: boolean;
  /** Schema type that determines the shape and validation rules for this value. */
  type: ItemTypeDefinition;
  /** Value that configures or reports file for this contract. */
  file: {
    path: string;
    definitions: number;
  };
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

/** Documents the schema remove type result payload exchanged by command, SDK, and package integrations. */
export interface SchemaRemoveTypeResult {
  /** Value that configures or reports action for this contract. */
  action: "remove-type";
  /** Value that configures or reports removed for this contract. */
  removed: boolean;
  /** Schema type that determines the shape and validation rules for this value. */
  type?: ItemTypeDefinition;
  /** Value that configures or reports file for this contract. */
  file: {
    path: string;
    definitions: number;
  };
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

/** Documents the schema add status result payload exchanged by command, SDK, and package integrations. */
export interface SchemaAddStatusResult {
  /** Value that configures or reports action for this contract. */
  action: "add-status";
  /** Value that configures or reports registered for this contract. */
  registered: boolean;
  /** Value that configures or reports replaced for this contract. */
  replaced: boolean;
  /** Lifecycle state reported for status. */
  status: RuntimeStatusDefinition;
  /** Value that configures or reports file for this contract. */
  file: {
    path: string;
    statuses: number;
  };
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

/** Documents the schema remove status result payload exchanged by command, SDK, and package integrations. */
export interface SchemaRemoveStatusResult {
  /** Value that configures or reports action for this contract. */
  action: "remove-status";
  /** Value that configures or reports removed for this contract. */
  removed: boolean;
  /** Lifecycle state reported for status. */
  status?: RuntimeStatusDefinition;
  /** Value that configures or reports file for this contract. */
  file: {
    path: string;
    statuses: number;
  };
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

/** Documents the schema add field command options payload exchanged by command, SDK, and package integrations. */
export interface SchemaAddFieldCommandOptions {
  /** Schema type that determines the shape and validation rules for this value. */
  type?: string;
  /** Value that configures or reports commands for this contract. */
  commands?: string[];
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Value that configures or reports cli flag for this contract. */
  cliFlag?: string;
  /** Value that configures or reports alias for this contract. */
  alias?: string[];
  /** Value that configures or reports required for this contract. */
  required?: boolean;
  /** Value that configures or reports required on create for this contract. */
  requiredOnCreate?: boolean;
  /** Value that configures or reports allow unset for this contract. */
  allowUnset?: boolean;
  /** Value that configures or reports required types for this contract. */
  requiredTypes?: string[];
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the schema remove field command options payload exchanged by command, SDK, and package integrations. */
export interface SchemaRemoveFieldCommandOptions {
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the schema apply preset command options payload exchanged by command, SDK, and package integrations. */
export interface SchemaApplyPresetCommandOptions {
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the schema add type infer command options payload exchanged by command, SDK, and package integrations. */
export interface SchemaAddTypeInferCommandOptions {
  /** Number of min entries represented by this result. */
  minCount?: number;
  /** Value that configures or reports apply for this contract. */
  apply?: boolean;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the schema field summary payload exchanged by command, SDK, and package integrations. */
export interface SchemaFieldSummary {
  /** Value that configures or reports key for this contract. */
  key: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type: string;
  /** Value that configures or reports commands for this contract. */
  commands: string[];
  /** Value that configures or reports cli flag for this contract. */
  cli_flag: string;
  /** Value that configures or reports cli aliases for this contract. */
  cli_aliases: string[];
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Value that configures or reports required for this contract. */
  required: boolean;
  /** Value that configures or reports required on create for this contract. */
  required_on_create: boolean;
  /** Value that configures or reports allow unset for this contract. */
  allow_unset: boolean;
  /** Value that configures or reports required types for this contract. */
  required_types: string[];
}

/** Documents the schema add field result payload exchanged by command, SDK, and package integrations. */
export interface SchemaAddFieldResult {
  /** Value that configures or reports action for this contract. */
  action: "add-field";
  /** Value that configures or reports registered for this contract. */
  registered: boolean;
  /** Value that configures or reports replaced for this contract. */
  replaced: boolean;
  /** Value that configures or reports field for this contract. */
  field: RuntimeFieldDefinition;
  /** Value that configures or reports file for this contract. */
  file: {
    path: string;
    fields: number;
  };
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

/** Documents the schema remove field result payload exchanged by command, SDK, and package integrations. */
export interface SchemaRemoveFieldResult {
  /** Value that configures or reports action for this contract. */
  action: "remove-field";
  /** Value that configures or reports removed for this contract. */
  removed: boolean;
  /** Value that configures or reports field for this contract. */
  field?: RuntimeFieldDefinition;
  /** Value that configures or reports file for this contract. */
  file: {
    path: string;
    fields: number;
  };
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

/** Documents the schema list fields result payload exchanged by command, SDK, and package integrations. */
export interface SchemaListFieldsResult {
  /** Value that configures or reports action for this contract. */
  action: "list-fields";
  /** Value that configures or reports fields for this contract. */
  fields: SchemaFieldSummary[];
  /** Value that configures or reports counts for this contract. */
  counts: {
    total: number;
  };
  /** Value that configures or reports file for this contract. */
  file: {
    path: string;
  };
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

/** Documents the schema show field result payload exchanged by command, SDK, and package integrations. */
export interface SchemaShowFieldResult {
  /** Value that configures or reports action for this contract. */
  action: "show-field";
  /** Value that configures or reports field for this contract. */
  field: SchemaFieldSummary;
  /** Value that configures or reports file for this contract. */
  file: {
    path: string;
  };
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

/** Documents the schema apply preset result payload exchanged by command, SDK, and package integrations. */
export interface SchemaApplyPresetResult {
  /** Value that configures or reports action for this contract. */
  action: "apply-preset";
  /** Value that configures or reports preset for this contract. */
  preset: TypePresetName;
  /** Value that configures or reports registered for this contract. */
  registered: string[];
  /** Value that configures or reports replaced for this contract. */
  replaced: string[];
  /** Value that configures or reports file for this contract. */
  file: {
    path: string;
    definitions: number;
  };
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

/** Documents the schema add type infer result payload exchanged by command, SDK, and package integrations. */
export interface SchemaAddTypeInferResult {
  /** Value that configures or reports action for this contract. */
  action: "infer-types";
  /** Value that configures or reports applied for this contract. */
  applied: boolean;
  /** Number of min entries represented by this result. */
  min_count: number;
  /** Value that configures or reports candidates for this contract. */
  candidates: InferredTypeCandidate[];
  /** Value that configures or reports registered for this contract. */
  registered: string[];
  /** Value that configures or reports replaced for this contract. */
  replaced: string[];
  /** Value that configures or reports skipped for this contract. */
  skipped: Array<{ name: string; reason: string }>;
  /** Value that configures or reports file for this contract. */
  file: {
    path: string;
    definitions: number;
  };
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

/** Documents the schema type summary payload exchanged by command, SDK, and package integrations. */
export interface SchemaTypeSummary {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports folder for this contract. */
  folder: string;
  /** Value that configures or reports aliases for this contract. */
  aliases: string[];
  /** Default status id newly created items of this type receive. */
  default_status?: string;
  /** Value that configures or reports description for this contract. */
  description?: string;
}

/** Documents the schema status summary payload exchanged by command, SDK, and package integrations. */
export interface SchemaStatusSummary {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports source for this contract. */
  source: "builtin" | "custom";
  /** Value that configures or reports roles for this contract. */
  roles: string[];
  /** Value that configures or reports aliases for this contract. */
  aliases: string[];
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Value that configures or reports order for this contract. */
  order?: number;
}

/** Documents the schema type definition result payload exchanged by command, SDK, and package integrations. */
export interface SchemaTypeDefinitionResult extends SchemaTypeSummary {
  /** Value that configures or reports source for this contract. */
  source: "builtin" | "custom" | "extension";
  /** Value that configures or reports extension for this contract. */
  extension?: {
    layer: string;
    name: string;
  };
  /** Value that configures or reports required create fields for this contract. */
  required_create_fields: string[];
  /** Value that configures or reports required create repeatables for this contract. */
  required_create_repeatables: string[];
  /** Value that configures or reports options for this contract. */
  options: ResolvedItemTypeDefinition["options"];
  /** Value that configures or reports command option policies for this contract. */
  command_option_policies: ResolvedItemTypeDefinition["command_option_policies"];
}

/** Documents the schema list result payload exchanged by command, SDK, and package integrations. */
export interface SchemaListResult {
  /** Value that configures or reports action for this contract. */
  action: "list";
  /** Value that configures or reports builtin for this contract. */
  builtin: SchemaTypeSummary[];
  /** Value that configures or reports custom for this contract. */
  custom: SchemaTypeSummary[];
  /** Value that configures or reports extension for this contract. */
  extension: SchemaTypeSummary[];
  /** Value that configures or reports counts for this contract. */
  counts: {
    builtin: number;
    custom: number;
    extension: number;
    total: number;
  };
  /** Value that configures or reports statuses for this contract. */
  statuses: {
    builtin: SchemaStatusSummary[];
    custom: SchemaStatusSummary[];
    counts: {
      builtin: number;
      custom: number;
      total: number;
    };
  };
  /** Value that configures or reports fields for this contract. */
  fields: {
    custom: SchemaFieldSummary[];
    counts: {
      total: number;
    };
  };
  /** Value that configures or reports file for this contract. */
  file: {
    path: string;
  };
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

/** Documents the schema show result payload exchanged by command, SDK, and package integrations. */
export interface SchemaShowResult {
  /** Value that configures or reports action for this contract. */
  action: "show";
  /** Schema type that determines the shape and validation rules for this value. */
  type: SchemaTypeDefinitionResult;
  /** Value that configures or reports file for this contract. */
  file: {
    path: string;
  };
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

/** Documents the schema show status result payload exchanged by command, SDK, and package integrations. */
export interface SchemaShowStatusResult {
  /** Value that configures or reports action for this contract. */
  action: "show-status";
  /** Lifecycle state reported for status. */
  status: SchemaStatusSummary;
  /** Value that configures or reports file for this contract. */
  file: {
    path: string;
  };
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

/** Restricts schema inspect result values accepted by command, SDK, and storage contracts. */
export type SchemaInspectResult =
  | SchemaListResult
  | SchemaShowResult
  | SchemaShowStatusResult
  | SchemaListFieldsResult
  | SchemaShowFieldResult;

function toAuthor(
  candidate: string | undefined,
  defaultAuthor: string,
): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? defaultAuthor;
  const trimmed = resolved.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

/* c8 ignore start -- schema command mutation/inspection branches are covered by broader schema integration workflows. */
/** Implements run schema add type for the public runtime surface of this module. */
export async function runSchemaAddType(
  name: string | undefined,
  options: SchemaAddTypeCommandOptions,
  global: GlobalOptions,
): Promise<SchemaAddTypeResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);

  let normalized;
  try {
    normalized = normalizeAddTypeInput({
      name,
      description: options.description,
      defaultStatus: options.defaultStatus,
      folder: options.folder,
      aliases: options.alias,
    });
  } catch (error) {
    throw new PmCliError(
      error instanceof Error ? error.message : String(error),
      EXIT_CODE.USAGE,
    );
  }

  const settings = await readSettings(pmRoot);
  const schema = normalizeRuntimeSchemaSettings(settings.schema);
  const typesPath = filePathForSchemaSection(
    pmRoot,
    schema.files.types,
    DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.types,
  );

  const warnings: string[] = [];
  const author = toAuthor(options.author, settings.author_default);
  const governance = resolveGovernanceKnobs(settings);

  const releaseLock = await acquireLock(
    pmRoot,
    SCHEMA_TYPES_LOCK_ID,
    settings.locks.ttl_seconds,
    author,
    Boolean(options.force),
    governance.force_required_for_stale_lock,
    settings.locks.wait_ms,
  );
  let upsert;
  try {
    const previousRaw = await readFileIfExists(typesPath);
    let parsed;
    try {
      parsed = parseItemTypesFile(previousRaw);
    } catch (error) {
      throw new PmCliError(
        error instanceof Error ? error.message : String(error),
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    try {
      assertAliasesAvailable(normalized, parsed);
      // GH-248: reject distinct type names that would slug to the same storage
      // folder (e.g. "Spike"/"Spikes") so item files never silently share a
      // directory. Same-named upserts (recase/idempotent re-runs) are exempt.
      // reservedFolders covers built-in + extension + settings-resolved custom
      // folders so a slug like "Tasks" can't collide with the built-in Task.
      const reservedFolders = new Map<string, string>();
      const resolvedRegistry = resolveItemTypeRegistry(
        settings,
        getActiveExtensionRegistrations(),
      );
      for (const [typeName, folder] of Object.entries(
        resolvedRegistry.type_to_folder,
      )) {
        const folderKey = folder.trim().toLowerCase();
        if (folderKey.length > 0 && !reservedFolders.has(folderKey)) {
          reservedFolders.set(folderKey, typeName);
        }
      }
      assertTypeFolderAvailable(normalized, parsed, reservedFolders);
    } catch (error) {
      throw new PmCliError(
        error instanceof Error ? error.message : String(error),
        EXIT_CODE.USAGE,
      );
    }
    upsert = upsertItemType(parsed, normalized);
    // GH-248: an upsert that only differs in case from the existing canonical
    // name silently renames the stored type (e.g. registering "spike" over
    // "Spike"). Surface it as a non-blocking warning so the operator knows the
    // existing definition was replaced rather than a new type created.
    if (
      upsert.replaced &&
      upsert.previousName !== undefined &&
      upsert.previousName !== upsert.definition.name
    ) {
      warnings.push(
        `type_recased:${upsert.previousName}->${upsert.definition.name}`,
      );
    }
    // writeFileAtomic writes to a temp file then renames, so a failure leaves the
    // existing types.json untouched; no manual rollback is needed.
    await writeAuditedSchemaFile({
      pmRoot,
      filePath: typesPath,
      raw: serializeItemTypesFile(upsert.file),
      op: "schema:add-type",
      author,
      settings,
    });
    await ensureTypeFolderScaffold(
      pmRoot,
      [upsert.definition],
      warnings,
      "schema:add-type-folder",
    );
    warnings.push(
      ...(await runActiveOnWriteHooks({
        path: typesPath,
        scope: "project",
        op: "schema:add-type",
      })),
    );
  } finally {
    await releaseLock();
  }
  await appendMergeFenceWarnings(pmRoot, warnings);

  return {
    action: "add-type",
    registered: true,
    replaced: upsert.replaced,
    type: upsert.definition,
    file: {
      path: typesPath,
      definitions: upsert.file.definitions.length,
    },
    warnings: finalizeWarnings(warnings),
    generated_at: nowIso(),
  };
}

async function ensureInitialized(pmRoot: string): Promise<void> {
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
}

/**
 * Reconcile the committed merge-driver fence with the type folders that exist
 * after a schema type mutation. When `pm merge install` already ran the fence
 * is rewritten in place (`merge_fence_refreshed`); when the repository has a
 * tracker inside git but never installed the fence, an actionable hint warning
 * is emitted instead — new type folders would otherwise merge under git's
 * default text driver and reintroduce whole-file item conflicts (pm-i4fx).
 */
async function appendMergeFenceWarnings(
  pmRoot: string,
  warnings: string[],
): Promise<void> {
  try {
    const fence = await refreshMergeAttributeFenceIfInstalled(pmRoot);
    if (fence.status === "refreshed") {
      warnings.push("merge_fence_refreshed");
    } else if (fence.status === "not_installed") {
      warnings.push(
        'merge_fence_not_installed:type folders lack git merge drivers; run "pm merge install"',
      );
    }
  } catch {
    warnings.push(
      'merge_fence_refresh_failed:run "pm merge install" to reconcile',
    );
  }
}

/** Deduplicates schema mutation warnings and returns their stable locale-aware order. */
function finalizeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)].sort((left, right) =>
    left.localeCompare(right),
  );
}

/** Counts items whose resolved type matches `typeName` (case-insensitive). Uses the lightest existing read path (listAllItemMetadataLight skips the heavy collections cache). All items are counted — not just open ones — so the advisory warning surfaces every item the removed definition would orphan; the count is non-blocking. The caller passes its already-loaded `settings` so we never re-read settings.json from disk here. */
async function countItemsUsingType(
  pmRoot: string,
  settings: PmSettings,
  schema: ReturnType<typeof normalizeRuntimeSchemaSettings>,
  typeName: string,
): Promise<number> {
  const registry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const lowerName = typeName.trim().toLowerCase();
  const items = await listAllItemMetadataLight(
    pmRoot,
    settings.item_format,
    registry.type_to_folder,
    [],
    schema,
  );
  return items.filter(
    (item) =>
      typeof item.type === "string" && item.type.toLowerCase() === lowerName,
  ).length;
}

/** Counts items currently set to the status whose id/aliases resolve to `statusId`. Uses listAllItemMetadataLight (the lightest read path). All items are counted regardless of lifecycle phase; the count is advisory only. The caller passes its already-loaded `settings` so we never re-read from disk. */
async function countItemsUsingStatus(
  pmRoot: string,
  settings: PmSettings,
  schema: ReturnType<typeof normalizeRuntimeSchemaSettings>,
  statusId: string,
): Promise<number> {
  const registry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const statusRegistry = resolveRuntimeStatusRegistry(schema);
  const normalizedId = normalizeStatusToken(statusId);
  const items = await listAllItemMetadataLight(
    pmRoot,
    settings.item_format,
    registry.type_to_folder,
    [],
    schema,
  );
  return items.filter((item) => {
    const itemStatus = typeof item.status === "string" ? item.status : "";
    const resolved =
      statusRegistry.alias_to_id.get(normalizeStatusToken(itemStatus)) ??
      normalizeStatusToken(itemStatus);
    return resolved === normalizedId;
  }).length;
}

/** Adds non-blocking usage and workflow diagnostics for a removed custom status. */
async function appendRemovedStatusWarnings(
  warnings: string[],
  pmRoot: string,
  settings: PmSettings,
  schema: ReturnType<typeof normalizeRuntimeSchemaSettings>,
  removedId: string,
): Promise<void> {
  if (removedId.length === 0 || BUILTIN_STATUS_IDS.has(removedId)) {
    return;
  }
  const usingStatus = await countItemsUsingStatus(
    pmRoot,
    settings,
    schema,
    removedId,
  );
  if (usingStatus > 0) {
    warnings.push(`items_using_status:${usingStatus}`);
  }
  const referencingSlots = workflowSlotsReferencing(schema.workflow, removedId);
  if (referencingSlots.length > 0) {
    warnings.push(
      `status_referenced_by_workflow:${referencingSlots.join(",")}`,
    );
  }
}

/** Returns the workflow role-slot names (open_status, close_status, ...) that currently point at `statusId` (normalized). Used to warn before removing a status that a workflow default still references. */
function workflowSlotsReferencing(
  workflow: {
    draft_status?: string;
    open_status?: string;
    in_progress_status?: string;
    blocked_status?: string;
    close_status?: string;
    canceled_status?: string;
  },
  statusId: string,
): string[] {
  const slots: Array<[string, string | undefined]> = [
    ["draft_status", workflow.draft_status],
    ["open_status", workflow.open_status],
    ["in_progress_status", workflow.in_progress_status],
    ["blocked_status", workflow.blocked_status],
    ["close_status", workflow.close_status],
    ["canceled_status", workflow.canceled_status],
  ];
  return slots
    .filter(
      ([, value]) =>
        value !== undefined && normalizeStatusToken(value) === statusId,
    )
    .map(([slot]) => slot);
}

/** Implements run schema remove type for the public runtime surface of this module. */
export async function runSchemaRemoveType(
  name: string | undefined,
  options: SchemaRemoveTypeCommandOptions,
  global: GlobalOptions,
): Promise<SchemaRemoveTypeResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);

  const settings = await readSettings(pmRoot);
  const schema = normalizeRuntimeSchemaSettings(settings.schema);
  const typesPath = filePathForSchemaSection(
    pmRoot,
    schema.files.types,
    DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.types,
  );

  const warnings: string[] = [];
  const author = toAuthor(options.author, settings.author_default);
  const governance = resolveGovernanceKnobs(settings);

  const releaseLock = await acquireLock(
    pmRoot,
    SCHEMA_TYPES_LOCK_ID,
    settings.locks.ttl_seconds,
    author,
    Boolean(options.force),
    governance.force_required_for_stale_lock,
    settings.locks.wait_ms,
  );
  let removal;
  try {
    const previousRaw = await readFileIfExists(typesPath);
    let parsed;
    try {
      parsed = parseItemTypesFile(previousRaw);
    } catch (error) {
      throw new PmCliError(
        error instanceof Error ? error.message : String(error),
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    try {
      removal = removeItemType(parsed, name);
    } catch (error) {
      throw new PmCliError(
        error instanceof Error ? error.message : String(error),
        EXIT_CODE.USAGE,
      );
    }
    if (removal.removed) {
      // Only emit the advisory orphan-count warning once a removable custom
      // definition was actually removed; a no-op/unknown removal would otherwise
      // surface a misleading items_using_type:* warning. The count is
      // non-blocking and reuses the already-loaded settings (no disk re-read).
      const removedName = (removal.definition?.name ?? name ?? "").trim();
      if (removedName.length > 0) {
        const usingType = await countItemsUsingType(
          pmRoot,
          settings,
          schema,
          removedName,
        );
        if (usingType > 0) {
          warnings.push(`items_using_type:${usingType}`);
        }
      }
      // writeFileAtomic writes to a temp file then renames, so a failure leaves
      // the existing types.json untouched; no manual rollback is needed.
      await writeAuditedSchemaFile({
        pmRoot,
        filePath: typesPath,
        raw: serializeItemTypesFile(removal.file),
        op: "schema:remove-type",
        author,
        settings,
      });
      warnings.push(
        ...(await runActiveOnWriteHooks({
          path: typesPath,
          scope: "project",
          op: "schema:remove-type",
        })),
      );
    }
  } finally {
    await releaseLock();
  }
  if (removal.removed) {
    await appendMergeFenceWarnings(pmRoot, warnings);
  }

  return {
    action: "remove-type",
    removed: removal.removed,
    ...(removal.definition ? { type: removal.definition } : {}),
    file: {
      path: typesPath,
      definitions: removal.file.definitions.length,
    },
    warnings: finalizeWarnings(warnings),
    generated_at: nowIso(),
  };
}

function statusesPathFor(
  pmRoot: string,
  schema: ReturnType<typeof normalizeRuntimeSchemaSettings>,
): string {
  return filePathForSchemaSection(
    pmRoot,
    schema.files.statuses,
    DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.statuses,
  );
}

function fieldsPathFor(
  pmRoot: string,
  schema: ReturnType<typeof normalizeRuntimeSchemaSettings>,
): string {
  return filePathForSchemaSection(
    pmRoot,
    schema.files.fields,
    DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.fields,
  );
}

function typesPathFor(
  pmRoot: string,
  schema: ReturnType<typeof normalizeRuntimeSchemaSettings>,
): string {
  return filePathForSchemaSection(
    pmRoot,
    schema.files.types,
    DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.types,
  );
}

/** Creates the storage folder for each item-type definition (resolving the default folder when unset) and runs on-write hooks for newly created folders. Shared with `pm profile apply` so profile-staged types scaffold identically to `pm schema add-type`. Existing folders are skipped, keeping the call idempotent. */
export async function ensureTypeFolderScaffold(
  pmRoot: string,
  definitions: readonly ItemTypeDefinition[],
  warnings: string[],
  op: string,
): Promise<void> {
  for (const definition of definitions) {
    const folder = definition.folder ?? toDefaultFolder(definition.name);
    const target = path.join(pmRoot, folder);
    if (await pathExists(target)) {
      continue;
    }
    await mkdir(target, { recursive: true });
    warnings.push(
      ...(await runActiveOnWriteHooks({
        path: target,
        scope: "project",
        op,
      })),
    );
  }
}

function toSchemaFieldSummary(
  field: ReturnType<typeof resolveRuntimeFieldRegistry>["definitions"][number],
): SchemaFieldSummary {
  return {
    key: field.key,
    type: field.type,
    commands: [...field.commands],
    cli_flag: `--${field.cli_flag}`,
    cli_aliases: field.cli_aliases.map((alias) => `--${alias}`),
    ...(field.description ? { description: field.description } : {}),
    required: field.required,
    required_on_create: field.required_on_create,
    allow_unset: field.allow_unset,
    required_types: [...field.required_types],
  };
}

function toExistingStatusDefinition(
  resolvedExisting:
    | ReturnType<typeof resolveRuntimeStatusRegistry>["definitions"][number]
    | undefined,
): RuntimeStatusDefinition | undefined {
  if (!resolvedExisting) {
    return undefined;
  }
  return {
    id: resolvedExisting.id,
    ...(resolvedExisting.roles.length > 0
      ? { roles: [...resolvedExisting.roles] }
      : {}),
    ...(resolvedExisting.aliases.length > 0
      ? { aliases: [...resolvedExisting.aliases] }
      : {}),
    ...(resolvedExisting.description
      ? { description: resolvedExisting.description }
      : {}),
    ...(typeof resolvedExisting.order === "number"
      ? { order: resolvedExisting.order }
      : {}),
  };
}

function buildStatusFileAliasMap(
  statuses: RuntimeStatusDefinition[],
): Map<string, string> {
  const fileAliasToId = new Map<string, string>();
  for (const definition of statuses) {
    const defId = normalizeStatusToken(definition.id);
    if (defId.length === 0) {
      continue;
    }
    fileAliasToId.set(defId, defId);
    for (const alias of Array.isArray(definition.aliases)
      ? definition.aliases
      : []) {
      const aliasToken = normalizeStatusToken(alias);
      if (aliasToken.length > 0 && !fileAliasToId.has(aliasToken)) {
        fileAliasToId.set(aliasToken, defId);
      }
    }
  }
  return fileAliasToId;
}

/** Implements run schema add status for the public runtime surface of this module. */
export async function runSchemaAddStatus(
  id: string | undefined,
  options: SchemaAddStatusCommandOptions,
  global: GlobalOptions,
): Promise<SchemaAddStatusResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);

  let normalized;
  try {
    normalized = normalizeAddStatusInput({
      id,
      roles: options.role,
      aliases: options.alias,
      description: options.description,
      order: options.order,
    });
  } catch (error) {
    throw new PmCliError(
      error instanceof Error ? error.message : String(error),
      EXIT_CODE.USAGE,
    );
  }

  const settings = await readSettings(pmRoot);
  const schema = normalizeRuntimeSchemaSettings(settings.schema);
  const statusesPath = statusesPathFor(pmRoot, schema);
  const statusRegistry = resolveRuntimeStatusRegistry(schema);

  // Reject id/alias collisions with a DIFFERENT existing status so a custom
  // status can never shadow a built-in lifecycle token (e.g. --alias open).
  try {
    assertStatusTokensAvailable(normalized, statusRegistry.alias_to_id);
  } catch (error) {
    throw new PmCliError(
      error instanceof Error ? error.message : String(error),
      EXIT_CODE.USAGE,
    );
  }

  // Seed the upsert from the resolved (settings-or-file) definition so omitting
  // --role/--alias preserves metadata defined in settings.schema.statuses, not
  // only what is already in statuses.json.
  const baseDefinition = toExistingStatusDefinition(
    statusRegistry.by_id.get(normalized.id),
  );

  const warnings: string[] = [];
  const author = toAuthor(options.author, settings.author_default);
  const governance = resolveGovernanceKnobs(settings);

  const releaseLock = await acquireLock(
    pmRoot,
    SCHEMA_STATUSES_LOCK_ID,
    settings.locks.ttl_seconds,
    author,
    Boolean(options.force),
    governance.force_required_for_stale_lock,
    settings.locks.wait_ms,
  );
  let upsert;
  try {
    const previousRaw = await readFileIfExists(statusesPath);
    let parsed;
    try {
      parsed = parseStatusDefsFile(previousRaw);
    } catch (error) {
      throw new PmCliError(
        error instanceof Error ? error.message : String(error),
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    // Re-check collisions against the CURRENT file under the lock: the pre-lock
    // check used the registry loaded before acquiring schema-statuses, so a
    // concurrent add-status could have written a colliding id/alias in between.
    // The lock serializes writes; this serializes the collision decision too.
    const fileAliasToId = buildStatusFileAliasMap(parsed.statuses);
    try {
      assertStatusTokensAvailable(normalized, fileAliasToId);
    } catch (error) {
      throw new PmCliError(
        error instanceof Error ? error.message : String(error),
        EXIT_CODE.USAGE,
      );
    }
    upsert = upsertStatusDef(parsed, normalized, baseDefinition);
    // writeFileAtomic writes to a temp file then renames, so a failure leaves
    // the existing statuses.json untouched; no manual rollback is needed.
    await writeAuditedSchemaFile({
      pmRoot,
      filePath: statusesPath,
      raw: serializeStatusDefsFile(upsert.file),
      op: "schema:add-status",
      author,
      settings,
    });
    warnings.push(
      ...(await runActiveOnWriteHooks({
        path: statusesPath,
        scope: "project",
        op: "schema:add-status",
      })),
    );
  } finally {
    await releaseLock();
  }

  return {
    action: "add-status",
    registered: true,
    replaced: upsert.replaced,
    status: upsert.definition,
    file: {
      path: statusesPath,
      statuses: upsert.file.statuses.length,
    },
    warnings: finalizeWarnings(warnings),
    generated_at: nowIso(),
  };
}

/** Implements run schema remove status for the public runtime surface of this module. */
export async function runSchemaRemoveStatus(
  id: string | undefined,
  options: SchemaRemoveStatusCommandOptions,
  global: GlobalOptions,
): Promise<SchemaRemoveStatusResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);

  const settings = await readSettings(pmRoot);
  const schema = normalizeRuntimeSchemaSettings(settings.schema);
  const statusesPath = statusesPathFor(pmRoot, schema);

  const warnings: string[] = [];
  const author = toAuthor(options.author, settings.author_default);
  const governance = resolveGovernanceKnobs(settings);

  const releaseLock = await acquireLock(
    pmRoot,
    SCHEMA_STATUSES_LOCK_ID,
    settings.locks.ttl_seconds,
    author,
    Boolean(options.force),
    governance.force_required_for_stale_lock,
    settings.locks.wait_ms,
  );
  let removal;
  try {
    const previousRaw = await readFileIfExists(statusesPath);
    let parsed;
    try {
      parsed = parseStatusDefsFile(previousRaw);
    } catch (error) {
      throw new PmCliError(
        error instanceof Error ? error.message : String(error),
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    try {
      removal = removeStatusDef(parsed, id);
    } catch (error) {
      throw new PmCliError(
        error instanceof Error ? error.message : String(error),
        EXIT_CODE.USAGE,
      );
    }
    if (removal.removed) {
      // Only emit the advisory orphan-count warning once a removable custom
      // status was actually removed; a no-op/unknown removal would otherwise
      // surface a misleading items_using_status:* warning. The count reuses the
      // already-loaded settings (no disk re-read) and is non-blocking.
      const removedId = normalizeStatusToken(removal.definition?.id ?? id);
      // Removing a status that a workflow default still points at would leave
      // pm close / default pm create resolving to an unregistered status. Warn
      // (non-blocking, consistent with remove-type) so the operator re-points
      // the workflow slot via schema/workflows.json or pm config.
      await appendRemovedStatusWarnings(
        warnings,
        pmRoot,
        settings,
        schema,
        removedId,
      );
      await writeAuditedSchemaFile({
        pmRoot,
        filePath: statusesPath,
        raw: serializeStatusDefsFile(removal.file),
        op: "schema:remove-status",
        author,
        settings,
      });
      warnings.push(
        ...(await runActiveOnWriteHooks({
          path: statusesPath,
          scope: "project",
          op: "schema:remove-status",
        })),
      );
    }
  } finally {
    await releaseLock();
  }

  return {
    action: "remove-status",
    removed: removal.removed,
    ...(removal.definition ? { status: removal.definition } : {}),
    file: {
      path: statusesPath,
      statuses: removal.file.statuses.length,
    },
    warnings: finalizeWarnings(warnings),
    generated_at: nowIso(),
  };
}

function toSchemaTypeSummary(
  definition: ResolvedItemTypeDefinition,
): SchemaTypeSummary {
  return {
    name: definition.name,
    folder: definition.folder,
    aliases: Array.isArray(definition.aliases) ? [...definition.aliases] : [],
    ...(definition.default_status
      ? { default_status: definition.default_status }
      : {}),
    ...(definition.description ? { description: definition.description } : {}),
  };
}

function toSchemaTypeDefinition(
  definition: ResolvedItemTypeDefinition,
  source: SchemaTypeDefinitionResult["source"],
  extensionProvenance?: SchemaTypeDefinitionResult["extension"],
): SchemaTypeDefinitionResult {
  return {
    ...toSchemaTypeSummary(definition),
    source,
    ...(extensionProvenance ? { extension: extensionProvenance } : {}),
    required_create_fields: [...definition.required_create_fields],
    required_create_repeatables: [...definition.required_create_repeatables],
    options: structuredClone(definition.options),
    command_option_policies: structuredClone(
      definition.command_option_policies,
    ),
  };
}

function toSchemaStatusSummary(
  definition: RuntimeStatusDefinition,
): SchemaStatusSummary {
  return {
    id: definition.id,
    source: BUILTIN_STATUS_IDS.has(definition.id) ? "builtin" : "custom",
    roles: Array.isArray(definition.roles) ? [...definition.roles] : [],
    aliases: Array.isArray(definition.aliases) ? [...definition.aliases] : [],
    ...(definition.description ? { description: definition.description } : {}),
    ...(typeof definition.order === "number"
      ? { order: definition.order }
      : {}),
  };
}

function classifyTypeSource(
  name: string,
  customNames: Set<string>,
  extensionNames: Set<string>,
): SchemaTypeDefinitionResult["source"] {
  const lowerName = name.toLowerCase();
  if (extensionNames.has(lowerName)) {
    return "extension";
  }
  if (customNames.has(lowerName)) {
    return "custom";
  }
  return "builtin";
}

function collectExtensionTypeProvenance(): Map<
  string,
  SchemaTypeDefinitionResult["extension"]
> {
  const provenance = new Map<string, SchemaTypeDefinitionResult["extension"]>();
  const registrations = getActiveExtensionRegistrations();
  for (const registration of registrations?.item_types ?? []) {
    const rawTypes = (registration as { types?: unknown[] }).types;
    if (!Array.isArray(rawTypes)) {
      continue;
    }
    for (const rawType of rawTypes) {
      if (
        typeof rawType !== "object" ||
        rawType === null ||
        Array.isArray(rawType)
      ) {
        continue;
      }
      const name = (rawType as { name?: unknown }).name;
      if (typeof name === "string" && name.trim().length > 0) {
        provenance.set(name.trim().toLowerCase(), {
          layer: registration.layer,
          name: registration.name,
        });
      }
    }
  }
  return provenance;
}

function buildSchemaStatusSummaries(
  schema: ReturnType<typeof normalizeRuntimeSchemaSettings>,
): { builtin: SchemaStatusSummary[]; custom: SchemaStatusSummary[] } {
  const registry = resolveRuntimeStatusRegistry(schema);
  const builtin: SchemaStatusSummary[] = [];
  const custom: SchemaStatusSummary[] = [];
  for (const definition of registry.definitions) {
    const summary = toSchemaStatusSummary(definition);
    if (summary.source === "builtin") {
      builtin.push(summary);
    } else {
      custom.push(summary);
    }
  }
  return { builtin, custom };
}

async function loadSchemaInspectionContext(global: GlobalOptions): Promise<{
  pmRoot: string;
  typesPath: string;
  statusesPath: string;
  byType: Record<string, ResolvedItemTypeDefinition>;
  customNames: Set<string>;
  extensionProvenance: Map<string, SchemaTypeDefinitionResult["extension"]>;
  schema: ReturnType<typeof normalizeRuntimeSchemaSettings>;
}> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);
  const settings = await readSettings(pmRoot);
  const schema = normalizeRuntimeSchemaSettings(settings.schema);
  const typesPath = filePathForSchemaSection(
    pmRoot,
    schema.files.types,
    DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.types,
  );
  const statusesPath = statusesPathFor(pmRoot, schema);
  const registry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const extensionProvenance = collectExtensionTypeProvenance();
  const customNames = new Set(
    (settings.item_types?.definitions ?? [])
      .map((definition) => definition.name.trim().toLowerCase())
      .filter((name) => name.length > 0 && !extensionProvenance.has(name)),
  );
  return {
    pmRoot,
    typesPath,
    statusesPath,
    byType: registry.by_type,
    customNames,
    extensionProvenance,
    schema,
  };
}

/** Implements run schema list for the public runtime surface of this module. */
export async function runSchemaList(
  global: GlobalOptions,
): Promise<SchemaListResult> {
  const context = await loadSchemaInspectionContext(global);
  const builtin: SchemaTypeSummary[] = [];
  const custom: SchemaTypeSummary[] = [];
  const extension: SchemaTypeSummary[] = [];
  for (const definition of Object.values(context.byType).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const source = classifyTypeSource(
      definition.name,
      context.customNames,
      new Set(context.extensionProvenance.keys()),
    );
    const summary = toSchemaTypeSummary(definition);
    if (source === "extension") {
      extension.push(summary);
    } else if (source === "custom") {
      custom.push(summary);
    } else {
      builtin.push(summary);
    }
  }
  const statusSummaries = buildSchemaStatusSummaries(context.schema);
  const fieldSummaries = resolveRuntimeFieldRegistry(
    context.schema,
  ).definitions.map(toSchemaFieldSummary);
  return {
    action: "list",
    builtin,
    custom,
    extension,
    counts: {
      builtin: builtin.length,
      custom: custom.length,
      extension: extension.length,
      total: builtin.length + custom.length + extension.length,
    },
    statuses: {
      builtin: statusSummaries.builtin,
      custom: statusSummaries.custom,
      counts: {
        builtin: statusSummaries.builtin.length,
        custom: statusSummaries.custom.length,
        total: statusSummaries.builtin.length + statusSummaries.custom.length,
      },
    },
    fields: {
      custom: fieldSummaries,
      counts: {
        total: fieldSummaries.length,
      },
    },
    file: {
      path: context.typesPath,
    },
    generated_at: nowIso(),
  };
}

/** Implements run schema show for the public runtime surface of this module. */
export async function runSchemaShow(
  name: string | undefined,
  global: GlobalOptions,
): Promise<SchemaShowResult> {
  const typeName = (name ?? "").trim();
  if (typeName.length === 0) {
    throw new PmCliError("Type name must not be empty.", EXIT_CODE.USAGE);
  }
  const context = await loadSchemaInspectionContext(global);
  const match = Object.values(context.byType).find(
    (definition) =>
      definition.name.toLowerCase() === typeName.toLowerCase() ||
      definition.aliases.some(
        (alias) => alias.toLowerCase() === typeName.toLowerCase(),
      ),
  );
  if (!match) {
    throw new PmCliError(
      `Unknown item type "${typeName}". Run pm schema list to inspect registered types, or pm schema add-type "${escapeForDoubleQuotes(typeName)}" to register it.`,
      EXIT_CODE.NOT_FOUND,
      { code: "unknown_item_type" },
    );
  }
  return {
    action: "show",
    type: toSchemaTypeDefinition(
      match,
      classifyTypeSource(
        match.name,
        context.customNames,
        new Set(context.extensionProvenance.keys()),
      ),
      context.extensionProvenance.get(match.name.toLowerCase()),
    ),
    file: {
      path: context.typesPath,
    },
    generated_at: nowIso(),
  };
}

/** Implements run schema show status for the public runtime surface of this module. */
export async function runSchemaShowStatus(
  id: string | undefined,
  global: GlobalOptions,
): Promise<SchemaShowStatusResult> {
  const statusToken = normalizeStatusToken(id);
  if (statusToken.length === 0) {
    throw new PmCliError("Status id must not be empty.", EXIT_CODE.USAGE);
  }
  const context = await loadSchemaInspectionContext(global);
  const statusRegistry = resolveRuntimeStatusRegistry(context.schema);
  const resolvedId = statusRegistry.alias_to_id.get(statusToken) ?? statusToken;
  const match = statusRegistry.by_id.get(resolvedId);
  if (!match) {
    throw new PmCliError(
      `Unknown status "${id}". Run pm schema list to inspect registered statuses, or pm schema add-status "${escapeForDoubleQuotes(
        id ?? "",
      )}" to register it.`,
      EXIT_CODE.NOT_FOUND,
      { code: "unknown_status" },
    );
  }
  return {
    action: "show-status",
    status: toSchemaStatusSummary(match),
    file: {
      path: context.statusesPath,
    },
    generated_at: nowIso(),
  };
}

/** Implements run schema add field for the public runtime surface of this module. */
export async function runSchemaAddField(
  key: string | undefined,
  options: SchemaAddFieldCommandOptions,
  global: GlobalOptions,
): Promise<SchemaAddFieldResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);

  let normalized;
  try {
    normalized = normalizeAddFieldInput({
      key,
      type: options.type,
      commands: options.commands,
      description: options.description,
      cliFlag: options.cliFlag,
      aliases: options.alias,
      required: options.required,
      requiredOnCreate: options.requiredOnCreate,
      allowUnset: options.allowUnset,
      requiredTypes: options.requiredTypes,
    });
  } catch (error) {
    throw new PmCliError(
      error instanceof Error ? error.message : String(error),
      EXIT_CODE.USAGE,
    );
  }

  const settings = await readSettings(pmRoot);
  const schema = normalizeRuntimeSchemaSettings(settings.schema);
  const fieldsPath = fieldsPathFor(pmRoot, schema);

  const warnings: string[] = [];
  const author = toAuthor(options.author, settings.author_default);
  const governance = resolveGovernanceKnobs(settings);

  const releaseLock = await acquireLock(
    pmRoot,
    SCHEMA_FIELDS_LOCK_ID,
    settings.locks.ttl_seconds,
    author,
    Boolean(options.force),
    governance.force_required_for_stale_lock,
    settings.locks.wait_ms,
  );
  let upsert;
  try {
    const previousRaw = await readFileIfExists(fieldsPath);
    let parsed;
    try {
      parsed = parseFieldsFile(previousRaw);
    } catch (error) {
      throw new PmCliError(
        error instanceof Error ? error.message : String(error),
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    upsert = upsertField(parsed, normalized);
    await writeAuditedSchemaFile({
      pmRoot,
      filePath: fieldsPath,
      raw: serializeFieldsFile(upsert.file),
      op: "schema:add-field",
      author,
      settings,
    });
    warnings.push(
      ...(await runActiveOnWriteHooks({
        path: fieldsPath,
        scope: "project",
        op: "schema:add-field",
      })),
    );
  } finally {
    await releaseLock();
  }

  return {
    action: "add-field",
    registered: true,
    replaced: upsert.replaced,
    field: upsert.definition,
    file: {
      path: fieldsPath,
      fields: upsert.file.fields.length,
    },
    warnings: finalizeWarnings(warnings),
    generated_at: nowIso(),
  };
}

/** Counts items carrying a non-empty value for the custom field's metadata key. Advisory only (non-blocking) so remove-field can surface how many items would lose a managed column. Reuses the already-loaded settings (no disk re-read). */
async function countItemsUsingField(
  pmRoot: string,
  settings: PmSettings,
  schema: ReturnType<typeof normalizeRuntimeSchemaSettings>,
  metadataKey: string,
): Promise<number> {
  const registry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const items = await listAllItemMetadataLight(
    pmRoot,
    settings.item_format,
    registry.type_to_folder,
    [],
    schema,
  );
  return items.filter((item) => {
    const value = (item as unknown as Record<string, unknown>)[metadataKey];
    if (value === undefined || value === null) {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    return true;
  }).length;
}

/** Implements run schema remove field for the public runtime surface of this module. */
export async function runSchemaRemoveField(
  key: string | undefined,
  options: SchemaRemoveFieldCommandOptions,
  global: GlobalOptions,
): Promise<SchemaRemoveFieldResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);

  const settings = await readSettings(pmRoot);
  const schema = normalizeRuntimeSchemaSettings(settings.schema);
  const fieldsPath = fieldsPathFor(pmRoot, schema);

  const warnings: string[] = [];
  const author = toAuthor(options.author, settings.author_default);
  const governance = resolveGovernanceKnobs(settings);

  const releaseLock = await acquireLock(
    pmRoot,
    SCHEMA_FIELDS_LOCK_ID,
    settings.locks.ttl_seconds,
    author,
    Boolean(options.force),
    governance.force_required_for_stale_lock,
    settings.locks.wait_ms,
  );
  let removal;
  try {
    const previousRaw = await readFileIfExists(fieldsPath);
    let parsed;
    try {
      parsed = parseFieldsFile(previousRaw);
    } catch (error) {
      throw new PmCliError(
        error instanceof Error ? error.message : String(error),
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    try {
      removal = removeField(parsed, key);
    } catch (error) {
      throw new PmCliError(
        error instanceof Error ? error.message : String(error),
        EXIT_CODE.USAGE,
      );
    }
    if (removal.removed) {
      const removedKey = normalizeFieldKey(removal.definition?.key ?? key);
      const metadataKey = normalizeFieldKey(
        removal.definition?.metadata_key ??
          removal.definition?.front_matter_key ??
          removedKey,
      );
      if (metadataKey.length > 0) {
        const usingField = await countItemsUsingField(
          pmRoot,
          settings,
          schema,
          metadataKey,
        );
        if (usingField > 0) {
          warnings.push(`items_using_field:${usingField}`);
        }
      }
      await writeAuditedSchemaFile({
        pmRoot,
        filePath: fieldsPath,
        raw: serializeFieldsFile(removal.file),
        op: "schema:remove-field",
        author,
        settings,
      });
      warnings.push(
        ...(await runActiveOnWriteHooks({
          path: fieldsPath,
          scope: "project",
          op: "schema:remove-field",
        })),
      );
    }
  } finally {
    await releaseLock();
  }

  return {
    action: "remove-field",
    removed: removal.removed,
    ...(removal.definition ? { field: removal.definition } : {}),
    file: {
      path: fieldsPath,
      fields: removal.file.fields.length,
    },
    warnings: finalizeWarnings(warnings),
    generated_at: nowIso(),
  };
}

/** Implements run schema list fields for the public runtime surface of this module. */
export async function runSchemaListFields(
  global: GlobalOptions,
): Promise<SchemaListFieldsResult> {
  const context = await loadSchemaInspectionContext(global);
  const fields = resolveRuntimeFieldRegistry(context.schema).definitions.map(
    toSchemaFieldSummary,
  );
  return {
    action: "list-fields",
    fields,
    counts: {
      total: fields.length,
    },
    file: {
      path: fieldsPathFor(context.pmRoot, context.schema),
    },
    generated_at: nowIso(),
  };
}

/** Implements run schema show field for the public runtime surface of this module. */
export async function runSchemaShowField(
  key: string | undefined,
  global: GlobalOptions,
): Promise<SchemaShowFieldResult> {
  const fieldKey = normalizeFieldKey(key);
  if (fieldKey.length === 0) {
    throw new PmCliError("Field key must not be empty.", EXIT_CODE.USAGE);
  }
  const context = await loadSchemaInspectionContext(global);
  const match = resolveRuntimeFieldRegistry(context.schema).by_key.get(
    fieldKey,
  );
  if (!match) {
    throw new PmCliError(
      `Unknown custom field "${key}". Run pm schema list-fields to inspect registered fields, or pm schema add-field "${escapeForDoubleQuotes(
        key ?? "",
      )}" to register it.`,
      EXIT_CODE.NOT_FOUND,
      { code: "unknown_field" },
    );
  }
  return {
    action: "show-field",
    field: toSchemaFieldSummary(match),
    file: {
      path: fieldsPathFor(context.pmRoot, context.schema),
    },
    generated_at: nowIso(),
  };
}

/** Implements run schema apply preset for the public runtime surface of this module. */
export async function runSchemaApplyPreset(
  preset: string | undefined,
  options: SchemaApplyPresetCommandOptions,
  global: GlobalOptions,
): Promise<SchemaApplyPresetResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);

  let presetName: TypePresetName;
  try {
    const normalized = normalizeTypePresetName(preset);
    if (normalized === undefined) {
      throw new Error(
        `Type preset name is required. Allowed: ${TYPE_PRESET_NAMES.join(", ")}.`,
      );
    }
    presetName = normalized;
  } catch (error) {
    throw new PmCliError(
      error instanceof Error ? error.message : String(error),
      EXIT_CODE.USAGE,
    );
  }

  const settings = await readSettings(pmRoot);
  const schema = normalizeRuntimeSchemaSettings(settings.schema);
  const typesPath = typesPathFor(pmRoot, schema);

  const warnings: string[] = [];
  const author = toAuthor(options.author, settings.author_default);
  const governance = resolveGovernanceKnobs(settings);

  const registered: string[] = [];
  const replaced: string[] = [];
  let definitionsCount: number;
  const releaseLock = await acquireLock(
    pmRoot,
    SCHEMA_TYPES_LOCK_ID,
    settings.locks.ttl_seconds,
    author,
    Boolean(options.force),
    governance.force_required_for_stale_lock,
    settings.locks.wait_ms,
  );
  try {
    const previousRaw = await readFileIfExists(typesPath);
    let parsed;
    try {
      parsed = parseItemTypesFile(previousRaw);
    } catch (error) {
      throw new PmCliError(
        error instanceof Error ? error.message : String(error),
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    let nextFile = parsed;
    for (const normalized of resolveTypePresetDefinitions(presetName)) {
      const upsert = upsertItemType(nextFile, normalized);
      nextFile = upsert.file;
      (upsert.replaced ? replaced : registered).push(upsert.definition.name);
    }
    definitionsCount = nextFile.definitions.length;
    await writeAuditedSchemaFile({
      pmRoot,
      filePath: typesPath,
      raw: serializeItemTypesFile(nextFile),
      op: "schema:apply-preset",
      author,
      settings,
    });
    await ensureTypeFolderScaffold(
      pmRoot,
      resolveTypePresetDefinitions(presetName),
      warnings,
      "schema:apply-preset-folder",
    );
    warnings.push(
      ...(await runActiveOnWriteHooks({
        path: typesPath,
        scope: "project",
        op: "schema:apply-preset",
      })),
    );
  } finally {
    await releaseLock();
  }

  return {
    action: "apply-preset",
    preset: presetName,
    registered,
    replaced,
    file: {
      path: typesPath,
      definitions: definitionsCount,
    },
    warnings: finalizeWarnings(warnings),
    generated_at: nowIso(),
  };
}

/** Validates the positive inference threshold while preserving the command default. */
function resolveSchemaInferenceMinCount(value: number | undefined): number {
  if (value === undefined) {
    return 10;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new PmCliError(
      "--min-count must be a positive integer (>= 1).",
      EXIT_CODE.USAGE,
    );
  }
  return value;
}

/** Implements run schema infer types for the public runtime surface of this module. */
export async function runSchemaInferTypes(
  options: SchemaAddTypeInferCommandOptions,
  global: GlobalOptions,
): Promise<SchemaAddTypeInferResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);

  const settings = await readSettings(pmRoot);
  const schema = normalizeRuntimeSchemaSettings(settings.schema);
  const typesPath = typesPathFor(pmRoot, schema);
  const minCount = resolveSchemaInferenceMinCount(options.minCount);

  const registry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const items = await listAllItemMetadataLight(
    pmRoot,
    settings.item_format,
    registry.type_to_folder,
    [],
    schema,
  );
  const titles = items.map((item) =>
    typeof item.title === "string" ? item.title : "",
  );
  const candidates = inferTypesFromTitles(titles, { minCount });

  const warnings: string[] = [];
  const registered: string[] = [];
  const replaced: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  let definitionsCount: number;

  // Dry-run preview by default: only --apply mutates schema/types.json.
  if (!options.apply) {
    let parsed;
    try {
      parsed = parseItemTypesFile(await readFileIfExists(typesPath));
    } catch (error) {
      throw new PmCliError(
        error instanceof Error ? error.message : String(error),
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    definitionsCount = parsed.definitions.length;
    return {
      action: "infer-types",
      applied: false,
      min_count: minCount,
      candidates,
      registered,
      replaced,
      skipped,
      file: {
        path: typesPath,
        definitions: definitionsCount,
      },
      warnings,
      generated_at: nowIso(),
    };
  }

  const author = toAuthor(options.author, settings.author_default);
  const governance = resolveGovernanceKnobs(settings);
  const releaseLock = await acquireLock(
    pmRoot,
    SCHEMA_TYPES_LOCK_ID,
    settings.locks.ttl_seconds,
    author,
    Boolean(options.force),
    governance.force_required_for_stale_lock,
    settings.locks.wait_ms,
  );
  try {
    const previousRaw = await readFileIfExists(typesPath);
    let parsed;
    try {
      parsed = parseItemTypesFile(previousRaw);
    } catch (error) {
      throw new PmCliError(
        error instanceof Error ? error.message : String(error),
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    let nextFile = parsed;
    for (const candidate of candidates) {
      if (candidate.shadows_builtin) {
        skipped.push({ name: candidate.name, reason: "shadows_builtin" });
        continue;
      }
      let normalized;
      try {
        normalized = normalizeAddTypeInput({ name: candidate.name });
      } catch {
        // A title prefix that does not normalize to a valid type token (rare,
        // given the inference pattern) is skipped rather than aborting the batch.
        skipped.push({ name: candidate.name, reason: "invalid_type_token" });
        continue;
      }
      const upsert = upsertItemType(nextFile, normalized);
      nextFile = upsert.file;
      (upsert.replaced ? replaced : registered).push(upsert.definition.name);
    }
    definitionsCount = nextFile.definitions.length;
    await writeAuditedSchemaFile({
      pmRoot,
      filePath: typesPath,
      raw: serializeItemTypesFile(nextFile),
      op: "schema:infer-types",
      author,
      settings,
    });
    await ensureTypeFolderScaffold(
      pmRoot,
      nextFile.definitions.filter(
        (definition) =>
          registered.includes(definition.name) ||
          replaced.includes(definition.name),
      ),
      warnings,
      "schema:infer-types-folder",
    );
    warnings.push(
      ...(await runActiveOnWriteHooks({
        path: typesPath,
        scope: "project",
        op: "schema:infer-types",
      })),
    );
  } finally {
    await releaseLock();
  }

  return {
    action: "infer-types",
    applied: true,
    min_count: minCount,
    candidates,
    registered,
    replaced,
    skipped,
    file: {
      path: typesPath,
      definitions: definitionsCount,
    },
    warnings: finalizeWarnings(warnings),
    generated_at: nowIso(),
  };
}

/** Implements format schema add type human for the public runtime surface of this module. */
export function formatSchemaAddTypeHuman(result: SchemaAddTypeResult): string {
  const verb = result.replaced ? "Updated" : "Registered";
  const aliasSuffix =
    result.type.aliases && result.type.aliases.length > 0
      ? ` (aliases: ${result.type.aliases.join(", ")})`
      : "";
  return `${verb} custom item type "${result.type.name}"${aliasSuffix} in ${result.file.path}. Run: pm create "${escapeForDoubleQuotes(result.type.name)}" "<title>"`;
}

/** Implements format schema remove type human for the public runtime surface of this module. */
export function formatSchemaRemoveTypeHuman(
  result: SchemaRemoveTypeResult,
): string {
  if (!result.removed) {
    return `No custom item type matched; nothing removed from ${result.file.path}.`;
  }
  const name = result.type?.name ?? "(unknown)";
  return `Removed custom item type "${name}" from ${result.file.path}.`;
}

/** Implements format schema add status human for the public runtime surface of this module. */
export function formatSchemaAddStatusHuman(
  result: SchemaAddStatusResult,
): string {
  const verb = result.replaced ? "Updated" : "Registered";
  const roleSuffix =
    result.status.roles && result.status.roles.length > 0
      ? ` (roles: ${result.status.roles.join(", ")})`
      : "";
  const aliasSuffix =
    result.status.aliases && result.status.aliases.length > 0
      ? ` (aliases: ${result.status.aliases.join(", ")})`
      : "";
  return `${verb} status "${result.status.id}"${roleSuffix}${aliasSuffix} in ${result.file.path}.`;
}

/** Implements format schema remove status human for the public runtime surface of this module. */
export function formatSchemaRemoveStatusHuman(
  result: SchemaRemoveStatusResult,
): string {
  if (!result.removed) {
    return `No custom status matched; nothing removed from ${result.file.path}.`;
  }
  const id = result.status?.id ?? "(unknown)";
  return `Removed custom status "${id}" from ${result.file.path}.`;
}

/** Implements format schema list human for the public runtime surface of this module. */
export function formatSchemaListHuman(result: SchemaListResult): string {
  const lines = [
    `Schema types: ${result.counts.total} total (${result.counts.builtin} builtin, ${result.counts.custom} custom, ${result.counts.extension} extension)`,
  ];
  for (const [label, entries] of [
    ["builtin", result.builtin],
    ["custom", result.custom],
    ["extension", result.extension],
  ] as const) {
    if (entries.length === 0) {
      continue;
    }
    lines.push(`${label}: ${entries.map((entry) => entry.name).join(", ")}`);
  }
  lines.push(
    `statuses: ${result.statuses.counts.total} total (${result.statuses.counts.builtin} builtin, ${result.statuses.counts.custom} custom)`,
  );
  for (const [label, entries] of [
    ["builtin statuses", result.statuses.builtin],
    ["custom statuses", result.statuses.custom],
  ] as const) {
    if (entries.length === 0) {
      continue;
    }
    lines.push(`${label}: ${entries.map((entry) => entry.id).join(", ")}`);
  }
  lines.push(`custom fields: ${result.fields.counts.total} total`);
  if (result.fields.custom.length > 0) {
    lines.push(
      `fields: ${result.fields.custom.map((field) => `${field.key} (${field.type}, ${field.cli_flag})`).join(", ")}`,
    );
  }
  lines.push(`Inspect one: pm schema show <Type>`);
  lines.push(`Inspect one status: pm schema show-status <status>`);
  lines.push(`Inspect one field: pm schema show-field <key>`);
  return lines.join("\n");
}

/** Implements format schema show human for the public runtime surface of this module. */
export function formatSchemaShowHuman(result: SchemaShowResult): string {
  const parts = [
    `type: ${result.type.name}`,
    `source: ${result.type.source}`,
    `folder: ${result.type.folder}`,
  ];
  if (result.type.default_status) {
    parts.push(`default_status: ${result.type.default_status}`);
  }
  if (result.type.aliases.length > 0) {
    parts.push(`aliases: ${result.type.aliases.join(", ")}`);
  }
  if (result.type.description) {
    parts.push(`description: ${result.type.description}`);
  }
  if (result.type.options.length > 0) {
    parts.push(
      `options: ${result.type.options.map((option) => option.key).join(", ")}`,
    );
  }
  return parts.join("\n");
}

/** Implements format schema show status human for the public runtime surface of this module. */
export function formatSchemaShowStatusHuman(
  result: SchemaShowStatusResult,
): string {
  const parts = [
    `status: ${result.status.id}`,
    `source: ${result.status.source}`,
  ];
  if (result.status.roles.length > 0) {
    parts.push(`roles: ${result.status.roles.join(", ")}`);
  }
  if (result.status.aliases.length > 0) {
    parts.push(`aliases: ${result.status.aliases.join(", ")}`);
  }
  if (result.status.description) {
    parts.push(`description: ${result.status.description}`);
  }
  if (typeof result.status.order === "number") {
    parts.push(`order: ${result.status.order}`);
  }
  return parts.join("\n");
}

function formatFieldSummaryLine(field: SchemaFieldSummary): string {
  const flags: string[] = [];
  if (field.required) {
    flags.push("required");
  }
  if (field.required_on_create) {
    flags.push("required_on_create");
  }
  if (!field.allow_unset) {
    flags.push("no_unset");
  }
  const flagSuffix = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
  return `${field.key} (${field.type}) ${field.cli_flag} commands=${field.commands.join("/")}${flagSuffix}`;
}

/** Implements format schema add field human for the public runtime surface of this module. */
export function formatSchemaAddFieldHuman(
  result: SchemaAddFieldResult,
): string {
  const verb = result.replaced ? "Updated" : "Registered";
  return `${verb} custom field "${result.field.key}" in ${result.file.path}. Use it: pm create "<title>" --${(result.field.cli_flag ?? result.field.key).replaceAll("_", "-")} <value>`;
}

/** Implements format schema remove field human for the public runtime surface of this module. */
export function formatSchemaRemoveFieldHuman(
  result: SchemaRemoveFieldResult,
): string {
  if (!result.removed) {
    return `No custom field matched; nothing removed from ${result.file.path}.`;
  }
  const key = result.field?.key ?? "(unknown)";
  return `Removed custom field "${key}" from ${result.file.path}.`;
}

/** Implements format schema list fields human for the public runtime surface of this module. */
export function formatSchemaListFieldsHuman(
  result: SchemaListFieldsResult,
): string {
  const lines = [`Custom fields: ${result.counts.total} total`];
  for (const field of result.fields) {
    lines.push(`  ${formatFieldSummaryLine(field)}`);
  }
  lines.push(`Inspect one: pm schema show-field <key>`);
  return lines.join("\n");
}

/** Implements format schema show field human for the public runtime surface of this module. */
export function formatSchemaShowFieldHuman(
  result: SchemaShowFieldResult,
): string {
  const field = result.field;
  const parts = [
    `field: ${field.key}`,
    `type: ${field.type}`,
    `cli_flag: ${field.cli_flag}`,
    `commands: ${field.commands.join(", ")}`,
  ];
  if (field.cli_aliases.length > 0) {
    parts.push(`cli_aliases: ${field.cli_aliases.join(", ")}`);
  }
  if (field.description) {
    parts.push(`description: ${field.description}`);
  }
  if (field.required) {
    parts.push(`required: true`);
  }
  if (field.required_on_create) {
    parts.push(`required_on_create: true`);
  }
  if (!field.allow_unset) {
    parts.push(`allow_unset: false`);
  }
  if (field.required_types.length > 0) {
    parts.push(`required_types: ${field.required_types.join(", ")}`);
  }
  return parts.join("\n");
}

/** Implements format schema apply preset human for the public runtime surface of this module. */
export function formatSchemaApplyPresetHuman(
  result: SchemaApplyPresetResult,
): string {
  const registered =
    result.registered.length > 0
      ? `registered: ${result.registered.join(", ")}`
      : "";
  const replaced =
    result.replaced.length > 0 ? `updated: ${result.replaced.join(", ")}` : "";
  const detail = [registered, replaced]
    .filter((part) => part.length > 0)
    .join("; ");
  return `Applied "${result.preset}" type preset to ${result.file.path}${detail.length > 0 ? ` (${detail})` : ""}.`;
}

/** Implements format schema infer types human for the public runtime surface of this module. */
export function formatSchemaInferTypesHuman(
  result: SchemaAddTypeInferResult,
): string {
  if (result.candidates.length === 0) {
    return `No title-prefix conventions found with at least ${result.min_count} items. Lower the threshold with --min-count <n>.`;
  }
  const lines = result.applied
    ? [
        `Inferred and registered custom types from title prefixes (min-count ${result.min_count}):`,
      ]
    : [
        `Inferred custom type candidates from title prefixes (min-count ${result.min_count}, dry-run):`,
      ];
  for (const candidate of result.candidates) {
    const note = candidate.shadows_builtin
      ? " [shadows built-in, skipped]"
      : "";
    lines.push(
      `  ${candidate.name} <- "${candidate.prefix}" (${candidate.count} items)${note}`,
    );
  }
  if (!result.applied) {
    lines.push(`Re-run with --apply to register the non-shadowing candidates.`);
  } else {
    if (result.registered.length > 0) {
      lines.push(`registered: ${result.registered.join(", ")}`);
    }
    if (result.replaced.length > 0) {
      lines.push(`updated: ${result.replaced.join(", ")}`);
    }
  }
  return lines.join("\n");
}

/* c8 ignore stop */

/** Re-export so register-mutation can surface the hint in usage examples without importing the core module directly. */
export { buildInvalidTypeHint };

/** Public contract for test only schema command, shared by SDK and presentation-layer consumers. */
export const _testOnlySchemaCommand = {
  toAuthor,
  workflowSlotsReferencing,
};
