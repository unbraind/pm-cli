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
  toItemRecord,
  transferMutationStdinTokenPolicy,
  type GlobalOptions,
  type RuntimeStatusRegistry,
} from "../runtime-primitives.js";
import type { ItemMetadata } from "../../types/index.js";
import type { CloseRouteContext, UpdateCommandOptions, UpdateResult } from "./update.js";

/** Receipt for an update that repeats the item's current terminal state, so no closure clock is re-stamped (GH-1628). */
export const TERMINAL_STATE_UNCHANGED_WARNING = "terminal_state_unchanged";

function normalizeTerminalReasonInput(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * True when the requested close status, reason and completion time already
 * describe the stored item. Such an update is not a transition: routing it to
 * the closure writer would re-stamp `closed_at` and `updated_at` on every
 * retry (GH-1628), while the same identical payload on an open item is a
 * no-op.
 */
export function describesCurrentTerminalState(
  metadata: ItemMetadata,
  options: UpdateCommandOptions,
  statusRegistry: RuntimeStatusRegistry,
): boolean {
  if (
    normalizeStatusInput(metadata.status, statusRegistry) !==
    statusRegistry.close_status
  ) {
    return false;
  }
  const requestedReason = normalizeTerminalReasonInput(options.closeReason);
  if (
    requestedReason !== undefined &&
    requestedReason !== normalizeTerminalReasonInput(metadata.close_reason)
  ) {
    return false;
  }
  return (
    options.completedAt === undefined ||
    options.completedAt === metadata.completed_at
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
 * update path, which skips the write when nothing changes.
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
