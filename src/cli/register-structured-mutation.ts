/**
 * @module cli/register-structured-mutation
 *
 * Registers the noun-first CLI adapter for public SDK atomic item mutations.
 */
import type { Command } from "commander";
import {
  createStdinTokenResolver,
  EXIT_CODE,
  PmCliError,
  resolveAuthor,
  resolvePmRoot,
} from "../sdk/runtime-primitives.js";
import { commitItemMutations } from "../sdk/item-transaction.js";
import {
  parseAtomicMutationControls,
  parseItemMutationBatch,
} from "../sdk/structured-mutations.js";
import { getGlobalOptions, printResult } from "./registration-helpers.js";

async function runItemMutateAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const input = await createStdinTokenResolver().resolveValue(
    "-",
    "--stdin-json",
  );
  if (input === undefined || input.trim().length === 0) {
    throw new PmCliError(
      "pm item mutate requires a non-empty JSON batch on stdin.",
      EXIT_CODE.USAGE,
    );
  }
  const mutations = parseItemMutationBatch(input);
  const transactionId =
    typeof options.transactionId === "string"
      ? options.transactionId.trim()
      : "";
  if (transactionId.length === 0) {
    throw new PmCliError(
      "pm item mutate requires --transaction-id <value>.",
      EXIT_CODE.USAGE,
    );
  }
  const controls = parseAtomicMutationControls(options);
  if (options.dryRun === true) {
    printResult(
      {
        transaction_id: transactionId,
        dry_run: true,
        mutation_count: mutations.length,
        mutations,
      },
      globalOptions,
    );
    return;
  }
  const result = await commitItemMutations({
    pmRoot: resolvePmRoot(process.cwd(), globalOptions.path),
    transactionId,
    author: resolveAuthor(
      typeof options.author === "string"
        ? options.author
        : globalOptions.author,
      "unknown",
    ),
    mutations,
    ...controls,
  });
  printResult({ ...result, mutation_count: mutations.length }, globalOptions);
}

/** Register `pm item mutate`, the stable noun-first atomic batch surface. */
export function registerStructuredMutationCommands(program: Command): void {
  const itemCommand =
    program.commands.find((command) => command.name() === "item") ??
    program
      .command("item")
      .description("Run item lifecycle and mutation operations.");
  itemCommand
    .command("mutate")
    .requiredOption(
      "--transaction-id <value>",
      "Stable idempotency key used to resume an interrupted batch",
    )
    .option("--stdin-json", "Read the JSON mutation array from stdin", true)
    .option("--dry-run", "Validate and preview the batch without writing")
    .option(
      "--create-compensation <mode>",
      "Created-item compensation policy: close or delete",
      "close",
    )
    .option(
      "--lock-ttl-seconds <n>",
      "Workspace transaction lock lifetime in seconds",
    )
    .option(
      "--lock-wait-ms <n>",
      "Maximum time to wait for the workspace transaction lock",
    )
    .option("--author <value>", "Mutation author")
    .description(
      "Apply create/update/close mutations atomically through the public pm SDK.",
    )
    .action(runItemMutateAction);
}

/** Internal action hooks used by exhaustive source-level registration tests. */
export const structuredMutationTestOnly = { runItemMutateAction };
