/**
 * @module sdk/lifecycle/reopen
 *
 * Reopens terminal work as a recurrence while preserving immutable closure
 * evidence and delegating every state change to the canonical update pipeline.
 */
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import { resolveRuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { resolveStartTaskInProgressStatus } from "../start-task-status.js";
import {
  runReopenUpdate,
  type PreviousTerminalEvidence,
} from "./update.js";

/** Options accepted by the SDK and `pm item reopen` recurrence primitive. */
export interface ReopenCommandOptions {
  /** Active target status; only the workspace open or in-progress status is allowed. */
  status?: string;
  /** Explicit mutation author override. */
  author?: string;
  /** Optional human-readable history message in addition to structured recurrence context. */
  message?: string;
  /** Override an ownership or stale-lock conflict. */
  force?: boolean;
}

/** Structured recurrence receipt returned by every presentation surface. */
export interface RecurrenceReceipt {
  /** Required reason that the terminal work became active again. */
  reason: string;
  /** Terminal status observed while holding the item lock. */
  from_status: string;
  /** Active status written through the update pipeline. */
  to_status: string;
  /** Prior terminal evidence retained in immutable history. */
  previous_terminal: PreviousTerminalEvidence;
}

/** Result returned after a terminal item is reopened. */
export interface ReopenResult {
  /** Reopened item metadata. */
  item: Record<string, unknown>;
  /** Fields changed by the canonical update pipeline. */
  changed_fields: string[];
  /** Non-fatal mutation and extension warnings. */
  warnings: string[];
  /** Immutable recurrence transition receipt. */
  recurrence: RecurrenceReceipt;
}

/** Reopen terminal work through the canonical update mutation and history path. */
export async function runReopen(
  id: string,
  reason: string,
  options: ReopenCommandOptions,
  global: GlobalOptions,
): Promise<ReopenResult> {
  const normalizedReason = reason.trim();
  if (normalizedReason.length === 0) {
    throw new PmCliError(
      "pm item reopen requires a non-empty recurrence reason.",
      EXIT_CODE.USAGE,
      {
        code: "reopen_reason_required",
        required: "Describe why the terminal work became active again.",
        recovery: {
          suggested_retry: `pm item reopen ${id} "<recurrence reason>"`,
          suggested_retry_args: ["item", "reopen", id, "<recurrence reason>"],
        },
      },
    );
  }
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const statusRegistry = resolveRuntimeStatusRegistry(
    (await readSettings(pmRoot)).schema,
  );
  const openStatus = statusRegistry.open_status;
  const inProgressStatus = resolveStartTaskInProgressStatus(statusRegistry);
  const requestedStatus = options.status ?? openStatus;
  const targetStatus =
    normalizeStatusInput(requestedStatus, statusRegistry) ?? requestedStatus;
  if (targetStatus !== openStatus && targetStatus !== inProgressStatus) {
    throw new PmCliError(
      `Reopen target status must be ${openStatus} or ${inProgressStatus}; received ${requestedStatus}.`,
      EXIT_CODE.USAGE,
      {
        code: "reopen_target_status_invalid",
        required: "Choose the workspace open or in-progress lifecycle status.",
        recovery: {
          allowed_values: [...new Set([openStatus, inProgressStatus])],
          suggested_retry: `pm item reopen ${id} "${normalizedReason}" --status ${openStatus}`,
          suggested_retry_args: [
            "item",
            "reopen",
            id,
            normalizedReason,
            "--status",
            openStatus,
          ],
        },
      },
    );
  }
  const update = await runReopenUpdate(
    id,
    {
      status: targetStatus,
      unset: [
        "close-reason",
        "resolution",
        "expected-result",
        "actual-result",
        "fixed-version",
      ],
      author: options.author,
      message: options.message,
      force: options.force,
    },
    global,
    normalizedReason,
  );
  return {
    item: update.item,
    changed_fields: update.changed_fields,
    warnings: update.warnings,
    recurrence: update.lifecycle_transition,
  };
}
