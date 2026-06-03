import { pathExists, readFileIfExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { acquireLock } from "../../core/lock/lock.js";
import {
  assertAliasesAvailable,
  buildInvalidTypeHint,
  escapeForDoubleQuotes,
  normalizeAddTypeInput,
  parseItemTypesFile,
  serializeItemTypesFile,
  upsertItemType,
  type ItemTypeDefinition,
} from "../../core/schema/item-types-file.js";
import {
  DEFAULT_RUNTIME_SCHEMA_FILE_PATHS,
  filePathForSchemaSection,
  normalizeRuntimeSchemaSettings,
} from "../../core/schema/runtime-schema.js";
import { resolveItemTypeRegistry, type ResolvedItemTypeDefinition } from "../../core/item/type-registry.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { getActiveExtensionRegistrations, runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings, resolveGovernanceKnobs } from "../../core/store/settings.js";
import { ITEM_TYPE_VALUES } from "../../types/index.js";

export const SCHEMA_SUBCOMMANDS = ["add-type", "list", "show"] as const;
export type SchemaSubcommand = (typeof SCHEMA_SUBCOMMANDS)[number];

const SCHEMA_TYPES_LOCK_ID = "schema-types";

export interface SchemaAddTypeCommandOptions {
  description?: string;
  defaultStatus?: string;
  folder?: string;
  alias?: string[];
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

export interface SchemaTypeSummary {
  name: string;
  folder: string;
  aliases: string[];
  default_status?: string;
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

async function loadSchemaInspectionContext(global: GlobalOptions): Promise<{
  typesPath: string;
  byType: Record<string, ResolvedItemTypeDefinition>;
  customNames: Set<string>;
  extensionProvenance: Map<string, SchemaTypeDefinitionResult["extension"]>;
}> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const schema = normalizeRuntimeSchemaSettings(settings.schema);
  const typesPath = filePathForSchemaSection(pmRoot, schema.files.types, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.types);
  const registry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const builtinNames = new Set(ITEM_TYPE_VALUES.map((value) => value.toLowerCase()));
  const extensionProvenance = collectExtensionTypeProvenance();
  const customNames = new Set(
    Object.values(registry.by_type)
      .map((definition) => definition.name.toLowerCase())
      .filter((name) => !builtinNames.has(name) && !extensionProvenance.has(name)),
  );
  return {
    typesPath,
    byType: registry.by_type,
    customNames,
    extensionProvenance,
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
