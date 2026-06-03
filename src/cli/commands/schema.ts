import { pathExists, readFileIfExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { acquireLock } from "../../core/lock/lock.js";
import {
  assertAliasesAvailable,
  buildInvalidTypeHint,
  escapeForDoubleQuotes,
  normalizeAddTypeInput,
  parseItemTypesFile,
  removeItemType,
  serializeItemTypesFile,
  upsertItemType,
  type ItemTypeDefinition,
} from "../../core/schema/item-types-file.js";
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
} from "../../core/schema/status-defs-file.js";
import {
  DEFAULT_RUNTIME_SCHEMA_FILE_PATHS,
  filePathForSchemaSection,
  normalizeRuntimeSchemaSettings,
  resolveRuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import { resolveItemTypeRegistry, type ResolvedItemTypeDefinition } from "../../core/item/type-registry.js";
import { listAllFrontMatterLight } from "../../core/store/item-store.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import type { PmSettings } from "../../types/index.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { getActiveExtensionRegistrations, runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings, resolveGovernanceKnobs } from "../../core/store/settings.js";

export const SCHEMA_SUBCOMMANDS = ["add-type", "remove-type", "add-status", "remove-status", "list", "show"] as const;
export type SchemaSubcommand = (typeof SCHEMA_SUBCOMMANDS)[number];

const SCHEMA_TYPES_LOCK_ID = "schema-types";
const SCHEMA_STATUSES_LOCK_ID = "schema-statuses";

export interface SchemaAddTypeCommandOptions {
  description?: string;
  defaultStatus?: string;
  folder?: string;
  alias?: string[];
  author?: string;
  force?: boolean;
}

export interface SchemaRemoveTypeCommandOptions {
  author?: string;
  force?: boolean;
}

export interface SchemaAddStatusCommandOptions {
  role?: string[];
  alias?: string[];
  description?: string;
  order?: number;
  author?: string;
  force?: boolean;
}

export interface SchemaRemoveStatusCommandOptions {
  author?: string;
  force?: boolean;
}

export interface SchemaAddTypeResult {
  action: "add-type";
  registered: boolean;
  replaced: boolean;
  type: ItemTypeDefinition;
  file: {
    path: string;
    definitions: number;
  };
  warnings: string[];
  generated_at: string;
}

export interface SchemaRemoveTypeResult {
  action: "remove-type";
  removed: boolean;
  type?: ItemTypeDefinition;
  file: {
    path: string;
    definitions: number;
  };
  warnings: string[];
  generated_at: string;
}

export interface SchemaAddStatusResult {
  action: "add-status";
  registered: boolean;
  replaced: boolean;
  status: RuntimeStatusDefinition;
  file: {
    path: string;
    statuses: number;
  };
  warnings: string[];
  generated_at: string;
}

export interface SchemaRemoveStatusResult {
  action: "remove-status";
  removed: boolean;
  status?: RuntimeStatusDefinition;
  file: {
    path: string;
    statuses: number;
  };
  warnings: string[];
  generated_at: string;
}

export interface SchemaTypeSummary {
  name: string;
  folder: string;
  aliases: string[];
  default_status?: string;
  description?: string;
}

export interface SchemaStatusSummary {
  id: string;
  source: "builtin" | "custom";
  roles: string[];
  aliases: string[];
  description?: string;
}

export interface SchemaTypeDefinitionResult extends SchemaTypeSummary {
  source: "builtin" | "custom" | "extension";
  extension?: {
    layer: string;
    name: string;
  };
  required_create_fields: string[];
  required_create_repeatables: string[];
  options: ResolvedItemTypeDefinition["options"];
  command_option_policies: ResolvedItemTypeDefinition["command_option_policies"];
}

export interface SchemaListResult {
  action: "list";
  builtin: SchemaTypeSummary[];
  custom: SchemaTypeSummary[];
  extension: SchemaTypeSummary[];
  counts: {
    builtin: number;
    custom: number;
    extension: number;
    total: number;
  };
  statuses: {
    builtin: SchemaStatusSummary[];
    custom: SchemaStatusSummary[];
    counts: {
      builtin: number;
      custom: number;
      total: number;
    };
  };
  file: {
    path: string;
  };
  generated_at: string;
}

export interface SchemaShowResult {
  action: "show";
  type: SchemaTypeDefinitionResult;
  file: {
    path: string;
  };
  generated_at: string;
}

export type SchemaInspectResult = SchemaListResult | SchemaShowResult;

function toAuthor(candidate: string | undefined, defaultAuthor: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? defaultAuthor;
  const trimmed = resolved.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

export async function runSchemaAddType(
  name: string | undefined,
  options: SchemaAddTypeCommandOptions,
  global: GlobalOptions,
): Promise<SchemaAddTypeResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

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
    throw new PmCliError(error instanceof Error ? error.message : String(error), EXIT_CODE.USAGE);
  }

  const settings = await readSettings(pmRoot);
  const schema = normalizeRuntimeSchemaSettings(settings.schema);
  const typesPath = filePathForSchemaSection(pmRoot, schema.files.types, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.types);

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
  );
  let upsert;
  try {
    const previousRaw = await readFileIfExists(typesPath);
    let parsed;
    try {
      parsed = parseItemTypesFile(previousRaw);
    } catch (error) {
      throw new PmCliError(error instanceof Error ? error.message : String(error), EXIT_CODE.GENERIC_FAILURE);
    }
    try {
      assertAliasesAvailable(normalized, parsed);
    } catch (error) {
      throw new PmCliError(error instanceof Error ? error.message : String(error), EXIT_CODE.USAGE);
    }
    upsert = upsertItemType(parsed, normalized);
    // writeFileAtomic writes to a temp file then renames, so a failure leaves the
    // existing types.json untouched; no manual rollback is needed.
    await writeFileAtomic(typesPath, serializeItemTypesFile(upsert.file));
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

  return {
    action: "add-type",
    registered: true,
    replaced: upsert.replaced,
    type: upsert.definition,
    file: {
      path: typesPath,
      definitions: upsert.file.definitions.length,
    },
    warnings: [...new Set(warnings)].sort((left, right) => left.localeCompare(right)),
    generated_at: nowIso(),
  };
}

async function ensureInitialized(pmRoot: string): Promise<void> {
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
}

/**
 * Counts items whose resolved type matches `typeName` (case-insensitive). Uses
 * the lightest existing read path (listAllFrontMatterLight skips the heavy
 * collections cache). All items are counted — not just open ones — so the
 * advisory warning surfaces every item the removed definition would orphan;
 * the count is non-blocking. The caller passes its already-loaded `settings`
 * so we never re-read settings.json from disk here.
 */
async function countItemsUsingType(
  pmRoot: string,
  settings: PmSettings,
  schema: ReturnType<typeof normalizeRuntimeSchemaSettings>,
  typeName: string,
): Promise<number> {
  const registry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const lowerName = typeName.trim().toLowerCase();
  const items = await listAllFrontMatterLight(pmRoot, settings.item_format, registry.type_to_folder, [], schema);
  return items.filter((item) => typeof item.type === "string" && item.type.toLowerCase() === lowerName).length;
}

/**
 * Counts items currently set to the status whose id/aliases resolve to
 * `statusId`. Uses listAllFrontMatterLight (the lightest read path). All items
 * are counted regardless of lifecycle phase; the count is advisory only. The
 * caller passes its already-loaded `settings` so we never re-read from disk.
 */
async function countItemsUsingStatus(
  pmRoot: string,
  settings: PmSettings,
  schema: ReturnType<typeof normalizeRuntimeSchemaSettings>,
  statusId: string,
): Promise<number> {
  const registry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const statusRegistry = resolveRuntimeStatusRegistry(schema);
  const normalizedId = normalizeStatusToken(statusId);
  const items = await listAllFrontMatterLight(pmRoot, settings.item_format, registry.type_to_folder, [], schema);
  return items.filter((item) => {
    const itemStatus = typeof item.status === "string" ? item.status : "";
    const resolved = statusRegistry.alias_to_id.get(normalizeStatusToken(itemStatus)) ?? normalizeStatusToken(itemStatus);
    return resolved === normalizedId;
  }).length;
}

/**
 * Returns the workflow role-slot names (open_status, close_status, ...) that
 * currently point at `statusId` (normalized). Used to warn before removing a
 * status that a workflow default still references.
 */
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
    .filter(([, value]) => value !== undefined && normalizeStatusToken(value) === statusId)
    .map(([slot]) => slot);
}

export async function runSchemaRemoveType(
  name: string | undefined,
  options: SchemaRemoveTypeCommandOptions,
  global: GlobalOptions,
): Promise<SchemaRemoveTypeResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);

  const settings = await readSettings(pmRoot);
  const schema = normalizeRuntimeSchemaSettings(settings.schema);
  const typesPath = filePathForSchemaSection(pmRoot, schema.files.types, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.types);

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
  );
  let removal;
  try {
    const previousRaw = await readFileIfExists(typesPath);
    let parsed;
    try {
      parsed = parseItemTypesFile(previousRaw);
    } catch (error) {
      throw new PmCliError(error instanceof Error ? error.message : String(error), EXIT_CODE.GENERIC_FAILURE);
    }
    try {
      removal = removeItemType(parsed, name);
    } catch (error) {
      throw new PmCliError(error instanceof Error ? error.message : String(error), EXIT_CODE.USAGE);
    }
    if (removal.removed) {
      // Only emit the advisory orphan-count warning once a removable custom
      // definition was actually removed; a no-op/unknown removal would otherwise
      // surface a misleading items_using_type:* warning. The count is
      // non-blocking and reuses the already-loaded settings (no disk re-read).
      const removedName = (removal.definition?.name ?? name ?? "").trim();
      if (removedName.length > 0) {
        const usingType = await countItemsUsingType(pmRoot, settings, schema, removedName);
        if (usingType > 0) {
          warnings.push(`items_using_type:${usingType}`);
        }
      }
      // writeFileAtomic writes to a temp file then renames, so a failure leaves
      // the existing types.json untouched; no manual rollback is needed.
      await writeFileAtomic(typesPath, serializeItemTypesFile(removal.file));
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

  return {
    action: "remove-type",
    removed: removal.removed,
    ...(removal.definition ? { type: removal.definition } : {}),
    file: {
      path: typesPath,
      definitions: removal.file.definitions.length,
    },
    warnings: [...new Set(warnings)].sort((left, right) => left.localeCompare(right)),
    generated_at: nowIso(),
  };
}

function statusesPathFor(pmRoot: string, schema: ReturnType<typeof normalizeRuntimeSchemaSettings>): string {
  return filePathForSchemaSection(pmRoot, schema.files.statuses, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.statuses);
}

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
    throw new PmCliError(error instanceof Error ? error.message : String(error), EXIT_CODE.USAGE);
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
    throw new PmCliError(error instanceof Error ? error.message : String(error), EXIT_CODE.USAGE);
  }

  // Seed the upsert from the resolved (settings-or-file) definition so omitting
  // --role/--alias preserves metadata defined in settings.schema.statuses, not
  // only what is already in statuses.json.
  const resolvedExisting = statusRegistry.by_id.get(normalized.id);
  const baseDefinition: RuntimeStatusDefinition | undefined = resolvedExisting
    ? {
        id: resolvedExisting.id,
        ...(resolvedExisting.roles?.length ? { roles: [...resolvedExisting.roles] } : {}),
        ...(resolvedExisting.aliases?.length ? { aliases: [...resolvedExisting.aliases] } : {}),
        ...(resolvedExisting.description ? { description: resolvedExisting.description } : {}),
        ...(typeof resolvedExisting.order === "number" ? { order: resolvedExisting.order } : {}),
      }
    : undefined;

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
  );
  let upsert;
  try {
    const previousRaw = await readFileIfExists(statusesPath);
    let parsed;
    try {
      parsed = parseStatusDefsFile(previousRaw);
    } catch (error) {
      throw new PmCliError(error instanceof Error ? error.message : String(error), EXIT_CODE.GENERIC_FAILURE);
    }
    // Re-check collisions against the CURRENT file under the lock: the pre-lock
    // check used the registry loaded before acquiring schema-statuses, so a
    // concurrent add-status could have written a colliding id/alias in between.
    // The lock serializes writes; this serializes the collision decision too.
    const fileAliasToId = new Map<string, string>();
    for (const definition of parsed.statuses) {
      const defId = normalizeStatusToken(definition.id);
      if (defId.length === 0) {
        continue;
      }
      fileAliasToId.set(defId, defId);
      for (const alias of definition.aliases ?? []) {
        const aliasToken = normalizeStatusToken(alias);
        if (aliasToken.length > 0 && !fileAliasToId.has(aliasToken)) {
          fileAliasToId.set(aliasToken, defId);
        }
      }
    }
    try {
      assertStatusTokensAvailable(normalized, fileAliasToId);
    } catch (error) {
      throw new PmCliError(error instanceof Error ? error.message : String(error), EXIT_CODE.USAGE);
    }
    upsert = upsertStatusDef(parsed, normalized, baseDefinition);
    // writeFileAtomic writes to a temp file then renames, so a failure leaves
    // the existing statuses.json untouched; no manual rollback is needed.
    await writeFileAtomic(statusesPath, serializeStatusDefsFile(upsert.file));
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
    warnings: [...new Set(warnings)].sort((left, right) => left.localeCompare(right)),
    generated_at: nowIso(),
  };
}

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
  );
  let removal;
  try {
    const previousRaw = await readFileIfExists(statusesPath);
    let parsed;
    try {
      parsed = parseStatusDefsFile(previousRaw);
    } catch (error) {
      throw new PmCliError(error instanceof Error ? error.message : String(error), EXIT_CODE.GENERIC_FAILURE);
    }
    try {
      removal = removeStatusDef(parsed, id);
    } catch (error) {
      throw new PmCliError(error instanceof Error ? error.message : String(error), EXIT_CODE.USAGE);
    }
    if (removal.removed) {
      // Only emit the advisory orphan-count warning once a removable custom
      // status was actually removed; a no-op/unknown removal would otherwise
      // surface a misleading items_using_status:* warning. The count reuses the
      // already-loaded settings (no disk re-read) and is non-blocking.
      const removedId = normalizeStatusToken(removal.definition?.id ?? id);
      if (removedId.length > 0 && !BUILTIN_STATUS_IDS.has(removedId)) {
        const usingStatus = await countItemsUsingStatus(pmRoot, settings, schema, removedId);
        if (usingStatus > 0) {
          warnings.push(`items_using_status:${usingStatus}`);
        }
        // Removing a status that a workflow default still points at would leave
        // pm close / default pm create resolving to an unregistered status. Warn
        // (non-blocking, consistent with remove-type) so the operator re-points
        // the workflow slot via schema/workflows.json or pm config.
        const referencingSlots = workflowSlotsReferencing(schema.workflow, removedId);
        if (referencingSlots.length > 0) {
          warnings.push(`status_referenced_by_workflow:${referencingSlots.join(",")}`);
        }
      }
      await writeFileAtomic(statusesPath, serializeStatusDefsFile(removal.file));
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
    warnings: [...new Set(warnings)].sort((left, right) => left.localeCompare(right)),
    generated_at: nowIso(),
  };
}

function toSchemaTypeSummary(definition: ResolvedItemTypeDefinition): SchemaTypeSummary {
  return {
    name: definition.name,
    folder: definition.folder,
    aliases: [...definition.aliases],
    ...(definition.default_status ? { default_status: definition.default_status } : {}),
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
    command_option_policies: structuredClone(definition.command_option_policies),
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

function collectExtensionTypeProvenance(): Map<string, SchemaTypeDefinitionResult["extension"]> {
  const provenance = new Map<string, SchemaTypeDefinitionResult["extension"]>();
  const registrations = getActiveExtensionRegistrations();
  for (const registration of registrations?.item_types ?? []) {
    const rawTypes = (registration as { types?: unknown[] }).types;
    if (!Array.isArray(rawTypes)) {
      continue;
    }
    for (const rawType of rawTypes) {
      if (typeof rawType !== "object" || rawType === null || Array.isArray(rawType)) {
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
    const source: SchemaStatusSummary["source"] = BUILTIN_STATUS_IDS.has(definition.id) ? "builtin" : "custom";
    const summary: SchemaStatusSummary = {
      id: definition.id,
      source,
      roles: [...(definition.roles ?? [])],
      aliases: [...(definition.aliases ?? [])],
      ...(definition.description ? { description: definition.description } : {}),
    };
    if (source === "builtin") {
      builtin.push(summary);
    } else {
      custom.push(summary);
    }
  }
  return { builtin, custom };
}

async function loadSchemaInspectionContext(global: GlobalOptions): Promise<{
  typesPath: string;
  byType: Record<string, ResolvedItemTypeDefinition>;
  customNames: Set<string>;
  extensionProvenance: Map<string, SchemaTypeDefinitionResult["extension"]>;
  schema: ReturnType<typeof normalizeRuntimeSchemaSettings>;
}> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const schema = normalizeRuntimeSchemaSettings(settings.schema);
  const typesPath = filePathForSchemaSection(pmRoot, schema.files.types, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.types);
  const registry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const extensionProvenance = collectExtensionTypeProvenance();
  const customNames = new Set(
    (settings.item_types?.definitions ?? [])
      .map((definition) => definition.name.trim().toLowerCase())
      .filter((name) => name.length > 0 && !extensionProvenance.has(name)),
  );
  return {
    typesPath,
    byType: registry.by_type,
    customNames,
    extensionProvenance,
    schema,
  };
}

export async function runSchemaList(global: GlobalOptions): Promise<SchemaListResult> {
  const context = await loadSchemaInspectionContext(global);
  const builtin: SchemaTypeSummary[] = [];
  const custom: SchemaTypeSummary[] = [];
  const extension: SchemaTypeSummary[] = [];
  for (const definition of Object.values(context.byType).sort((left, right) => left.name.localeCompare(right.name))) {
    const source = classifyTypeSource(definition.name, context.customNames, new Set(context.extensionProvenance.keys()));
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
    file: {
      path: context.typesPath,
    },
    generated_at: nowIso(),
  };
}

export async function runSchemaShow(name: string | undefined, global: GlobalOptions): Promise<SchemaShowResult> {
  const typeName = (name ?? "").trim();
  if (typeName.length === 0) {
    throw new PmCliError("Type name must not be empty.", EXIT_CODE.USAGE);
  }
  const context = await loadSchemaInspectionContext(global);
  const match = Object.values(context.byType).find(
    (definition) =>
      definition.name.toLowerCase() === typeName.toLowerCase() ||
      definition.aliases.some((alias) => alias.toLowerCase() === typeName.toLowerCase()),
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
      classifyTypeSource(match.name, context.customNames, new Set(context.extensionProvenance.keys())),
      context.extensionProvenance.get(match.name.toLowerCase()),
    ),
    file: {
      path: context.typesPath,
    },
    generated_at: nowIso(),
  };
}

export function formatSchemaAddTypeHuman(result: SchemaAddTypeResult): string {
  const verb = result.replaced ? "Updated" : "Registered";
  const aliasSuffix =
    result.type.aliases && result.type.aliases.length > 0 ? ` (aliases: ${result.type.aliases.join(", ")})` : "";
  return `${verb} custom item type "${result.type.name}"${aliasSuffix} in ${result.file.path}. Run: pm create "${escapeForDoubleQuotes(result.type.name)}" "<title>"`;
}

export function formatSchemaRemoveTypeHuman(result: SchemaRemoveTypeResult): string {
  if (!result.removed) {
    return `No custom item type matched; nothing removed from ${result.file.path}.`;
  }
  const name = result.type?.name ?? "(unknown)";
  return `Removed custom item type "${name}" from ${result.file.path}.`;
}

export function formatSchemaAddStatusHuman(result: SchemaAddStatusResult): string {
  const verb = result.replaced ? "Updated" : "Registered";
  const roleSuffix =
    result.status.roles && result.status.roles.length > 0 ? ` (roles: ${result.status.roles.join(", ")})` : "";
  const aliasSuffix =
    result.status.aliases && result.status.aliases.length > 0 ? ` (aliases: ${result.status.aliases.join(", ")})` : "";
  return `${verb} status "${result.status.id}"${roleSuffix}${aliasSuffix} in ${result.file.path}.`;
}

export function formatSchemaRemoveStatusHuman(result: SchemaRemoveStatusResult): string {
  if (!result.removed) {
    return `No custom status matched; nothing removed from ${result.file.path}.`;
  }
  const id = result.status?.id ?? "(unknown)";
  return `Removed custom status "${id}" from ${result.file.path}.`;
}

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
  lines.push(`Inspect one: pm schema show <Type>`);
  return lines.join("\n");
}

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
    parts.push(`options: ${result.type.options.map((option) => option.key).join(", ")}`);
  }
  return parts.join("\n");
}

/**
 * Re-export so register-mutation can surface the hint in usage examples
 * without importing the core module directly.
 */
export { buildInvalidTypeHint };
