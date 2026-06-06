import { Option, type Command } from "commander";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { isPureSnakeCaseAlias } from "../core/shared/option-alias-visibility.js";
import {
  CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS,
  UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS,
  type CommanderOptionRegistrationContract,
} from "../sdk/cli-contracts.js";
import { BUILTIN_ITEM_TYPE_VALUES } from "../types/index.js";

// Lowercase set of built-in type names ("epic", "feature", ...) used by the
// `pm create` positional guard (pm-edge #1, 2026-05-28): if the single
// positional exactly matches a known type AND no --title was given, we throw
// instead of silently creating a Task titled with the type name.
const BUILTIN_TYPE_NAME_LOOKUP = new Set<string>(BUILTIN_ITEM_TYPE_VALUES.map((value) => value.toLowerCase()));
import {
  collect,
  extractUpdateManyMutationOptionSource,
  formatHookWarnings,
  getGlobalOptions,
  invalidateSearchCachesForMutation,
  normalizeCreateOptions,
  normalizeUpdateOptions,
  printError,
  printResult,
  writeStdout,
} from "./registration-helpers.js";



/**
 * Register a flag and hide it from `--help` text while keeping it fully
 * functional as a parse-time alias. The option still appears in
 * `command.options`, so the JSON help payload and shell completion (which read
 * from the contracts/commander option list, not the rendered text) are
 * unchanged — only commander's text `--help` omits it.
 */
function addHiddenOption(command: Command, flags: string, description: string, repeatable: boolean): void {
  const option = new Option(flags, description).hideHelp();
  if (repeatable) {
    option.argParser(collect);
  }
  command.addOption(option);
}

/**
 * Parse the `--order` value for `pm schema add-status`. Accepts a value that is
 * already a number or a numeric string; throws a usage error when the flag was
 * supplied but does not parse to a finite integer (rather than silently dropping
 * it). Returns `undefined` only when the flag was genuinely not provided.
 */
function parseSchemaOrderOption(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) {
      throw new PmCliError("--order must be a finite integer.", EXIT_CODE.USAGE);
    }
    return raw;
  }
  if (typeof raw === "string") {
    if (raw.trim().length === 0) {
      return undefined;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
      throw new PmCliError("--order must be a finite integer.", EXIT_CODE.USAGE);
    }
    return parsed;
  }
  throw new PmCliError("--order must be a finite integer.", EXIT_CODE.USAGE);
}

function registerCommanderOptionContracts(command: Command, contracts: CommanderOptionRegistrationContract[]): void {
  for (const contract of contracts) {
    if (contract.required) {
      command.requiredOption(contract.option, contract.description);
    } else if (contract.repeatable) {
      command.option(contract.option, contract.description, collect);
    } else {
      command.option(contract.option, contract.description);
    }
    for (const aliasContract of contract.aliasOptions ?? []) {
      // Hide pure snake_case underscore-duplicate aliases (e.g. --create_mode
      // for --create-mode) from --help, but keep semantically-distinct aliases
      // (e.g. --ac for --acceptance-criteria) visible.
      if (isPureSnakeCaseAlias(contract.option, aliasContract.option)) {
        addHiddenOption(command, aliasContract.option, aliasContract.description, contract.repeatable === true);
      } else if (contract.repeatable) {
        command.option(aliasContract.option, aliasContract.description, collect);
      } else {
        command.option(aliasContract.option, aliasContract.description);
      }
    }
  }
}

export function registerMutationCommands(program: Command): void {
  const createCommand = program
    .command("create")
    .argument("[typeOrTitle]", "Item title, or item type when a title follows (e.g. `pm create task \"Fix bug\"`)")
    .argument("[title]", "Item title when the first argument is an item type")
    .description("Create a new project management item.");
  registerCommanderOptionContracts(createCommand, CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS);
  createCommand
    .option("--clear-deps", "Clear dependency entries")
    .option("--clear-comments", "Clear comments")
    .option("--clear-notes", "Clear notes")
    .option("--clear-learnings", "Clear learnings")
    .option("--clear-files", "Clear linked files")
    .option("--clear-tests", "Clear linked tests")
    .option("--clear-docs", "Clear linked docs")
    .option("--clear-reminders", "Clear reminders")
    .option("--clear-events", "Clear events")
    .option("--clear-type-options", "Clear type options")
    .action(async (
      typeOrTitle: string | undefined,
      secondTitle: string | undefined,
      options: Record<string, unknown>,
      command,
    ) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      // Support both `pm create "<title>"` and the natural subcommand-style
      // `pm create <type> "<title>"` so agents are never blocked by argument
      // count. When two positionals are given, the first is the item type.
      let positionalType: string | undefined;
      let positionalTitle: string | undefined;
      if (typeof secondTitle === "string" && secondTitle.length > 0) {
        positionalType = typeOrTitle;
        positionalTitle = secondTitle;
      } else if (typeof typeOrTitle === "string" && typeOrTitle.length > 0) {
        positionalTitle = typeOrTitle;
      }
      // pm-edge #1 (2026-05-28): when the sole positional matches a known
      // item type AND no --title was supplied, refuse early instead of
      // silently creating a Task titled with the type name (e.g. `pm create
      // Epic` would previously produce a Task literally titled "Epic"). The
      // guard fires only for the ambiguous single-positional case so the
      // documented `pm create <type> <title>` flow stays a never-block.
      if (
        positionalType === undefined &&
        typeof positionalTitle === "string" &&
        positionalTitle.length > 0 &&
        options.title === undefined &&
        options.type === undefined &&
        BUILTIN_TYPE_NAME_LOOKUP.has(positionalTitle.trim().toLowerCase())
      ) {
        const matchedType = positionalTitle.trim();
        throw new PmCliError(
          `pm create needs a title — "${matchedType}" looks like an item type, not a title. Use either: pm create ${matchedType} "<title>" or pm create "<title>" --type ${matchedType}.`,
          EXIT_CODE.USAGE,
          {
            code: "create_positional_type_without_title",
            why: "Without this guard the single positional is used as the title and the type defaults to Task — so the command would silently create a Task literally titled \"" + matchedType + "\".",
            examples: [
              `pm create ${matchedType} "Wire up SSO for the agent harness"`,
              `pm create "Wire up SSO for the agent harness" --type ${matchedType}`,
            ],
            nextSteps: [
              `Re-run with both type and title: pm create ${matchedType} "<title>"`,
            ],
          },
        );
      }
      if (typeof positionalType === "string" && positionalType.length > 0 && options.type === undefined) {
        options.type = positionalType;
      }
      if (typeof positionalTitle === "string" && positionalTitle.length > 0 && options.title === undefined) {
        options.title = positionalTitle;
      }
      const normalized = normalizeCreateOptions(options, { requireType: false });
      const { runCreate } = await import("./commands/create.js");
      const result = await runCreate(normalized, globalOptions);
      await invalidateSearchCachesForMutation(globalOptions, result);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=create took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("copy")
    .argument("<id>", "Source item id")
    .option("--title <value>", "Optional title override for the copied item")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .description("Copy an item into a new item id while resetting lifecycle fields.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runCopy } = await import("./commands/copy.js");
      const result = await runCopy(
        id,
        {
          title: typeof options.title === "string" ? options.title : undefined,
          author: typeof options.author === "string" ? options.author : undefined,
          message: typeof options.message === "string" ? options.message : undefined,
        },
        globalOptions,
      );
      await invalidateSearchCachesForMutation(globalOptions, result);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=copy took_ms=${Date.now() - startedAt}`);
      }
    });

  const updateCommand = program
    .command("update")
    .argument("<id>", "Item id")
    .description("Update item fields and metadata.");
  registerCommanderOptionContracts(updateCommand, UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS);
  updateCommand
    .option("--replace-deps", "Atomically replace dependency entries with the provided --dep values")
    .option("--replace-tests", "Atomically replace linked test entries with the provided --test values")
    .option("--clear-deps", "Clear dependency entries")
    .option("--clear-comments", "Clear comments")
    .option("--clear-notes", "Clear notes")
    .option("--clear-learnings", "Clear learnings")
    .option("--clear-files", "Clear linked files")
    .option("--clear-tests", "Clear linked tests")
    .option("--clear-docs", "Clear linked docs")
    .option("--clear-reminders", "Clear reminders")
    .option("--clear-events", "Clear events")
    .option("--clear-type-options", "Clear type options")
    .option("--allow-audit-update", "Allow non-owner metadata-only audit updates without requiring --force")
    .option("--allow-audit-dep-update", "Allow non-owner append-only dependency updates without requiring --force")
    .option("--force", "Force ownership override");
  addHiddenOption(updateCommand, "--allow_audit_update", "Alias for --allow-audit-update", false);
  addHiddenOption(updateCommand, "--allow_audit_dep_update", "Alias for --allow-audit-dep-update", false);
  updateCommand
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runUpdate } = await import("./commands/update.js");
      const result = await runUpdate(id, normalizeUpdateOptions(options), globalOptions);
      await invalidateSearchCachesForMutation(globalOptions, result);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=update took_ms=${Date.now() - startedAt}`);
      }
    });

  const updateManyCommand = program
    .command("update-many")
    .description("Bulk-update matched items with dry-run plans and rollback checkpoints.")
    .option("--filter-status <value>", "Filter by status before applying updates")
    .option("--filter-type <value>", "Filter by item type before applying updates")
    .option("--filter-tag <value>", "Filter by tag before applying updates")
    .option("--filter-priority <value>", "Filter by priority before applying updates")
    .option("--filter-deadline-before <value>", "Filter by deadline upper bound before applying updates")
    .option("--filter-deadline-after <value>", "Filter by deadline lower bound before applying updates")
    .option("--filter-updated-after <value>", "Filter by updated_at lower bound before applying updates (ISO/relative)")
    .option("--filter-updated-before <value>", "Filter by updated_at upper bound before applying updates (ISO/relative)")
    .option("--filter-created-after <value>", "Filter by created_at lower bound before applying updates (ISO/relative)")
    .option("--filter-created-before <value>", "Filter by created_at upper bound before applying updates (ISO/relative)")
    .option("--filter-assignee <value>", "Filter by assignee before applying updates")
    .option("--filter-assignee-filter <value>", "Filter assignee presence: assigned|unassigned before applying updates")
    .option("--filter-parent <value>", "Filter by parent item ID before applying updates")
    .option("--filter-sprint <value>", "Filter by sprint before applying updates")
    .option("--filter-release <value>", "Filter by release before applying updates")
    .option("--ids <value>", "Restrict to an explicit comma-separated ID allowlist (intersected with other filters)")
    .option("--limit <n>", "Limit matched item count before apply/preview")
    .option("--offset <n>", "Skip first n matched rows before apply/preview")
    .option("--dry-run", "Preview per-item diffs and checkpoint intent without mutating")
    .option("--rollback <value>", "Rollback a prior update-many checkpoint ID")
    .option("--no-checkpoint", "Disable checkpoint creation during apply mode")
    .option("--title, -t <value>", "Set title")
    .option("--description, -d <value>", "Set description")
    .option("--body, -b <value>", "Set body (allow empty string)")
    .option("--status, -s <value>", "Set status (use close command for closed)")
    .option("--priority, -p <value>", "Set priority")
    .option("--type <value>", "Set type")
    .option("--tags <value>", "Set comma-separated tags (replaces existing). Use --add-tags / --remove-tags to mutate additively.")
    .option("--add-tags <value>", "Add tags additively without replacing existing (repeatable; CSV accepted)", collect)
    .option("--remove-tags <value>", "Remove tags from the existing list (repeatable; CSV accepted)", collect)
    .option("--deadline <value>", "Set deadline (ISO/date string or relative)")
    .option("--estimate, --estimated-minutes <value>", "Set estimated minutes")
    .option("--acceptance-criteria <value>", "Set acceptance criteria")
    .option("--ac <value>", "Alias for --acceptance-criteria")
    .option("--definition-of-ready <value>", "Set definition of ready")
    .option("--order <value>", "Set planning order/rank integer")
    .option("--rank <value>", "Alias for --order")
    .option("--goal <value>", "Set goal identifier")
    .option("--objective <value>", "Set objective identifier")
    .option("--value <value>", "Set business value summary")
    .option("--impact <value>", "Set business impact summary")
    .option("--outcome <value>", "Set expected outcome summary")
    .option("--why-now <value>", "Set why-now rationale")
    .option("--assignee <value>", "Set assignee")
    .option("--parent <value>", "Set parent item ID")
    .option("--reviewer <value>", "Set reviewer")
    .option("--risk <value>", "Set risk level")
    .option("--confidence <value>", "Set confidence level")
    .option("--sprint <value>", "Set sprint identifier")
    .option("--release <value>", "Set release identifier")
    .option("--blocked-by <value>", "Set blocked-by item ID or reason")
    .option("--blocked-reason <value>", "Set blocked reason")
    .option("--unblock-note <value>", "Set unblock rationale note")
    .option("--reporter <value>", "Set issue reporter")
    .option("--severity <value>", "Set issue severity")
    .option("--environment <value>", "Set issue environment context")
    .option("--repro-steps <value>", "Set issue reproduction steps")
    .option("--resolution <value>", "Set issue resolution summary")
    .option("--expected-result <value>", "Set issue expected behavior")
    .option("--expected <value>", "Short alias for --expected-result")
    .option("--actual-result <value>", "Set issue observed behavior")
    .option("--actual <value>", "Short alias for --actual-result")
    .option("--affected-version <value>", "Set affected version identifier")
    .option("--fixed-version <value>", "Set fixed version identifier")
    .option("--component <value>", "Set issue component ownership")
    .option("--regression <value>", "Set regression marker: true|false|1|0")
    .option("--customer-impact <value>", "Set customer impact summary")
    .option("--dep <value>", "Add dependency entry id=<id>,kind=<kind>,author=<author>,created_at=<timestamp>", collect)
    .option("--dep-remove <value>", "Remove dependency entries by id/kind/author/timestamp signature", collect)
    .option("--replace-deps", "Atomically replace dependency entries with provided --dep values")
    .option("--replace-tests", "Atomically replace linked tests with provided --test values")
    .option("--comment <value>", "Add comment seed author=<value>,created_at=<iso|now>,text=<value>", collect)
    .option("--note <value>", "Add note seed author=<value>,created_at=<iso|now>,text=<value>", collect)
    .option("--learning <value>", "Add learning seed author=<value>,created_at=<iso|now>,text=<value>", collect)
    .option("--file <value>", "Add linked file path=<value>,scope=<project|global>,note=<text>", collect)
    .option("--test <value>", "Add linked test command=<value>,path=<value>,scope=<project|global>", collect)
    .option("--doc <value>", "Add linked doc path=<value>,scope=<project|global>,note=<text>", collect)
    .option("--reminder <value>", "Add reminder entry at=<iso|relative>|date=<iso|relative>,text=<text>|title=<text>", collect)
    .option("--event <value>", "Add event entry start=<iso|relative>,end=<iso|relative>,recur_*", collect)
    .option("--type-option <value>", "Set type options key=value (repeatable)", collect)
    .option("--unset <field>", "Clear scalar metadata field by name (repeatable)", collect)
    .option("--clear-deps", "Clear dependency entries")
    .option("--clear-comments", "Clear comments")
    .option("--clear-notes", "Clear notes")
    .option("--clear-learnings", "Clear learnings")
    .option("--clear-files", "Clear linked files")
    .option("--clear-tests", "Clear linked tests")
    .option("--clear-docs", "Clear linked docs")
    .option("--clear-reminders", "Clear reminders")
    .option("--clear-events", "Clear events")
    .option("--clear-type-options", "Clear type options")
    .option("--allow-audit-update", "Allow non-owner metadata-only audit updates without requiring --force")
    .option("--allow-audit-dep-update", "Allow non-owner append-only dependency updates without requiring --force")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "Mutation message")
    .option("--force", "Force ownership override");
  // Hidden pure snake_case underscore-duplicate aliases (kept parse-functional,
  // omitted from --help to save agent context).
  for (const [flags, description] of [
    ["--filter-assignee_filter <value>", "Alias for --filter-assignee-filter"],
    ["--estimated_minutes <value>", "Alias for --estimated-minutes"],
    ["--acceptance_criteria <value>", "Alias for --acceptance-criteria"],
    ["--definition_of_ready <value>", "Alias for --definition-of-ready"],
    ["--why_now <value>", "Alias for --why-now"],
    ["--blocked_by <value>", "Alias for --blocked-by"],
    ["--blocked_reason <value>", "Alias for --blocked-reason"],
    ["--unblock_note <value>", "Alias for --unblock-note"],
    ["--repro_steps <value>", "Alias for --repro-steps"],
    ["--expected_result <value>", "Alias for --expected-result"],
    ["--actual_result <value>", "Alias for --actual-result"],
    ["--affected_version <value>", "Alias for --affected-version"],
    ["--fixed_version <value>", "Alias for --fixed-version"],
    ["--customer_impact <value>", "Alias for --customer-impact"],
    ["--allow_audit_update", "Alias for --allow-audit-update"],
    ["--allow_audit_dep_update", "Alias for --allow-audit-dep-update"],
  ] as const) {
    addHiddenOption(updateManyCommand, flags, description, false);
  }
  for (const [flags, description] of [
    ["--dep_remove <value>", "Alias for --dep-remove"],
    ["--type_option <value>", "Alias for --type-option"],
    ["--add_tags <value>", "Alias for --add-tags"],
    ["--remove_tags <value>", "Alias for --remove-tags"],
  ] as const) {
    addHiddenOption(updateManyCommand, flags, description, true);
  }
  updateManyCommand
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runUpdateMany } = await import("./commands/update-many.js");
      const result = await runUpdateMany(
        {
          status: typeof options.filterStatus === "string" ? options.filterStatus : undefined,
          list: {
            type: typeof options.filterType === "string" ? options.filterType : undefined,
            tag: typeof options.filterTag === "string" ? options.filterTag : undefined,
            priority: typeof options.filterPriority === "string" ? options.filterPriority : undefined,
            deadlineBefore: typeof options.filterDeadlineBefore === "string" ? options.filterDeadlineBefore : undefined,
            deadlineAfter: typeof options.filterDeadlineAfter === "string" ? options.filterDeadlineAfter : undefined,
            updatedAfter: typeof options.filterUpdatedAfter === "string" ? options.filterUpdatedAfter : undefined,
            updatedBefore: typeof options.filterUpdatedBefore === "string" ? options.filterUpdatedBefore : undefined,
            createdAfter: typeof options.filterCreatedAfter === "string" ? options.filterCreatedAfter : undefined,
            createdBefore: typeof options.filterCreatedBefore === "string" ? options.filterCreatedBefore : undefined,
            ids: typeof options.ids === "string" ? options.ids : undefined,
            assignee: typeof options.filterAssignee === "string" ? options.filterAssignee : undefined,
            assigneeFilter:
              typeof options.filterAssigneeFilter === "string"
                ? options.filterAssigneeFilter
                : typeof options.filterAssignee_filter === "string"
                  ? options.filterAssignee_filter
                  : undefined,
            parent: typeof options.filterParent === "string" ? options.filterParent : undefined,
            sprint: typeof options.filterSprint === "string" ? options.filterSprint : undefined,
            release: typeof options.filterRelease === "string" ? options.filterRelease : undefined,
            limit: typeof options.limit === "string" ? options.limit : undefined,
            offset: typeof options.offset === "string" ? options.offset : undefined,
            includeBody: true,
          },
          update: normalizeUpdateOptions(extractUpdateManyMutationOptionSource(options)),
          dryRun: options.dryRun === true ? true : undefined,
          rollback: typeof options.rollback === "string" ? options.rollback : undefined,
          checkpoint: options.checkpoint === false ? false : undefined,
        },
        globalOptions,
      );
      await invalidateSearchCachesForMutation(globalOptions, result);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=update-many took_ms=${Date.now() - startedAt}`);
      }
    });

  const closeCommand = program
    .command("close")
    .argument("<id>", "Item id")
    .argument("[text]", "Close reason text (alias: --reason)")
    .option("--reason <value>", "Close reason text (alias for positional <text>)")
    .option("--close-reason <value>", "Close reason text (alias for positional <text>)")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--validate-close [mode]", 'Validate closure metadata before close: "off", "warn", or "strict" (default: settings governance preset)')
    .option("--resolution <value>", "Set the closure resolution summary inline (same field --validate-close strict checks; previously required a prior pm update)")
    .option("--expected-result <value>", "Set the expected-result note inline (closure validation field)")
    .option("--expected <value>", "Short alias for --expected-result")
    .option("--actual-result <value>", "Set the actual-result note inline (closure validation field)")
    .option("--actual <value>", "Short alias for --actual-result")
    .option("--force", "Force ownership override")
    .description("Close an item. Close reason requirement follows governance.require_close_reason.");
  // pm-fl0c #11 (2026-05-28): expose snake_case aliases alongside the canonical
  // kebab-case so agents using --expected_result/--actual_result do not get an
  // Unknown option error; the rendered help stays clean (aliases hidden).
  addHiddenOption(closeCommand, "--expected_result <value>", "Alias for --expected-result", false);
  addHiddenOption(closeCommand, "--actual_result <value>", "Alias for --actual-result", false);
  closeCommand
    .action(async (id: string, text: string | undefined, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runClose } = await import("./commands/close.js");
      const reasonFromOption =
        (typeof options.reason === "string" && options.reason.trim().length > 0 && options.reason) ||
        (typeof options.closeReason === "string" && options.closeReason.trim().length > 0 && options.closeReason) ||
        undefined;
      const resolvedText = typeof text === "string" && text.length > 0 ? text : reasonFromOption;
      const pickInlineString = (...candidates: unknown[]): string | undefined => {
        for (const candidate of candidates) {
          if (typeof candidate === "string") {
            return candidate;
          }
        }
        return undefined;
      };
      const result = await runClose(
        id,
        resolvedText,
        {
          author: typeof options.author === "string" ? options.author : undefined,
          message: typeof options.message === "string" ? options.message : undefined,
          validateClose:
            options.validateClose === true
              ? "warn"
              : typeof options.validateClose === "string"
                ? options.validateClose
                : undefined,
          force: Boolean(options.force),
          resolution: typeof options.resolution === "string" ? options.resolution : undefined,
          expectedResult: pickInlineString(options.expectedResult, options.expected_result, options.expected),
          actualResult: pickInlineString(options.actualResult, options.actual_result, options.actual),
        },
        globalOptions,
      );
      await invalidateSearchCachesForMutation(globalOptions, result);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=close took_ms=${Date.now() - startedAt}`);
      }
    });

  const closeManyCommand = program
    .command("close-many")
    .description("Bulk-close matched items with a shared reason and full runClose semantics (dry-run + rollback checkpoint).")
    .option("--filter-status <value>", "Filter by status before closing")
    .option("--filter-type <value>", "Filter by item type before closing")
    .option("--filter-tag <value>", "Filter by tag before closing")
    .option("--filter-priority <value>", "Filter by priority before closing")
    .option("--filter-deadline-before <value>", "Filter by deadline upper bound before closing")
    .option("--filter-deadline-after <value>", "Filter by deadline lower bound before closing")
    .option("--filter-updated-after <value>", "Filter by updated_at lower bound before closing (ISO/relative)")
    .option("--filter-updated-before <value>", "Filter by updated_at upper bound before closing (ISO/relative)")
    .option("--filter-created-after <value>", "Filter by created_at lower bound before closing (ISO/relative)")
    .option("--filter-created-before <value>", "Filter by created_at upper bound before closing (ISO/relative)")
    .option("--filter-assignee <value>", "Filter by assignee before closing")
    .option("--filter-assignee-filter <value>", "Filter assignee presence: assigned|unassigned before closing")
    .option("--filter-parent <value>", "Filter by parent item ID before closing")
    .option("--filter-sprint <value>", "Filter by sprint before closing")
    .option("--filter-release <value>", "Filter by release before closing")
    .option("--ids <value>", "Restrict to an explicit comma-separated ID allowlist (intersected with other filters)")
    .option("--limit <n>", "Limit matched item count before apply/preview")
    .option("--offset <n>", "Skip first n matched rows before apply/preview")
    .option("--reason <value>", "Shared close reason applied to matched items (required when governance.require_close_reason is enabled)")
    .option("--resolution <value>", "Shared closure resolution applied to every matched item (closure-validation field)")
    .option("--expected-result <value>", "Shared expected-result note (closure-validation field)")
    .option("--expected <value>", "Short alias for --expected-result")
    .option("--actual-result <value>", "Shared actual-result note (closure-validation field)")
    .option("--actual <value>", "Short alias for --actual-result")
    .option("--validate-close [mode]", 'Validate closure metadata per item: "off", "warn", or "strict" (default: settings governance preset)')
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Re-close already-terminal matches and override ownership")
    .option("--dry-run", "Preview matched items + per-item skip/active-child plan without mutating")
    .option("--rollback <value>", "Rollback a prior close-many checkpoint ID")
    .option("--no-checkpoint", "Disable checkpoint creation during apply mode");
  addHiddenOption(closeManyCommand, "--filter-assignee_filter <value>", "Alias for --filter-assignee-filter", false);
  addHiddenOption(closeManyCommand, "--expected_result <value>", "Alias for --expected-result", false);
  addHiddenOption(closeManyCommand, "--actual_result <value>", "Alias for --actual-result", false);
  closeManyCommand.action(async (options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const pickString = (...candidates: unknown[]): string | undefined => {
      for (const candidate of candidates) {
        if (typeof candidate === "string") {
          return candidate;
        }
      }
      return undefined;
    };
    const { runCloseMany } = await import("./commands/close-many.js");
    const result = await runCloseMany(
      {
        status: typeof options.filterStatus === "string" ? options.filterStatus : undefined,
        list: {
          type: typeof options.filterType === "string" ? options.filterType : undefined,
          tag: typeof options.filterTag === "string" ? options.filterTag : undefined,
          priority: typeof options.filterPriority === "string" ? options.filterPriority : undefined,
          deadlineBefore: typeof options.filterDeadlineBefore === "string" ? options.filterDeadlineBefore : undefined,
          deadlineAfter: typeof options.filterDeadlineAfter === "string" ? options.filterDeadlineAfter : undefined,
          updatedAfter: typeof options.filterUpdatedAfter === "string" ? options.filterUpdatedAfter : undefined,
          updatedBefore: typeof options.filterUpdatedBefore === "string" ? options.filterUpdatedBefore : undefined,
          createdAfter: typeof options.filterCreatedAfter === "string" ? options.filterCreatedAfter : undefined,
          createdBefore: typeof options.filterCreatedBefore === "string" ? options.filterCreatedBefore : undefined,
          ids: typeof options.ids === "string" ? options.ids : undefined,
          assignee: typeof options.filterAssignee === "string" ? options.filterAssignee : undefined,
          assigneeFilter: pickString(options.filterAssigneeFilter, options.filterAssignee_filter),
          parent: typeof options.filterParent === "string" ? options.filterParent : undefined,
          sprint: typeof options.filterSprint === "string" ? options.filterSprint : undefined,
          release: typeof options.filterRelease === "string" ? options.filterRelease : undefined,
          limit: typeof options.limit === "string" ? options.limit : undefined,
          offset: typeof options.offset === "string" ? options.offset : undefined,
        },
        reason: typeof options.reason === "string" ? options.reason : undefined,
        resolution: typeof options.resolution === "string" ? options.resolution : undefined,
        expectedResult: pickString(options.expectedResult, options.expected_result, options.expected),
        actualResult: pickString(options.actualResult, options.actual_result, options.actual),
        validateClose:
          options.validateClose === true
            ? "warn"
            : typeof options.validateClose === "string"
              ? options.validateClose
              : undefined,
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
        dryRun: options.dryRun === true ? true : undefined,
        rollback: typeof options.rollback === "string" ? options.rollback : undefined,
        checkpoint: options.checkpoint === false ? false : undefined,
      },
      globalOptions,
    );
    await invalidateSearchCachesForMutation(globalOptions, result);
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=close-many took_ms=${Date.now() - startedAt}`);
    }
  });

  program
    .command("delete")
    .argument("<id>", "Item id")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership override")
    .option("--dry-run", "Preview the item file that would be deleted without mutating")
    .description("Delete an item and record the change in history.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runDelete } = await import("./commands/delete.js");
      const result = await runDelete(id, {
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
        dryRun: options.dryRun === true,
      }, globalOptions);
      if (result.dry_run !== true) {
        await invalidateSearchCachesForMutation(globalOptions, result);
      }
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=delete took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("append")
    .argument("<id>", "Item id")
    .argument("[text]", "Optional body text shorthand (equivalent to --body; use - for stdin)")
    .option("--body <value>", "Text to append to body (or - for stdin)")
    .option("--text <value>", "Alias for --body")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "Mutation message")
    .option("--force", "Force ownership override")
    .description("Append text to an item's body.")
    .action(async (id: string, text: string | undefined, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const bodyFromOption = typeof options.body === "string" ? options.body : undefined;
      const bodyFromAlias = typeof options.text === "string" ? options.text : undefined;
      const bodyFromPositional = typeof text === "string" ? text : undefined;
      const bodySourceCount = [bodyFromOption, bodyFromAlias, bodyFromPositional].filter((value) => value !== undefined).length;
      if (bodySourceCount > 1) {
        throw new PmCliError("Specify append text with exactly one source: positional [text], --body, or --text", EXIT_CODE.USAGE);
      }
      const resolvedBody = bodyFromOption ?? bodyFromAlias ?? bodyFromPositional;
      if (resolvedBody === undefined) {
        throw new PmCliError(
          "Missing append text. Provide it as positional [text], --body <value>, or --text <value> (use - for stdin).",
          EXIT_CODE.USAGE,
        );
      }
      const { runAppend } = await import("./commands/append.js");
      const result = await runAppend(id, {
        body: resolvedBody,
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
      }, globalOptions);
      await invalidateSearchCachesForMutation(globalOptions, result);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=append took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("restore")
    .argument("<id>", "Item id")
    .argument("<target>", "Restore target timestamp or version number")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership/lock override")
    .description("Restore an item to an earlier timestamp or version.")
    .action(async (id: string, target: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runRestore } = await import("./commands/restore.js");
      const result = await runRestore(id, target, {
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
      }, globalOptions);
      await invalidateSearchCachesForMutation(globalOptions, result);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=restore took_ms=${Date.now() - startedAt}`);
      }
    });

  const planCommand = program
    .command("plan")
    .description("Agent-optimized Plan item workflow: create, manage steps, link dependencies, approve, and materialize.")
    .argument("[subcommand]", "Plan subcommand: create|show|add-step|update-step|complete-step|block-step|reorder-step|remove-step|link|unlink|decision|discovery|validation|resume|approve|materialize")
    .argument("[id]", "Plan id (required for non-create subcommands); for create this may be the positional title")
    .argument("[stepRef]", "Step reference: stable id (plan-step-001) or order integer")
    .argument("[reorderTo]", "New order integer for reorder-step")
    .option("--title <value>", "Plan title")
    .option("--description <value>", "Plan description")
    .option("--scope <value>", "Short scope statement of the target change or investigation")
    .option("--parent <value>", "Parent pm item id")
    .option("--related <value>", "Related pm item ids (repeatable, csv-friendly)", collect)
    .option("--blocks <value>", "Pm item ids this plan blocks (repeatable, csv-friendly)", collect)
    .option("--blocked-by <value>", "Pm item ids that block this plan (repeatable, csv-friendly)", collect)
    .option("--harness <value>", "Plan harness provenance: codex|claude-code|cursor|generic")
    .option("--mode <value>", "Plan mode: draft|research|review|approved|executing|paused|completed|superseded")
    .option("--resume-context <value>", "Compact context summary for a future stateless agent")
    .option("--tags <value>", "Comma-separated tags")
    .option("--priority <value>", "Priority 0-4")
    .option("--body <value>", "Plan item body")
    .option("--claim", "Claim the plan on create for the author")
    .option("--from-search <value>", "Record the search query that led to plan creation")
    .option("--step-title <value>", "Step title for add-step / update-step")
    .option("--step <value>", "Alias for --step-title")
    .option("--step-body <value>", "Step body text")
    .option("--step-owner <value>", "Step owner")
    .option("--step-status <value>", "Step status: pending|in_progress|completed|blocked|skipped|superseded")
    .option("--step-evidence <value>", "Step evidence text (used by update-step/complete-step)")
    .option("--step-blocked-reason <value>", "Step blocked reason (required when blocking)")
    .option("--step-replacement <value>", "Replacement reference for a superseded step")
    .option("--depends-on <value>", "Pm item ids the step depends on (repeatable, csv-friendly)", collect)
    .option("--link <value>", "Pm item id to link (repeatable, csv-friendly)", collect)
    .option("--link-kind <value>", "Link kind: related|blocks|blocked_by|depends_on|discovered_from|implements|verifies|supersedes")
    .option("--link-note <value>", "Optional note for the link")
    .option("--promote-to-item-dep", "Also add the linked id as a top-level item dependency when linking")
    .option("--allow-multiple-active", "Allow multiple steps to be in_progress at once")
    .option("--file <value>", "Step linked file path=<value>[,scope=project|global,note=<text>] (repeatable)", collect)
    .option("--test <value>", "Step linked test command=<value>[,path=<value>,note=<text>] (repeatable)", collect)
    .option("--doc <value>", "Step linked doc path=<value>[,scope=project|global,note=<text>] (repeatable)", collect)
    .option("--decision-text <value>", "Decision log entry text")
    .option("--decision <value>", "Alias for --decision-text")
    .option("--decision-rationale <value>", "Decision log entry rationale")
    .option("--decision-evidence <value>", "Decision log entry evidence")
    .option("--discovery-text <value>", "Discovery log entry text")
    .option("--discovery <value>", "Alias for --discovery-text")
    .option("--validation-text <value>", "Validation log entry text")
    .option("--validation <value>", "Alias for --validation-text")
    .option("--validation-command <value>", "Validation log entry command")
    .option("--validation-expected <value>", "Validation log entry expected outcome")
    .option("--depth <value>", "Show depth: brief|standard|deep (default: brief)")
    .option("--fields <value>", "Comma-separated field projection for show output")
    .option("--steps <value>", "Comma-separated step ids/orders for materialize")
    .option("--materialize-type <value>", "Item type for materialized steps (default: Task)")
    .option("--materialize-parent <value>", "Parent item id for materialized children (default: the plan)")
    .option("--materialize-tags <value>", "Comma-separated tags for materialized children")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "Mutation message")
    .option("--force", "Force ownership override");
  // Hidden pure snake_case underscore-duplicate aliases (kept parse-functional,
  // omitted from --help to save agent context).
  for (const [flags, description] of [
    ["--resume_context <value>", "Alias for --resume-context"],
    ["--from_search <value>", "Alias for --from-search"],
    ["--step_title <value>", "Alias for --step-title"],
    ["--step_body <value>", "Alias for --step-body"],
    ["--step_owner <value>", "Alias for --step-owner"],
    ["--step_status <value>", "Alias for --step-status"],
    ["--step_evidence <value>", "Alias for --step-evidence"],
    ["--step_blocked_reason <value>", "Alias for --step-blocked-reason"],
    ["--step_replacement <value>", "Alias for --step-replacement"],
    ["--link_kind <value>", "Alias for --link-kind"],
    ["--link_note <value>", "Alias for --link-note"],
    ["--promote_to_item_dep", "Alias for --promote-to-item-dep"],
    ["--allow_multiple_active", "Alias for --allow-multiple-active"],
    ["--decision_text <value>", "Alias for --decision-text"],
    ["--decision_rationale <value>", "Alias for --decision-rationale"],
    ["--decision_evidence <value>", "Alias for --decision-evidence"],
    ["--discovery_text <value>", "Alias for --discovery-text"],
    ["--validation_text <value>", "Alias for --validation-text"],
    ["--validation_command <value>", "Alias for --validation-command"],
    ["--validation_expected <value>", "Alias for --validation-expected"],
    ["--materialize_type <value>", "Alias for --materialize-type"],
    ["--materialize_parent <value>", "Alias for --materialize-parent"],
    ["--materialize_tags <value>", "Alias for --materialize-tags"],
  ] as const) {
    addHiddenOption(planCommand, flags, description, false);
  }
  for (const [flags, description] of [
    ["--blocked_by <value>", "Alias for --blocked-by"],
    ["--depends_on <value>", "Alias for --depends-on"],
  ] as const) {
    addHiddenOption(planCommand, flags, description, true);
  }
  planCommand
    .action(async (subcommand: string | undefined, id: string | undefined, stepRef: string | undefined, reorderToken: string | undefined, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runPlan, PLAN_SUBCOMMANDS } = await import("./commands/plan.js");
      const normalizedSubcommand = (subcommand ?? "").trim().toLowerCase();
      if (!normalizedSubcommand) {
        throw new PmCliError(
          `pm plan requires a subcommand. Allowed: ${PLAN_SUBCOMMANDS.join(", ")}`,
          EXIT_CODE.USAGE,
          {
            code: "missing_required_argument",
            examples: [
              'pm plan create --title "Refactor lock retry"',
              "pm plan show pm-a1b2 --depth standard",
              'pm plan add-step pm-a1b2 --step-title "Read lock.ts"',
            ],
          },
        );
      }
      if (!PLAN_SUBCOMMANDS.includes(normalizedSubcommand as typeof PLAN_SUBCOMMANDS[number])) {
        const didYouMean =
          normalizedSubcommand === "list" || normalizedSubcommand === "ls"
            ? ['pm list --type Plan', 'pm list-all --type Plan']
            : undefined;
        throw new PmCliError(
          `Unknown pm plan subcommand "${subcommand}". Allowed: ${PLAN_SUBCOMMANDS.join(", ")}`,
          EXIT_CODE.USAGE,
          didYouMean ? { code: "unknown_subcommand", examples: didYouMean } : undefined,
        );
      }
      const planOptions: Record<string, unknown> = { ...options };
      // Normalize alternate-snake/camel aliases that Commander parses as different keys.
      const aliasPairs: Array<[string, string]> = [
        ["blocked_by", "blockedBy"],
        ["resume_context", "resumeContext"],
        ["from_search", "fromSearch"],
        ["step", "stepTitle"],
        ["step_title", "stepTitle"],
        ["step_body", "stepBody"],
        ["step_owner", "stepOwner"],
        ["step_status", "stepStatus"],
        ["step_evidence", "stepEvidence"],
        ["step_blocked_reason", "stepBlockedReason"],
        ["step_replacement", "stepReplacement"],
        ["depends_on", "dependsOn"],
        ["link_kind", "linkKind"],
        ["link_note", "linkNote"],
        ["promote_to_item_dep", "promoteToItemDep"],
        ["allow_multiple_active", "allowMultipleActive"],
        ["decision_text", "decisionText"],
        ["decision_rationale", "decisionRationale"],
        ["decision_evidence", "decisionEvidence"],
        ["discovery_text", "discoveryText"],
        ["validation_text", "validationText"],
        ["validation_command", "validationCommand"],
        ["validation_expected", "validationExpected"],
        ["materialize_type", "materializeType"],
        ["materialize_parent", "materializeParent"],
        ["materialize_tags", "materializeTags"],
      ];
      for (const [snake, camel] of aliasPairs) {
        if (planOptions[snake] !== undefined && planOptions[camel] === undefined) {
          planOptions[camel] = planOptions[snake];
        }
      }
      let reorderTo: number | undefined;
      if (normalizedSubcommand === "reorder-step" && typeof reorderToken === "string") {
        const parsed = Number.parseInt(reorderToken, 10);
        if (!Number.isFinite(parsed)) {
          throw new PmCliError(`reorder-step requires an integer new order, got "${reorderToken}"`, EXIT_CODE.USAGE);
        }
        reorderTo = parsed;
      }
      // Allow positional title for `pm plan create "Title"` (mirrors pm create UX).
      // Plan create never takes an id positional; the second token is the title.
      let planId = id;
      if (normalizedSubcommand === "create" && typeof id === "string" && id.length > 0 && planOptions.title === undefined) {
        planOptions.title = id;
        planId = undefined;
      }
      const result = await runPlan({
        subcommand: normalizedSubcommand as typeof PLAN_SUBCOMMANDS[number],
        id: planId,
        stepRef,
        reorderTo,
        options: planOptions as Record<string, never>,
        global: globalOptions,
      });
      await invalidateSearchCachesForMutation(globalOptions, result);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=plan took_ms=${Date.now() - startedAt}`);
      }
    });
  void planCommand;

  program
    .command("history-redact")
    .argument("<id>", "Item id")
    .option("--literal <value>", "Literal string to redact (repeatable)", collect)
    .option("--regex <value>", "Regex pattern to redact (repeatable; accepts /pattern/flags or raw pattern)", collect)
    .option("--replacement <value>", 'Replacement string (default: "[redacted]")')
    .option("--dry-run", "Preview redaction impact without writing item/history files")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "Audit history message for the redaction marker entry")
    .option("--force", "Force ownership/lock override")
    .description("Redact sensitive literals/patterns from an item history stream and recompute hashes.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runHistoryRedact } = await import("./commands/history-redact.js");
      const literal = Array.isArray(options.literal) ? (options.literal as string[]) : undefined;
      const regex = Array.isArray(options.regex) ? (options.regex as string[]) : undefined;
      const result = await runHistoryRedact(
        id,
        {
          literal,
          regex,
          replacement: typeof options.replacement === "string" ? options.replacement : undefined,
          dryRun: options.dryRun === true,
          author: typeof options.author === "string" ? options.author : undefined,
          message: typeof options.message === "string" ? options.message : undefined,
          force: Boolean(options.force),
        },
        globalOptions,
      );
      if (result.changed && !result.dry_run) {
        await invalidateSearchCachesForMutation(globalOptions, result);
      }
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=history-redact took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("history-repair")
    .argument("<id>", "Item id")
    .option("--dry-run", "Preview the re-anchor impact without writing the history file")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "Audit history message for the repair marker entry")
    .option("--force", "Force ownership/lock override")
    .description("Re-anchor a drifted item history chain (recompute hashes, reconcile with the on-disk item) and record an audit marker.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runHistoryRepair } = await import("./commands/history-repair.js");
      const result = await runHistoryRepair(
        id,
        {
          dryRun: options.dryRun === true,
          author: typeof options.author === "string" ? options.author : undefined,
          message: typeof options.message === "string" ? options.message : undefined,
          force: Boolean(options.force),
        },
        globalOptions,
      );
      // history-repair only re-anchors the audit stream; item content is untouched,
      // so search caches do not need invalidation.
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=history-repair took_ms=${Date.now() - startedAt}`);
      }
    });

  const schemaCommand = program
    .command("schema")
    .argument("[subcommand]", "Schema subcommand: list, show, add-type, remove-type, add-status, remove-status, or a custom item type name shorthand")
    .argument("[name]", "Item type name (add-type/remove-type/show) or status id (add-status/remove-status)")
    .option("--description <text>", "Human description for the custom item type or status")
    .option("--default-status <status>", "Default status hint recorded for the custom item type")
    .option("--folder <dir>", "Storage folder for items of this custom type")
    .option("--alias <name>", "Alias for the custom type or status (repeatable, csv-friendly)", collect)
    .option("--role <value>", "Lifecycle role for a custom status (repeatable): draft, active, blocked, terminal, terminal_done, terminal_canceled, default_open, default_close, default_cancel", collect)
    .option("--order <n>", "Display/sort order for a custom status")
    .option("--author <value>", "Mutation author")
    .option("--force", "Force ownership/lock override")
    .description("Inspect and manage config-driven runtime schema.");
  // Hidden pure snake_case underscore-duplicate alias.
  addHiddenOption(schemaCommand, "--default_status <status>", "Alias for --default-status", false);
  schemaCommand
    .action(async (
      subcommand: string | undefined,
      name: string | undefined,
      options: Record<string, unknown>,
      command,
    ) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const {
        runSchemaAddType,
        runSchemaRemoveType,
        runSchemaAddStatus,
        runSchemaRemoveStatus,
        runSchemaList,
        runSchemaShow,
        formatSchemaAddTypeHuman,
        formatSchemaRemoveTypeHuman,
        formatSchemaAddStatusHuman,
        formatSchemaRemoveStatusHuman,
        formatSchemaListHuman,
        formatSchemaShowHuman,
        SCHEMA_SUBCOMMANDS,
      } = await import("./commands/schema.js");
      let normalizedSubcommand = (subcommand ?? "").trim().toLowerCase();
      let typeName = name;
      if (!normalizedSubcommand) {
        throw new PmCliError(
          `pm schema requires a subcommand. Allowed: ${SCHEMA_SUBCOMMANDS.join(", ")}`,
          EXIT_CODE.USAGE,
          {
            code: "missing_required_argument",
            examples: [
              "pm schema list",
              "pm schema show Task",
              'pm schema add-type Spike --description "Time-boxed investigation" --default-status open',
              "pm schema remove-type Spike",
              "pm schema add-status review --role active --alias in_review",
              "pm schema remove-status review",
            ],
          },
        );
      }
      const aliases =
        typeof options.alias === "string"
          ? [options.alias]
          : Array.isArray(options.alias)
            ? (options.alias as string[])
            : undefined;
      const roles =
        typeof options.role === "string"
          ? [options.role]
          : Array.isArray(options.role)
            ? (options.role as string[])
            : undefined;
      const defaultStatus =
        typeof options.defaultStatus === "string"
          ? options.defaultStatus
          : typeof options.default_status === "string"
            ? (options.default_status as string)
            : undefined;
      const order = parseSchemaOrderOption(options.order);
      if (!SCHEMA_SUBCOMMANDS.includes(normalizedSubcommand as typeof SCHEMA_SUBCOMMANDS[number]) && typeName === undefined) {
        typeName = subcommand;
        normalizedSubcommand = "add-type";
      }
      if (!SCHEMA_SUBCOMMANDS.includes(normalizedSubcommand as typeof SCHEMA_SUBCOMMANDS[number])) {
        throw new PmCliError(
          `Unknown pm schema subcommand "${subcommand}". Allowed: ${SCHEMA_SUBCOMMANDS.join(", ")}`,
          EXIT_CODE.USAGE,
          { code: "unknown_subcommand" },
        );
      }
      const author = typeof options.author === "string" ? options.author : undefined;
      const force = Boolean(options.force);
      const result =
        normalizedSubcommand === "list"
          ? await runSchemaList(globalOptions)
          : normalizedSubcommand === "show"
            ? await runSchemaShow(typeName, globalOptions)
            : normalizedSubcommand === "remove-type"
              ? await runSchemaRemoveType(typeName, { author, force }, globalOptions)
              : normalizedSubcommand === "add-status"
                ? await runSchemaAddStatus(
                    typeName,
                    {
                      role: roles,
                      alias: aliases,
                      description: typeof options.description === "string" ? options.description : undefined,
                      order,
                      author,
                      force,
                    },
                    globalOptions,
                  )
                : normalizedSubcommand === "remove-status"
                  ? await runSchemaRemoveStatus(typeName, { author, force }, globalOptions)
                  : await runSchemaAddType(
                      typeName,
                      {
                        description: typeof options.description === "string" ? options.description : undefined,
                        defaultStatus,
                        folder: typeof options.folder === "string" ? options.folder : undefined,
                        alias: aliases,
                        author,
                        force,
                      },
                      globalOptions,
                    );
      // Schema inspection and type registration do not touch item content, so search caches stay valid.
      if (globalOptions.json === true || globalOptions.defaultOutputFormat === "json") {
        printResult(result, globalOptions);
      } else if (!globalOptions.quiet) {
        if (result.action === "list") {
          writeStdout(`${formatSchemaListHuman(result)}\n`);
        } else if (result.action === "show") {
          writeStdout(`${formatSchemaShowHuman(result)}\n`);
        } else if (result.action === "remove-type") {
          writeStdout(`${formatSchemaRemoveTypeHuman(result)}\n`);
        } else if (result.action === "add-status") {
          writeStdout(`${formatSchemaAddStatusHuman(result)}\n`);
        } else if (result.action === "remove-status") {
          writeStdout(`${formatSchemaRemoveStatusHuman(result)}\n`);
        } else {
          writeStdout(`${formatSchemaAddTypeHuman(result)}\n`);
        }
        // Surface extension on-write hook diagnostics so policy/enforcement
        // warnings are visible without forcing --json.
        if (result.action !== "list" && result.action !== "show" && result.warnings.length > 0) {
          printError(`schema ${result.action} warnings: ${formatHookWarnings(result.warnings)}`);
        }
      }
      if (globalOptions.profile) {
        printError(`profile:command=schema took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("comments")
    .argument("<id>", "Item id")
    .argument("[text]", "Optional comment text shorthand (equivalent to --add)")
    .option("--add <text>", "Add one comment entry (plain text fallback, text=<value>, markdown pairs, or - for stdin; CSV-like key fragments are preserved as plain text unless text is explicit)")
    .option("--stdin", "Read comment text from stdin (supports multiline markdown)")
    .option("--file <path>", "Read comment text from file (supports multiline markdown)")
    .option("--limit <n>", "Return only latest n comments")
    .option("--author [value]", "Comment author (optional; falls back to PM_AUTHOR/settings)")
    .option("--message <value>", "History message")
    .option("--allow-audit-comment", "Allow non-owner append-only comment audits without requiring --force")
    .option("--force", "Force ownership override")
    .description("List or add comments for an item.")
    .action(async (id: string, text: string | undefined, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const addFromOption = typeof options.add === "string" ? options.add : undefined;
      const addFromPositional = typeof text === "string" ? text : undefined;
      const readFromStdin = options.stdin === true;
      const readFromFile = typeof options.file === "string" ? options.file : undefined;
      const sourceCount =
        Number(addFromOption !== undefined) +
        Number(addFromPositional !== undefined) +
        Number(readFromStdin) +
        Number(readFromFile !== undefined);
      if (sourceCount > 1) {
        if (addFromOption !== undefined && addFromPositional !== undefined && !readFromStdin && readFromFile === undefined) {
          throw new PmCliError("Specify comment text either as positional [text] or with --add, not both", EXIT_CODE.USAGE);
        }
        throw new PmCliError(
          "Specify comment text with exactly one source: positional [text], --add, --stdin, or --file",
          EXIT_CODE.USAGE,
        );
      }
      const add = addFromOption ?? addFromPositional;
      const { runComments } = await import("./commands/comments.js");
      const result = await runComments(id, {
        add,
        stdin: readFromStdin,
        file: readFromFile,
        limit: typeof options.limit === "string" ? options.limit : undefined,
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        allowAuditComment: Boolean(options.allowAuditComment),
        force: Boolean(options.force),
      }, globalOptions);
      if (typeof add === "string" || readFromStdin || readFromFile !== undefined) {
        await invalidateSearchCachesForMutation(globalOptions, result);
      }
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=comments took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("notes")
    .argument("<id>", "Item id")
    .argument("[text]", "Optional note text shorthand (equivalent to --add; use - for stdin)")
    .option("--add <text>", "Add one note entry (plain text fallback, text=<value>, markdown pairs, or - for stdin; CSV-like key fragments are preserved as plain text unless text is explicit)")
    .option("--limit <n>", "Return only latest n notes")
    .option("--author [value]", "Note author (optional; falls back to PM_AUTHOR/settings)")
    .option("--message <value>", "History message")
    .option("--allow-audit-note", "Allow non-owner append-only note audits without requiring --force")
    .option("--allow-audit-comment", "Backward-compatible alias for --allow-audit-note")
    .option("--force", "Force ownership override")
    .description("List or add notes for an item.")
    .action(async (id: string, text: string | undefined, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const addFromOption = typeof options.add === "string" ? options.add : undefined;
      const addFromPositional = typeof text === "string" ? text : undefined;
      if (addFromOption !== undefined && addFromPositional !== undefined) {
        throw new PmCliError("Specify note text either as positional [text] or with --add, not both", EXIT_CODE.USAGE);
      }
      const add = addFromOption ?? addFromPositional;
      const { runNotes } = await import("./commands/notes.js");
      const result = await runNotes(id, {
        add,
        limit: typeof options.limit === "string" ? options.limit : undefined,
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        allowAuditComment: Boolean(options.allowAuditNote || options.allowAuditComment),
        force: Boolean(options.force),
      }, globalOptions);
      if (typeof add === "string") {
        await invalidateSearchCachesForMutation(globalOptions, result);
      }
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=notes took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("learnings")
    .argument("<id>", "Item id")
    .argument("[text]", "Optional learning text shorthand (equivalent to --add; use - for stdin)")
    .option("--add <text>", "Add one learning entry (plain text fallback, text=<value>, markdown pairs, or - for stdin; CSV-like key fragments are preserved as plain text unless text is explicit)")
    .option("--limit <n>", "Return only latest n learnings")
    .option("--author [value]", "Learning author (optional; falls back to PM_AUTHOR/settings)")
    .option("--message <value>", "History message")
    .option("--allow-audit-learning", "Allow non-owner append-only learning audits without requiring --force")
    .option("--allow-audit-comment", "Backward-compatible alias for --allow-audit-learning")
    .option("--force", "Force ownership override")
    .description("List or add learnings for an item.")
    .action(async (id: string, text: string | undefined, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const addFromOption = typeof options.add === "string" ? options.add : undefined;
      const addFromPositional = typeof text === "string" ? text : undefined;
      if (addFromOption !== undefined && addFromPositional !== undefined) {
        throw new PmCliError("Specify learning text either as positional [text] or with --add, not both", EXIT_CODE.USAGE);
      }
      const add = addFromOption ?? addFromPositional;
      const { runLearnings } = await import("./commands/learnings.js");
      const result = await runLearnings(id, {
        add,
        limit: typeof options.limit === "string" ? options.limit : undefined,
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        allowAuditComment: Boolean(options.allowAuditLearning || options.allowAuditComment),
        force: Boolean(options.force),
      }, globalOptions);
      if (typeof add === "string") {
        await invalidateSearchCachesForMutation(globalOptions, result);
      }
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=learnings took_ms=${Date.now() - startedAt}`);
      }
    });

  const filesCommand = program
    .command("files")
    .description("Manage files linked to an item.");

  filesCommand
    .argument("<id>", "Item id")
    .option("--add <value>", "Add linked file entry (CSV/markdown pairs or - for stdin)", collect)
    .option("--add-glob <value>", "Add linked file entries from a glob (plain glob or pattern=<glob>,scope=<scope>,note=<text>; repeatable)", collect)
    .option("--remove <value>", "Remove linked file by path (path=<value>, path:<value>, plain path, or - for stdin)", collect)
    .option("--migrate <value>", "Migrate linked file paths in-place (from=<prefix>,to=<prefix>; repeatable)", collect)
    .option("--list", "List linked files without mutating")
    .option("--append-stable", "Preserve existing linked-file order and append new links without full-array resorting")
    .option("--validate-paths", "Validate linked file paths for existence and file shape")
    .option("--audit", "Audit linked file usage across all items for this item's linked paths")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership override")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const addValues = Array.isArray(options.add) ? (options.add as string[]) : [];
      const addGlobValues = Array.isArray(options.addGlob) ? (options.addGlob as string[]) : [];
      const removeValues = Array.isArray(options.remove) ? (options.remove as string[]) : [];
      const migrateValues = Array.isArray(options.migrate) ? (options.migrate as string[]) : [];
      const { runFiles } = await import("./commands/files.js");
      const result = await runFiles(id, {
        add: addValues,
        addGlob: addGlobValues,
        remove: removeValues,
        migrate: migrateValues,
        list: Boolean(options.list),
        appendStable: Boolean(options.appendStable),
        validatePaths: Boolean(options.validatePaths),
        audit: Boolean(options.audit),
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
      }, globalOptions);
      if (addValues.length > 0 || addGlobValues.length > 0 || removeValues.length > 0 || migrateValues.length > 0) {
        await invalidateSearchCachesForMutation(globalOptions, result);
      }
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=files took_ms=${Date.now() - startedAt}`);
      }
    });

  filesCommand
    .command("discover")
    .argument("<id>", "Item id")
    .option("--apply", "Add discovered missing files to the item")
    .option("--note <value>", "Note to attach to discovered file links")
    .option("--append-stable", "Preserve existing linked-file order and append discovered links without full-array resorting")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership override")
    .description("Discover existing file paths referenced in item text and optionally link missing files.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runFilesDiscover } = await import("./commands/files.js");
      const result = await runFilesDiscover(id, {
        apply: Boolean(options.apply),
        note: typeof options.note === "string" ? options.note : undefined,
        appendStable: Boolean(options.appendStable),
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
      }, globalOptions);
      if (result.changed) {
        await invalidateSearchCachesForMutation(globalOptions, result);
      }
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=files.discover took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("docs")
    .argument("<id>", "Item id")
    .option("--add <value>", "Add linked doc entry (CSV/markdown pairs or - for stdin)", collect)
    .option("--add-glob <value>", "Add linked doc entries from a glob (plain glob or pattern=<glob>,scope=<scope>,note=<text>; repeatable)", collect)
    .option("--remove <value>", "Remove linked doc by path (path=<value>, path:<value>, plain path, or - for stdin)", collect)
    .option("--migrate <value>", "Migrate linked doc paths in-place (from=<prefix>,to=<prefix>; repeatable)", collect)
    .option("--list", "List linked docs without mutating")
    .option("--validate-paths", "Validate linked doc paths for existence and file shape")
    .option("--audit", "Audit linked doc usage across all items for this item's linked paths")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership override")
    .description("Manage docs linked to an item.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const addValues = Array.isArray(options.add) ? (options.add as string[]) : [];
      const addGlobValues = Array.isArray(options.addGlob) ? (options.addGlob as string[]) : [];
      const removeValues = Array.isArray(options.remove) ? (options.remove as string[]) : [];
      const migrateValues = Array.isArray(options.migrate) ? (options.migrate as string[]) : [];
      const { runDocs } = await import("./commands/docs.js");
      const result = await runDocs(id, {
        add: addValues,
        addGlob: addGlobValues,
        remove: removeValues,
        migrate: migrateValues,
        list: Boolean(options.list),
        validatePaths: Boolean(options.validatePaths),
        audit: Boolean(options.audit),
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
      }, globalOptions);
      if (addValues.length > 0 || addGlobValues.length > 0 || removeValues.length > 0 || migrateValues.length > 0) {
        await invalidateSearchCachesForMutation(globalOptions, result);
      }
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=docs took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("deps")
    .argument("<id>", "Item id")
    .option("--format <value>", "Output format (tree or graph)", "tree")
    .option("--max-depth <value>", "Maximum dependency traversal depth (0 keeps only the root)")
    .option("--collapse <value>", "Collapse mode (none or repeated)", "none")
    .option("--summary", "Return counts only without full tree/graph payload")
    .description("Show dependency relationships for an item.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runDeps } = await import("./commands/deps.js");
      const result = await runDeps(id, {
        format: typeof options.format === "string" ? options.format : undefined,
        maxDepth: typeof options.maxDepth === "string" ? options.maxDepth : undefined,
        collapse: typeof options.collapse === "string" ? options.collapse : undefined,
        summary: options.summary === true,
      }, globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=deps took_ms=${Date.now() - startedAt}`);
      }
    });
}
