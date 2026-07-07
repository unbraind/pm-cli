/**
 * @module sdk/start-task-status
 *
 * Resolves lifecycle alias status transitions shared by CLI registration and the SDK runtime.
 */
import {
  normalizeStatusInputWithRegistry,
  type RuntimeStatusRegistry,
} from "../core/schema/runtime-schema.js";

/**
 * Resolve the status the `start-task` lifecycle alias should move an item to.
 * Resolves `in_progress` strictly through the workspace registry so a custom
 * workflow that omits in_progress falls back to its open status instead of
 * setting a status the workflow does not define.
 */
export function resolveStartTaskInProgressStatus(statusRegistry: RuntimeStatusRegistry): string {
  return normalizeStatusInputWithRegistry("in_progress", statusRegistry) ?? statusRegistry.open_status;
}
