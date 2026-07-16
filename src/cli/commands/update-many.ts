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
import {
  applyTagRemovals,
  mergeAdditiveTags,
  parseOptionalNonNegativeInteger,
  parseTags,
} from "../../core/item/parse.js";
import { resolvePriority } from "../../core/item/priority.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import {
  resolveItemTypeRegistry,
  resolveTypeName,
} from "../../core/item/type-registry.js";
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
import type { ItemStatus, PmSettings } from "../../types/index.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { resolveAuthor } from "../../core/shared/author.js";
import { hasListFilters } from "./list-filter-shared.js";
import {
  runList,
  type ListFullResult,
  type ListOptions,
  type ListedItem,
} from "./list.js";
import { runRestore } from "./restore.js";
import { runUpdate, type UpdateCommandOptions } from "./update.js";

const UPDATE_MANY_CHECKPOINT_SCHEMA_VERSION = 1;
const UPDATE_MANY_CHECKPOINT_SUBDIR = "update-many";

const NON_MUTATION_UPDATE_OPTION_KEYS = new Set<PropertyKey>([
  "author",
  "message",
  "force",
  "ownershipMetadataBypass",
  "ownershipDependencyBypass",
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

const UPDATE_OPTION_TO_ITEM_KEY: Partial<
  Record<keyof UpdateCommandOptions, string>
> = {
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

const COLLECTION_MUTATION_PLAN_DEFINITIONS: CollectionMutationPlanDefinition[] =
  [
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

/** Documents the update many command options payload exchanged by command, SDK, and package integrations. */
export interface UpdateManyCommandOptions {
  /** Lifecycle state reported for status. */
  status?: string;
  /** Value that configures or reports list for this contract. */
  list: ListOptions;
  /** Value that configures or reports update for this contract. */
  update: UpdateCommandOptions;
  /** Value that configures or reports dry run for this contract. */
  dryRun?: boolean;
  /** Value that configures or reports rollback for this contract. */
  rollback?: string;
  /** Value that configures or reports checkpoint for this contract. */
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

/** Documents the update many result payload exchanged by command, SDK, and package integrations. */
export interface UpdateManyResult {
  /** Value that configures or reports mode for this contract. */
  mode: "dry_run" | "apply" | "rollback";
  /** Number of matched entries represented by this result. */
  matched_count: number;
  /** Value that configures or reports dry run for this contract. */
  dry_run: boolean;
  /** Value that configures or reports filters for this contract. */
  filters?: Record<string, unknown>;
  /** Inputs that customize the planned update operation. */
  planned_update_options?: Record<string, unknown>;
  /** Value that configures or reports item plans for this contract. */
  item_plans?: PlannedItemDiff[];
  /** Value that configures or reports checkpoint for this contract. */
  checkpoint?: {
    id: string;
    created_at: string;
    path: string;
    rollback_command: string;
  };
  /** Number of updated entries represented by this result. */
  updated_count?: number;
  /** Number of skipped entries represented by this result. */
  skipped_count?: number;
  /** Number of failed entries represented by this result. */
  failed_count?: number;
  /** Number of restored entries represented by this result. */
  restored_count?: number;
  /** Value that configures or reports rollback checkpoint id for this contract. */
  rollback_checkpoint_id?: string;
  /** Value that configures or reports rows for this contract. */
  rows?: UpdateManyApplyResultRow[] | UpdateManyRollbackResultRow[];
  /** Value that configures or reports ids for this contract. */
  ids: string[];
}

/** Removes execution-only options from the mutation summary persisted in checkpoints. */
const sanitizeUpdateOptionsForSummary = (
  options: UpdateCommandOptions,
): Record<string, unknown> => {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options) as Array<
    [keyof UpdateCommandOptions, unknown]
  >) {
    if (NON_MUTATION_UPDATE_OPTION_KEYS.has(key)) {
      continue;
    }
    if (value === undefined) {
      continue;
    }
    summary[key] = value;
  }
  return summary;
};

/** Reports whether an update-many request contains at least one mutation input. */
const hasAnyUpdateMutationInput = (options: UpdateCommandOptions): boolean => {
  return Object.keys(sanitizeUpdateOptionsForSummary(options)).length > 0;
};

type PreviewValueNormalizer = (value: unknown) => unknown;

const trimPreviewValue: PreviewValueNormalizer = (value) =>
  typeof value === "string" ? value.trim() : value;
const normalizeIntegerPreviewValue: PreviewValueNormalizer = (value) => {
  const trimmed = String(value).trim();
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : trimmed;
};
const normalizeNumericPreviewValue: PreviewValueNormalizer = (value) => {
  const trimmed = String(value).trim();
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : trimmed;
};
const normalizeRegressionPreviewValue: PreviewValueNormalizer = (value) => {
  const normalized = String(value).trim().toLowerCase();
  const parsed = new Map<string, boolean>([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ]).get(normalized);
  return parsed ?? trimPreviewValue(value);
};

const PREVIEW_VALUE_NORMALIZERS: Partial<
  Record<keyof UpdateCommandOptions, PreviewValueNormalizer>
> = {
  priority: normalizeIntegerPreviewValue,
  estimatedMinutes: normalizeNumericPreviewValue,
  order: normalizeNumericPreviewValue,
  rank: normalizeNumericPreviewValue,
  regression: normalizeRegressionPreviewValue,
};

/** Normalizes a CLI mutation value to the storage-shaped value used by previews. */
const toComparablePreviewValue = (
  optionKey: keyof UpdateCommandOptions,
  value: unknown,
): unknown => {
  if (value === undefined) {
    return undefined;
  }
  return (PREVIEW_VALUE_NORMALIZERS[optionKey] ?? trimPreviewValue)(value);
};

/** Resolves user-facing unset aliases to stored metadata keys. */
const normalizeUnsetField = (rawField: string): string => {
  const normalized = rawField.trim().toLowerCase().replaceAll("-", "_");
  return UNSET_FIELD_ALIASES[normalized] ?? normalized;
};

/** Compares preview values using the canonical stable serialization contract. */
const areValuesEqual = (left: unknown, right: unknown): boolean => {
  return stableValueEquals(left, right);
};

/** Supplies the storage-shaped empty value for an absent collection field. */
const normalizeCollectionBeforeValue = (
  field: string,
  value: unknown,
): unknown => {
  if (value !== undefined) {
    return value;
  }
  if (field === "type_options") {
    return {};
  }
  return [];
};

/** Counts entries in list and type-option collection values. */
const collectionValueCount = (field: string, value: unknown): number => {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (field === "type_options" && value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length;
  }
  return 0;
};

/** Resolves the dominant collection mutation using apply-path precedence. */
const resolveCollectionMutationOperation = (params: {
  replace: boolean;
  clear: boolean;
  removeCount: number;
}): string => {
  if (params.replace) {
    return "replace";
  }
  if (params.clear) {
    return "clear_or_reset";
  }
  return params.removeCount > 0 ? "merge_remove" : "append";
};

/** Reads an optional definition key without indexing through undefined. */
const readOptionalUpdateValue = (
  update: UpdateCommandOptions,
  key: keyof UpdateCommandOptions | undefined,
): unknown => (key === undefined ? undefined : update[key]);

/** Counts array-shaped mutation inputs while treating other shapes as empty. */
const updateArrayValueCount = (value: unknown): number =>
  Array.isArray(value) ? value.length : 0;

/** Builds one collection plan when its definition has an active mutation. */
const buildCollectionMutationPlan = (
  definition: CollectionMutationPlanDefinition,
  row: Record<string, unknown>,
  update: UpdateCommandOptions,
): PlannedChange | undefined => {
  const addValues = update[definition.addKey];
  const removeValues = readOptionalUpdateValue(update, definition.removeKey);
  const addCount = updateArrayValueCount(addValues);
  const removeCount = updateArrayValueCount(removeValues);
  const clear = update[definition.clearKey] === true;
  const replace =
    readOptionalUpdateValue(update, definition.replaceKey) === true;
  if (![clear, replace, addCount > 0, removeCount > 0].includes(true)) {
    return undefined;
  }
  const before = normalizeCollectionBeforeValue(
    definition.field,
    row[definition.field],
  );
  return {
    field: definition.field,
    before,
    after: {
      operation: resolveCollectionMutationOperation({
        replace,
        clear,
        removeCount,
      }),
      clear,
      replace,
      add_count: addCount,
      remove_count: removeCount,
      before_count: collectionValueCount(definition.field, before),
    },
  };
};

/** Builds collection mutation previews for every active collection option. */
const buildCollectionMutationPlans = (
  row: Record<string, unknown>,
  update: UpdateCommandOptions,
): PlannedChange[] => {
  const changes: PlannedChange[] = [];
  for (const definition of COLLECTION_MUTATION_PLAN_DEFINITIONS) {
    const plan = buildCollectionMutationPlan(definition, row, update);
    if (plan !== undefined) {
      changes.push(plan);
    }
  }
  return changes;
};

/** Keeps only string tags from an existing storage value. */
const normalizeExistingTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((tag): tag is string => typeof tag === "string");
};

// Tags support three mutation modes that compose: --tags replaces, --add-tags
// extends, --remove-tags prunes. Replicate runUpdate's resolution order so the
// dry-run preview and the apply-mode actionable detection both account for
// additive/subtractive tag mutations (a --add-tags-only update must NOT be
// treated as a no-op skip).
const buildTagMutationPlan = (
  row: Record<string, unknown>,
  update: UpdateCommandOptions,
): PlannedChange | undefined => {
  if (
    ![
      update.tags !== undefined,
      updateArrayValueCount(update.addTags) > 0,
      updateArrayValueCount(update.removeTags) > 0,
    ].includes(true)
  ) {
    return undefined;
  }
  const existing = normalizeExistingTags(row.tags);
  const baseTags =
    update.tags === undefined ? existing : parseTags(update.tags);
  const withAdditions = mergeAdditiveTags(baseTags, update.addTags);
  const after = applyTagRemovals(withAdditions, update.removeTags)
    .slice()
    .sort((a, b) => a.localeCompare(b));
  const before = existing.slice().sort((a, b) => a.localeCompare(b));
  if (areValuesEqual(before, after)) {
    return undefined;
  }
  return { field: "tags", before: existing, after };
};

/** Adds changed scalar options to a planned item diff. */
const appendScalarMutationPlans = (
  changes: PlannedChange[],
  row: Record<string, unknown>,
  update: UpdateCommandOptions,
): void => {
  for (const [optionKey, itemKey] of Object.entries(
    UPDATE_OPTION_TO_ITEM_KEY,
  ) as Array<[keyof UpdateCommandOptions, string]>) {
    const candidate = update[optionKey];
    if (candidate === undefined) {
      continue;
    }
    const before = row[itemKey];
    const after = toComparablePreviewValue(optionKey, candidate);
    if (!areValuesEqual(before, after)) {
      changes.push({ field: itemKey, before, after });
    }
  }
};

/** Adds changed runtime-schema fields to a planned item diff. */
const appendRuntimeFieldMutationPlans = (
  changes: PlannedChange[],
  row: Record<string, unknown>,
  update: UpdateCommandOptions,
  runtimeFieldRegistry: RuntimeFieldRegistry,
): void => {
  const runtimeFieldUpdates = collectRuntimeUpdateFieldValues(
    update as Record<string, unknown>,
    runtimeFieldRegistry,
    ["update_many"],
  );
  for (const [field, after] of Object.entries(runtimeFieldUpdates)) {
    const before = row[field];
    if (!areValuesEqual(before, after)) {
      changes.push({ field, before, after });
    }
  }
};

/** Adds present fields requested through unset options to a planned item diff. */
const appendUnsetMutationPlans = (
  changes: PlannedChange[],
  row: Record<string, unknown>,
  unset: string[] | undefined,
): void => {
  for (const rawUnsetField of unset ?? []) {
    const field = normalizeUnsetField(rawUnsetField);
    const before = row[field];
    if (before !== undefined) {
      changes.push({ field, before, after: null });
    }
  }
};

/** Builds the complete storage-shaped mutation preview for one item. */
const buildPlannedItemDiff = (
  item: ListedItem,
  update: UpdateCommandOptions = {},
  runtimeFieldRegistry: RuntimeFieldRegistry,
): PlannedItemDiff => {
  const row = toItemRecord(item);
  const changes: PlannedChange[] = [];
  const tagPlan = buildTagMutationPlan(row, update);
  if (tagPlan) {
    changes.push(tagPlan);
  }
  appendScalarMutationPlans(changes, row, update);
  changes.push(...buildCollectionMutationPlans(row, update));
  appendRuntimeFieldMutationPlans(changes, row, update, runtimeFieldRegistry);
  appendUnsetMutationPlans(changes, row, update.unset);

  return {
    id: item.id,
    changes,
  };
};

/** Normalizes an optional list status against the runtime schema. */
const normalizeStatusFilter = (
  value: string | undefined,
  statusRegistry: RuntimeStatusRegistry,
): ItemStatus | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeStatusInput(value, statusRegistry);
  if (!normalized) {
    const allowedStatuses = statusRegistry.definitions.map(
      (definition) => definition.id,
    );
    throw new PmCliError(
      `Invalid --filter-status value "${value}". Allowed: ${allowedStatuses.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized;
};

/** Rejects an explicitly blank bulk ID filter before loading the corpus. */
const rejectBlankIdsFilter = (list: ListOptions | undefined): void => {
  if (list?.ids != null && String(list.ids).trim().length === 0) {
    throw new PmCliError(
      "--ids requires at least one non-empty item ID",
      EXIT_CODE.USAGE,
    );
  }
};

// GH-256: validate planned scalar enum/format fields up front so a `--dry-run`
// preview rejects globally-invalid values exactly as apply would (true
// preview==apply parity), and so apply itself fails fast before creating an
// orphan checkpoint. Only VALUE/ENUM/FORMAT correctness is checked here — these
// are invalid regardless of the matched item. Per-item governance and
// workflow-transition rules stay in the apply path (runUpdate). Each field is
// validated only when the caller actually provided it, reusing the exact same
// resolvers and error messages runUpdate raises so single/bulk/dry-run stay
// consistent.
interface PlannedUpdateValidationContext {
  update: UpdateCommandOptions;
  settings: PmSettings;
  statusRegistry: RuntimeStatusRegistry;
  pmRoot: string;
}

type PlannedUpdateValidator = (context: PlannedUpdateValidationContext) => void;

const PLANNED_UPDATE_VALIDATORS: PlannedUpdateValidator[] = [
  ({ update }) => {
    if (update.priority !== undefined) {
      resolvePriority(update.priority);
    }
  },
  ({ update, settings, pmRoot }) => {
    if (update.type === undefined) {
      return;
    }
    const typeRegistry = resolveItemTypeRegistry(
      settings,
      getActiveExtensionRegistrations(),
    );
    if (!resolveTypeName(update.type, typeRegistry)) {
      throw new PmCliError(
        buildInvalidTypeError(
          update.type,
          typeRegistry.types,
          resolveItemTypesFilePath(pmRoot, settings.schema),
        ),
        EXIT_CODE.USAGE,
      );
    }
  },
  ({ update, statusRegistry }) => {
    if (
      update.status !== undefined &&
      !normalizeStatusInput(update.status, statusRegistry)
    ) {
      const allowedStatuses = statusRegistry.definitions.map(
        (definition) => definition.id,
      );
      throw new PmCliError(
        `Invalid --status value "${update.status}". Allowed: ${allowedStatuses.join(", ")}`,
        EXIT_CODE.USAGE,
      );
    }
  },
  ({ update }) => {
    if (update.deadline !== undefined) {
      resolveIsoOrRelative(update.deadline, new Date(), "deadline");
    }
  },
  ({ update }) => {
    if (update.estimatedMinutes !== undefined) {
      parseOptionalNonNegativeInteger(
        update.estimatedMinutes,
        "estimated-minutes",
      );
    }
  },
];

/** Validates globally invalid mutation values before preview or checkpoint work. */
const assertPlannedUpdateValuesValid = (
  update: UpdateCommandOptions,
  settings: PmSettings,
  statusRegistry: RuntimeStatusRegistry,
  pmRoot: string,
): void => {
  const context = { update, settings, statusRegistry, pmRoot };
  for (const validate of PLANNED_UPDATE_VALIDATORS) {
    validate(context);
  }
};

/** Restores every item captured by an update-many checkpoint. */
const runUpdateManyRollback = async (params: {
  pmRoot: string;
  rollbackId: string;
  options: UpdateManyCommandOptions;
  global: GlobalOptions;
}): Promise<UpdateManyResult> => {
  const checkpoint = await loadMutationCheckpoint(
    params.pmRoot,
    UPDATE_MANY_CHECKPOINT_SUBDIR,
    params.rollbackId,
    UPDATE_MANY_CHECKPOINT_SCHEMA_VERSION,
  );
  const restoreMessage =
    params.options.update?.message ??
    `Rollback update-many checkpoint ${checkpoint.id}`;
  const rollback = await restoreCheckpointItems(
    checkpoint.items,
    (id, targetUpdatedAt) =>
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
};

/** Persists an apply checkpoint and returns its user-facing descriptor. */
const writeUpdateManyCheckpoint = async (params: {
  pmRoot: string;
  checkpointId: string;
  nowValue: string;
  options: UpdateManyCommandOptions;
  statusFilter: string | undefined;
  filters: Record<string, unknown>;
  updateSummary: Record<string, unknown>;
  checkpointItems: MutationCheckpointItem[];
}): Promise<UpdateManyResult["checkpoint"]> => {
  const checkpointPayload: UpdateManyCheckpoint = {
    schema_version: UPDATE_MANY_CHECKPOINT_SCHEMA_VERSION,
    id: params.checkpointId,
    created_at: params.nowValue,
    author: resolveAuthor(params.options.update?.author, "unknown"),
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
};

interface UpdateManyRuntimeContext {
  pmRoot: string;
  settings: PmSettings;
  statusRegistry: RuntimeStatusRegistry;
  runtimeFieldRegistry: RuntimeFieldRegistry;
}

interface UpdateManyPlan {
  listed: ListFullResult;
  planned: PlannedItemDiff[];
  actionable: PlannedItemDiff[];
  updateSummary: Record<string, unknown>;
  statusFilter: ItemStatus | undefined;
}

/** Loads tracker settings and runtime registries for update-many execution. */
const loadUpdateManyRuntimeContext = async (
  global: GlobalOptions,
): Promise<UpdateManyRuntimeContext> => {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const settings = await readSettings(pmRoot);
  return {
    pmRoot,
    settings,
    statusRegistry: resolveRuntimeStatusRegistry(settings.schema),
    runtimeFieldRegistry: resolveRuntimeFieldRegistry(settings.schema),
  };
};

/** Validates rollback exclusivity before restoring a checkpoint. */
const runRequestedUpdateManyRollback = async (params: {
  runtime: UpdateManyRuntimeContext;
  rollbackId: string;
  options: UpdateManyCommandOptions;
  global: GlobalOptions;
  updateSummary: Record<string, unknown>;
}): Promise<UpdateManyResult> => {
  if (params.options.dryRun === true) {
    throw new PmCliError(
      "--dry-run cannot be combined with --rollback",
      EXIT_CODE.USAGE,
    );
  }
  if (hasListFilters(params.options.list, params.options.status)) {
    throw new PmCliError(
      "Rollback mode does not accept filter options",
      EXIT_CODE.USAGE,
    );
  }
  if (Object.keys(params.updateSummary).length > 0) {
    throw new PmCliError(
      "Rollback mode does not accept update mutation flags",
      EXIT_CODE.USAGE,
    );
  }
  return runUpdateManyRollback({
    pmRoot: params.runtime.pmRoot,
    rollbackId: params.rollbackId,
    options: params.options,
    global: params.global,
  });
};

/** Loads complete matching rows and derives their mutation previews. */
const buildUpdateManyPlan = async (params: {
  options: UpdateManyCommandOptions;
  global: GlobalOptions;
  runtime: UpdateManyRuntimeContext;
  updateSummary: Record<string, unknown>;
}): Promise<UpdateManyPlan> => {
  const statusFilter = normalizeStatusFilter(
    params.options.status,
    params.runtime.statusRegistry,
  );
  const listed = await runList(
    statusFilter,
    {
      ...params.options.list,
      compact: undefined,
      brief: undefined,
      fields: undefined,
      includeBody: true,
      full: true,
    },
    params.global,
  );
  const planned = listed.items.map((item) =>
    buildPlannedItemDiff(
      item,
      params.options.update,
      params.runtime.runtimeFieldRegistry,
    ),
  );
  return {
    listed,
    planned,
    actionable: planned.filter((row) => row.changes.length > 0),
    updateSummary: params.updateSummary,
    statusFilter,
  };
};

/** Builds the non-mutating preview response for a prepared update-many plan. */
const buildUpdateManyDryRunResult = (
  plan: UpdateManyPlan,
): UpdateManyResult => ({
  mode: "dry_run",
  matched_count: plan.listed.items.length,
  dry_run: true,
  filters: plan.listed.filters,
  planned_update_options: plan.updateSummary,
  item_plans: plan.planned,
  ids: [],
});

/** Builds the apply response for a plan whose rows are all already current. */
const buildUpdateManyNoopResult = (plan: UpdateManyPlan): UpdateManyResult => ({
  mode: "apply",
  matched_count: plan.listed.items.length,
  dry_run: false,
  filters: plan.listed.filters,
  planned_update_options: plan.updateSummary,
  updated_count: 0,
  skipped_count: plan.listed.items.length,
  failed_count: 0,
  rows: plan.planned.map((row) => ({
    id: row.id,
    status: "skipped" as const,
  })),
  ids: [],
});

/** Applies planned item updates independently while preserving per-row failures. */
const applyUpdateManyRows = async (params: {
  items: ListedItem[];
  actionable: PlannedItemDiff[];
  options: UpdateManyCommandOptions;
  global: GlobalOptions;
  checkpointId: string;
}): Promise<{ rows: UpdateManyApplyResultRow[]; updatedIds: string[] }> => {
  const rows: UpdateManyApplyResultRow[] = [];
  const updatedIds: string[] = [];
  const updateMessage =
    params.options.update.message ?? `update-many apply ${params.checkpointId}`;
  const actionableById = new Set(params.actionable.map((row) => row.id));
  for (const item of params.items) {
    if (!actionableById.has(item.id)) {
      rows.push({ id: item.id, status: "skipped" });
      continue;
    }
    try {
      const result = await runUpdate(
        item.id,
        {
          ...params.options.update,
          message: updateMessage,
          runtimeFieldCommands: ["update_many"],
        },
        params.global,
      );
      rows.push({
        id: item.id,
        status: "updated",
        changed_fields: result.changed_fields,
        warnings: result.warnings,
      });
      updatedIds.push(item.id);
    } catch (error: unknown) {
      rows.push({
        id: item.id,
        status: "failed",
        error: toErrorMessage(error),
      });
    }
  }
  return { rows, updatedIds };
};

/** Applies a prepared plan, checkpointing actionable rows when requested. */
const applyUpdateManyPlan = async (params: {
  runtime: UpdateManyRuntimeContext;
  options: UpdateManyCommandOptions;
  global: GlobalOptions;
  plan: UpdateManyPlan;
}): Promise<UpdateManyResult> => {
  if (params.plan.actionable.length === 0) {
    return buildUpdateManyNoopResult(params.plan);
  }
  const nowValue = nowIso();
  const checkpointId = createCheckpointId(
    UPDATE_MANY_CHECKPOINT_SUBDIR,
    nowValue,
  );
  const actionableById = new Set(params.plan.actionable.map((row) => row.id));
  const checkpointItems = params.plan.listed.items
    .filter((item) => actionableById.has(item.id))
    .map((item) => ({ id: item.id, target_updated_at: item.updated_at }));
  const checkpointInfo =
    params.options.checkpoint === false
      ? undefined
      : await writeUpdateManyCheckpoint({
          pmRoot: params.runtime.pmRoot,
          checkpointId,
          nowValue,
          options: params.options,
          statusFilter: params.plan.statusFilter,
          filters: params.plan.listed.filters,
          updateSummary: params.plan.updateSummary,
          checkpointItems,
        });
  const applied = await applyUpdateManyRows({
    items: params.plan.listed.items,
    actionable: params.plan.actionable,
    options: params.options,
    global: params.global,
    checkpointId,
  });
  const countStatus = (status: UpdateManyApplyResultRow["status"]): number =>
    applied.rows.filter((row) => row.status === status).length;
  return {
    mode: "apply",
    matched_count: params.plan.listed.items.length,
    dry_run: false,
    filters: params.plan.listed.filters,
    planned_update_options: params.plan.updateSummary,
    ...(checkpointInfo ? { checkpoint: checkpointInfo } : {}),
    updated_count: countStatus("updated"),
    skipped_count: countStatus("skipped"),
    failed_count: countStatus("failed"),
    rows: applied.rows,
    ids: applied.updatedIds,
  };
};

/** Implements run update many for the public runtime surface of this module. */
export const runUpdateMany = async (
  options: UpdateManyCommandOptions,
  global: GlobalOptions,
): Promise<UpdateManyResult> => {
  const runtime = await loadUpdateManyRuntimeContext(global);
  const rollbackId =
    typeof options.rollback === "string" ? options.rollback : undefined;
  const updateSummary = sanitizeUpdateOptionsForSummary(options.update);
  rejectBlankIdsFilter(options.list);
  if (rollbackId !== undefined) {
    return runRequestedUpdateManyRollback({
      runtime,
      rollbackId,
      options,
      global,
      updateSummary,
    });
  }
  if (!hasAnyUpdateMutationInput(options.update)) {
    throw new PmCliError(
      `No update-many mutation flags provided. Add at least one mutation flag (for example: ${UPDATE_MANY_MUTATION_FLAG_GUIDANCE}).`,
      EXIT_CODE.USAGE,
    );
  }
  assertPlannedUpdateValuesValid(
    options.update,
    runtime.settings,
    runtime.statusRegistry,
    runtime.pmRoot,
  );
  const plan = await buildUpdateManyPlan({
    options,
    global,
    runtime,
    updateSummary,
  });
  return options.dryRun === true
    ? buildUpdateManyDryRunResult(plan)
    : applyUpdateManyPlan({ runtime, options, global, plan });
};

/** Public contract for test only update many command, shared by SDK and presentation-layer consumers. */
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
