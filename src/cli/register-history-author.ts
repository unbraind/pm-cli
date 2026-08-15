/**
 * @module cli/register-history-author
 *
 * Registers the append-only remediation surface for unknown history authors.
 */
import type { Command } from "commander";
import { resolvePmRoot } from "../sdk/runtime-primitives.js";
import { acknowledgeUnknownAuthorHistoryEventsFromTransport } from "../sdk/author-attribution.js";
import {
  collect,
  getGlobalOptions,
  printResult,
  readOptionString,
} from "./registration-helpers.js";

async function runHistoryAuthorAcknowledgeAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const rawEvents = Array.isArray(options.event)
    ? (options.event as string[])
    : [];
  const result = await acknowledgeUnknownAuthorHistoryEventsFromTransport(
    resolvePmRoot(process.cwd(), globalOptions.path),
    {
      historyEvent: rawEvents,
      allActionable: options.allActionable === true,
      dryRun: options.dryRun === true,
      planFingerprint: readOptionString(options, "planFingerprint"),
      limit: options.limit,
      attributedAuthor: readOptionString(options, "attributedAuthor"),
      reviewer: readOptionString(options, "reviewer"),
      reason: readOptionString(options, "reason"),
    },
  );
  printResult(result, globalOptions);
}

/** Register the evidence-backed immutable-history author disposition command. */
export function registerHistoryAuthorAcknowledgeCommand(
  program: Command,
): void {
  program
    .command("history-author-acknowledge")
    .option(
      "--event <item-id:line>",
      "Unknown-author event coordinate (repeatable)",
      collect,
    )
    .option("--all-actionable", "Select all actionable events")
    .option("--dry-run", "Preview a deterministic source-bound plan")
    .option(
      "--plan-fingerprint <sha256>",
      "Apply the exact fingerprint returned by --dry-run",
    )
    .option("--limit <n>", "Maximum coordinate rows returned in the plan")
    .option("--attributed-author <value>", "Reviewed principal attribution")
    .option("--reviewer <value>", "Disposition reviewer")
    .option("--reason <value>", "Review evidence")
    .description(
      "Append audited dispositions for immutable unknown-author events.",
    )
    .action(runHistoryAuthorAcknowledgeAction);
}
