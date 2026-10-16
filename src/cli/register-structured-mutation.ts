/**
 * @module cli/register-structured-mutation
 *
 * Registers the noun-first CLI adapter for public SDK atomic item mutations.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import {
  createStdinTokenResolver,
  EXIT_CODE,
  PmCliError,
  readSettings,
  resolveAuthor,
  resolvePmRoot,
} from "../sdk/runtime-primitives.js";
import { describeUnknownError } from "../sdk/error-runtime.js";
import { planItemMutationDocument } from "../sdk/lifecycle/structured-mutation-plan.js";
import {
  buildItemCompletionMutations,
  commitItemCompletion,
  commitItemMutations,
  previewItemMutations,
} from "../sdk/item-transaction.js";
import { runReopen } from "../sdk/lifecycle/reopen.js";
import { parseAtomicMutationControls } from "../sdk/structured-mutations.js";
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
  const expectedResult = options.expectedResult ?? options.expected;
  const result = await runReopen(
    id,
    reason,
    {
      status: typeof options.status === "string" ? options.status : undefined,
      expectedResult: typeof expectedResult === "string" ? expectedResult : undefined,
      author:
        typeof options.author === "string"
          ? options.author
          : globalOptions.author,
      message:
        typeof options.message === "string" ? options.message : undefined,
      force: options.force === true,
    },
    globalOptions,
  );
  await invalidateSearchCachesForMutation(globalOptions, result);
  printResult(result, globalOptions);
}

/** Read the mutation document from `--from <path>` (or `-` for stdin) or from the default stdin JSON channel. */
async function readItemMutateInput(
  options: Record<string, unknown>,
  command: Command,
): Promise<string> {
  const from = typeof options.from === "string" ? options.from.trim() : "";
  if (from.length > 0 && from !== "-") {
    if (command.getOptionValueSource("stdinJson") === "cli") {
      throw new PmCliError(
        "pm item mutate cannot combine --from <path> with explicit --stdin-json. Select one input source.",
        EXIT_CODE.USAGE,
      );
    }
    try {
      return await readFile(path.resolve(process.cwd(), from), "utf8");
    } catch (error: unknown) {
      throw new PmCliError(
        `pm item mutate could not read --from ${from}: ${describeUnknownError(error)}`,
        EXIT_CODE.USAGE,
        {
          code: "mutation_document_unreadable",
          required: "Pass a readable JSON, JSON Lines, or envelope document path, or `-` for stdin.",
          why: "The whole document must be available before any tracker write begins.",
        },
      );
    }
  }
  const input = await createStdinTokenResolver().resolveValue(
    "-",
    "--stdin-json",
  );
  return input ?? "";
}

/** Preview or commit the ordered item plan through the shared lifecycle coordinator. */
async function runItemMutateAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const input = await readItemMutateInput(options, command);
  if (input.trim().length === 0) {
    throw new PmCliError(
      "pm item mutate requires a non-empty JSON batch on stdin or via --from <path>.",
      EXIT_CODE.USAGE,
    );
  }
  if (options.transactionId !== undefined && (typeof options.transactionId !== "string" || options.transactionId.trim().length === 0)) {
    throw new PmCliError(
      "pm item mutate requires --transaction-id <value> to be non-empty when provided.",
      EXIT_CODE.USAGE,
    );
  }
  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  const settings = await readSettings(pmRoot);
  const plan = await planItemMutationDocument({
    pmRoot,
    input,
    settings,
    ...(typeof options.transactionId === "string"
      ? { transactionId: options.transactionId }
      : {}),
    ...(typeof options.upsertKey === "string"
      ? { upsertKey: options.upsertKey }
      : {}),
  });
  const { mutations, references, rows } = plan;
  const transactionId = plan.transaction_id;
  const receipt = {
    transaction_id: transactionId,
    transaction_id_source: plan.transaction_id_source,
    ...(plan.upsert_key === undefined ? {} : { upsert_key: plan.upsert_key }),
  };
  const controls = parseAtomicMutationControls(options);
  const author = resolveAuthor(
    typeof options.author === "string" ? options.author : globalOptions.author,
    settings.author_default,
  );
  if (options.dryRun === true) {
    const validation = await previewItemMutations({ pmRoot, transactionId, author, mutations });
    printResult(
      {
        ...receipt,
        dry_run: true,
        validation,
        mutation_count: mutations.length,
        mutations,
        references,
        rows,
      },
      globalOptions,
    );
    return;
  }
  const result = await commitItemMutations({
    pmRoot,
    transactionId,
    author,
    mutations,
    ...controls,
  });
  printResult(
    { ...result, ...receipt, mutation_count: mutations.length, references, rows },
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

/** Compose completion evidence, closure and release before previewing or committing the plan. */
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
  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  const author = resolveAuthor(
    typeof options.author === "string" ? options.author : globalOptions.author,
    (await readSettings(pmRoot)).author_default,
  );
  if (options.dryRun === true) {
    const mutations = buildItemCompletionMutations(completion);
    const validation = await previewItemMutations({ pmRoot, transactionId, author, mutations });
    printResult(
      {
        transaction_id: transactionId,
        dry_run: true,
        validation,
        mutation_count: mutations.length,
        mutations,
      },
      globalOptions,
    );
    return;
  }
  const result = await commitItemCompletion({
    pmRoot,
    transactionId,
    author,
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
    .option("--expected-result <value>", "Current active planning expectation; otherwise the receipt offers recovery")
    .option("--expected <value>", "Alias for --expected-result")
    .option("--message <value>", "Human-readable recurrence history message")
    .option("--force", "Override ownership or stale-lock conflicts")
    .option("--author <value>", "Mutation author")
    .description(
      "Reopen terminal work with recurrence evidence.",
    )
    .action(runItemReopenAction);
  itemCommand
    .command("mutate")
    .option(
      "--transaction-id <value>",
      "Stable idempotency key used to resume an interrupted batch; derived from the document when omitted",
    )
    .option("--stdin-json", "Read the JSON mutation array from stdin", true)
    .option("--from <path>", "Read the JSON, JSON Lines, or envelope document from a file (- for stdin)")
    .option("--upsert-key <field>", "Update the existing item whose field matches instead of creating a duplicate")
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
