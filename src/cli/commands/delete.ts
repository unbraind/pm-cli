import path from "node:path";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { deleteItem, locateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings, resolveGovernanceKnobs } from "../../core/store/settings.js";

export interface DeleteCommandOptions {
  author?: string;
  message?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface DeleteResult {
  item: Record<string, unknown>;
  changed_fields: string[];
  dry_run: boolean;
  target_path?: string;
  warnings: string[];
}

function toAuthor(candidate: string | undefined, defaultAuthor: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? defaultAuthor;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

export async function runDelete(id: string, options: DeleteCommandOptions, global: GlobalOptions): Promise<DeleteResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const author = toAuthor(options.author, settings.author_default);
  if (options.dryRun === true) {
    const typeToFolder = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations()).type_to_folder;
    const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeToFolder);
    if (!located) {
      throw new PmCliError(`Item not found: ${id}`, EXIT_CODE.NOT_FOUND);
    }

    const warnings: string[] = [];
    const { document } = await readLocatedItem(located, {
      schema: settings.schema,
      warnings,
    });
    const assigned = document.metadata.assignee?.trim();
    const governance = resolveGovernanceKnobs(settings);
    if (assigned && assigned !== author && !options.force) {
      if (governance.ownership_enforcement === "strict") {
        throw new PmCliError(`Item ${located.id} is assigned to ${assigned}. Use --force to override.`, EXIT_CODE.CONFLICT);
      }
      if (governance.ownership_enforcement === "warn") {
        warnings.push(`ownership_warning:assignee_conflict:${located.id}:${assigned}`);
      }
    }

    return {
      item: document.metadata as unknown as Record<string, unknown>,
      changed_fields: ["deleted"],
      dry_run: true,
      target_path: path.relative(pmRoot, located.itemPath),
      warnings,
    };
  }

  const result = await deleteItem({
    pmRoot,
    settings,
    id,
    author,
    message: options.message,
    force: options.force,
  });

  return {
    item: result.item as unknown as Record<string, unknown>,
    changed_fields: result.changedFields,
    dry_run: false,
    warnings: result.warnings,
  };
}
