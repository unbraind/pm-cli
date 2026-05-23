import fs from "node:fs/promises";
import { pathExists, readFileIfExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { acquireLock } from "../../core/lock/lock.js";
import {
  buildInvalidTypeHint,
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
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings, resolveGovernanceKnobs } from "../../core/store/settings.js";

export const SCHEMA_SUBCOMMANDS = ["add-type"] as const;
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
    upsert = upsertItemType(parsed, normalized);
    const serialized = serializeItemTypesFile(upsert.file);
    try {
      await writeFileAtomic(typesPath, serialized);
    } catch (error) {
      if (previousRaw === null) {
        await fs.rm(typesPath, { force: true });
      } else {
        await writeFileAtomic(typesPath, previousRaw);
      }
      throw error;
    }
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

export function formatSchemaAddTypeHuman(result: SchemaAddTypeResult): string {
  const verb = result.replaced ? "Updated" : "Registered";
  const aliasSuffix =
    result.type.aliases && result.type.aliases.length > 0 ? ` (aliases: ${result.type.aliases.join(", ")})` : "";
  return `${verb} custom item type "${result.type.name}"${aliasSuffix} in ${result.file.path}. Run: pm create ${result.type.name} "<title>"`;
}

/**
 * Re-export so register-mutation can surface the hint in usage examples
 * without importing the core module directly.
 */
export { buildInvalidTypeHint };
