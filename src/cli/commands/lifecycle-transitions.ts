/**
 * @module cli/commands/lifecycle-transitions
 *
 * Implements the pm lifecycle transitions command surface and its agent-facing runtime behavior.
 */
import {
  normalizeStatusInputWithRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";

/** GH-216: a contextual next-step hint that nudges agents toward the underutilized `in_progress` lifecycle state instead of jumping straight from `open` to `closed`. The suggestion is intentionally non-binding (no governance enforcement) and only surfaces when a richer transition genuinely exists. */
export interface LifecycleTransitionSuggestion {
  /** Ready-to-run command that advances the item to the suggested status. */
  command: string;
  /** The status the suggested command moves the item to. */
  to_status: string;
}

/** Item types whose lifecycle does not follow the `open -> in_progress -> closed` work path. Scheduling/reference types are tracked or scheduled rather than "worked", so a `start-task` nudge would be noise. Compared case-insensitively against the resolved item type. */
const NON_WORKABLE_TYPES = new Set([
  "event",
  "meeting",
  "reminder",
  "milestone",
  "decision",
  "adr",
]);

/**
 * Suggest the next lifecycle transition for a freshly created (or open) item.
 *
 * Returns a `pm start-task` hint when the item is a workable type currently in
 * the workspace open status AND the workflow defines a distinct `in_progress`
 * status to advance to. Returns `undefined` (no hint) otherwise — including for
 * scheduling types and workflows that collapse `in_progress` into `open` — so
 * the suggestion never fabricates a transition the workflow cannot perform.
 */
export function suggestNextLifecycleTransition(
  id: string,
  type: string,
  status: string,
  statusRegistry: RuntimeStatusRegistry,
): LifecycleTransitionSuggestion | undefined {
  if (NON_WORKABLE_TYPES.has(type.trim().toLowerCase())) {
    return undefined;
  }
  if (status !== statusRegistry.open_status) {
    return undefined;
  }
  const inProgress = normalizeStatusInputWithRegistry(
    "in_progress",
    statusRegistry,
  );
  if (inProgress === undefined || inProgress === statusRegistry.open_status) {
    return undefined;
  }
  return { command: `pm start-task ${id}`, to_status: inProgress };
}
