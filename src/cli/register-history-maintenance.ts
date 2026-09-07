/**
 * @module cli/register-history-maintenance
 *
 * Registers native history maintenance and permanent legacy spellings from
 * the same option and action definitions; all behavior remains SDK-owned.
 */
import type { Command } from "commander";
import {
  EXIT_CODE,
  PmCliError,
  resolveCliBulkIdsInput,
  splitCommaList,
} from "../sdk/runtime-primitives.js";
import {
  assertHistoryCompactTarget,
  runHistoryCompact,
  runHistoryCompactBulk,
} from "./commands/history-compact.js";
import { runHistoryRedact } from "./commands/history-redact.js";
import {
  assertHistoryRepairTarget,
  runHistoryRepair,
  runHistoryRepairAll,
} from "./commands/history-repair.js";
import { runRestore } from "./commands/restore.js";
import {
  collect,
  getGlobalOptions,
  invalidateSearchCachesForMutation,
  printError,
  printResult,
  readOptionString,
} from "./registration-helpers.js";

/** Validate bulk numeric selectors without accepting signed or partial numeric input. */
function parseNonNegativeIntFlag(
  raw: unknown,
  flag: string,
): number | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(parsed)) {
    throw new PmCliError(
      `history-compact ${flag} must be a non-negative integer.`,
      EXIT_CODE.USAGE,
    );
  }
  return parsed;
}

/** Resolve bulk input sources and delegate single or multi-stream compaction to the SDK. */
async function runHistoryCompactAction(
  id: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const idsValue = await resolveCliBulkIdsInput(
    readOptionString(options, "ids"),
  );
  const ids = idsValue === undefined ? undefined : splitCommaList(idsValue);
  const allOver = parseNonNegativeIntFlag(options.allOver, "--all-over");
  const minEntries = parseNonNegativeIntFlag(
    options.minEntries,
    "--min-entries",
  );
  if (options.closed === true && options.allStreams === true) {
    throw new PmCliError(
      "history-compact: --closed and --all-streams are mutually exclusive; pick one lifecycle scope.",
      EXIT_CODE.USAGE,
    );
  }
  const scope =
    options.closed === true
      ? "closed"
      : options.allStreams === true
        ? "all-streams"
        : undefined;
  const isBulk =
    ids !== undefined || allOver !== undefined || scope !== undefined;
  if (isBulk && typeof options.before === "string") {
    throw new PmCliError(
      "history-compact: --before applies only in single-id mode (bulk mode always compacts full streams).",
      EXIT_CODE.USAGE,
    );
  }
  assertHistoryCompactTarget(id, { ids, allOver, scope });
  if (id === undefined) {
    const result = await runHistoryCompactBulk(
      {
        ids,
        scope,
        allOver,
        minEntries,
        dryRun: options.dryRun === true,
        author: readOptionString(options, "author"),
        message: readOptionString(options, "message"),
        force: Boolean(options.force),
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (result.totals.items_errored > 0) {
      process.exitCode = EXIT_CODE.GENERIC_FAILURE;
    }
  } else {
    const result = await runHistoryCompact(
      id,
      {
        before: readOptionString(options, "before"),
        dryRun: options.dryRun === true,
        author: readOptionString(options, "author"),
        message: readOptionString(options, "message"),
        force: Boolean(options.force),
      },
      globalOptions,
    );
    printResult(result, globalOptions);
  }
  if (globalOptions.profile) {
    printError(
      `profile:command=history-compact took_ms=${Date.now() - startedAt}`,
    );
  }
}

/** Restore through the lifecycle SDK and invalidate derived search state after mutation. */
async function runRestoreAction(
  id: string,
  target: string,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const result = await runRestore(
    id,
    target,
    {
      author: readOptionString(options, "author"),
      message: readOptionString(options, "message"),
      force: Boolean(options.force),
    },
    globalOptions,
  );
  await invalidateSearchCachesForMutation(globalOptions, result);
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=restore took_ms=${Date.now() - startedAt}`);
  }
}

/** Install identical maintenance actions at the history namespace or legacy root. */
export function registerHistoryMaintenanceCommands(
  parent: Command,
  native: boolean,
): void {
  parent
    .command("restore", { hidden: !native })
    .summary("Restore a version.")
    .argument("<id>", "Item id")
    .argument("<target>", "Restore target timestamp or version number")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership/lock override")
    .description("Restore an item to an earlier timestamp or version.")
    .action(runRestoreAction);

  parent
    .command(native ? "redact" : "history-redact", { hidden: !native })
    .summary("Redact sensitive values.")
    .argument("<id>", "Item id")
    .option(
      "--literal <value>",
      "Literal string to redact (repeatable)",
      collect,
    )
    .option(
      "--regex <value>",
      "Regex pattern to redact (repeatable; accepts /pattern/flags or raw pattern)",
      collect,
    )
    .option(
      "--replacement <value>",
      'Replacement string (default: "[redacted]")',
    )
    .option(
      "--dry-run",
      "Preview redaction impact without writing item/history files",
    )
    .option("--author <value>", "Mutation author")
    .option(
      "--message <value>",
      "Audit history message for the redaction marker entry",
    )
    .option("--force", "Force ownership/lock override")
    .description(
      "Redact sensitive literals/patterns from an item history stream and recompute hashes.",
    )
    .action(
      async (id: string, options: Record<string, unknown>, command) => {
        const globalOptions = getGlobalOptions(command);
        const startedAt = Date.now();
        const literal = Array.isArray(options.literal)
          ? (options.literal as string[])
          : undefined;
        const regex = Array.isArray(options.regex)
          ? (options.regex as string[])
          : undefined;
        const result = await runHistoryRedact(
          id,
          {
            literal,
            regex,
            replacement: readOptionString(options, "replacement"),
            dryRun: options.dryRun === true,
            author: readOptionString(options, "author"),
            message: readOptionString(options, "message"),
            force: Boolean(options.force),
          },
          globalOptions,
        );
        if (result.changed && !result.dry_run) {
          await invalidateSearchCachesForMutation(globalOptions, result);
        }
        printResult(result, globalOptions);
        if (globalOptions.profile) {
          printError(
            `profile:command=history-redact took_ms=${Date.now() - startedAt}`,
          );
        }
      },
    );

  parent
    .command(native ? "repair" : "history-repair", { hidden: !native })
    .summary("Repair drift.")
    .argument("[id]", "Item id (omit with --all)")
    .option(
      "--salvage-tail",
      "Recover invalid tail; requires verified prefix",
    )
    .option(
      "--all",
      "Scan every stream for drift and repair each drifted stream in one audited pass",
    )
    .option(
      "--dry-run",
      "Preview the re-anchor impact without writing the history file",
    )
    .option(
      "--normalize-provenance",
      "Remove invalid provenance; return aggregate-only evidence",
    )
    .option("--author <value>", "Mutation author")
    .option(
      "--message <value>",
      "Audit history message for the repair marker entry",
    )
    .option("--force", "Force ownership/lock override")
    .description(
      "Re-anchor a drifted item history chain (recompute hashes, reconcile with the on-disk item) and record an audit marker. Use --all to repair every drifted stream.",
    )
    .action(
      async (
        id: string | undefined,
        options: Record<string, unknown>,
        command,
      ) => {
        const globalOptions = getGlobalOptions(command);
        const startedAt = Date.now();
        const all = options.all === true;
        assertHistoryRepairTarget(id, all);
        const repairOptions = {
          dryRun: options.dryRun === true,
          author: readOptionString(options, "author"),
          message: readOptionString(options, "message"),
          force: Boolean(options.force),
          normalizeProvenance: options.normalizeProvenance === true,
          salvageTail: options.salvageTail === true,
        };
        // history-repair only re-anchors the audit stream; item content is untouched,
        // so search caches do not need invalidation.
        if (all) {
          const result = await runHistoryRepairAll(
            repairOptions,
            globalOptions,
          );
          printResult(result, globalOptions);
          if (result.totals.failed > 0) {
            // Per-stream failures are collected (one bad stream never aborts the
            // pass) but must still fail the command for gating callers.
            process.exitCode = EXIT_CODE.GENERIC_FAILURE;
          }
        } else {
          const result = await runHistoryRepair(
            id as string,
            repairOptions,
            globalOptions,
          );
          printResult(result, globalOptions);
        }
        if (globalOptions.profile) {
          printError(
            `profile:command=history-repair took_ms=${Date.now() - startedAt}`,
          );
        }
      },
    );

  parent
    .command(native ? "compact" : "history-compact", { hidden: !native })
    .summary("Compact streams.")
    .argument("[id]", "Item id (omit when using a bulk selector)")
    .option(
      "--before <value>",
      "Compact entries strictly before this version number or ISO timestamp (single-id mode only)",
    )
    .option(
      "--ids <value>",
      "Bulk IDs: comma/newline text, - stdin, or @path file",
    )
    .option(
      "--all-over <n>",
      "Bulk: compact every stream with more than N entries",
    )
    .option(
      "--closed",
      "Bulk: compact only closed (terminal) items' streams",
    )
    .option(
      "--all-streams",
      "Bulk: compact every history stream regardless of lifecycle state",
    )
    .option(
      "--min-entries <n>",
      "Bulk: skip streams with at most N entries (already compact; default 3)",
    )
    .option(
      "--dry-run",
      "Preview compaction impact without writing the history file",
    )
    .option("--author <value>", "Mutation author")
    .option(
      "--message <value>",
      "Audit history message for the compaction marker entry",
    )
    .option("--force", "Force ownership/lock override")
    .description(
      "Compact item history streams into a synthetic baseline plus retained tail entries. Pass an item id for one stream, or a bulk selector (--ids/--all-over/--closed/--all-streams) to compact many.",
    )
    .action(runHistoryCompactAction);
}
