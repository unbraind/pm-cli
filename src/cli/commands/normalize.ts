/**
 * @module cli/commands/normalize
 *
 * Implements the pm normalize command surface and its agent-facing runtime behavior.
 */
import { pathExists } from "../../core/fs/fs-utils.js";
import { toItemRecord } from "../../core/item/item-record.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import {
  resolveRuntimeStatusRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import {
  DEFAULT_VALIDATE_CLOSURE_LIKE_METADATA_FIELD_PATTERNS,
  EXIT_CODE,
} from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  toErrorMessage,
  toNonEmptyStringOrUndefined,
} from "../../core/shared/primitives.js";
import { nowIso } from "../../core/shared/time.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemStatus } from "../../types/index.js";
import { runList, type ListedItem, type ListOptions } from "./list.js";
import { runUpdate, type UpdateCommandOptions } from "./update.js";

interface LifecyclePatternSettingsSource {
  validation: {
    lifecycle_closure_like_blocked_reason_patterns: string[];
    lifecycle_closure_like_resolution_patterns: string[];
    lifecycle_closure_like_actual_result_patterns: string[];
  };
}

type LifecyclePatternFieldKey =
  | "blocked_reason"
  | "resolution"
  | "actual_result";

interface LifecyclePatternPolicy {
  closure_like_metadata_field_patterns: Record<
    LifecyclePatternFieldKey,
    string[]
  >;
}

interface NormalizeRuleCount {
  rule: string;
  count: number;
}

interface NormalizePlannedChange {
  field: string;
  before: unknown;
  after: unknown;
  rule: string;
}

interface NormalizeItemPlan {
  id: string;
  changes: NormalizePlannedChange[];
}

interface NormalizeInternalItemPlan extends NormalizeItemPlan {
  update: UpdateCommandOptions;
}

interface NormalizeApplyResultRow {
  id: string;
  status: "updated" | "failed" | "skipped";
  changed_fields?: string[];
  warnings?: string[];
  error?: string;
}

/** Documents the normalize command options payload exchanged by command, SDK, and package integrations. */
export interface NormalizeCommandOptions {
  /** Lifecycle state reported for status. */
  status?: string;
  /** Value that configures or reports list for this contract. */
  list: ListOptions;
  /** Value that configures or reports dry run for this contract. */
  dryRun?: boolean;
  /** Value that configures or reports apply for this contract. */
  apply?: boolean;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
  /** Value that configures or reports allow audit update for this contract. */
  allowAuditUpdate?: boolean;
}

/** Documents the normalize result payload exchanged by command, SDK, and package integrations. */
export interface NormalizeResult {
  /** Value that configures or reports mode for this contract. */
  mode: "dry_run" | "apply";
  /** Value that configures or reports dry run for this contract. */
  dry_run: boolean;
  /** Number of matched entries represented by this result. */
  matched_count: number;
  /** Value that configures or reports filters for this contract. */
  filters: Record<string, unknown>;
  /** Value that configures or reports rules for this contract. */
  rules: string[];
  /** Value that configures or reports rule counts for this contract. */
  rule_counts: NormalizeRuleCount[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Value that configures or reports item plans for this contract. */
  item_plans: NormalizeItemPlan[];
  /** Number of updated entries represented by this result. */
  updated_count?: number;
  /** Number of skipped entries represented by this result. */
  skipped_count?: number;
  /** Number of failed entries represented by this result. */
  failed_count?: number;
  /** Value that configures or reports rows for this contract. */
  rows?: NormalizeApplyResultRow[];
  /** Value that configures or reports ids for this contract. */
  ids: string[];
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

const LOW_SIGNAL_TEXT_TOKENS = new Set([
  "none",
  "null",
  "n/a",
  "na",
  "tbd",
  "todo",
  "unknown",
  "placeholder",
]);

const RULE_ACTIVE_CLOSURE_LIKE_METADATA = "active_closure_like_metadata";
const RULE_ACTIVE_CLOSE_REASON = "active_close_reason";
const RULE_CLOSED_RESOLUTION_BACKFILL = "closed_resolution_backfill";

const ACTIVE_CLEAR_FIELD_RULES: Array<{
  field: LifecyclePatternFieldKey;
  unsetField: string;
}> = [
  { field: "blocked_reason", unsetField: "blocked-reason" },
  { field: "resolution", unsetField: "resolution" },
  { field: "actual_result", unsetField: "actual-result" },
];

const CLOSED_BACKFILL_FIELD_RULES: Array<{
  field: "resolution" | "expected_result" | "actual_result";
  optionKey: "resolution" | "expectedResult" | "actualResult";
}> = [
  { field: "resolution", optionKey: "resolution" },
  { field: "expected_result", optionKey: "expectedResult" },
  { field: "actual_result", optionKey: "actualResult" },
];

function normalizeComparableText(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

function isLowSignalText(value: string | undefined): boolean {
  /* c8 ignore start -- undefined input is guarded by higher-level normalization callers. */
  if (!value) {
    return false;
  }
  /* c8 ignore stop */
  return LOW_SIGNAL_TEXT_TOKENS.has(normalizeComparableText(value));
}

function sanitizeBeforeValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  return value;
}

function normalizeLifecyclePatternList(
  values: readonly string[] | undefined,
): string[] {
  /* c8 ignore start -- settings schema always materializes lifecycle arrays before command execution. */
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));
  /* c8 ignore stop */
}

function resolveLifecyclePatternPolicy(
  settings: LifecyclePatternSettingsSource,
): LifecyclePatternPolicy {
  return {
    closure_like_metadata_field_patterns: {
      blocked_reason: normalizeLifecyclePatternList(
        settings.validation.lifecycle_closure_like_blocked_reason_patterns,
      ),
      resolution: normalizeLifecyclePatternList(
        settings.validation.lifecycle_closure_like_resolution_patterns,
      ),
      actual_result: normalizeLifecyclePatternList(
        settings.validation.lifecycle_closure_like_actual_result_patterns,
      ),
    },
  };
}

function toMeaningfulCloseReason(value: unknown): string | undefined {
  const normalized = toNonEmptyStringOrUndefined(value);
  if (!normalized || isLowSignalText(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeStatusFilter(
  value: string | undefined,
  statusRegistry: RuntimeStatusRegistry,
): ItemStatus | undefined {
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
}

function buildClosedBackfillValue(
  field: "resolution" | "expected_result" | "actual_result",
  closeReason: string | undefined,
): string {
  const closureEvidenceSuffix = closeReason
    ? "existing close_reason remains the detailed closure evidence."
    : "the field was missing or low-signal.";
  if (closeReason) {
    if (field === "resolution") {
      return `Resolution normalized from closed status; ${closureEvidenceSuffix}`;
    }
    if (field === "expected_result") {
      return `Expected closure outcome normalized from closed status; ${closureEvidenceSuffix}`;
    }
    return `Actual closure outcome normalized from closed status; ${closureEvidenceSuffix}`;
  }
  if (field === "resolution") {
    return `Resolution normalized from closed status because ${closureEvidenceSuffix}`;
  }
  if (field === "expected_result") {
    return `Expected closure outcome normalized from closed status because ${closureEvidenceSuffix}`;
  }
  return `Actual closure outcome normalized from closed status because ${closureEvidenceSuffix}`;
}

function isTerminalStatus(
  item: ListedItem,
  statusRegistry: RuntimeStatusRegistry,
): boolean {
  /* c8 ignore next -- normalizeStatusInput currently resolves all command-level status values. */
  const normalized =
    normalizeStatusInput(item.status, statusRegistry) ?? item.status;
  return statusRegistry.terminal_statuses.has(normalized);
}

function isTerminalDoneStatus(
  item: ListedItem,
  terminalDoneStatuses: ReadonlySet<string>,
  statusRegistry: RuntimeStatusRegistry,
): boolean {
  /* c8 ignore next -- normalizeStatusInput currently resolves all command-level status values. */
  const normalized =
    normalizeStatusInput(item.status, statusRegistry) ?? item.status;
  return terminalDoneStatuses.has(normalized);
}

function buildNormalizePlan(
  item: ListedItem,
  statusRegistry: RuntimeStatusRegistry,
  terminalDoneStatuses: ReadonlySet<string>,
  lifecyclePatterns: LifecyclePatternPolicy,
): NormalizeInternalItemPlan {
  const updates: UpdateCommandOptions = {};
  const changes: NormalizePlannedChange[] = [];
  const unsetFields = new Set<string>();
  const itemRecord = toItemRecord(item);

  if (!isTerminalStatus(item, statusRegistry)) {
    for (const definition of ACTIVE_CLEAR_FIELD_RULES) {
      const currentValue = toNonEmptyStringOrUndefined(
        itemRecord[definition.field],
      );
      if (!currentValue) {
        continue;
      }
      const normalized = normalizeComparableText(currentValue);
      const hasClosurePattern =
        lifecyclePatterns.closure_like_metadata_field_patterns[
          definition.field
        ].some((pattern) => normalized.includes(pattern));
      if (!hasClosurePattern && !isLowSignalText(currentValue)) {
        continue;
      }
      /* c8 ignore start -- duplicate unset insertions are defensive against malformed duplicated rule definitions; ACTIVE_CLEAR_FIELD_RULES has distinct unsetField values. */
      if (!unsetFields.has(definition.unsetField)) {
        unsetFields.add(definition.unsetField);
      }
      /* c8 ignore stop */
      changes.push({
        field: definition.field,
        before: sanitizeBeforeValue(itemRecord[definition.field]),
        after: null,
        rule: RULE_ACTIVE_CLOSURE_LIKE_METADATA,
      });
    }

    if (toNonEmptyStringOrUndefined(itemRecord.close_reason)) {
      unsetFields.add("close-reason");
      changes.push({
        field: "close_reason",
        before: sanitizeBeforeValue(itemRecord.close_reason),
        after: null,
        rule: RULE_ACTIVE_CLOSE_REASON,
      });
    }
  }

  if (isTerminalDoneStatus(item, terminalDoneStatuses, statusRegistry)) {
    const closeReason = toMeaningfulCloseReason(itemRecord.close_reason);
    for (const definition of CLOSED_BACKFILL_FIELD_RULES) {
      const currentValue = toNonEmptyStringOrUndefined(
        itemRecord[definition.field],
      );
      if (currentValue && !isLowSignalText(currentValue)) {
        continue;
      }
      const replacement = buildClosedBackfillValue(
        definition.field,
        closeReason,
      );
      updates[definition.optionKey] = replacement;
      changes.push({
        field: definition.field,
        before: sanitizeBeforeValue(itemRecord[definition.field]),
        after: replacement,
        rule: RULE_CLOSED_RESOLUTION_BACKFILL,
      });
    }
  }

  if (unsetFields.size > 0) {
    updates.unset = [...unsetFields].sort((left, right) =>
      left.localeCompare(right),
    );
  }

  /* c8 ignore start -- secondary comparator arm only fires for two changes sharing one field; active-clear and closed-backfill rules are mutually exclusive per item so this is unreachable in practice. */
  changes.sort(
    (left, right) =>
      left.field.localeCompare(right.field) ||
      left.rule.localeCompare(right.rule),
  );
  /* c8 ignore stop */
  return {
    id: item.id,
    changes,
    update: updates,
  };
}

function summarizeRuleCounts(
  itemPlans: NormalizeItemPlan[],
): NormalizeRuleCount[] {
  const counts = new Map<string, number>();
  for (const plan of itemPlans) {
    const planRules = new Set(plan.changes.map((change) => change.rule));
    for (const rule of planRules) {
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((left, right) => left.rule.localeCompare(right.rule));
}

function toNormalizeWarnings(ruleCounts: NormalizeRuleCount[]): string[] {
  return ruleCounts
    .map((entry) => `normalize_${entry.rule}:${entry.count}`)
    .sort((left, right) => left.localeCompare(right));
}

/** Implements run normalize for the public runtime surface of this module. */
export async function runNormalize(
  options: NormalizeCommandOptions,
  global: GlobalOptions,
): Promise<NormalizeResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  /* c8 ignore next -- tracker bootstrap failure path is validated in broader CLI tests. */
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }

  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const lifecyclePatternPolicy = resolveLifecyclePatternPolicy(
    settings as unknown as LifecyclePatternSettingsSource,
  );
  const statusFilter = normalizeStatusFilter(options.status, statusRegistry);
  const dryRun = options.apply === true ? false : true;

  if (options.apply === true && options.dryRun === true) {
    throw new PmCliError(
      "--dry-run cannot be combined with --apply",
      EXIT_CODE.USAGE,
    );
  }

  const listed = await runList(
    statusFilter,
    {
      ...options.list,
      includeBody: true,
      excludeTerminal: false,
    },
    global,
  );

  const terminalDoneStatuses = new Set<string>(
    statusRegistry.terminal_done_statuses,
  );
  terminalDoneStatuses.add(statusRegistry.close_status);
  const sortedItems = [...listed.items].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const planned = sortedItems.map((item) =>
    buildNormalizePlan(
      item,
      statusRegistry,
      terminalDoneStatuses,
      lifecyclePatternPolicy,
    ),
  );
  const ruleCounts = summarizeRuleCounts(planned);
  const warnings = toNormalizeWarnings(ruleCounts);
  const itemPlans = planned.map((plan) => ({
    id: plan.id,
    changes: plan.changes,
  }));
  const rules = [...new Set(ruleCounts.map((entry) => entry.rule))].sort(
    (left, right) => left.localeCompare(right),
  );
  /* c8 ignore next -- list responses in normalize command tests always carry a `now` timestamp. */
  const generatedAt = listed.now ?? nowIso();

  if (dryRun) {
    return {
      mode: "dry_run",
      dry_run: true,
      matched_count: listed.items.length,
      filters: listed.filters,
      rules,
      rule_counts: ruleCounts,
      warnings,
      item_plans: itemPlans,
      ids: [],
      generated_at: generatedAt,
    };
  }

  const applyRows: NormalizeApplyResultRow[] = [];
  const updatedIds: string[] = [];
  const applyMessage =
    typeof options.message === "string" && options.message.trim().length > 0
      ? options.message
      : "normalize apply";
  const updateBaseOptions: Pick<
    UpdateCommandOptions,
    "author" | "message" | "force" | "allowAuditUpdate"
  > = {
    author: options.author,
    message: applyMessage,
    /* c8 ignore next -- false/undefined forms are normalized before reaching this assembly. */
    force: options.force === true ? true : undefined,
    /* c8 ignore next -- false/undefined forms are normalized before reaching this assembly. */
    allowAuditUpdate: options.allowAuditUpdate === true ? true : undefined,
  };

  for (const plan of planned) {
    if (plan.changes.length === 0) {
      applyRows.push({
        id: plan.id,
        status: "skipped",
      });
      continue;
    }
    try {
      const result = await runUpdate(
        plan.id,
        {
          ...plan.update,
          ...updateBaseOptions,
        },
        global,
      );
      applyRows.push({
        id: plan.id,
        status: "updated",
        changed_fields: result.changed_fields,
        warnings: result.warnings,
      });
      updatedIds.push(plan.id);
    } catch (error: unknown) {
      applyRows.push({
        id: plan.id,
        status: "failed",
        error: toErrorMessage(error),
      });
    }
  }

  const updatedCount = applyRows.filter(
    (row) => row.status === "updated",
  ).length;
  const skippedCount = applyRows.filter(
    (row) => row.status === "skipped",
  ).length;
  const failedCount = applyRows.filter((row) => row.status === "failed").length;

  return {
    mode: "apply",
    dry_run: false,
    matched_count: listed.items.length,
    filters: listed.filters,
    rules,
    rule_counts: ruleCounts,
    warnings,
    item_plans: itemPlans,
    updated_count: updatedCount,
    skipped_count: skippedCount,
    failed_count: failedCount,
    rows: applyRows,
    ids: updatedIds,
    generated_at: generatedAt,
  };
}
