/**
 * @module cli/register-history-activity
 *
 * Shares history activity options and output handling across native and legacy entrypoints.
 */
import type { Command } from "commander";
import { EXIT_CODE, PmCliError } from "../sdk/runtime-primitives.js";
import { runActivity } from "./commands/activity.js";
import {
  collect,
  getGlobalOptions,
  normalizeActivityOptions,
  printActivityJsonStream,
  printError,
  printResult,
  resolveActivityStreamMode,
} from "./registration-helpers.js";

/** Validate projection and streaming choices before rendering SDK activity results. */
async function runActivityAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  if (
    [options.raw, options.compact, options.full, options.provenance].filter(
      (value) => value === true,
    ).length > 1
  ) {
    throw new PmCliError(
      "Activity projection options are mutually exclusive. Use --raw, --compact, --provenance, or --full.",
      EXIT_CODE.USAGE,
    );
  }
  const streamMode = resolveActivityStreamMode(options.stream);
  if (streamMode && !globalOptions.json) {
    throw new PmCliError(
      "--stream requires --json output mode.",
      EXIT_CODE.USAGE,
    );
  }
  const normalized = normalizeActivityOptions(options);
  const result = await runActivity(
    streamMode && options.full !== true && options.provenance !== true
      ? { ...normalized, raw: true, compact: true }
      : normalized,
    globalOptions,
  );
  if (streamMode) {
    printActivityJsonStream(result, normalized, globalOptions);
  } else {
    printResult(result, globalOptions);
  }
  if (globalOptions.profile) {
    printError(
      `profile:command=activity took_ms=${Date.now() - startedAt}`,
    );
  }
}

/** Configure an activity leaf with the shared projection and streaming contract. */
export function registerHistoryActivityCommand(command: Command): void {
  command
    .option("--id <value>", "Filter by item ID")
    .option("--op <value>", "Filter by history operation")
    .option("--author <value>", "Filter by history author")
    .option(
      "--from <value>",
      "Lower timestamp bound (ISO/date string or relative)",
    )
    .option(
      "--to <value>",
      "Upper timestamp bound (ISO/date string or relative)",
    )
    .option("--limit <n>", "Return only the latest n activity entries")
    .option(
      "--unbounded",
      "Explicitly return every matching activity entry (disables the default bound)",
    )
    .option(
      "--compact",
      "Condensed output: show only id, op, ts, author, msg per entry",
    )
    .option(
      "--raw",
      "Show the legacy compact per-event stream instead of the item digest",
    )
    .option("--full", "Show full activity entries with JSON Patch payloads")
    .option(
      "--provenance",
      "Show patch-free author, harness, instance, and extensible provenance",
    )
    .option(
      "--provenance-summary",
      "Include bounded provenance completeness counts",
    )
    .option(
      "--harness <value>",
      "Filter by recorded or vocabulary-resolved harness (repeatable)",
      collect,
    )
    .option(
      "--agent-instance <value>",
      "Filter by privacy-safe agent instance (repeatable)",
      collect,
    )
    .option(
      "--provenance-filter <dimension=value>",
      "Filter by an exact declared provenance value (repeatable)",
      collect,
    )
    .option(
      "--stream [mode]",
      "Emit line-delimited JSON rows (requires --json). Optional mode: rows|ndjson|jsonl",
    )
    .description("Show recent activity across items.")
    .action(runActivityAction);
}
