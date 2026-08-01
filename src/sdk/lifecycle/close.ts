/**
 * @module sdk/lifecycle/close
 *
 * Implements the pm close command surface and its agent-facing runtime behavior.
 */
import {
  pathExists,
  toItemRecord,
  isTerminalStatus,
  resolveItemTypeRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeStatusRegistry,
  EXIT_CODE,
  type GlobalOptions,
  PmCliError,
  buildItemNotFoundError,
  listAllItemMetadataLight,
  locateItem,
  mutateItem,
  readLocatedItem,
  getSettingsPath,
  resolvePmRoot,
  readSettings,
  resolveAuthor,
  resolveIsoOrRelative,
  shouldCompletePlanOnClose,
  getActiveExtensionRegistrations,
} from "../runtime-primitives.js";
import { collectBlockedByIds } from "../actionability.js";
import {
  applyTerminalOrderingPolicy,
  requireTerminalReason,
  type CloseOperationOptions,
  type CloseOperationResult,
  type TerminalTransitionPolicy,
} from "../lifecycle-policy.js";
import type { ItemMetadata } from "../../types/index.js";
import { renderPmCommand } from "../command-line.js";

/** Compatibility options for command-shaped close consumers. */
export interface CloseCommandOptions {
  /** Mutation author. */
  author?: string;
  /** Immutable history message. */
  message?: string;
  /** Closure validation mode. */
  validateClose?: string;
  /** Permit repeat closure. */
  force?: boolean;
  /** Structured resolution evidence. */
  resolution?: string;
  /** Expected outcome evidence. */
  expectedResult?: string;
  /** Actual outcome evidence. */
  actualResult?: string;
  /** Canonical duplicate target. */
  duplicateOf?: string;
  /** Actual completion time. */
  completedAt?: string;
}

/** Compatibility result for command-shaped close consumers. */
export interface CloseResult {
  /** Closed item record. */
  item: Record<string, unknown>;
  /** Changed metadata fields. */
  changed_fields: string[];
  /** Validation and lifecycle receipts. */
  warnings: string[];
}

interface AutoUnblockCandidate {
  id: string;
  blocker_ids: string[];
}

type CloseInlineFieldKey = "resolution" | "expected_result" | "actual_result";

interface CloseMutationContext {
  statusRegistry: RuntimeStatusRegistry;
  force: boolean | undefined;
  options: CloseOperationOptions;
  duplicateOf: string | undefined;
  validateCloseMode: ValidateCloseMode;
  activeChildIds: string[];
  closeReason: string | undefined;
  closedAt: string;
  completedAt: string;
  lifecyclePolicy: TerminalTransitionPolicy;
}

type ValidateCloseMode = "off" | "warn" | "strict";


const CLOSE_VALIDATION_FIELDS: Array<{
  key: keyof Pick<
    ItemMetadata,
    "resolution" | "expected_result" | "actual_result"
  >;
  label: string;
}> = [
  { key: "resolution", label: "resolution (--resolution)" },
  {
    key: "expected_result",
    label: "expected_result (--expected-result)",
  },
  { key: "actual_result", label: "actual_result (--actual-result)" },
];

function parseValidateCloseMode(
  raw: string | undefined,
): ValidateCloseMode | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0 || normalized === "warn") {
    return "warn";
  }
  if (
    normalized === "off" ||
    normalized === "none" ||
    normalized === "disabled"
  ) {
    return "off";
  }
  if (normalized === "strict") {
    return "strict";
  }
  throw new PmCliError(
    `Invalid --validate-close mode "${raw}" (expected "off", "warn", or "strict")`,
    EXIT_CODE.USAGE,
  );
}

function findMissingCloseValidationFields(
  itemMetadata: ItemMetadata,
): string[] {
  const missing: string[] = [];
  for (const field of CLOSE_VALIDATION_FIELDS) {
    const rawValue = itemMetadata[field.key];
    if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
      missing.push(field.label);
    }
  }
  return missing;
}

async function duplicateChainReferencesClosingItem(
  loadItemById: (id: string) => Promise<ItemMetadata | null>,
  initialDuplicateOf: unknown,
  closingId: string,
): Promise<boolean> {
  const visited = new Set<string>();
  let current = initialDuplicateOf;
  while (typeof current === "string" && current.trim().length > 0) {
    const currentId = current.trim();
    if (currentId === closingId) {
      return true;
    }
    if (visited.has(currentId)) {
      return false;
    }
    visited.add(currentId);
    current = (await loadItemById(currentId))?.duplicate_of;
  }
  return false;
}

function shouldApplyDuplicateFallback(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

async function assertDuplicateTargetExists(
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  duplicateOf: string | undefined,
  closingId: string,
): Promise<string | undefined> {
  const rawTarget = duplicateOf?.trim();
  if (!rawTarget) {
    return undefined;
  }
  if (rawTarget === closingId) {
    throw new PmCliError(
      "An item cannot be closed as a duplicate of itself.",
      EXIT_CODE.USAGE,
      {
        code: "duplicate_target_self",
        why: "--duplicate-of must identify the canonical item that should remain open or already represent the work.",
      },
    );
  }
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const itemCache = new Map<string, ItemMetadata | null>();
  const loadItemById = async (id: string): Promise<ItemMetadata | null> => {
    if (itemCache.has(id)) {
      return itemCache.get(id) ?? null;
    }
    const located = await locateItem(
      pmRoot,
      id,
      settings.id_prefix,
      settings.item_format,
      typeRegistry.type_to_folder,
    );
    if (!located) {
      itemCache.set(id, null);
      return null;
    }
    const { document } = await readLocatedItem(located, {
      schema: settings.schema,
    });
    itemCache.set(id, document.metadata);
    return document.metadata;
  };
  const target = await loadItemById(rawTarget);
  if (!target) {
    throw new PmCliError(
      `Duplicate target "${rawTarget}" was not found. Create or locate the canonical item first.`,
      EXIT_CODE.USAGE,
      {
        code: "duplicate_target_missing",
        why: "Duplicate closure should point at a real canonical pm item so future dedupe and changelog tooling can trace the relationship.",
        examples: [
          `pm close ${closingId} "Duplicate of ${rawTarget}" --duplicate-of ${rawTarget}`,
        ],
        nextSteps: [
          "Run pm search/list to find the canonical item, then retry with --duplicate-of <id>.",
        ],
      },
    );
  }
  if (
    await duplicateChainReferencesClosingItem(
      loadItemById,
      target.duplicate_of,
      closingId,
    )
  ) {
    throw new PmCliError(
      `Circular duplicate reference detected. Target "${rawTarget}" points back to "${closingId}".`,
      EXIT_CODE.USAGE,
      {
        code: "duplicate_target_circular",
        why: "Circular duplicate relationships create loops for dedupe and status propagation tooling.",
        nextSteps: [
          "Choose the existing canonical item, or clear the target duplicate_of metadata before closing this item as a duplicate.",
        ],
      },
    );
  }
  if (
    typeof target.duplicate_of === "string" &&
    target.duplicate_of.trim().length > 0
  ) {
    throw new PmCliError(
      `Duplicate target "${rawTarget}" is already marked as a duplicate of "${target.duplicate_of.trim()}".`,
      EXIT_CODE.USAGE,
      {
        code: "duplicate_target_is_duplicate",
        why: "Duplicate closure should point directly at the canonical item, not another duplicate.",
        examples: [
          `pm close ${closingId} "Duplicate of ${target.duplicate_of.trim()}" --duplicate-of ${target.duplicate_of.trim()}`,
        ],
        nextSteps: [
          "Use the canonical item referenced by duplicate_of as the --duplicate-of target.",
        ],
      },
    );
  }
  return target.id;
}

function findActiveChildIds(
  items: ItemMetadata[],
  parentId: string,
  statusRegistry: RuntimeStatusRegistry,
): string[] {
  return items
    .filter(
      (item) =>
        item.parent === parentId &&
        !isTerminalStatus(item.status, statusRegistry),
    )
    .map((item) => item.id)
    .sort((left, right) => left.localeCompare(right));
}

function findAutoUnblockCandidates(
  items: ItemMetadata[],
  closedId: string,
  statusRegistry: RuntimeStatusRegistry,
): AutoUnblockCandidate[] {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const blockedStatuses = statusRegistry.blocked_statuses;
  return items
    .filter((item) => blockedStatuses.has(item.status))
    .map((item) => ({ item, blockerIds: collectBlockedByIds(item) }))
    .filter(({ blockerIds }) => blockerIds.includes(closedId))
    .filter(({ blockerIds }) =>
      blockerIds.every((blockerId) => {
        if (blockerId === closedId) {
          return true;
        }
        const blocker = itemsById.get(blockerId);
        return (
          blocker !== undefined &&
          isTerminalStatus(blocker.status, statusRegistry)
        );
      }),
    )
    .map(({ item, blockerIds }) => ({ id: item.id, blocker_ids: blockerIds }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function autoUnblockResolvedDependents(
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  items: ItemMetadata[],
  closedId: string,
  author: string,
  statusRegistry: RuntimeStatusRegistry,
): Promise<string[]> {
  const candidates = findAutoUnblockCandidates(items, closedId, statusRegistry);
  const warnings: string[] = [];
  for (const candidate of candidates) {
    try {
      const unblocked = await mutateItem({
        pmRoot,
        settings,
        id: candidate.id,
        op: "update",
        author,
        message: `Auto-unblocked after blocker ${closedId} closed`,
        mutate(document) {
          /* c8 ignore start -- normal auto-unblock candidates carry dependency metadata; fallback preserves hand-edited scalar-only blockers. */
          const dependencies = document.metadata.dependencies ?? [];
          /* c8 ignore stop */
          const remainingDependencies = dependencies.filter((dependency) => {
            const dependencyId = dependency.id.trim();
            return (
              dependency.kind !== "blocked_by" ||
              !candidate.blocker_ids.includes(dependencyId)
            );
          });
          document.metadata.status = statusRegistry.open_status;
          delete document.metadata.blocked_by;
          delete document.metadata.blocked_reason;
          document.metadata.unblock_note = `Auto-unblocked after blocker ${closedId} closed; all blockers resolved (${candidate.blocker_ids.join(", ")}).`;
          if (remainingDependencies.length > 0) {
            document.metadata.dependencies = remainingDependencies;
          } else {
            delete document.metadata.dependencies;
          }
          const changedFields = [
            "status",
            "blocked_by",
            "blocked_reason",
            "unblock_note",
          ];
          if (remainingDependencies.length !== dependencies.length) {
            changedFields.push("dependencies");
          }
          return {
            changedFields,
          };
        },
      });
      warnings.push(
        `auto_unblocked:${unblocked.item.id}:resolved_blockers=${candidate.blocker_ids.join(",")}`,
      );
      /* c8 ignore start -- defensive fan-out failure path; normal lock/claim state is auditable and still unblocks. */
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message.replace(/\s+/g, " ").trim()
          : "unknown";
      warnings.push(`auto_unblock_failed:${candidate.id}:${reason}`);
    }
    /* c8 ignore stop */
  }
  return warnings;
}

function applyInlineCloseFields(
  metadata: ItemMetadata,
  options: CloseCommandOptions,
): CloseInlineFieldKey[] {
  const changedFields: CloseInlineFieldKey[] = [];
  const inlineCloseFields: Array<{
    option: string | undefined;
    key: CloseInlineFieldKey;
  }> = [
    { option: options.resolution, key: "resolution" },
    { option: options.expectedResult, key: "expected_result" },
    { option: options.actualResult, key: "actual_result" },
  ];
  for (const { option, key } of inlineCloseFields) {
    if (typeof option !== "string") {
      continue;
    }
    const trimmed = option.trim();
    if (trimmed.length === 0) {
      continue;
    }
    metadata[key] = trimmed;
    changedFields.push(key);
  }
  return changedFields;
}

function applyDuplicateCloseMetadata(
  metadata: ItemMetadata,
  duplicateOf: string | undefined,
): CloseInlineFieldKey[] {
  if (duplicateOf === undefined) {
    return [];
  }
  metadata.duplicate_of = duplicateOf;
  const duplicateFallbackFields: CloseInlineFieldKey[] = [];
  const fallbackValues: Array<{ key: CloseInlineFieldKey; value: string }> = [
    { key: "resolution", value: `Duplicate of ${duplicateOf}` },
    {
      key: "expected_result",
      value: `Canonical item ${duplicateOf} tracks the work.`,
    },
    { key: "actual_result", value: `Closed as duplicate of ${duplicateOf}.` },
  ];
  for (const { key, value } of fallbackValues) {
    if (shouldApplyDuplicateFallback(metadata[key])) {
      metadata[key] = value;
      duplicateFallbackFields.push(key);
    }
  }
  return duplicateFallbackFields;
}

function collectCloseValidationWarnings(
  metadata: ItemMetadata,
  validateCloseMode: ValidateCloseMode,
  activeChildIds: string[],
  closeReason: string | undefined,
): string[] {
  const warnings: string[] = [];
  if (validateCloseMode !== "off") {
    const missingFields = findMissingCloseValidationFields(metadata);
    if (missingFields.length > 0) {
      if (validateCloseMode === "strict") {
        const missingFlags = missingFields.map(
          (field) => `--${field.replaceAll("_", "-")}`,
        );
        const retryTokens = [
          "close",
          metadata.id,
          closeReason ?? "<reason>",
          ...missingFlags.flatMap((flag) => [flag, "<value>"]),
        ];
        throw new PmCliError(
          `Cannot close item ${metadata.id}: missing ${missingFields.join(", ")}. Populate fields or use --validate-close warn.`,
          EXIT_CODE.USAGE,
          {
            code: "close_validation_missing_fields",
            recovery: {
              missing: missingFlags,
              suggested_retry: renderPmCommand(retryTokens),
            },
            nextSteps: [
              "Use pm close with the missing closure fields populated.",
              "Use --validate-close warn only when governance permits an evidenced exception.",
            ],
          },
        );
      }
      warnings.push(
        `close_validation_missing_fields:${metadata.id}:${missingFields.join(",")}`,
      );
    }
    if (activeChildIds.length > 0) {
      if (validateCloseMode === "strict") {
        throw new PmCliError(
          `Cannot close item ${metadata.id}: active child items remain open (${activeChildIds.join(", ")}). Close, cancel, or re-parent them first, or use --validate-close warn.`,
          EXIT_CODE.USAGE,
        );
      }
      warnings.push(
        `close_validation_active_children:${metadata.id}:${activeChildIds.join(",")}`,
      );
    }
    return warnings;
  }
  if (activeChildIds.length > 0) {
    warnings.push(
      `closed_with_active_children:${metadata.id}:${activeChildIds.join(",")}`,
    );
  }
  return warnings;
}

function applyCloseReason(
  metadata: ItemMetadata,
  closeReason: string | undefined,
): string[] {
  if (closeReason !== undefined) {
    metadata.close_reason = closeReason;
    return ["close_reason"];
  }
  return [];
}

function clearCloseAssignee(metadata: ItemMetadata): string[] {
  if (metadata.assignee === undefined) {
    return [];
  }
  delete metadata.assignee;
  return ["assignee"];
}

function mutateCloseMetadata(
  metadata: ItemMetadata,
  context: CloseMutationContext,
): { changedFields: string[]; warnings?: string[] } {
  if (
    isTerminalStatus(metadata.status, context.statusRegistry) &&
    !context.force
  ) {
    throw new PmCliError(
      `Item ${metadata.id} is already terminal; use --force to close again.`,
      EXIT_CODE.CONFLICT,
    );
  }
  const inlineChangedFields = applyInlineCloseFields(metadata, context.options);
  const duplicateFallbackFields = applyDuplicateCloseMetadata(
    metadata,
    context.duplicateOf,
  );
  const mutationWarnings = collectCloseValidationWarnings(
    metadata,
    context.validateCloseMode,
    context.activeChildIds,
    context.closeReason,
  );
  metadata.status = context.statusRegistry.close_status;
  metadata.closed_at = context.closedAt;
  const shouldWriteCompletedAt =
    context.options.completedAt !== undefined ||
    metadata.completed_at === undefined;
  if (shouldWriteCompletedAt) {
    metadata.completed_at = context.completedAt;
  }
  const changedFields = [
    "status",
    "closed_at",
    ...(shouldWriteCompletedAt ? ["completed_at"] : []),
    ...applyCloseReason(metadata, context.closeReason),
    ...inlineChangedFields,
  ];
  if (shouldCompletePlanOnClose(metadata)) {
    metadata.plan_mode = "completed";
    changedFields.push("plan_mode");
  }
  if (context.duplicateOf !== undefined) {
    changedFields.push("duplicate_of");
    for (const key of duplicateFallbackFields) {
      /* v8 ignore start -- duplicate fallback keys are already pre-deduped by applyDuplicateCloseMetadata in covered close paths */
      if (!changedFields.includes(key)) {
        changedFields.push(key);
      }
      /* v8 ignore stop */
    }
  }
  changedFields.push(...clearCloseAssignee(metadata));
  const blockerCleanup = applyTerminalOrderingPolicy(
    metadata,
    context.lifecyclePolicy,
  );
  changedFields.push(...blockerCleanup.changedFields);
  mutationWarnings.push(...blockerCleanup.warnings);
  return {
    changedFields,
    ...(mutationWarnings.length > 0 ? { warnings: mutationWarnings } : {}),
  };
}

/** Public contract for test only close command, shared by SDK and presentation-layer consumers. */
export const _testOnlyCloseCommand = {
  blockedByIds: collectBlockedByIds,
};

/** Close one item through the SDK-owned lifecycle transaction and policy. */
export async function closeItem(
  id: string,
  closeReasonText: string | undefined,
  options: CloseOperationOptions,
  global: GlobalOptions,
): Promise<CloseOperationResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }

  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const author = resolveAuthor(options.author, settings.author_default);
  // GH-250: verify the target item EXISTS before the governance close-reason
  // gate fires. Otherwise closing a typo'd id with no reason reports
  // "Close reason text is required" and hides the real cause (bad id) until a
  // reason is supplied. Existence is the more fundamental precondition, so it
  // is validated first regardless of whether a reason was provided.
  const typeToFolder = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  ).type_to_folder;
  const located = await locateItem(
    pmRoot,
    id,
    settings.id_prefix,
    settings.item_format,
    typeToFolder,
  );
  if (!located) {
    throw await buildItemNotFoundError(
      pmRoot,
      id,
      settings.id_prefix,
      typeToFolder,
    );
  }
  // GH-204: resolve the duplicate target BEFORE reason validation so
  // `pm close <id> --duplicate-of <canonical>` succeeds under
  // governance.require_close_reason without a manual reason — when no
  // positional/--reason text is provided the reason defaults to
  // "Duplicate of <id>" (mirroring the auto-filled closure metadata).
  // Explicit reason text still wins.
  const duplicateOf = await assertDuplicateTargetExists(
    pmRoot,
    settings,
    options.duplicateOf,
    located.id,
  );
  // pm-7x8d / pm-9hry / GH-204: when no explicit positional/--reason text is given, derive
  // the close reason from the next-best closure signal instead of hard-blocking
  // under governance.require_close_reason. Precedence: explicit reason text >
  // --duplicate-of ("Duplicate of <id>") > --resolution summary > --message.
  // Resolution still writes metadata.resolution below; message still writes the
  // history entry through mutateItem. Reusing either as the close reason just lets
  // a single agent-authored close command succeed when it already supplied a
  // closure summary through another structured option.
  const lifecyclePolicy: TerminalTransitionPolicy = {
    requireCloseReason:
      options.lifecyclePolicy?.requireCloseReason ??
      settings.governance.require_close_reason,
    orderingEdges: options.lifecyclePolicy?.orderingEdges ?? "preserve",
  };
  const closeReason = requireTerminalReason(
    {
      explicit: closeReasonText,
      duplicateOf,
      resolution: options.resolution,
      message: options.message,
    },
    lifecyclePolicy.requireCloseReason,
  ).closeReason;
  const validateCloseMode =
    parseValidateCloseMode(options.validateClose) ??
    settings.governance.close_validation_default;
  // C3 (pm-fu5d): scan for active children even under minimal governance so
  // closing a parent is never silently orphaning — off mode emits an
  // informational note instead of the warn/strict validation warning.
  const trackerItems = await listAllItemMetadataLight(
    pmRoot,
    settings.item_format,
    typeToFolder,
    undefined,
    settings.schema,
  );
  const activeChildIds = findActiveChildIds(
    trackerItems,
    located.id,
    statusRegistry,
  );

  const closedAt = new Date().toISOString();
  const completedAt =
    options.completedAt === undefined
      ? closedAt
      : resolveIsoOrRelative(
          options.completedAt,
          new Date(closedAt),
          "completed-at",
        );
  const result = await mutateItem({
    pmRoot,
    settings,
    id: located.id,
    op: "close",
    author,
    message: options.message,
    force: options.force,
    mutate(document) {
      return mutateCloseMetadata(document.metadata, {
        statusRegistry,
        force: options.force,
        options,
        duplicateOf,
        validateCloseMode,
        activeChildIds,
        closeReason,
        closedAt,
        completedAt,
        lifecyclePolicy,
      });
    },
  });

  return {
    item: toItemRecord(result.item),
    changed_fields: result.changedFields,
    warnings: [
      ...result.warnings,
      ...(await autoUnblockResolvedDependents(
        pmRoot,
        settings,
        trackerItems,
        located.id,
        author,
        statusRegistry,
      )),
    ],
  };
}

/** Compatibility command-shaped wrapper over the SDK-owned close operation. */
export function runClose(
  id: string,
  closeReasonText: string | undefined,
  options: CloseCommandOptions,
  global: GlobalOptions,
): Promise<CloseResult> {
  return closeItem(id, closeReasonText, options, global);
}
