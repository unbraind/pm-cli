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
import { listAllFrontMatterLight } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { runClose, type CloseCommandOptions } from "./close.js";
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

export interface CloseManyCommandOptions {
  status?: string;
  list?: ListOptions;
  reason?: string;
  resolution?: string;
  expectedResult?: string;
  actualResult?: string;
  validateClose?: string;
  author?: string;
  message?: string;
  force?: boolean;
  dryRun?: boolean;
  rollback?: string;
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

export interface CloseManyResult {
  mode: "dry_run" | "apply" | "rollback";
  matched_count: number;
  dry_run: boolean;
  reason?: string;
  filters?: Record<string, unknown>;
  validate_close?: string;
  item_plans?: CloseManyPlanRow[];
  checkpoint?: {
    id: string;
    created_at: string;
    path: string;
    rollback_command: string;
  };
  closed_count?: number;
  skipped_count?: number;
  failed_count?: number;
  restored_count?: number;
  rollback_checkpoint_id?: string;
  rows?: CloseManyApplyRow[] | Array<{ id: string; status: "restored" | "failed"; changed_fields?: string[]; warnings?: string[]; error?: string }>;
  ids: string[];
}

function hasCloseManyFilters(list: ListOptions | undefined, status: string | undefined): boolean {
  const isActive = (value: unknown): boolean =>
    value != null && (typeof value !== "string" || value.split(",").some((entry) => entry.trim().length > 0));
  return (
    isActive(status) ||
    isActive(list?.status) ||
    isActive(list?.type) ||
    isActive(list?.tag) ||
    isActive(list?.priority) ||
    isActive(list?.deadlineBefore) ||
    isActive(list?.deadlineAfter) ||
    isActive(list?.updatedAfter) ||
    isActive(list?.updatedBefore) ||
    isActive(list?.createdAfter) ||
    isActive(list?.createdBefore) ||
    isActive(list?.ids) ||
    isActive(list?.assignee) ||
    isActive(list?.assigneeFilter) ||
    isActive(list?.parent) ||
    isActive(list?.sprint) ||
    isActive(list?.release)
  );
}

function hasCloseManyRollbackConflicts(list: ListOptions | undefined, status: string | undefined): boolean {
  return (
    hasCloseManyFilters(list, status) ||
    (list?.limit != null && String(list.limit).trim().length > 0) ||
    (list?.offset != null && String(list.offset).trim().length > 0)
  );
}

function rejectBlankIdsFilter(list: ListOptions | undefined): void {
  if (list?.ids != null && String(list.ids).trim().length === 0) {
    throw new PmCliError("--ids requires at least one non-empty item ID", EXIT_CODE.USAGE);
  }
}

function activeListOptions(list: ListOptions | undefined): ListOptions {
  const active: ListOptions = {};
  if (!list) {
    return active;
  }
  for (const [key, value] of Object.entries(list) as Array<[keyof ListOptions, unknown]>) {
    if (value == null || (typeof value === "string" && !value.split(",").some((entry) => entry.trim().length > 0))) {
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
        required: "Provide a shared closing summary via --reason for the whole batch.",
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
): Promise<{ childrenByParent: Map<string, string[]>; parentByChild: Map<string, string> }> {
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const items = await listAllFrontMatterLight(
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

function hierarchyDepth(id: string, parentByChild: Map<string, string>, cache?: Map<string, number>): number {
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

export async function runCloseMany(options: CloseManyCommandOptions, global: GlobalOptions): Promise<CloseManyResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);

  const dryRun = options.dryRun === true;
  const rollbackId = typeof options.rollback === "string" ? options.rollback : undefined;
  rejectBlankIdsFilter(options.list);

  if (rollbackId) {
    if (dryRun) {
      throw new PmCliError("--dry-run cannot be combined with --rollback", EXIT_CODE.USAGE);
    }
    if (hasCloseManyRollbackConflicts(options.list, options.status)) {
      throw new PmCliError("Rollback mode does not accept filter options", EXIT_CODE.USAGE);
    }
    const checkpoint = await loadMutationCheckpoint(
      pmRoot,
      CLOSE_MANY_CHECKPOINT_SUBDIR,
      rollbackId,
      CLOSE_MANY_CHECKPOINT_SCHEMA_VERSION,
    );
    const restoreMessage = options.message ?? `Rollback close-many checkpoint ${checkpoint.id}`;
    const rollback = await restoreCheckpointItems(checkpoint.items, (id, targetUpdatedAt) =>
      runRestore(id, targetUpdatedAt, { author: options.author, message: restoreMessage, force: true }, global),
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

  if (!hasCloseManyFilters(options.list, options.status)) {
    throw new PmCliError(
      `close-many requires at least one filter to scope the close (for example: ${CLOSE_MANY_FILTER_GUIDANCE}). Refusing to match every item.`,
      EXIT_CODE.USAGE,
    );
  }

  const reason = resolveReason(options.reason, settings.governance.require_close_reason);
  const validateCloseMode = options.validateClose;
  const force = options.force === true;

  const listOptions = activeListOptions(options.list);
  const listed = await runList(options.status, listOptions, global);
  const { childrenByParent, parentByChild } = await buildActiveChildrenByParent(pmRoot, settings);
  const depthCache = new Map<string, number>();
  const matched = [...(listed.items as ListedItem[])].sort((left, right) => {
    const depthDelta = hierarchyDepth(right.id, parentByChild, depthCache) - hierarchyDepth(left.id, parentByChild, depthCache);
    return depthDelta !== 0 ? depthDelta : left.id.localeCompare(right.id);
  });
  const closePlannedIds = new Set(
    matched
      .filter((item) => force || !isTerminalStatus(item.status, statusRegistry))
      .map((item) => item.id),
  );

  const planRows: CloseManyPlanRow[] = matched.map((item) => {
    const alreadyTerminal = isTerminalStatus(item.status, statusRegistry);
    const activeChildIds = (childrenByParent.get(item.id) ?? []).filter((childId) => !closePlannedIds.has(childId));
    const willSkip = alreadyTerminal && !force;
    return {
      id: item.id,
      title: typeof item.title === "string" ? item.title : "",
      status: item.status,
      action: willSkip ? "skip" : "close",
      ...(willSkip ? { skip_reason: "already_terminal" } : {}),
      ...(activeChildIds.length > 0 ? { active_child_ids: activeChildIds } : {}),
    };
  });

  if (dryRun) {
    return {
      mode: "dry_run",
      matched_count: matched.length,
      dry_run: true,
      ...(reason !== undefined ? { reason } : {}),
      filters: listed.filters,
      ...(validateCloseMode ? { validate_close: validateCloseMode } : {}),
      item_plans: planRows,
      ids: [],
    };
  }

  const closableIds = new Set(planRows.filter((row) => row.action === "close").map((row) => row.id));

  const nowValue = nowIso();
  const checkpointId = createCheckpointId(CLOSE_MANY_CHECKPOINT_SUBDIR, nowValue);
  const checkpointEnabled = options.checkpoint !== false;
  let checkpointInfo: CloseManyResult["checkpoint"] | undefined;
  if (checkpointEnabled && closableIds.size > 0) {
    const checkpointItems: MutationCheckpointItem[] = matched
      .filter((item) => closableIds.has(item.id))
      .map((item) => ({ id: item.id, target_updated_at: item.updated_at }));
    const checkpointPath = await writeMutationCheckpoint(pmRoot, CLOSE_MANY_CHECKPOINT_SUBDIR, checkpointId, {
      schema_version: CLOSE_MANY_CHECKPOINT_SCHEMA_VERSION,
      id: checkpointId,
      created_at: nowValue,
      author: resolveAuthor(options.author, "unknown"),
      ...(reason !== undefined ? { reason } : {}),
      filters: listed.filters,
      items: checkpointItems,
    });
    checkpointInfo = {
      id: checkpointId,
      created_at: nowValue,
      path: checkpointPath,
      rollback_command: `pm close-many --rollback ${checkpointId}`,
    };
  }

  const closeOptions: CloseCommandOptions = {
    author: options.author,
    message: options.message ?? `close-many apply ${checkpointId}`,
    validateClose: validateCloseMode,
    force,
    resolution: options.resolution,
    expectedResult: options.expectedResult,
    actualResult: options.actualResult,
  };

  const rows: CloseManyApplyRow[] = [];
  const closedIds: string[] = [];
  for (const item of matched) {
    if (!closableIds.has(item.id)) {
      rows.push({ id: item.id, status: "skipped", skip_reason: "already_terminal" });
      continue;
    }
    try {
      const result = await runClose(item.id, reason, closeOptions, global);
      rows.push({
        id: item.id,
        status: "closed",
        changed_fields: result.changed_fields,
        ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      });
      closedIds.push(item.id);
    } catch (error: unknown) {
      rows.push({ id: item.id, status: "failed", error: toErrorMessage(error) });
    }
  }

  return {
    mode: "apply",
    matched_count: matched.length,
    dry_run: false,
    ...(reason !== undefined ? { reason } : {}),
    filters: listed.filters,
    ...(validateCloseMode ? { validate_close: validateCloseMode } : {}),
    ...(checkpointInfo ? { checkpoint: checkpointInfo } : {}),
    closed_count: rows.filter((row) => row.status === "closed").length,
    skipped_count: rows.filter((row) => row.status === "skipped").length,
    failed_count: rows.filter((row) => row.status === "failed").length,
    rows,
    ids: closedIds,
  };
}

export const _testOnly = {
  activeListOptions,
  buildActiveChildrenByParent,
  hasCloseManyFilters,
  hasCloseManyRollbackConflicts,
  hierarchyDepth,
  rejectBlankIdsFilter,
  resolveReason,
};
