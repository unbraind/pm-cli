/**
 * @module cli/commands/close-many
 *
 * Implements the pm close many command surface and its agent-facing runtime behavior.
 */
import { pathExists } from "../../core/fs/fs-utils.js";
import {
  createCheckpointId,
  loadMutationCheckpoint,
  restoreCheckpointItems,
  writeMutationCheckpoint,
  type MutationCheckpointItem,
} from "../../core/checkpoint/mutation-checkpoint.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { isTerminalStatus } from "../../core/item/status.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { resolveRuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { toErrorMessage } from "../../core/shared/primitives.js";
import { resolveAuthor } from "../../core/shared/author.js";
import { nowIso } from "../../core/shared/time.js";
import { listAllItemMetadataLight } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { runClose, type CloseCommandOptions } from "./close.js";
import { hasListFilters } from "./list-filter-shared.js";
import { runList, type ListOptions, type ListedItem } from "./list.js";
import { runRestore } from "./restore.js";

const CLOSE_MANY_CHECKPOINT_SCHEMA_VERSION = 1;
const CLOSE_MANY_CHECKPOINT_SUBDIR = "close-many";

const CLOSE_MANY_FILTER_GUIDANCE = [
  "--filter-status",
  "--filter-type",
  "--filter-tag",
  "--filter-priority",
  "--filter-sprint",
  "--filter-release",
  "--filter-parent",
  "--filter-assignee",
  "--filter-updated-before",
  "--ids",
].join(", ");

/** Documents the close many command options payload exchanged by command, SDK, and package integrations. */
export interface CloseManyCommandOptions {
  /** Lifecycle state reported for status. */
  status?: string;
  /** Value that configures or reports list for this contract. */
  list?: ListOptions;
  /** Value that configures or reports reason for this contract. */
  reason?: string;
  /** Value that configures or reports resolution for this contract. */
  resolution?: string;
  /** Structured result returned by the expected operation. */
  expectedResult?: string;
  /** Structured result returned by the actual operation. */
  actualResult?: string;
  /** Value that configures or reports validate close for this contract. */
  validateClose?: string;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
  /** Value that configures or reports dry run for this contract. */
  dryRun?: boolean;
  /** Value that configures or reports rollback for this contract. */
  rollback?: string;
  /** Value that configures or reports checkpoint for this contract. */
  checkpoint?: boolean;
}

interface CloseManyPlanRow {
  id: string;
  title: string;
  status: string;
  action: "close" | "skip";
  skip_reason?: string;
  active_child_ids?: string[];
}

interface CloseManyApplyRow {
  id: string;
  status: "closed" | "skipped" | "failed";
  skip_reason?: string;
  changed_fields?: string[];
  warnings?: string[];
  error?: string;
}

interface CloseManyPlanContext {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  statusRegistry: ReturnType<typeof resolveRuntimeStatusRegistry>;
  reason: string | undefined;
  validateCloseMode: string | undefined;
  force: boolean;
  listed: Awaited<ReturnType<typeof runList>>;
  matched: ListedItem[];
  planRows: CloseManyPlanRow[];
}

/** Documents the close many result payload exchanged by command, SDK, and package integrations. */
export interface CloseManyResult {
  /** Value that configures or reports mode for this contract. */
  mode: "dry_run" | "apply" | "rollback";
  /** Number of matched entries represented by this result. */
  matched_count: number;
  /** Value that configures or reports dry run for this contract. */
  dry_run: boolean;
  /** Value that configures or reports reason for this contract. */
  reason?: string;
  /** Value that configures or reports filters for this contract. */
  filters?: Record<string, unknown>;
  /** Value that configures or reports validate close for this contract. */
  validate_close?: string;
  /** Value that configures or reports item plans for this contract. */
  item_plans?: CloseManyPlanRow[];
  /** Value that configures or reports checkpoint for this contract. */
  checkpoint?: {
    id: string;
    created_at: string;
    path: string;
    rollback_command: string;
  };
  /** Number of closed entries represented by this result. */
  closed_count?: number;
  /** Number of skipped entries represented by this result. */
  skipped_count?: number;
  /** Number of failed entries represented by this result. */
  failed_count?: number;
  /** Number of restored entries represented by this result. */
  restored_count?: number;
  /** Value that configures or reports rollback checkpoint id for this contract. */
  rollback_checkpoint_id?: string;
  /** Value that configures or reports rows for this contract. */
  rows?:
    | CloseManyApplyRow[]
    | Array<{
        id: string;
        status: "restored" | "failed";
        changed_fields?: string[];
        warnings?: string[];
        error?: string;
      }>;
  /** Value that configures or reports ids for this contract. */
  ids: string[];
}

function hasCloseManyFilters(
  list: ListOptions | undefined,
  status: string | undefined,
): boolean {
  return hasListFilters(list, status, { includePagination: false });
}

function hasCloseManyRollbackConflicts(
  list: ListOptions | undefined,
  status: string | undefined,
): boolean {
  return hasListFilters(list, status);
}

function rejectBlankIdsFilter(list: ListOptions | undefined): void {
  if (list?.ids != null && String(list.ids).trim().length === 0) {
    throw new PmCliError(
      "--ids requires at least one non-empty item ID",
      EXIT_CODE.USAGE,
    );
  }
}

function activeListOptions(list: ListOptions | undefined): ListOptions {
  const active: ListOptions = {};
  if (!list) {
    return active;
  }
  for (const [key, value] of Object.entries(list) as Array<
    [keyof ListOptions, unknown]
  >) {
    if (
      value == null ||
      (typeof value === "string" &&
        !value.split(",").some((entry) => entry.trim().length > 0))
    ) {
      continue;
    }
    (active as Record<string, unknown>)[key] = value;
  }
  return active;
}

function resolveReason(reason: unknown, required: boolean): string | undefined {
  const trimmed = String(reason ?? "").trim();
  if (trimmed.length > 0) {
    return trimmed;
  }
  if (required) {
    throw new PmCliError(
      "pm close-many requires a shared close reason via --reason because governance.require_close_reason is enabled.",
      EXIT_CODE.USAGE,
      {
        code: "close_reason_required",
        required:
          "Provide a shared closing summary via --reason for the whole batch.",
        why: "governance.require_close_reason is enabled, so every close must record why the items are done.",
        examples: [
          'pm close-many --filter-sprint S-12 --reason "Sprint S-12 acceptance criteria met"',
          'pm close-many --ids pm-a,pm-b --reason "Superseded by redesign"',
        ],
        nextSteps: [
          "Re-run with --reason describing the shared outcome.",
          "To stop requiring reasons, run: pm config set governance-require-close-reason --policy disabled",
        ],
      },
    );
  }
  return undefined;
}

// Build a parent -> non-terminal child id map in a single light scan so each
// matched parent can be annotated with the active children that closing it
// would orphan (the same signal runClose surfaces per item on apply).
async function buildActiveChildrenByParent(
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
): Promise<{
  childrenByParent: Map<string, string[]>;
  parentByChild: Map<string, string>;
}> {
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const items = await listAllItemMetadataLight(
    pmRoot,
    settings.item_format,
    typeRegistry.type_to_folder,
    undefined,
    settings.schema,
  );
  const childrenByParent = new Map<string, string[]>();
  const parentByChild = new Map<string, string>();
  for (const item of items) {
    if (typeof item.parent !== "string" || item.parent.length === 0) {
      continue;
    }
    parentByChild.set(item.id, item.parent);
    if (isTerminalStatus(item.status, statusRegistry)) {
      continue;
    }
    const existing = childrenByParent.get(item.parent);
    if (existing) {
      existing.push(item.id);
    } else {
      childrenByParent.set(item.parent, [item.id]);
    }
  }
  for (const ids of childrenByParent.values()) {
    ids.sort((left, right) => left.localeCompare(right));
  }
  return { childrenByParent, parentByChild };
}

function hierarchyDepth(
  id: string,
  parentByChild: Map<string, string>,
  cache?: Map<string, number>,
): number {
  const cached = cache?.get(id);
  if (cached !== undefined) {
    return cached;
  }
  let depth = 0;
  let current = parentByChild.get(id);
  const path: string[] = [];
  const visited = new Set<string>();
  let hasCycle = false;
  while (current !== undefined && !visited.has(current)) {
    const cachedCurrent = cache?.get(current);
    if (cachedCurrent !== undefined) {
      depth += cachedCurrent + 1;
      break;
    }
    visited.add(current);
    path.push(current);
    depth += 1;
    current = parentByChild.get(current);
  }
  if (current !== undefined && visited.has(current)) {
    hasCycle = true;
  }
  if (!hasCycle) {
    cache?.set(id, depth);
    for (const [index, ancestorId] of path.entries()) {
      cache?.set(ancestorId, depth - index - 1);
    }
  }
  return depth;
}

async function runCloseManyRollback(params: {
  pmRoot: string;
  rollbackId: string;
  options: CloseManyCommandOptions;
  global: GlobalOptions;
}): Promise<CloseManyResult> {
  const checkpoint = await loadMutationCheckpoint(
    params.pmRoot,
    CLOSE_MANY_CHECKPOINT_SUBDIR,
    params.rollbackId,
    CLOSE_MANY_CHECKPOINT_SCHEMA_VERSION,
  );
  const restoreMessage =
    params.options.message ?? `Rollback close-many checkpoint ${checkpoint.id}`;
  const rollback = await restoreCheckpointItems(
    checkpoint.items,
    (id, targetUpdatedAt) =>
      runRestore(
        id,
        targetUpdatedAt,
        { author: params.options.author, message: restoreMessage, force: true },
        params.global,
      ),
  );
  return {
    mode: "rollback",
    matched_count: checkpoint.items.length,
    dry_run: false,
    rollback_checkpoint_id: checkpoint.id,
    checkpoint: {
      id: checkpoint.id,
      created_at: checkpoint.created_at,
      path: checkpoint.path,
      rollback_command: `pm close-many --rollback ${checkpoint.id}`,
    },
    restored_count: rollback.restored_ids.length,
    failed_count: rollback.failed_count,
    rows: rollback.rows,
    ids: rollback.restored_ids,
  };
}

function planCloseManyRows(
  matched: ListedItem[],
  childrenByParent: Map<string, string[]>,
  closePlannedIds: Set<string>,
  statusRegistry: ReturnType<typeof resolveRuntimeStatusRegistry>,
  force: boolean,
): CloseManyPlanRow[] {
  return matched.map((item) => {
    const activeChildIds = (childrenByParent.get(item.id) ?? []).filter(
      (childId) => !closePlannedIds.has(childId),
    );
    const willSkip = !canCloseManyItem(item, statusRegistry, force);
    return {
      id: item.id,
      title: typeof item.title === "string" ? item.title : "",
      status: item.status,
      action: willSkip ? "skip" : "close",
      ...(willSkip ? { skip_reason: "already_terminal" } : {}),
      ...(activeChildIds.length > 0
        ? { active_child_ids: activeChildIds }
        : {}),
    };
  });
}

async function writeCloseManyCheckpoint(params: {
  pmRoot: string;
  checkpointId: string;
  nowValue: string;
  options: CloseManyCommandOptions;
  reason: string | undefined;
  filters: Record<string, unknown>;
  checkpointItems: MutationCheckpointItem[];
}): Promise<CloseManyResult["checkpoint"]> {
  const checkpointPath = await writeMutationCheckpoint(
    params.pmRoot,
    CLOSE_MANY_CHECKPOINT_SUBDIR,
    params.checkpointId,
    {
      schema_version: CLOSE_MANY_CHECKPOINT_SCHEMA_VERSION,
      id: params.checkpointId,
      created_at: params.nowValue,
      author: resolveAuthor(params.options.author, "unknown"),
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
      filters: params.filters,
      items: params.checkpointItems,
    },
  );
  return {
    id: params.checkpointId,
    created_at: params.nowValue,
    path: checkpointPath,
    rollback_command: `pm close-many --rollback ${params.checkpointId}`,
  };
}

async function applyCloseManyRows(params: {
  matched: ListedItem[];
  closableIds: Set<string>;
  reason: string | undefined;
  closeOptions: CloseCommandOptions;
  global: GlobalOptions;
}): Promise<{ rows: CloseManyApplyRow[]; closedIds: string[] }> {
  const rows: CloseManyApplyRow[] = [];
  const closedIds: string[] = [];
  for (const item of params.matched) {
    if (!params.closableIds.has(item.id)) {
      rows.push({
        id: item.id,
        status: "skipped",
        skip_reason: "already_terminal",
      });
      continue;
    }
    try {
      const result = await runClose(
        item.id,
        params.reason,
        params.closeOptions,
        params.global,
      );
      rows.push({
        id: item.id,
        status: "closed",
        changed_fields: result.changed_fields,
        ...(result.warnings && result.warnings.length > 0
          ? { warnings: result.warnings }
          : {}),
      });
      closedIds.push(item.id);
    } catch (error: unknown) {
      rows.push({
        id: item.id,
        status: "failed",
        error: toErrorMessage(error),
      });
    }
  }
  return { rows, closedIds };
}

function resolveCloseManyRollbackId(
  options: CloseManyCommandOptions,
): string | undefined {
  return typeof options.rollback === "string" ? options.rollback : undefined;
}

function validateCloseManyRollbackOptions(
  options: CloseManyCommandOptions,
  rollbackId: string,
): void {
  if (rollbackId.trim().length === 0) {
    throw new PmCliError(
      "--rollback requires a checkpoint id",
      EXIT_CODE.USAGE,
    );
  }
  if (options.dryRun === true) {
    throw new PmCliError(
      "--dry-run cannot be combined with --rollback",
      EXIT_CODE.USAGE,
    );
  }
  if (hasCloseManyRollbackConflicts(options.list, options.status)) {
    throw new PmCliError(
      "Rollback mode does not accept filter options",
      EXIT_CODE.USAGE,
    );
  }
}

function assertCloseManyHasFilters(options: CloseManyCommandOptions): void {
  if (hasCloseManyFilters(options.list, options.status)) {
    return;
  }
  throw new PmCliError(
    `close-many requires at least one filter to scope the close (for example: ${CLOSE_MANY_FILTER_GUIDANCE}). Refusing to match every item.`,
    EXIT_CODE.USAGE,
  );
}

function sortCloseManyMatchedItems(
  matched: ListedItem[],
  parentByChild: Map<string, string>,
): ListedItem[] {
  const depthCache = new Map<string, number>();
  return [...matched].sort((left, right) => {
    const depthDelta =
      hierarchyDepth(right.id, parentByChild, depthCache) -
      hierarchyDepth(left.id, parentByChild, depthCache);
    return depthDelta !== 0 ? depthDelta : left.id.localeCompare(right.id);
  });
}

function canCloseManyItem(
  item: ListedItem,
  statusRegistry: ReturnType<typeof resolveRuntimeStatusRegistry>,
  force: boolean,
): boolean {
  return force || !isTerminalStatus(item.status, statusRegistry);
}

function resolveCloseManyPlannedIds(
  matched: ListedItem[],
  statusRegistry: ReturnType<typeof resolveRuntimeStatusRegistry>,
  force: boolean,
): Set<string> {
  return new Set(
    matched
      .filter((item) => canCloseManyItem(item, statusRegistry, force))
      .map((item) => item.id),
  );
}

async function buildCloseManyPlanContext(params: {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  options: CloseManyCommandOptions;
  global: GlobalOptions;
}): Promise<CloseManyPlanContext> {
  assertCloseManyHasFilters(params.options);
  const statusRegistry = resolveRuntimeStatusRegistry(params.settings.schema);
  const reason = resolveReason(
    params.options.reason,
    params.settings.governance.require_close_reason,
  );
  const force = params.options.force === true;
  const listed = await runList(
    params.options.status,
    activeListOptions(params.options.list),
    params.global,
  );
  const { childrenByParent, parentByChild } = await buildActiveChildrenByParent(
    params.pmRoot,
    params.settings,
  );
  const matched = sortCloseManyMatchedItems(
    listed.items as ListedItem[],
    parentByChild,
  );
  const closePlannedIds = resolveCloseManyPlannedIds(
    matched,
    statusRegistry,
    force,
  );
  return {
    pmRoot: params.pmRoot,
    settings: params.settings,
    statusRegistry,
    reason,
    validateCloseMode: params.options.validateClose,
    force,
    listed,
    matched,
    planRows: planCloseManyRows(
      matched,
      childrenByParent,
      closePlannedIds,
      statusRegistry,
      force,
    ),
  };
}

function buildCloseManyDryRunResult(
  context: CloseManyPlanContext,
): CloseManyResult {
  return {
    mode: "dry_run",
    matched_count: context.matched.length,
    dry_run: true,
    ...(context.reason !== undefined ? { reason: context.reason } : {}),
    filters: context.listed.filters,
    ...(context.validateCloseMode
      ? { validate_close: context.validateCloseMode }
      : {}),
    item_plans: context.planRows,
    ids: [],
  };
}

async function resolveCloseManyCheckpointInfo(params: {
  context: CloseManyPlanContext;
  options: CloseManyCommandOptions;
  closableIds: Set<string>;
  checkpointId: string;
  nowValue: string;
}): Promise<CloseManyResult["checkpoint"]> {
  if (params.options.checkpoint === false || params.closableIds.size === 0) {
    return undefined;
  }
  const checkpointItems: MutationCheckpointItem[] = params.context.matched
    .filter((item) => params.closableIds.has(item.id))
    .map((item) => ({ id: item.id, target_updated_at: item.updated_at }));
  return writeCloseManyCheckpoint({
    pmRoot: params.context.pmRoot,
    checkpointId: params.checkpointId,
    nowValue: params.nowValue,
    options: params.options,
    reason: params.context.reason,
    filters: params.context.listed.filters,
    checkpointItems,
  });
}

/** Implements run close many for the public runtime surface of this module. */
export async function runCloseMany(
  options: CloseManyCommandOptions,
  global: GlobalOptions,
): Promise<CloseManyResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const settings = await readSettings(pmRoot);

  const dryRun = options.dryRun === true;
  const rollbackId = resolveCloseManyRollbackId(options);
  rejectBlankIdsFilter(options.list);

  if (rollbackId !== undefined) {
    validateCloseManyRollbackOptions(options, rollbackId);
    return runCloseManyRollback({ pmRoot, rollbackId, options, global });
  }

  const context = await buildCloseManyPlanContext({
    pmRoot,
    settings,
    options,
    global,
  });

  if (dryRun) {
    return buildCloseManyDryRunResult(context);
  }

  const closableIds = new Set(
    context.planRows
      .filter((row) => row.action === "close")
      .map((row) => row.id),
  );
  const nowValue = nowIso();
  const checkpointId = createCheckpointId(
    CLOSE_MANY_CHECKPOINT_SUBDIR,
    nowValue,
  );
  const checkpointInfo = await resolveCloseManyCheckpointInfo({
    context,
    options,
    closableIds,
    checkpointId,
    nowValue,
  });

  const closeOptions: CloseCommandOptions = {
    author: options.author,
    message: options.message ?? `close-many apply ${checkpointId}`,
    validateClose: context.validateCloseMode,
    force: context.force,
    resolution: options.resolution,
    expectedResult: options.expectedResult,
    actualResult: options.actualResult,
  };

  const { rows, closedIds } = await applyCloseManyRows({
    matched: context.matched,
    closableIds,
    reason: context.reason,
    closeOptions,
    global,
  });

  return {
    mode: "apply",
    matched_count: context.matched.length,
    dry_run: false,
    ...(context.reason !== undefined ? { reason: context.reason } : {}),
    filters: context.listed.filters,
    ...(context.validateCloseMode
      ? { validate_close: context.validateCloseMode }
      : {}),
    ...(checkpointInfo ? { checkpoint: checkpointInfo } : {}),
    closed_count: rows.filter((row) => row.status === "closed").length,
    skipped_count: rows.filter((row) => row.status === "skipped").length,
    failed_count: rows.filter((row) => row.status === "failed").length,
    rows,
    ids: closedIds,
  };
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  activeListOptions,
  buildActiveChildrenByParent,
  hasCloseManyFilters,
  hasCloseManyRollbackConflicts,
  hierarchyDepth,
  rejectBlankIdsFilter,
  resolveReason,
};
