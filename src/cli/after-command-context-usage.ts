/**
 * @module cli/after-command-context-usage
 *
 * Records privacy-minimal context feedback after successful CLI mutations.
 */
import {
  finishTelemetryCommand,
  getActiveCommandResult,
  readSettings,
  resolveAuthor,
  type ActiveTelemetryCommand,
  type TelemetryCommandOutcome,
} from "../sdk/runtime-primitives.js";
import {
  finalizeContextUsageDelivery,
  recordContextUsageTouches,
} from "../sdk/context-usage.js";

/** Inputs required to attribute one completed command's affected items. */
export interface AfterCommandContextUsageOptions {
  /** Active tracker root. */
  pmRoot: string;
  /** Optional invocation-wide author override. */
  author?: string;
  /** Affected item identifiers, empty for failed or read-only commands. */
  itemIds: readonly string[];
  /** Stable command intent recorded beside derived touch rows. */
  intent: string;
}

/** Finalizes the active telemetry command with its normalized CLI outcome. */
export async function finishActiveTelemetryCommand(
  runtime: ActiveTelemetryCommand | null,
  outcome: TelemetryCommandOutcome,
): Promise<void> {
  await finishTelemetryCommand(runtime, {
    ok: outcome.ok,
    error: outcome.error,
    result: getActiveCommandResult(),
    exit_code: outcome.exit_code,
    error_code: outcome.error_code,
    error_category: outcome.error_category,
    command_resolution: outcome.command_resolution,
    resolution_stage: outcome.resolution_stage,
  });
}

/** Records derived touch rows through the same author resolver as mutations. */
export async function recordAfterCommandContextUsage(
  options: AfterCommandContextUsageOptions,
): Promise<void> {
  if (process.env.PM_CONTEXT_USAGE_DISABLED === "1") return;
  await finalizeContextUsageDelivery({
    pmRoot: options.pmRoot,
    result: getActiveCommandResult(),
  });
  const settings = await readSettings(options.pmRoot);
  await recordContextUsageTouches({
    pmRoot: options.pmRoot,
    author: resolveAuthor(options.author, settings.author_default),
    itemIds: options.itemIds,
    intent: options.intent,
  });
}
