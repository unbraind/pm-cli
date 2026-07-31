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
  const rawEvents = Array.isArray(options.event)
    ? (options.event as string[])
    : [];
  const allActionable = options.allActionable === true;
  if ((rawEvents.length === 0) === !allActionable) {
    throw new PmCliError(
      "Specify exactly one selector: repeat --event or pass --all-actionable.",
      EXIT_CODE.USAGE,
      {
        code: "history_author_acknowledge_selector_required",
        required: "Exactly one of --event or --all-actionable",
        examples: [
          'pm history-author-acknowledge --event pm-a1b2:4 --attributed-author agent --reviewer maintainer --reason "Verified provenance"',
          'pm history-author-acknowledge --all-actionable --attributed-author import-agent --reviewer maintainer --reason "Reviewed the complete actionable set"',
        ],
      },
    );
  }
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
      all_actionable: allActionable,
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
