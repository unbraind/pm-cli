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
  readSettings,
  resolveAuthor,
  resolvePmRoot,
} from "../sdk/runtime-primitives.js";
import {
  buildItemCompletionMutations,
  commitItemCompletion,
  commitItemMutations,
} from "../sdk/item-transaction.js";
import { runReopen } from "../sdk/lifecycle/reopen.js";
import {
  parseAtomicMutationControls,
  resolveItemMutationDocument,
} from "../sdk/structured-mutations.js";
import {
  collect,
  getGlobalOptions,
  invalidateSearchCachesForMutation,
  printResult,
} from "./registration-helpers.js";

async function runItemReopenAction(
  id: string,
  reason: string,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const result = await runReopen(
    id,
    reason,
    {
      status: typeof options.status === "string" ? options.status : undefined,
      author: typeof options.author === "string" ? options.author : undefined,
      message:
        typeof options.message === "string" ? options.message : undefined,
      force: options.force === true,
    },
    globalOptions,
  );
  await invalidateSearchCachesForMutation(globalOptions, result);
  printResult(result, globalOptions);
}

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
  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  const settings = await readSettings(pmRoot);
  const resolved = resolveItemMutationDocument(input, {
    transactionId,
    idPrefix: settings.id_prefix,
  });
  const { mutations, references } = resolved;
  const controls = parseAtomicMutationControls(options);
  if (options.dryRun === true) {
    printResult(
      {
        transaction_id: transactionId,
        dry_run: true,
        mutation_count: mutations.length,
        mutations,
        references,
      },
      globalOptions,
    );
    return;
  }
  const result = await commitItemMutations({
    pmRoot,
    transactionId,
    author: resolveAuthor(
      typeof options.author === "string"
        ? options.author
        : globalOptions.author,
      settings.author_default,
    ),
    mutations,
    ...controls,
  });
  printResult(
    { ...result, mutation_count: mutations.length, references },
    globalOptions,
  );
}

function resolveCompletionReason(
  positionalReason: string | undefined,
  optionReason: unknown,
): string {
  if (
    typeof positionalReason === "string" &&
    positionalReason.trim().length > 0
  ) {
    return positionalReason.trim();
  }
  return typeof optionReason === "string" ? optionReason.trim() : "";
}

async function runItemCompleteAction(
  id: string,
  positionalReason: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const transactionId =
    typeof options.transactionId === "string"
      ? options.transactionId.trim()
      : "";
  if (transactionId.length === 0) {
    throw new PmCliError(
      "pm item complete requires --transaction-id <value>.",
      EXIT_CODE.USAGE,
    );
  }
  const reason = resolveCompletionReason(positionalReason, options.reason);
  if (reason.length === 0) {
    throw new PmCliError(
      "pm item complete requires a close reason.",
      EXIT_CODE.USAGE,
    );
  }
  const evidenceKeys = [
    "file",
    "doc",
    "test",
    "comment",
    "note",
    "learning",
  ] as const;
  const evidence = Object.fromEntries(
    evidenceKeys
      .filter((key) => options[key] !== undefined)
      .map((key) => [key, options[key]]),
  );
  const force = options.force === true;
  const { lockTtlSeconds, lockWaitMs } = parseAtomicMutationControls(options);
  const closeOptions = {
    ...(typeof options.resolution === "string"
      ? { resolution: options.resolution }
      : {}),
    ...(typeof options.expectedResult === "string"
      ? { expectedResult: options.expectedResult }
      : {}),
    ...(typeof options.actualResult === "string"
      ? { actualResult: options.actualResult }
      : {}),
    ...(typeof options.completedAt === "string"
      ? { completedAt: options.completedAt }
      : {}),
    ...(typeof options.validateClose === "string"
      ? { validateClose: options.validateClose }
      : {}),
    ...(force ? { force: true } : {}),
  };
  const completion = {
    id,
    reason,
    ...(Object.keys(evidence).length === 0 ? {} : { evidence }),
    ...(Object.keys(closeOptions).length === 0 ? {} : { closeOptions }),
    ...(force ? { releaseOptions: { force: true } } : {}),
  };
  if (options.dryRun === true) {
    const mutations = buildItemCompletionMutations(completion);
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
  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  const result = await commitItemCompletion({
    pmRoot,
    transactionId,
    author: resolveAuthor(
      typeof options.author === "string"
        ? options.author
        : globalOptions.author,
      (await readSettings(pmRoot)).author_default,
    ),
    ...completion,
    lockTtlSeconds,
    lockWaitMs,
  });
  printResult(
    { ...result, mutation_count: Object.keys(result.results).length },
    globalOptions,
  );
}

/** Register `pm item mutate`, the stable noun-first atomic batch surface. */
export function registerStructuredMutationCommands(program: Command): void {
  const itemCommand =
    program.commands.find((command) => command.name() === "item") ??
    program
      .command("item")
      .description("Run item lifecycle operations.");
  itemCommand
    .command("reopen <id> <reason>")
    .option("--status <value>", "Active target status: open or in_progress")
    .option("--message <value>", "Human-readable recurrence history message")
    .option("--force", "Override ownership or stale-lock conflicts")
    .option("--author <value>", "Mutation author")
    .description(
      "Reopen terminal work with recurrence evidence.",
    )
    .action(runItemReopenAction);
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
      "Apply SDK-backed mutations atomically.",
    )
    .action(runItemMutateAction);
  itemCommand
    .command("complete <id> [reason]")
    .requiredOption(
      "--transaction-id <value>",
      "Stable idempotency key for the composed completion",
    )
    .option("--reason <value>", "Close reason when omitted positionally")
    .option("--file <value>", "Linked file evidence", collect)
    .option("--doc <value>", "Linked documentation evidence", collect)
    .option("--test <value>", "Linked test evidence", collect)
    .option("--comment <value>", "Evidence comment", collect)
    .option("--note <value>", "Completion note", collect)
    .option("--learning <value>", "Durable completion learning", collect)
    .option("--resolution <value>", "Structured resolution evidence")
    .option("--expected-result <value>", "Expected result evidence")
    .option("--actual-result <value>", "Actual result evidence")
    .option("--completed-at <value>", "Actual completion time")
    .option("--validate-close <mode>", "Close validation: off, warn, or strict")
    .option(
      "--lock-ttl-seconds <n>",
      "Workspace transaction lock lifetime in seconds",
    )
    .option(
      "--lock-wait-ms <n>",
      "Maximum time to wait for the workspace transaction lock",
    )
    .option("--dry-run", "Validate and preview completion without writing")
    .option("--force", "Override lifecycle and ownership conflicts")
    .option("--author <value>", "Completion author")
    .description(
      "Close with evidence and release the claim.",
    )
    .action(runItemCompleteAction);
}

/** Internal action hooks used by exhaustive source-level registration tests. */
export const structuredMutationTestOnly = {
  runItemCompleteAction,
  runItemMutateAction,
  runItemReopenAction,
};
