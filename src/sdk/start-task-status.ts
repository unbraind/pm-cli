/**
 * @module sdk/start-task-status
 *
 * Resolves lifecycle alias status transitions shared by CLI registration and the SDK runtime.
 */
import {
  normalizeStatusInputWithRegistry,
  type RuntimeStatusRegistry,
} from "../core/schema/runtime-schema.js";

/** Resolve the status a start moves an item to. A configured in-progress status distinct from the open status wins (for example `workflow.in_progress_status: "working"`); otherwise `in_progress` resolves through the registry's ids and aliases, and a workflow without one falls back to its open status instead of inventing a status it does not define. */
export function resolveStartTaskInProgressStatus(
  statusRegistry: RuntimeStatusRegistry,
): string {
  // A workflow may still name a status that `pm schema remove-status` deleted; never start into an unregistered status.
  if (
    statusRegistry.in_progress_status !== statusRegistry.open_status &&
    statusRegistry.by_id.has(statusRegistry.in_progress_status)
  ) {
    return statusRegistry.in_progress_status;
  }
  return (
    normalizeStatusInputWithRegistry("in_progress", statusRegistry) ??
    statusRegistry.open_status
  );
}
