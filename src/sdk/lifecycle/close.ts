/**
 * @module sdk/lifecycle/close
 *
 * Implements the pm close command surface and its agent-facing runtime behavior.
 */
import { assertInitializedTracker } from "../environment/tracker-preflight.js";
import { enrichItemRevisionConflict, isItemRevisionConflict, itemRevisionConflictRowFields, type ItemRevisionConflictRowFields } from "./item-revision.js";
import { toErrorMessage } from "../runtime-primitives.js";
import {
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
  readLocatedItem,
  mutateItem,
  resolvePmRoot,
  readSettings,
  resolveAuthor,
  resolveIsoOrRelative,
  shouldCompletePlanOnClose,
  getActiveExtensionRegistrations,
} from "../runtime-primitives.js";
import { collectBlockedByIds, indexBlockedByIds } from "../actionability.js";
import {
  applyTerminalOrderingPolicy,
  requireTerminalReason,
  type CloseOperationOptions,
  type CloseOperationResult,
  type CloseEvidenceFollowUp,
  type CloseCompletionReceipt,
  type TerminalTransitionPolicy,
} from "../lifecycle-policy.js";
import type { ItemDeferredField, ItemMetadata } from "../../types/index.js";
import { deferrableItemFieldByKey, outstandingDeferredFields } from "../../core/item/deferred-fields.js";
import { nowIso } from "../../core/shared/time.js";
import { isPmCliErrorDetails } from "../../core/shared/error-details.js";
import { unicodeSafePrefix } from "../../core/shared/text-normalization.js";
import type { PmCliErrorDetails, PmCliErrorDetailValue } from "../../core/shared/errors.js";
import { renderPmCommand, resolvePmCommandScopeArgs } from "../command-line.js";
import { mutateItemWithHistoryContextResolver } from "../../core/store/item-store.js";
import { activeItemRevisionExpectations, itemRevisionConflictGuidance } from "../../core/store/item-mutation-precondition.js";

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
  /** Completion timestamp provenance sealed into this close event. */
  completion?: CloseCompletionReceipt;
  /** Closed item record. */
  item: Record<string, unknown>;
  /** Changed metadata fields. */
  changed_fields: string[];
  /** Evidence-only update guidance when acceptance fields are missing. */
  follow_up?: CloseEvidenceFollowUp;
  /** Validation and lifecycle receipts. */
  warnings: string[];
}

interface AutoUnblockCandidate {
  id: string;
  blocker_ids: string[];
}

type CloseInlineFieldKey = "resolution" | "expected_result" | "actual_result";

interface CloseMutationContext {
  pmRoot: string;
  commandScope: string[];
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
): (typeof CLOSE_VALIDATION_FIELDS)[number][] {
  const missing: (typeof CLOSE_VALIDATION_FIELDS)[number][] = [];
  for (const field of CLOSE_VALIDATION_FIELDS) {
    const rawValue = itemMetadata[field.key];
    if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
      missing.push(field);
    }
  }
  return missing;
}

/** Build an argv-safe update that appends acceptance evidence without repeating a terminal transition. */
function closeEvidenceRecovery(metadata: ItemMetadata, commandScope: readonly string[], options: CloseCommandOptions = {}): { missing: string[]; suggested_retry: string; suggested_retry_args: string[] } | undefined {
  const missing = findMissingCloseValidationFields(metadata);
  if (missing.length === 0) return undefined;
  const values = { resolution: options.resolution, expected_result: options.expectedResult, actual_result: options.actualResult };
  const missingFlags = missing.map((field) => `--${field.key.replaceAll("_", "-")}`);
  const args = [...commandScope, "update", metadata.id, ...missing.flatMap((field, index) => [missingFlags[index]!, values[field.key]?.trim() || "<value>"])];
  return { missing: missingFlags, suggested_retry: renderPmCommand(args), suggested_retry_args: args };
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
  const itemsById = new Map(
    items.map((item) => [item.id.trim().toLowerCase(), item]),
  );
  const blockerIdsByItem = indexBlockedByIds(items);
  const normalizedClosedId = closedId.trim().toLowerCase();
  const blockedStatuses = statusRegistry.blocked_statuses;
  return items
    .filter((item) => blockedStatuses.has(item.status))
    .map((item) => ({
      item,
      blockerIds: blockerIdsByItem.get(item.id.trim().toLowerCase())!,
    }))
    .filter(({ blockerIds }) => blockerIds.includes(normalizedClosedId))
    .filter(({ blockerIds }) =>
      blockerIds.every((blockerId) => {
        if (blockerId === normalizedClosedId) {
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
  commandScope: readonly string[],
): Promise<string[]> {
  const candidates = findAutoUnblockCandidates(items, closedId, statusRegistry);
  const warnings: string[] = [];
  const unblockedIds: string[] = [];
  // Dependents the fan-out could not unblock; only another close would have retried them. Revision
  // conflicts can be retried with a fresh revision, every other failure needs its cause fixed first.
  const conflictIds: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];
  let conflict: PmCliError | undefined;
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
            const dependencyId = dependency.id.trim().toLowerCase();
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
      unblockedIds.push(unblocked.item.id);
      /* c8 ignore start -- defensive fan-out failure path; normal lock/claim state is auditable and still unblocks. The revision specs exercise the kept conflict through the typed refusal below. */
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message.replace(/\s+/g, " ").trim()
          : "unknown";
      // A guarded dependent the caller declared a revision for refuses typed after the fan-out (pm-gh1576).
      if (isItemRevisionConflict(error)) {
        conflict ??= error;
        conflictIds.push(candidate.id);
      } else {
        failed.push({ id: candidate.id, reason });
      }
      warnings.push(`auto_unblock_failed:${candidate.id}:${reason}`);
    }
    /* c8 ignore stop */
  }
  if (conflict !== undefined) {
    // Attach the dependent's change evidence first, so the pending list joins it instead of displacing it.
    const enriched = await enrichItemRevisionConflict(conflict, pmRoot) as PmCliError;
    // Discovery spans every blocked-role status, the same set the fan-out drew its candidates from.
    const blockedStatuses = [...statusRegistry.blocked_statuses].sort().join(",");
    throw postCloseDependentConflict(enriched, { closedId, unblockedIds, conflictIds, failed, openStatus: statusRegistry.open_status, blockedStatuses, commandScope });
  }
  return warnings;
}

/** Dependents a post-close refusal names, so its diagnostics stay inside the error-details byte ceiling. */
const POST_CLOSE_REPORT_LIMIT = 10;

/** Recovery commands a post-close refusal lists, discovery step included. */
const POST_CLOSE_STEP_LIMIT = 20;

/** Lists trimmed, in order, until the merged post-close details fit the error-details ceiling; each keeps its floor. */
const POST_CLOSE_DETAIL_TRIMS = [
  { list: "auto_unblock_failed", omitted: "auto_unblock_failed_omitted", floor: 0 },
  { list: "changes_since", omitted: "changes_since_omitted", floor: 0 },
  { list: "pending_unblock", omitted: "pending_unblock_omitted", floor: 1 },
] as const;

/**
 * Trim the merged post-close details until the error host renders them whole:
 * other failures first, then the revision change evidence, then pending ids
 * (one always stays). Each dropped entry is counted in its list's omitted
 * field, so a reader knows the list is partial.
 */
function fitPostCloseDetails(details: Record<string, PmCliErrorDetailValue>): PmCliErrorDetails {
  for (const trim of POST_CLOSE_DETAIL_TRIMS) {
    const list = details[trim.list];
    if (!Array.isArray(list)) continue;
    while (list.length > trim.floor && !isPmCliErrorDetails(details)) {
      list.pop();
      Reflect.set(details, trim.omitted, Number(details[trim.omitted]) + 1);
    }
  }
  return details;
}

/** Name at most the report limit of ids, then count the rest. */
function boundedIdList(ids: readonly string[]): string {
  const omitted = ids.length - POST_CLOSE_REPORT_LIMIT;
  return `${ids.slice(0, POST_CLOSE_REPORT_LIMIT).join(", ")}${omitted > 0 ? `, and ${omitted} more` : ""}`;
}

/**
 * The refusal for a guarded dependent whose auto-unblock refused after the close
 * committed. The dependent's own guidance says to retry with --expect-hash, but
 * a repeated close is refused as terminal, so the remedy names only what
 * remains: unblocking each dependent whose revision conflicted, in the caller's
 * tracker scope and with the configured open status the automatic unblock would
 * have written, and fixing the cause of every other failed unblock first.
 */
/** `reason` of a revision refusal close rewrote into its post-close auto-unblock report. */
const POST_CLOSE_AUTO_UNBLOCK_REFUSED_REASON = "post_close_auto_unblock_refused";

function postCloseDependentConflict(conflict: PmCliError, fanOut: {
  closedId: string;
  unblockedIds: readonly string[];
  conflictIds: readonly string[];
  failed: ReadonlyArray<{ id: string; reason: string }>;
  openStatus: string;
  blockedStatuses: string;
  commandScope: readonly string[];
}): PmCliError {
  const { closedId, conflictIds, failed, commandScope } = fanOut;
  const dependent = String(conflict.context.item_id);
  const unblock = (id: string) => renderPmCommand([...commandScope, "update", id, "--status", fanOut.openStatus, "--unset", "blocked_by", "--unset", "blocked_reason", "--expect-hash", `${id}=<item_hash>`]);
  // Reasons are bounded too: the whole details object is dropped if it outgrows the ceiling.
  const reported = failed.slice(0, POST_CLOSE_REPORT_LIMIT).map((entry) => ({ id: entry.id, reason: unicodeSafePrefix(entry.reason, 160) }));
  const otherFailures = failed.length === 0
    ? ""
    : ` Auto-unblocking also failed for ${boundedIdList(failed.map((entry) => entry.id))}; details.auto_unblock_failed gives the reasons it kept (auto_unblock_failed_omitted counts the rest; their get step shows the item). Fix that cause before unblocking it.`;
  // The fan-out warnings are dropped with the refusal, so ids past the report limit are found by listing instead.
  const discovery = renderPmCommand([...commandScope, "list", "--status", fanOut.blockedStatuses, "--fields", "id,title,blocked_by,dependencies", "--limit", "200"]);
  const allSteps = [
    ...conflictIds.slice(0, POST_CLOSE_REPORT_LIMIT).flatMap((id) => [renderPmCommand([...commandScope, "get", id, "--json"]), unblock(id)]),
    ...reported.map((entry) => renderPmCommand([...commandScope, "get", entry.id, "--json"])),
  ];
  // Partial when ids were omitted or when the step cap cuts a dependent's step: either way, list them instead.
  const truncated = conflictIds.length > POST_CLOSE_REPORT_LIMIT || failed.length > POST_CLOSE_REPORT_LIMIT || allSteps.length > POST_CLOSE_STEP_LIMIT;
  const steps = allSteps.slice(0, truncated ? POST_CLOSE_STEP_LIMIT - 1 : POST_CLOSE_STEP_LIMIT);
  return new PmCliError(`${closedId} was closed, but auto-unblocking ${dependent} was refused. ${conflict.message}`, conflict.exitCode, {
    ...conflict.context,
    // This report's commands are scoped already; hosts must not re-render it as a plain revision refusal.
    reason: POST_CLOSE_AUTO_UNBLOCK_REFUSED_REASON,
    examples: itemRevisionConflictGuidance(dependent, false, { scopeArgs: commandScope }).examples,
    required: `The close of ${closedId} is complete; do not retry it. Only unblocking ${conflictIds.length === 1 ? dependent : `the guarded dependents it refused (${boundedIdList(conflictIds)})`} remains: re-read each one (pm get <id> --json reports item_hash), check that every blocker it declares is resolved, then unblock it with ${unblock(dependent)}${conflictIds.length === 1 ? "" : " for each id"}.${otherFailures}${truncated ? ` This refusal does not list a step for every dependent left blocked; list them with ${discovery}, and while it reports has_more, continue with --after <next_cursor>.` : ""}`,
    nextSteps: truncated ? [...steps, discovery] : steps,
    details: fitPostCloseDetails({
      ...structuredClone(conflict.context.details),
      pending_unblock: conflictIds.slice(0, POST_CLOSE_REPORT_LIMIT),
      pending_unblock_omitted: Math.max(0, conflictIds.length - POST_CLOSE_REPORT_LIMIT),
      auto_unblock_failed: reported,
      auto_unblock_failed_omitted: Math.max(0, failed.length - POST_CLOSE_REPORT_LIMIT),
    }),
    // Every committed write before the refusal: the close and each dependent already unblocked.
    side_effects: [{ path: `history/${closedId}.jsonl`, op: "close" }, ...fanOut.unblockedIds.map((id) => ({ path: `history/${id}.jsonl`, op: "update" }))],
  });
}

/** A guarded dependent whose auto-unblock refused after a bulk row's close committed. */
export type DependentRevisionConflict = ItemRevisionConflictRowFields & { item_id: string; error: string };

/**
 * Bulk-row fields for a row whose close committed before a guarded dependent's
 * auto-unblock refused (the refusal discloses the close in `side_effects`), or
 * undefined for any other failure (pm-gh1576).
 */
export async function committedCloseDependentConflict(
  error: unknown,
  id: string,
  pmRoot: string,
): Promise<{ warnings: string[]; dependent_revision_conflict: DependentRevisionConflict } | undefined> {
  if (!isItemRevisionConflict(error) || !error.context.side_effects?.some((effect) => `${effect.op}:${effect.path}` === `close:history/${id}.jsonl`)) return undefined;
  const dependent = String(error.context.item_id);
  const unblocked = error.context.side_effects!.filter((effect) => effect.op === "update").map((effect) => effect.path.slice("history/".length, -".jsonl".length));
  return {
    warnings: [...unblocked.map((unblockedId) => `auto_unblocked:${unblockedId}`), `auto_unblock_refused:${dependent}:item_revision_conflict`],
    dependent_revision_conflict: { item_id: dependent, error: toErrorMessage(error), ...(await itemRevisionConflictRowFields(error, pmRoot)) },
  };
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

/**
 * Options the refused close supplied, rendered as attached `--flag=value`
 * tokens so a value that starts with a hyphen stays a value. The refused write
 * persisted none of them, so the retry must carry them again.
 */
function suppliedCloseOptionTokens(options: CloseOperationOptions, missingFlags: ReadonlySet<string>): string[] {
  const valued: Array<[string, string | undefined]> = [
    ["--resolution", options.resolution],
    ["--expected-result", options.expectedResult],
    ["--actual-result", options.actualResult],
    ["--validate-close", options.validateClose],
    ["--completed-at", options.completedAt],
    ["--message", options.message],
    ["--author", options.author],
  ];
  const tokens = valued.flatMap(([flag, value]) => (missingFlags.has(flag) || value === undefined || value.trim().length === 0 ? [] : [`${flag}=${value}`]));
  return options.force === true ? [...tokens, "--force"] : tokens;
}

/**
 * Refuse a strict close that lacks close evidence (pm-gh1676). pm close accepts
 * every missing field itself, so the retry is the same close with the missing
 * flags added: one write, one history entry. It carries every option the
 * refused close supplied, and the reason as `--reason=<text>` so a reason that
 * looks like a flag is not parsed as one. The CLI re-renders the retry from
 * the caller's exact argv; a separate pm update stays only as a secondary route.
 * A close with an SDK-only lifecycle override gets no CLI retry, since none can
 * reproduce that override; it is told to retry the SDK call with the evidence.
 */
function closeValidationMissingFieldsError(
  metadata: ItemMetadata,
  missingFields: ReadonlyArray<(typeof CLOSE_VALIDATION_FIELDS)[number]>,
  context: Pick<CloseMutationContext, "pmRoot" | "commandScope" | "closeReason" | "options">,
): PmCliError {
  const missingLabels = missingFields.map((field) => field.label);
  const missingFlags = missingFields.map((field) => `--${field.key.replaceAll("_", "-")}`);
  const placeholders = missingFlags.flatMap((flag) => [flag, "<value>"]);
  const updateTokens = [...context.commandScope, "update", metadata.id, ...placeholders];
  const message = `Cannot close item ${metadata.id}: missing ${missingLabels.join(", ")}. Populate fields or use --validate-close warn.`;
  const warnStep = "Use --validate-close warn only when governance permits an evidenced exception.";
  // An SDK-only lifecycle override (requireCloseReason, orderingEdges) has no CLI spelling, so a CLI close
  // would perform a different transition: retry the SDK call itself, with the evidence supplied.
  const overrides = Object.entries(context.options.lifecyclePolicy ?? {}).filter(([, value]) => value !== undefined).map(([key]) => key);
  // An SDK or MCP guard never reaches argv, so the retry carries every revision the active scopes expect
  // on this tracker, including guards on dependents the close would auto-unblock.
  const expectations = activeItemRevisionExpectations(context.pmRoot);
  // An explicitly blank author is attributed differently from an omitted one, and pm close refuses an empty --author.
  const blankAuthor = typeof context.options.author === "string" && context.options.author.trim().length === 0;
  const unreplayable = overrides.length > 0
    ? `its lifecyclePolicy override (${overrides.join(", ")}) has no CLI spelling`
    : blankAuthor
      ? "its explicitly blank author has no CLI spelling (pm close refuses an empty --author)"
      : expectations === undefined
      ? "its revision guards cannot be replayed as typed (nested revision guards expect different revisions of one item, or a write in the same operation advanced a guarded revision)"
      : undefined;
  if (unreplayable !== undefined) {
    return new PmCliError(message, EXIT_CODE.USAGE, {
      code: "close_validation_missing_fields",
      required: `Pass ${missingFields.map((field) => field.key).join(", ")} on the same SDK close; ${unreplayable}, so no CLI retry reproduces it.`,
      recovery: { missing: missingFlags, next_best_command: renderPmCommand(updateTokens) },
      nextSteps: ["Retry the same SDK close with the missing evidence supplied, inside the same lifecycle policy and revision guards.", warnStep],
    });
  }
  const reason = context.closeReason === undefined ? [] : [`--reason=${context.closeReason}`];
  // A replayable close has typed guards: an undefined expectation set took the unreplayable branch above.
  const guards = expectations!.map((guard) => `--expect-hash=${guard}`);
  const closeTokens = [...context.commandScope, "close", metadata.id, ...reason, ...suppliedCloseOptionTokens(context.options, new Set(missingFlags)), ...guards, ...placeholders];
  return new PmCliError(message, EXIT_CODE.USAGE, {
    code: "close_validation_missing_fields",
    // Truthful whether or not a host keeps the retry: the CLI withdraws it for commands (close-task)
    // that cannot accept the evidence flags.
    required: `Supply ${missingFlags.join(", ")}: pm close accepts them and records them in the same write as the closure.`,
    recovery: {
      missing: missingFlags,
      suggested_retry: renderPmCommand(closeTokens),
      suggested_retry_args: closeTokens,
      next_best_command: renderPmCommand(updateTokens),
    },
    nextSteps: [
      "Run recovery.suggested_retry when it is present: the same close with the missing flags added, so one write records the evidence and the closure.",
      "Without it, record the evidence with recovery.next_best_command, then repeat the original close.",
      warnStep,
    ],
  });
}

/**
 * Refuse a strict close while a deferred strict-required field still has no
 * value (GH-1713): the deferral let the item be created, never finished. The
 * recovery supplies each deferred field through pm update, which resolves the
 * deferral on the same write, and then repeats the close.
 */
function closeValidationDeferredFieldsError(
  metadata: ItemMetadata,
  deferred: readonly ItemDeferredField[],
  commandScope: readonly string[],
  author: string | undefined,
): PmCliError {
  const flags = deferred.map((entry) => deferrableItemFieldByKey(entry.field)!.flag);
  // The update runs as the identity the close ran as, so strict ownership does not refuse it.
  const identity = author === undefined || author.trim().length === 0 ? [] : [`--author=${author}`];
  const updateTokens = [...commandScope, "update", metadata.id, ...identity, ...flags.flatMap((flag) => [flag, "<value>"])];
  return new PmCliError(
    `Cannot close item ${metadata.id}: deferred fields still have no value (${deferred.map((entry) => entry.field).join(", ")}). Supply them or use --validate-close warn.`,
    EXIT_CODE.USAGE,
    {
      code: "close_validation_deferred_fields",
      required: `Supply ${flags.join(", ")}: each was deferred at create (${deferred.map((entry) => `${entry.field}: ${entry.reason}`).join("; ")}).`,
      recovery: { missing: flags, next_best_command: renderPmCommand(updateTokens) },
      nextSteps: [
        "Record the now-known values with recovery.next_best_command; the update resolves each deferral, then repeat the close.",
        "Use --validate-close warn only when governance permits closing with deferred values still unknown.",
      ],
    },
  );
}

/** Refuse (strict) or warn about deferred fields that still have no value when an item closes. */
function collectDeferredFieldCloseWarnings(
  metadata: ItemMetadata,
  validateCloseMode: Exclude<ValidateCloseMode, "off">,
  context: Pick<CloseMutationContext, "commandScope" | "options">,
): string[] {
  const deferred = outstandingDeferredFields(metadata);
  if (deferred.length === 0) return [];
  if (validateCloseMode === "strict") throw closeValidationDeferredFieldsError(metadata, deferred, context.commandScope, context.options.author);
  return [`close_validation_deferred_fields:${metadata.id}:${deferred.map((entry) => entry.field).join(",")}`];
}

function collectCloseValidationWarnings(
  metadata: ItemMetadata,
  validateCloseMode: ValidateCloseMode,
  activeChildIds: string[],
  context: Pick<CloseMutationContext, "pmRoot" | "commandScope" | "closeReason" | "options">,
): string[] {
  const warnings: string[] = [];
  if (validateCloseMode !== "off") {
    warnings.push(...collectDeferredFieldCloseWarnings(metadata, validateCloseMode, context));
    const missingFields = findMissingCloseValidationFields(metadata);
    if (missingFields.length > 0) {
      const missingLabels = missingFields.map((field) => field.label);
      if (validateCloseMode === "strict") {
        throw closeValidationMissingFieldsError(metadata, missingFields, context);
      }
      warnings.push(
        `close_validation_missing_fields:${metadata.id}:${missingLabels.join(",")}`,
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

/**
 * End ownership at closure: both the assignee and the claim principal clear,
 * so a closed item never keeps an active owner that only `pm release` could
 * remove later.
 */
function clearCloseAssignee(metadata: ItemMetadata): string[] {
  const cleared = (["assignee", "claim_principal"] as const).filter(
    (key) => metadata[key] !== undefined,
  );
  for (const key of cleared) delete metadata[key];
  return [...cleared];
}

/** Enforce terminal and closure policies before applying acceptance fields and the atomic lifecycle transition. */
function mutateCloseMetadata(
  metadata: ItemMetadata,
  context: CloseMutationContext,
): { changedFields: string[]; warnings?: string[] } {
  if (
    isTerminalStatus(metadata.status, context.statusRegistry) &&
    !context.force
  ) {
    throw new PmCliError(
      `Item ${metadata.id} is already terminal; use pm update to append acceptance evidence, or --force only for an intentional repeat closure.`,
      EXIT_CODE.CONFLICT,
      { recovery: closeEvidenceRecovery(metadata, context.commandScope, context.options) },
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
    context,
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
  fitPostCloseDetails,
};

/** Close one item through the SDK-owned lifecycle transaction and policy. */
export async function closeItem(
  id: string,
  closeReasonText: string | undefined,
  options: CloseOperationOptions,
  global: GlobalOptions,
): Promise<CloseOperationResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const commandScope = resolvePmCommandScopeArgs(global);
  await assertInitializedTracker(pmRoot);

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

  const closedAt = nowIso();
  const completedAt =
    options.completedAt === undefined
      ? closedAt
      : resolveIsoOrRelative(
          options.completedAt,
          new Date(closedAt),
          "completed-at",
        );
  let completion: CloseCompletionReceipt = {
    timestamp: completedAt,
    source: options.completedAt === undefined ? "close_time" : "asserted",
    ...(options.completedAt === undefined ? { hint: `completed_at defaults to the close time. If work finished earlier, correct it with ${renderPmCommand([...commandScope, "update", located.id, "--completed-at", "<ISO>"])}.` } : {}),
  };
  const result = await mutateItemWithHistoryContextResolver({
    pmRoot,
    settings,
    id: located.id,
    op: "close",
    author,
    message: options.message,
    force: options.force,
    resolveHistoryContext: () => ({ completion: { timestamp: completion.timestamp, source: completion.source } }),
    mutate(document) {
      if (options.completedAt === undefined && document.metadata.completed_at !== undefined) {
        completion = { timestamp: document.metadata.completed_at, source: "existing" };
      }
      return mutateCloseMetadata(document.metadata, {
        pmRoot,
        commandScope,
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

  const evidence = validateCloseMode === "warn" ? closeEvidenceRecovery(result.item, commandScope) : undefined;
  return {
    item: toItemRecord(result.item),
    changed_fields: result.changedFields,
    ...(evidence ? { follow_up: {
      kind: "complete_close_evidence" as const,
      missing: evidence.missing,
      suggested_command: evidence.suggested_retry,
      suggested_command_args: evidence.suggested_retry_args,
    } } : {}),
    warnings: [
      ...result.warnings,
      ...(await autoUnblockResolvedDependents(
        pmRoot,
        settings,
        trackerItems,
        located.id,
        author,
        statusRegistry,
        commandScope,
      )),
    ],
    completion,
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
