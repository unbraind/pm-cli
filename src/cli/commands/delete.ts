/**
 * @module cli/commands/delete
 *
 * Implements the pm delete command surface and its agent-facing runtime behavior.
 */
import path from "node:path";
import {
  pathExists,
  EXIT_CODE,
  type GlobalOptions,
  PmCliError,
  toItemRecord,
  deleteItem,
  getSettingsPath,
  resolvePmRoot,
  readSettings,
  resolveAuthor,
} from "../../sdk/runtime-primitives.js";
/** Documents the delete command options payload exchanged by command, SDK, and package integrations. */
export interface DeleteCommandOptions {
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
  /** Value that configures or reports dry run for this contract. */
  dryRun?: boolean;
}

/** Documents the delete result payload exchanged by command, SDK, and package integrations. */
export interface DeleteResult {
  /** Value that configures or reports item for this contract. */
  item: Record<string, unknown>;
  /** Value that configures or reports changed fields for this contract. */
  changed_fields: string[];
  /** Value that configures or reports dry run for this contract. */
  dry_run: boolean;
  /** Whether the item was deleted by this invocation. */
  deleted: boolean;
  /** Stable mutation outcome used instead of echoing the item's stale lifecycle status. */
  outcome: "deleted" | "would_delete";
  /** Lifecycle status the item had immediately before deletion. */
  previous_status: string;
  /** Filesystem path used for target resolution. */
  target_path?: string;
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
}

/** Implements run delete for the public runtime surface of this module. */
export async function runDelete(
  id: string,
  options: DeleteCommandOptions,
  global: GlobalOptions,
): Promise<DeleteResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
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
  const targetPath = result.targetPath
    ? path.relative(pmRoot, result.targetPath).split(path.sep).join("/")
    : undefined;

  return {
    item: toItemRecord(result.item),
    changed_fields: result.changedFields,
    dry_run: options.dryRun === true,
    deleted: options.dryRun !== true,
    outcome: options.dryRun === true ? "would_delete" : "deleted",
    previous_status: result.item.status,
    ...(targetPath ? { target_path: targetPath } : {}),
    warnings: result.warnings,
  };
}
