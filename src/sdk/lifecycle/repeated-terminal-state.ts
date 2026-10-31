/**
 * @module sdk/lifecycle/repeated-terminal-state
 *
 * An update that names the close status for an item that already holds that
 * status with the same reason is not a transition. Routing it to the closure
 * writer re-stamped `closed_at` and `updated_at` on every retry (GH-1628)
 * while the same payload on an open item was a no-op. These helpers detect
 * the repeated state and apply only the remaining fields.
 */
import {
  buildItemNotFoundError,
  locateItem,
  normalizeStatusInput,
  readLocatedItem,
  resolveIsoOrRelative,
  toItemRecord,
  transferMutationStdinTokenPolicy,
  type GlobalOptions,
  type RuntimeStatusRegistry,
} from "../runtime-primitives.js";
import type { ItemMetadata } from "../../types/index.js";
import { requireTerminalReason } from "../lifecycle-policy.js";
import { CLOSE_REASON_UNSET_ALIASES, expandUnsetFieldTokens } from "./shared-unset-fields.js";
import type { CloseRouteContext, UpdateCommandOptions, UpdateResult } from "./update.js";

/** Receipt for an update that repeats the item's current terminal state, so no closure clock is re-stamped (GH-1628). */
export const TERMINAL_STATE_UNCHANGED_WARNING = "terminal_state_unchanged";

function normalizeTerminalReasonInput(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** True when a stored or returned status is the registry's configured close status. */
function isCloseStatus(
  status: unknown,
  statusRegistry: RuntimeStatusRegistry,
): boolean {
  return (
    normalizeStatusInput(status, statusRegistry) === statusRegistry.close_status
  );
}

/** True when an update's `--unset` names `close_reason`, tokenized like the update parser. */
function unsetsCloseReason(options: UpdateCommandOptions): boolean {
  const isCloseReasonAlias = (entry: string): boolean =>
    CLOSE_REASON_UNSET_ALIASES.includes(entry.trim().toLowerCase());
  return expandUnsetFieldTokens(options.unset ?? [], isCloseReasonAlias).some(isCloseReasonAlias);
}

/**
 * Refuse, before any write, a close-status update that unsets the close
 * reason without supplying a new one while `governance.require_close_reason`
 * is enabled. Neither route may run first: the repeated-state path would
 * persist the unset as a no-op closure, and the ordinary route applies its
 * field pre-update before the closure writer's own refusal.
 */
export function assertRoutedCloseKeepsRequiredReason(context: CloseRouteContext): void {
  if (!context.settings.governance.require_close_reason || !unsetsCloseReason(context.options)) {
    return;
  }
  requireTerminalReason({ explicit: context.options.closeReason }, true);
}

/**
 * True when the requested close status, reason and completion time already
 * describe the stored item. Such an update is not a transition: routing it to
 * the closure writer would re-stamp `closed_at` and `updated_at` on every
 * retry (GH-1628), while the same identical payload on an open item is a
 * no-op. A blank reason under `governance.require_close_reason` is not a
 * repetition either: the closure writer must refuse it exactly as it would on
 * an open item.
 */
export function describesCurrentTerminalState(
  metadata: ItemMetadata,
  options: UpdateCommandOptions,
  statusRegistry: RuntimeStatusRegistry,
  requireCloseReason = false,
): boolean {
  if (!isCloseStatus(metadata.status, statusRegistry)) {
    return false;
  }
  const requestedReason = normalizeTerminalReasonInput(options.closeReason);
  if (
    requireCloseReason &&
    options.closeReason !== undefined &&
    requestedReason === undefined
  ) {
    return false;
  }
  if (
    requestedReason !== undefined &&
    requestedReason !== normalizeTerminalReasonInput(metadata.close_reason)
  ) {
    return false;
  }
  // Stored completion times are canonical ISO strings from resolveIsoOrRelative;
  // resolve the request the same way so an equivalent spelling is still a repeat.
  return (
    options.completedAt === undefined ||
    resolveIsoOrRelative(options.completedAt, new Date(), "completed-at") ===
      metadata.completed_at
  );
}

/** Read the stored metadata of the item an update is routing, refusing with the shared not-found guidance. */
export async function readRoutedItemMetadata(
  context: CloseRouteContext,
): Promise<ItemMetadata> {
  const located = await locateItem(
    context.pmRoot,
    context.id,
    context.settings.id_prefix,
    context.settings.item_format,
    context.typeRegistry.type_to_folder,
  );
  if (!located) {
    throw await buildItemNotFoundError(
      context.pmRoot,
      context.id,
      context.settings.id_prefix,
      context.typeRegistry.type_to_folder,
    );
  }
  const { document } = await readLocatedItem(located, {
    schema: context.settings.schema,
  });
  return document.metadata;
}

/**
 * Apply the non-terminal fields of an update whose close status, reason and
 * completion time already match the stored item. The closure clocks and the
 * terminal history stay untouched; the remaining fields take the ordinary
 * update path, which skips the write when nothing changes. The classification
 * read holds no item lock, so when the locked write returns an item another
 * writer has reopened, or whose reason or completion time changed meanwhile,
 * the request no longer repeats the stored state and `closeReopened` hands it
 * to the closure writer instead of reporting it unchanged.
 */
export async function applyRepeatedTerminalStateUpdate(
  context: CloseRouteContext,
  metadata: ItemMetadata,
  otherFieldKeys: readonly string[],
  runUpdate: (
    id: string,
    options: UpdateCommandOptions,
    global: GlobalOptions,
  ) => Promise<UpdateResult>,
  closeReopened: (fieldUpdate: UpdateResult) => Promise<UpdateResult>,
): Promise<UpdateResult> {
  if (otherFieldKeys.length === 0) {
    return {
      item: toItemRecord(metadata),
      changed_fields: [],
      warnings: [
        ...context.workflowTransitionWarnings,
        TERMINAL_STATE_UNCHANGED_WARNING,
      ],
    };
  }
  const remainingOptions = transferMutationStdinTokenPolicy(context.options, {
    ...context.options,
    status: undefined,
    closeReason: undefined,
    completedAt: undefined,
  });
  const result = await runUpdate(context.id, remainingOptions, context.global);
  // Recheck under the write's own result: another writer may have reopened
  // the item or changed its reason or completion time since classification.
  if (
    !describesCurrentTerminalState(
      result.item as unknown as ItemMetadata,
      context.options,
      context.statusRegistry,
      context.settings.governance.require_close_reason,
    )
  ) {
    return closeReopened(result);
  }
  return {
    item: result.item,
    changed_fields: result.changed_fields,
    warnings: [
      ...context.workflowTransitionWarnings,
      ...result.warnings,
      TERMINAL_STATE_UNCHANGED_WARNING,
    ],
  };
}
