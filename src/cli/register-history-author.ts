/**
 * @module cli/register-history-author
 *
 * Registers the append-only remediation surface for unknown history authors.
 */
import type { Command } from "commander";
import { resolvePmRoot } from "../sdk/runtime-primitives.js";
import {
  acknowledgeUnknownAuthorHistoryEvents,
  resolveUnknownAuthorAcknowledgmentSelector,
} from "../sdk/author-attribution.js";
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
  const selector = resolveUnknownAuthorAcknowledgmentSelector(
    rawEvents,
    options.allActionable === true,
  );
  const result = await acknowledgeUnknownAuthorHistoryEvents(
    resolvePmRoot(process.cwd(), globalOptions.path),
    {
      events: selector.events,
      all_actionable: selector.all_actionable,
      attributed_author: readOptionString(
        options,
        "attributedAuthor",
      ) as string,
      reviewer: readOptionString(options, "reviewer") as string,
      reason: readOptionString(options, "reason") as string,
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
    .requiredOption(
      "--attributed-author <value>",
      "Reviewed principal attribution",
    )
    .requiredOption("--reviewer <value>", "Disposition reviewer")
    .requiredOption("--reason <value>", "Review evidence")
    .description(
      "Append audited dispositions for immutable unknown-author events.",
    )
    .action(runHistoryAuthorAcknowledgeAction);
}
