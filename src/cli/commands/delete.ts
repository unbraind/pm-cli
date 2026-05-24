import path from "node:path";
import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { deleteItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { resolveAuthor } from "../../core/shared/author.js";

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

export async function runDelete(id: string, options: DeleteCommandOptions, global: GlobalOptions): Promise<DeleteResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const author = resolveAuthor(options.author, settings.author_default);

  const result = await deleteItem({
    pmRoot,
    settings,
    id,
    author,
    message: options.message,
    force: options.force,
    dryRun: options.dryRun,
  });
  const targetPath = result.targetPath ? path.relative(pmRoot, result.targetPath).split(path.sep).join("/") : undefined;

  return {
    item: result.item as unknown as Record<string, unknown>,
    changed_fields: result.changedFields,
    dry_run: options.dryRun === true,
    ...(targetPath ? { target_path: targetPath } : {}),
    warnings: result.warnings,
  };
}
