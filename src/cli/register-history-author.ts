/**
 * @module cli/register-history-author
 *
 * Registers the append-only remediation surface for unknown history authors.
 */
import type { Command } from "commander";
import {
  EXIT_CODE,
  PmCliError,
  resolvePmRoot,
} from "../sdk/runtime-primitives.js";
import { acknowledgeUnknownAuthorHistoryEvents } from "../sdk/author-attribution.js";
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
  const rawEvents = options.event as string[];
  const events = rawEvents.map((value) => {
    const separator = value.lastIndexOf(":");
    const itemId = value.slice(0, separator).trim();
    const line = Number(value.slice(separator + 1));
    if (
      separator < 1 ||
      !/^[a-z0-9][a-z0-9-]*$/iu.test(itemId) ||
      !Number.isSafeInteger(line) ||
      line < 1
    ) {
      throw new PmCliError(
        `history-author-acknowledge --event expects <item-id>:<one-based-line>, received "${value}".`,
        EXIT_CODE.USAGE,
      );
    }
    return { item_id: itemId, line };
  });
  const result = await acknowledgeUnknownAuthorHistoryEvents(
    resolvePmRoot(process.cwd(), globalOptions.path),
    {
      events,
      attributed_author: readOptionString(options, "attributedAuthor") as string,
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
    .requiredOption(
      "--event <item-id:line>",
      "Actionable unknown-author history event (repeatable)",
      collect,
    )
    .requiredOption(
      "--attributed-author <value>",
      "Principal attributed by evidence-backed maintainer review",
    )
    .requiredOption("--reviewer <value>", "Reviewer recording the disposition")
    .requiredOption("--reason <value>", "Evidence-backed review rationale")
    .description(
      "Disposition immutable post-baseline unknown-author events through an append-only workspace audit event.",
    )
    .action(runHistoryAuthorAcknowledgeAction);
}
