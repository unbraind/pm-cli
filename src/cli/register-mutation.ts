import type { Command } from "commander";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import {
  CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS,
  UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS,
  type CommanderOptionRegistrationContract,
} from "../sdk/cli-contracts.js";
import {
  collect,
  extractUpdateManyMutationOptionSource,
  getGlobalOptions,
  invalidateSearchCachesForMutation,
  normalizeCreateOptions,
  normalizeUpdateOptions,
  printError,
  printResult,
} from "./registration-helpers.js";

type MutationCommandsModule = typeof import("./commands/index.js");

let mutationCommandsModulePromise: Promise<MutationCommandsModule> | null = null;

async function loadMutationCommandsModule(): Promise<MutationCommandsModule> {
  mutationCommandsModulePromise ??= import("./commands/index.js");
  return mutationCommandsModulePromise;
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
      if (contract.repeatable) {
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
    .argument("[title]", "Item title (positional shortcut for --title)")
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
    .action(async (positionalTitle: string | undefined, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      if (typeof positionalTitle === "string" && positionalTitle.length > 0 && options.title === undefined) {
        options.title = positionalTitle;
      }
      const normalized = normalizeCreateOptions(options, { requireType: false });
      const { runCreate } = await loadMutationCommandsModule();
      const result = await runCreate(normalized, globalOptions);
      await invalidateSearchCachesForMutation(globalOptions, result);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=create took_ms=${Date.now() - startedAt}`);
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
    .option("--allow_audit_update", "Alias for --allow-audit-update")
    .option("--allow-audit-dep-update", "Allow non-owner append-only dependency updates without requiring --force")
    .option("--allow_audit_dep_update", "Alias for --allow-audit-dep-update")
    .option("--force", "Force ownership override")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runUpdate } = await loadMutationCommandsModule();
      const result = await runUpdate(id, normalizeUpdateOptions(options), globalOptions);
      await invalidateSearchCachesForMutation(globalOptions, result);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=update took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("update-many")
    .description("Bulk-update matched items with dry-run plans and rollback checkpoints.")
    .option("--filter-status <value>", "Filter by status before applying updates")
    .option("--filter-type <value>", "Filter by item type before applying updates")
    .option("--filter-tag <value>", "Filter by tag before applying updates")
    .option("--filter-priority <value>", "Filter by priority before applying updates")
    .option("--filter-deadline-before <value>", "Filter by deadline upper bound before applying updates")
    .option("--filter-deadline-after <value>", "Filter by deadline lower bound before applying updates")
    .option("--filter-assignee <value>", "Filter by assignee before applying updates")
    .option("--filter-assignee-filter <value>", "Filter assignee presence: assigned|unassigned before applying updates")
    .option("--filter-assignee_filter <value>", "Alias for --filter-assignee-filter")
    .option("--filter-parent <value>", "Filter by parent item ID before applying updates")
    .option("--filter-sprint <value>", "Filter by sprint before applying updates")
    .option("--filter-release <value>", "Filter by release before applying updates")
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
    .option("--tags <value>", "Set comma-separated tags")
    .option("--deadline <value>", "Set deadline (ISO/date string or relative)")
    .option("--estimate, --estimated-minutes <value>", "Set estimated minutes")
    .option("--estimated_minutes <value>", "Alias for --estimated-minutes")
    .option("--acceptance-criteria <value>", "Set acceptance criteria")
    .option("--acceptance_criteria <value>", "Alias for --acceptance-criteria")
    .option("--ac <value>", "Alias for --acceptance-criteria")
    .option("--definition-of-ready <value>", "Set definition of ready")
    .option("--definition_of_ready <value>", "Alias for --definition-of-ready")
    .option("--order <value>", "Set planning order/rank integer")
    .option("--rank <value>", "Alias for --order")
    .option("--goal <value>", "Set goal identifier")
    .option("--objective <value>", "Set objective identifier")
    .option("--value <value>", "Set business value summary")
    .option("--impact <value>", "Set business impact summary")
    .option("--outcome <value>", "Set expected outcome summary")
    .option("--why-now <value>", "Set why-now rationale")
    .option("--why_now <value>", "Alias for --why-now")
    .option("--assignee <value>", "Set assignee")
    .option("--parent <value>", "Set parent item ID")
    .option("--reviewer <value>", "Set reviewer")
    .option("--risk <value>", "Set risk level")
    .option("--confidence <value>", "Set confidence level")
    .option("--sprint <value>", "Set sprint identifier")
    .option("--release <value>", "Set release identifier")
    .option("--blocked-by <value>", "Set blocked-by item ID or reason")
    .option("--blocked_by <value>", "Alias for --blocked-by")
    .option("--blocked-reason <value>", "Set blocked reason")
    .option("--blocked_reason <value>", "Alias for --blocked-reason")
    .option("--unblock-note <value>", "Set unblock rationale note")
    .option("--unblock_note <value>", "Alias for --unblock-note")
    .option("--reporter <value>", "Set issue reporter")
    .option("--severity <value>", "Set issue severity")
    .option("--environment <value>", "Set issue environment context")
    .option("--repro-steps <value>", "Set issue reproduction steps")
    .option("--repro_steps <value>", "Alias for --repro-steps")
    .option("--resolution <value>", "Set issue resolution summary")
    .option("--expected-result <value>", "Set issue expected behavior")
    .option("--expected_result <value>", "Alias for --expected-result")
    .option("--actual-result <value>", "Set issue observed behavior")
    .option("--actual_result <value>", "Alias for --actual-result")
    .option("--affected-version <value>", "Set affected version identifier")
    .option("--affected_version <value>", "Alias for --affected-version")
    .option("--fixed-version <value>", "Set fixed version identifier")
    .option("--fixed_version <value>", "Alias for --fixed-version")
    .option("--component <value>", "Set issue component ownership")
    .option("--regression <value>", "Set regression marker: true|false|1|0")
    .option("--customer-impact <value>", "Set customer impact summary")
    .option("--customer_impact <value>", "Alias for --customer-impact")
    .option("--dep <value>", "Add dependency entry id=<id>,kind=<kind>,author=<author>,created_at=<timestamp>", collect)
    .option("--dep-remove <value>", "Remove dependency entries by id/kind/author/timestamp signature", collect)
    .option("--dep_remove <value>", "Alias for --dep-remove", collect)
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
    .option("--type_option <value>", "Alias for --type-option", collect)
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
    .option("--allow_audit_update", "Alias for --allow-audit-update")
    .option("--allow-audit-dep-update", "Allow non-owner append-only dependency updates without requiring --force")
    .option("--allow_audit_dep_update", "Alias for --allow-audit-dep-update")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "Mutation message")
    .option("--force", "Force ownership override")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runUpdateMany } = await loadMutationCommandsModule();
      const result = await runUpdateMany(
        {
          status: typeof options.filterStatus === "string" ? options.filterStatus : undefined,
          list: {
            type: typeof options.filterType === "string" ? options.filterType : undefined,
            tag: typeof options.filterTag === "string" ? options.filterTag : undefined,
            priority: typeof options.filterPriority === "string" ? options.filterPriority : undefined,
            deadlineBefore: typeof options.filterDeadlineBefore === "string" ? options.filterDeadlineBefore : undefined,
            deadlineAfter: typeof options.filterDeadlineAfter === "string" ? options.filterDeadlineAfter : undefined,
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

  program
    .command("close")
    .argument("<id>", "Item id")
    .argument("[text]", "Close reason text (alias: --reason)")
    .option("--reason <value>", "Close reason text (alias for positional <text>)")
    .option("--close-reason <value>", "Close reason text (alias for positional <text>)")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--validate-close [mode]", 'Validate closure metadata before close: "off", "warn", or "strict" (default: settings governance preset)')
    .option("--force", "Force ownership override")
    .description("Close an item with a required reason.")
    .action(async (id: string, text: string | undefined, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runClose } = await loadMutationCommandsModule();
      const reasonFromOption =
        (typeof options.reason === "string" && options.reason.trim().length > 0 && options.reason) ||
        (typeof options.closeReason === "string" && options.closeReason.trim().length > 0 && options.closeReason) ||
        undefined;
      const resolvedText = typeof text === "string" && text.length > 0 ? text : reasonFromOption;
      if (typeof resolvedText !== "string" || resolvedText.length === 0) {
        throw new PmCliError(
          "pm close requires a close reason as the second positional argument or via --reason.",
          EXIT_CODE.USAGE,
          {
            code: "missing_required_argument",
            why: "Close mutations are auditable; a reason is mandatory for the history record.",
            examples: [
              `pm close ${id} "All acceptance criteria met"`,
              `pm close ${id} --reason "Verified by integration test"`,
            ],
            nextSteps: [
              "Re-run with the close reason as the second positional argument, or pass --reason \"<text>\".",
            ],
          },
        );
      }
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
        },
        globalOptions,
      );
      await invalidateSearchCachesForMutation(globalOptions, result);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=close took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("delete")
    .argument("<id>", "Item id")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership override")
    .description("Delete an item and record the change in history.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runDelete } = await loadMutationCommandsModule();
      const result = await runDelete(id, {
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
      }, globalOptions);
      await invalidateSearchCachesForMutation(globalOptions, result);
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
      const bodySourceCount =
        Number(bodyFromOption !== undefined) + Number(bodyFromAlias !== undefined) + Number(bodyFromPositional !== undefined);
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
      const { runAppend } = await loadMutationCommandsModule();
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
      const { runRestore } = await loadMutationCommandsModule();
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
    .option("--blocked_by <value>", "Alias for --blocked-by", collect)
    .option("--harness <value>", "Plan harness provenance: codex|claude-code|cursor|generic")
    .option("--mode <value>", "Plan mode: draft|research|review|approved|executing|paused|completed|superseded")
    .option("--resume-context <value>", "Compact context summary for a future stateless agent")
    .option("--resume_context <value>", "Alias for --resume-context")
    .option("--tags <value>", "Comma-separated tags")
    .option("--priority <value>", "Priority 0-4")
    .option("--body <value>", "Plan item body")
    .option("--claim", "Claim the plan on create for the author")
    .option("--from-search <value>", "Record the search query that led to plan creation")
    .option("--from_search <value>", "Alias for --from-search")
    .option("--step-title <value>", "Step title for add-step / update-step")
    .option("--step_title <value>", "Alias for --step-title")
    .option("--step-body <value>", "Step body text")
    .option("--step_body <value>", "Alias for --step-body")
    .option("--step-owner <value>", "Step owner")
    .option("--step_owner <value>", "Alias for --step-owner")
    .option("--step-status <value>", "Step status: pending|in_progress|completed|blocked|skipped|superseded")
    .option("--step_status <value>", "Alias for --step-status")
    .option("--step-evidence <value>", "Step evidence text (used by update-step/complete-step)")
    .option("--step_evidence <value>", "Alias for --step-evidence")
    .option("--step-blocked-reason <value>", "Step blocked reason (required when blocking)")
    .option("--step_blocked_reason <value>", "Alias for --step-blocked-reason")
    .option("--step-replacement <value>", "Replacement reference for a superseded step")
    .option("--step_replacement <value>", "Alias for --step-replacement")
    .option("--depends-on <value>", "Pm item ids the step depends on (repeatable, csv-friendly)", collect)
    .option("--depends_on <value>", "Alias for --depends-on", collect)
    .option("--link <value>", "Pm item id to link (repeatable, csv-friendly)", collect)
    .option("--link-kind <value>", "Link kind: related|blocks|blocked_by|depends_on|discovered_from|implements|verifies|supersedes")
    .option("--link_kind <value>", "Alias for --link-kind")
    .option("--link-note <value>", "Optional note for the link")
    .option("--link_note <value>", "Alias for --link-note")
    .option("--promote-to-item-dep", "Also add the linked id as a top-level item dependency when linking")
    .option("--promote_to_item_dep", "Alias for --promote-to-item-dep")
    .option("--allow-multiple-active", "Allow multiple steps to be in_progress at once")
    .option("--allow_multiple_active", "Alias for --allow-multiple-active")
    .option("--file <value>", "Step linked file path=<value>[,scope=project|global,note=<text>] (repeatable)", collect)
    .option("--test <value>", "Step linked test command=<value>[,path=<value>,note=<text>] (repeatable)", collect)
    .option("--doc <value>", "Step linked doc path=<value>[,scope=project|global,note=<text>] (repeatable)", collect)
    .option("--decision-text <value>", "Decision log entry text")
    .option("--decision_text <value>", "Alias for --decision-text")
    .option("--decision-rationale <value>", "Decision log entry rationale")
    .option("--decision_rationale <value>", "Alias for --decision-rationale")
    .option("--decision-evidence <value>", "Decision log entry evidence")
    .option("--decision_evidence <value>", "Alias for --decision-evidence")
    .option("--discovery-text <value>", "Discovery log entry text")
    .option("--discovery_text <value>", "Alias for --discovery-text")
    .option("--validation-text <value>", "Validation log entry text")
    .option("--validation_text <value>", "Alias for --validation-text")
    .option("--validation-command <value>", "Validation log entry command")
    .option("--validation_command <value>", "Alias for --validation-command")
    .option("--validation-expected <value>", "Validation log entry expected outcome")
    .option("--validation_expected <value>", "Alias for --validation-expected")
    .option("--depth <value>", "Show depth: brief|standard|deep (default: brief)")
    .option("--fields <value>", "Comma-separated field projection for show output")
    .option("--steps <value>", "Comma-separated step ids/orders for materialize")
    .option("--materialize-type <value>", "Item type for materialized steps (default: Task)")
    .option("--materialize_type <value>", "Alias for --materialize-type")
    .option("--materialize-parent <value>", "Parent item id for materialized children (default: the plan)")
    .option("--materialize_parent <value>", "Alias for --materialize-parent")
    .option("--materialize-tags <value>", "Comma-separated tags for materialized children")
    .option("--materialize_tags <value>", "Alias for --materialize-tags")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "Mutation message")
    .option("--force", "Force ownership override")
    .action(async (subcommand: string | undefined, id: string | undefined, stepRef: string | undefined, reorderToken: string | undefined, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runPlan, PLAN_SUBCOMMANDS } = await loadMutationCommandsModule();
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
      const { runHistoryRedact } = await loadMutationCommandsModule();
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
      const { runComments } = await loadMutationCommandsModule();
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
      const { runNotes } = await loadMutationCommandsModule();
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
      const { runLearnings } = await loadMutationCommandsModule();
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
      const { runFiles } = await loadMutationCommandsModule();
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
      const { runFilesDiscover } = await loadMutationCommandsModule();
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
      const { runDocs } = await loadMutationCommandsModule();
      const result = await runDocs(id, {
        add: addValues,
        addGlob: addGlobValues,
        remove: removeValues,
        migrate: migrateValues,
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
      const { runDeps } = await loadMutationCommandsModule();
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
