/**
 * @module cli/commands/update-many
 *
 * Implements the pm update many command surface and its agent-facing runtime behavior.
 */
import { pathExists } from "../../core/fs/fs-utils.js";
import {
  createCheckpointId,
  loadMutationCheckpoint,
  restoreCheckpointItems,
  writeMutationCheckpoint,
  type MutationCheckpointItem,
} from "../../core/checkpoint/mutation-checkpoint.js";
import { toItemRecord } from "../../core/item/item-record.js";
import { applyTagRemovals, mergeAdditiveTags, parseTags } from "../../core/item/parse.js";
import { resolvePriority } from "../../core/item/priority.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import { resolveItemTypeRegistry, resolveTypeName } from "../../core/item/type-registry.js";
import { collectRuntimeUpdateFieldValues } from "../../core/schema/runtime-field-values.js";
import { buildInvalidTypeError } from "../../core/schema/item-types-file.js";
import {
  resolveItemTypesFilePath,
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeFieldRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { toErrorMessage } from "../../core/shared/primitives.js";
import { stableValueEquals } from "../../core/shared/serialization.js";
import { nowIso, resolveIsoOrRelative } from "../../core/shared/time.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import type { PmSettings } from "../../types/index.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { resolveAuthor } from "../../core/shared/author.js";
import type { ItemStatus } from "../../types/index.js";
import { hasListFilters } from "./list-filter-shared.js";
import { runList, type ListOptions, type ListedItem } from "./list.js";
import { runRestore } from "./restore.js";
import { runUpdate, type UpdateCommandOptions } from "./update.js";

const UPDATE_MANY_CHECKPOINT_SCHEMA_VERSION = 1;
const UPDATE_MANY_CHECKPOINT_SUBDIR = "update-many";

const NON_MUTATION_UPDATE_OPTION_KEYS = new Set<keyof UpdateCommandOptions>([
  "author",
  "message",
  "force",
  "allowAuditUpdate",
  "allowAuditDepUpdate",
]);

const UPDATE_MANY_MUTATION_FLAG_GUIDANCE = [
  "--status",
  "--priority",
  "--type",
  "--tags",
  "--description",
  "--body",
  "--deadline",
  "--estimate",
  "--assignee",
  "--dep",
  "--dep-remove",
  "--comment",
  "--note",
  "--learning",
  "--file",
  "--test",
  "--doc",
  "--replace-deps",
  "--replace-tests",
  "--unset",
  "--clear-*",
].join(", ");

const UPDATE_OPTION_TO_ITEM_KEY: Partial<Record<keyof UpdateCommandOptions, string>> = {
  title: "title",
  description: "description",
  body: "body",
  status: "status",
  closeReason: "close_reason",
  priority: "priority",
  type: "type",
  deadline: "deadline",
  estimatedMinutes: "estimated_minutes",
  acceptanceCriteria: "acceptance_criteria",
  definitionOfReady: "definition_of_ready",
  order: "order",
  goal: "goal",
  objective: "objective",
  value: "value",
  impact: "impact",
  outcome: "outcome",
  whyNow: "why_now",
  assignee: "assignee",
  parent: "parent",
  reviewer: "reviewer",
  risk: "risk",
  confidence: "confidence",
  sprint: "sprint",
  release: "release",
  blockedBy: "blocked_by",
  blockedReason: "blocked_reason",
  unblockNote: "unblock_note",
  reporter: "reporter",
  severity: "severity",
  environment: "environment",
  reproSteps: "repro_steps",
  resolution: "resolution",
  expectedResult: "expected_result",
  actualResult: "actual_result",
  affectedVersion: "affected_version",
  fixedVersion: "fixed_version",
  component: "component",
  regression: "regression",
  customerImpact: "customer_impact",
};

interface CollectionMutationPlanDefinition {
  field: string;
  addKey: keyof UpdateCommandOptions;
  removeKey?: keyof UpdateCommandOptions;
  clearKey: keyof UpdateCommandOptions;
  replaceKey?: keyof UpdateCommandOptions;
}

const COLLECTION_MUTATION_PLAN_DEFINITIONS: CollectionMutationPlanDefinition[] = [
  {
    field: "dependencies",
    addKey: "dep",
    removeKey: "depRemove",
    clearKey: "clearDeps",
    replaceKey: "replaceDeps",
  },
  {
    field: "comments",
    addKey: "comment",
    clearKey: "clearComments",
  },
  {
    field: "notes",
    addKey: "note",
    clearKey: "clearNotes",
  },
  {
    field: "learnings",
    addKey: "learning",
    clearKey: "clearLearnings",
  },
  {
    field: "files",
    addKey: "file",
    clearKey: "clearFiles",
  },
  {
    field: "tests",
    addKey: "test",
    clearKey: "clearTests",
    replaceKey: "replaceTests",
  },
  {
    field: "docs",
    addKey: "doc",
    clearKey: "clearDocs",
  },
  {
    field: "reminders",
    addKey: "reminder",
    clearKey: "clearReminders",
  },
  {
    field: "events",
    addKey: "event",
    clearKey: "clearEvents",
  },
  {
    field: "type_options",
    addKey: "typeOption",
    clearKey: "clearTypeOptions",
  },
];

const UNSET_FIELD_ALIASES: Record<string, string> = {
  close_reason: "close_reason",
  "close-reason": "close_reason",
  deadline: "deadline",
  estimate: "estimated_minutes",
  estimated_minutes: "estimated_minutes",
  "estimated-minutes": "estimated_minutes",
  acceptance_criteria: "acceptance_criteria",
  "acceptance-criteria": "acceptance_criteria",
  ac: "acceptance_criteria",
  definition_of_ready: "definition_of_ready",
  "definition-of-ready": "definition_of_ready",
  order: "order",
  rank: "order",
  goal: "goal",
  objective: "objective",
  value: "value",
  impact: "impact",
  outcome: "outcome",
  why_now: "why_now",
  "why-now": "why_now",
  assignee: "assignee",
  parent: "parent",
  reviewer: "reviewer",
  risk: "risk",
  confidence: "confidence",
  sprint: "sprint",
  release: "release",
  blocked_by: "blocked_by",
  "blocked-by": "blocked_by",
  blocked_reason: "blocked_reason",
  "blocked-reason": "blocked_reason",
  unblock_note: "unblock_note",
  "unblock-note": "unblock_note",
  reporter: "reporter",
  severity: "severity",
  environment: "environment",
  repro_steps: "repro_steps",
  "repro-steps": "repro_steps",
  resolution: "resolution",
  expected_result: "expected_result",
  "expected-result": "expected_result",
  actual_result: "actual_result",
  "actual-result": "actual_result",
  affected_version: "affected_version",
  "affected-version": "affected_version",
  fixed_version: "fixed_version",
  "fixed-version": "fixed_version",
  component: "component",
  regression: "regression",
  customer_impact: "customer_impact",
  "customer-impact": "customer_impact",
  type_options: "type_options",
  "type-options": "type_options",
  tags: "tags",
};

interface UpdateManyCheckpoint {
  schema_version: number;
  id: string;
  created_at: string;
  author: string;
  status_filter: string | null;
  list_filters: Record<string, unknown>;
  update_options: Record<string, unknown>;
  items: MutationCheckpointItem[];
}

/**
 * Documents the update many command options payload exchanged by command, SDK, and package integrations.
 */
export interface UpdateManyCommandOptions {
  status?: string;
  list: ListOptions;
  update: UpdateCommandOptions;
  dryRun?: boolean;
  rollback?: string;
  checkpoint?: boolean;
}

interface PlannedChange {
  field: string;
  before: unknown;
  after: unknown;
}

interface PlannedItemDiff {
  id: string;
  changes: PlannedChange[];
}

interface UpdateManyApplyResultRow {
  id: string;
  status: "updated" | "failed" | "skipped";
  changed_fields?: string[];
  warnings?: string[];
  error?: string;
}

interface UpdateManyRollbackResultRow {
  id: string;
  status: "restored" | "failed";
  changed_fields?: string[];
  warnings?: string[];
  error?: string;
}

/**
 * Documents the update many result payload exchanged by command, SDK, and package integrations.
 */
export interface UpdateManyResult {
  mode: "dry_run" | "apply" | "rollback";
  matched_count: number;
  dry_run: boolean;
  filters?: Record<string, unknown>;
  planned_update_options?: Record<string, unknown>;
  item_plans?: PlannedItemDiff[];
  checkpoint?: {
    id: string;
    created_at: string;
    path: string;
    rollback_command: string;
  };
  updated_count?: number;
  skipped_count?: number;
  failed_count?: number;
  restored_count?: number;
  rollback_checkpoint_id?: string;
  rows?: UpdateManyApplyResultRow[] | UpdateManyRollbackResultRow[];
  ids: string[];
}

function sanitizeUpdateOptionsForSummary(options: UpdateCommandOptions): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options) as Array<[keyof UpdateCommandOptions, unknown]>) {
    if (NON_MUTATION_UPDATE_OPTION_KEYS.has(key)) {
      continue;
    }
    if (value === undefined) {
      continue;
    }
    summary[key] = value;
  }
  return summary;
}

function hasAnyUpdateMutationInput(options: UpdateCommandOptions): boolean {
  return Object.keys(sanitizeUpdateOptionsForSummary(options)).length > 0;
}

function toComparablePreviewValue(optionKey: keyof UpdateCommandOptions, value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (optionKey === "priority") {
    const parsed = Number(String(value).trim());
    return Number.isInteger(parsed) ? parsed : String(value).trim();
  }
  if (optionKey === "estimatedMinutes" || optionKey === "order" || optionKey === "rank") {
    const parsed = Number(String(value).trim());
    return Number.isFinite(parsed) ? parsed : String(value).trim();
  }
  if (optionKey === "regression") {
    const normalized = String(value).trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return value;
}

function normalizeUnsetField(rawField: string): string {
  const normalized = rawField.trim().toLowerCase().replaceAll("-", "_");
  return UNSET_FIELD_ALIASES[normalized] ?? normalized;
}

function areValuesEqual(left: unknown, right: unknown): boolean {
  return stableValueEquals(left, right);
}

function normalizeCollectionBeforeValue(field: string, value: unknown): unknown {
  if (value !== undefined) {
    return value;
  }
  if (field === "type_options") {
    return {};
  }
  return [];
}

function collectionValueCount(field: string, value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (field === "type_options" && value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length;
  }
  return 0;
}

function buildCollectionMutationPlans(row: Record<string, unknown>, update: UpdateCommandOptions): PlannedChange[] {
  const changes: PlannedChange[] = [];
  for (const definition of COLLECTION_MUTATION_PLAN_DEFINITIONS) {
    const addValues = update[definition.addKey];
    const removeValues = definition.removeKey ? update[definition.removeKey] : undefined;
    const addCount = Array.isArray(addValues) ? addValues.length : 0;
    const removeCount = Array.isArray(removeValues) ? removeValues.length : 0;
    const clear = update[definition.clearKey] === true;
    const replace = definition.replaceKey ? update[definition.replaceKey] === true : false;
    if (!clear && !replace && addCount === 0 && removeCount === 0) {
      continue;
    }

    const before = normalizeCollectionBeforeValue(definition.field, row[definition.field]);
    const beforeCount = collectionValueCount(definition.field, before);
    const operation = replace ? "replace" : clear ? "clear_or_reset" : removeCount > 0 ? "merge_remove" : "append";
    changes.push({
      field: definition.field,
      before,
      after: {
        operation,
        clear,
        replace,
        add_count: addCount,
        remove_count: removeCount,
        before_count: beforeCount,
      },
    });
  }
  return changes;
}

function normalizeExistingTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((tag): tag is string => typeof tag === "string");
}

// Tags support three mutation modes that compose: --tags replaces, --add-tags
// extends, --remove-tags prunes. Replicate runUpdate's resolution order so the
// dry-run preview and the apply-mode actionable detection both account for
// additive/subtractive tag mutations (a --add-tags-only update must NOT be
// treated as a no-op skip).
function buildTagMutationPlan(row: Record<string, unknown>, update: UpdateCommandOptions): PlannedChange | undefined {
  const hasReplace = update.tags !== undefined;
  const hasAdd = Array.isArray(update.addTags) && update.addTags.length > 0;
  const hasRemove = Array.isArray(update.removeTags) && update.removeTags.length > 0;
  if (!hasReplace && !hasAdd && !hasRemove) {
    return undefined;
  }
  const existing = normalizeExistingTags(row.tags);
  const baseTags = hasReplace ? parseTags(update.tags as string) : existing;
  const withAdditions = mergeAdditiveTags(baseTags, update.addTags);
  const after = applyTagRemovals(withAdditions, update.removeTags).slice().sort((a, b) => a.localeCompare(b));
  const before = existing.slice().sort((a, b) => a.localeCompare(b));
  if (areValuesEqual(before, after)) {
    return undefined;
  }
  return { field: "tags", before: existing, after };
}

function buildPlannedItemDiff(
  item: ListedItem,
  update: UpdateCommandOptions = {},
  runtimeFieldRegistry: RuntimeFieldRegistry,
): PlannedItemDiff {
  const safeUpdate = update;
  const row = toItemRecord(item);
  const changes: PlannedChange[] = [];
  const tagPlan = buildTagMutationPlan(row, safeUpdate);
  if (tagPlan) {
    changes.push(tagPlan);
  }
  for (const [optionKey, itemKey] of Object.entries(UPDATE_OPTION_TO_ITEM_KEY) as Array<[keyof UpdateCommandOptions, string]>) {
    const candidate = safeUpdate[optionKey];
    if (candidate === undefined) {
      continue;
    }
    const before = row[itemKey];
    const after = toComparablePreviewValue(optionKey, candidate);
    if (areValuesEqual(before, after)) {
      continue;
    }
    changes.push({
      field: itemKey,
      before,
      after,
    });
  }
  changes.push(...buildCollectionMutationPlans(row, safeUpdate));

  const runtimeFieldUpdates = collectRuntimeUpdateFieldValues(
    safeUpdate as Record<string, unknown>,
    runtimeFieldRegistry,
    ["update_many"],
  );
  for (const [fieldKey, fieldValue] of Object.entries(runtimeFieldUpdates)) {
    const before = row[fieldKey];
    if (areValuesEqual(before, fieldValue)) {
      continue;
    }
    changes.push({
      field: fieldKey,
      before,
      after: fieldValue,
    });
  }

  if (safeUpdate.unset && safeUpdate.unset.length > 0) {
    for (const rawUnsetField of safeUpdate.unset) {
      const field = normalizeUnsetField(rawUnsetField);
      const before = row[field];
      if (before === undefined) {
        continue;
      }
      changes.push({
        field,
        before,
        after: null,
      });
    }
  }

  return {
    id: item.id,
    changes,
  };
}

function normalizeStatusFilter(value: string | undefined, statusRegistry: RuntimeStatusRegistry): ItemStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeStatusInput(value, statusRegistry);
  if (!normalized) {
    const allowedStatuses = statusRegistry.definitions.map((definition) => definition.id);
    throw new PmCliError(
      `Invalid --filter-status value "${value}". Allowed: ${allowedStatuses.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized;
}

function rejectBlankIdsFilter(list: ListOptions | undefined): void {
  if (list?.ids != null && String(list.ids).trim().length === 0) {
    throw new PmCliError("--ids requires at least one non-empty item ID", EXIT_CODE.USAGE);
  }
}

// GH-256: validate planned scalar enum/format fields up front so a `--dry-run`
// preview rejects globally-invalid values exactly as apply would (true
// preview==apply parity), and so apply itself fails fast before creating an
// orphan checkpoint. Only VALUE/ENUM/FORMAT correctness is checked here — these
// are invalid regardless of the matched item. Per-item governance and
// workflow-transition rules stay in the apply path (runUpdate). Each field is
// validated only when the caller actually provided it, reusing the exact same
// resolvers and error messages runUpdate raises so single/bulk/dry-run stay
// consistent.
function assertPlannedUpdateValuesValid(
  update: UpdateCommandOptions,
  settings: PmSettings,
  statusRegistry: RuntimeStatusRegistry,
  pmRoot: string,
): void {
  if (update.priority !== undefined) {
    resolvePriority(update.priority);
  }
  if (update.type !== undefined) {
    const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
    if (!resolveTypeName(update.type, typeRegistry)) {
      throw new PmCliError(
        buildInvalidTypeError(update.type, typeRegistry.types, resolveItemTypesFilePath(pmRoot, settings.schema)),
        EXIT_CODE.USAGE,
      );
    }
  }
  if (update.status !== undefined && !normalizeStatusInput(update.status, statusRegistry)) {
    const allowedStatuses = statusRegistry.definitions.map((definition) => definition.id);
    throw new PmCliError(
      `Invalid --status value "${update.status}". Allowed: ${allowedStatuses.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  if (update.deadline !== undefined) {
    resolveIsoOrRelative(update.deadline, new Date(), "deadline");
  }
}

async function runUpdateManyRollback(params: {
  pmRoot: string;
  rollbackId: string;
  options: UpdateManyCommandOptions;
  global: GlobalOptions;
}): Promise<UpdateManyResult> {
  const checkpoint = await loadMutationCheckpoint(
    params.pmRoot,
    UPDATE_MANY_CHECKPOINT_SUBDIR,
    params.rollbackId,
    UPDATE_MANY_CHECKPOINT_SCHEMA_VERSION,
  );
  const restoreMessage = params.options.update?.message ?? `Rollback update-many checkpoint ${checkpoint.id}`;
  const rollback = await restoreCheckpointItems(checkpoint.items, (id, targetUpdatedAt) =>
    runRestore(
      id,
      targetUpdatedAt,
      {
        author: params.options.update?.author,
        message: restoreMessage,
        force: params.options.update?.force ?? true,
      },
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
      rollback_command: `pm update-many --rollback ${checkpoint.id}`,
    },
    restored_count: rollback.restored_ids.length,
    failed_count: rollback.failed_count,
    rows: rollback.rows,
    ids: rollback.restored_ids,
  };
}

async function writeUpdateManyCheckpoint(params: {
  pmRoot: string;
  checkpointId: string;
  nowValue: string;
  options: UpdateManyCommandOptions;
  statusFilter: string | undefined;
  filters: Record<string, unknown>;
  updateSummary: Record<string, unknown>;
  checkpointItems: MutationCheckpointItem[];
}): Promise<UpdateManyResult["checkpoint"]> {
  const checkpointPayload: UpdateManyCheckpoint = {
    schema_version: UPDATE_MANY_CHECKPOINT_SCHEMA_VERSION,
    id: params.checkpointId,
    created_at: params.nowValue,
    author: resolveAuthor(params.options.update.author, "unknown"),
    status_filter: params.statusFilter ?? null,
    list_filters: params.filters,
    update_options: params.updateSummary,
    items: params.checkpointItems,
  };
  const checkpointPath = await writeMutationCheckpoint(
    params.pmRoot,
    UPDATE_MANY_CHECKPOINT_SUBDIR,
    params.checkpointId,
    checkpointPayload,
  );
  return {
    id: params.checkpointId,
    created_at: params.nowValue,
    path: checkpointPath,
    rollback_command: `pm update-many --rollback ${params.checkpointId}`,
  };
}


/**
 * Implements run update many for the public runtime surface of this module.
 */
export async function runUpdateMany(options: UpdateManyCommandOptions, global: GlobalOptions): Promise<UpdateManyResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const runtimeFieldRegistry = resolveRuntimeFieldRegistry(settings.schema);

  const dryRun = options.dryRun === true;
  const rollbackId = typeof options.rollback === "string" ? options.rollback : undefined;
  const updateSummary = sanitizeUpdateOptionsForSummary(options.update);
  rejectBlankIdsFilter(options.list);

  if (rollbackId) {
    if (dryRun) {
      throw new PmCliError("--dry-run cannot be combined with --rollback", EXIT_CODE.USAGE);
    }
    if (hasListFilters(options.list, options.status)) {
      throw new PmCliError("Rollback mode does not accept filter options", EXIT_CODE.USAGE);
    }
    if (Object.keys(updateSummary).length > 0) {
      throw new PmCliError("Rollback mode does not accept update mutation flags", EXIT_CODE.USAGE);
    }
    return runUpdateManyRollback({ pmRoot, rollbackId, options, global });
  }

  if (!hasAnyUpdateMutationInput(options.update)) {
    throw new PmCliError(
      `No update-many mutation flags provided. Add at least one mutation flag (for example: ${UPDATE_MANY_MUTATION_FLAG_GUIDANCE}).`,
      EXIT_CODE.USAGE,
    );
  }

  // GH-256: validate planned scalar values before listing/checkpointing so
  // dry-run previews and apply both reject globally-invalid enum/format input.
  assertPlannedUpdateValuesValid(options.update, settings, statusRegistry, pmRoot);

  const statusFilter = normalizeStatusFilter(options.status, statusRegistry);
  const listed = await runList(statusFilter, { ...options.list, includeBody: true }, global);
  const planned = listed.items.map((item) => buildPlannedItemDiff(item, options.update, runtimeFieldRegistry));
  const actionable = planned.filter((row) => row.changes.length > 0);
  if (dryRun) {
    return {
      mode: "dry_run",
      matched_count: listed.items.length,
      dry_run: true,
      filters: listed.filters,
      planned_update_options: updateSummary,
      item_plans: planned,
      ids: [],
    };
  }

  if (actionable.length === 0) {
    return {
      mode: "apply",
      matched_count: listed.items.length,
      dry_run: false,
      filters: listed.filters,
      planned_update_options: updateSummary,
      updated_count: 0,
      skipped_count: listed.items.length,
      failed_count: 0,
      rows: planned.map((row) => ({
        id: row.id,
        status: "skipped" as const,
      })),
      ids: [],
    };
  }

  const nowValue = nowIso();
  const checkpointId = createCheckpointId(UPDATE_MANY_CHECKPOINT_SUBDIR, nowValue);
  const checkpointEnabled = options.checkpoint !== false;
  const checkpointItems: MutationCheckpointItem[] = listed.items
    .filter((item) => actionable.some((candidate) => candidate.id === item.id))
    .map((item) => ({
      id: item.id,
      target_updated_at: item.updated_at,
    }));

  let checkpointInfo: UpdateManyResult["checkpoint"] | undefined;
  if (checkpointEnabled) {
    checkpointInfo = await writeUpdateManyCheckpoint({
      pmRoot,
      checkpointId,
      nowValue,
      options,
      statusFilter,
      filters: listed.filters,
      updateSummary,
      checkpointItems,
    });
  }

  const applyRows: UpdateManyApplyResultRow[] = [];
  const updatedIds: string[] = [];
  const updateMessage = options.update.message ?? `update-many apply ${checkpointId}`;
  const actionableById = new Set(actionable.map((row) => row.id));
  for (const item of listed.items) {
    if (!actionableById.has(item.id)) {
      applyRows.push({ id: item.id, status: "skipped" });
      continue;
    }
    try {
      const result = await runUpdate(
        item.id,
        {
          ...options.update,
          message: updateMessage,
          runtimeFieldCommands: ["update_many"],
        },
        global,
      );
      applyRows.push({
        id: item.id,
        status: "updated",
        changed_fields: result.changed_fields,
        warnings: result.warnings,
      });
      updatedIds.push(item.id);
    } catch (error: unknown) {
      applyRows.push({
        id: item.id,
        status: "failed",
        error: toErrorMessage(error),
      });
    }
  }

  const updatedCount = applyRows.filter((row) => row.status === "updated").length;
  const skippedCount = applyRows.filter((row) => row.status === "skipped").length;
  const failedCount = applyRows.filter((row) => row.status === "failed").length;

  return {
    mode: "apply",
    matched_count: listed.items.length,
    dry_run: false,
    filters: listed.filters,
    planned_update_options: updateSummary,
    ...(checkpointInfo ? { checkpoint: checkpointInfo } : {}),
    updated_count: updatedCount,
    skipped_count: skippedCount,
    failed_count: failedCount,
    rows: applyRows,
    ids: updatedIds,
  };
}

export const _testOnlyUpdateManyCommand = {
  assertPlannedUpdateValuesValid,
  buildCollectionMutationPlans,
  buildPlannedItemDiff,
  buildTagMutationPlan,
  collectionValueCount,
  hasAnyUpdateMutationInput,
  hasListFilters,
  normalizeStatusFilter,
  normalizeCollectionBeforeValue,
  normalizeExistingTags,
  normalizeUnsetField,
  rejectBlankIdsFilter,
  sanitizeUpdateOptionsForSummary,
  toComparablePreviewValue,
};
