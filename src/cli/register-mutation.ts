import type { Command } from "commander";
import {
  runAppend,
  runClose,
  runComments,
  runCommentsAudit,
  runCreate,
  runDelete,
  runDeps,
  runDocs,
  runFiles,
  runFilesDiscover,
  runLearnings,
  runNormalize,
  runNotes,
  runRestore,
  runUpdate,
  runUpdateMany,
} from "./commands/index.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
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

export function registerMutationCommands(program: Command): void {
  program
    .command("create")
    .description("Create a new project management item.")
    .requiredOption("--title, -t <value>", "Item title")
    .requiredOption("--description, -d <value>", "Item description (allow empty string)")
    .option("--type <value>", "Item type (built-ins plus any configured custom types)")
    .option("--template <value>", "Apply named create template defaults before explicit flags")
    .option("--create-mode <value>", "Create required-option policy mode: strict|progressive")
    .option("--create_mode <value>", "Alias for --create-mode")
    .option("--schedule-preset <value>", "Scheduling preset for Reminder|Meeting|Event: lightweight")
    .option("--schedule_preset <value>", "Alias for --schedule-preset")
    .option("--status, -s <value>", "Item status")
    .option("--priority, -p <value>", "Priority 0..4")
    .option("--tags <value>", "Comma-separated tags")
    .option("--body, -b <value>", "Item markdown body (allow empty string)")
    .option("--deadline <value>", "Deadline (ISO/date string or relative +6h/+1d/+2w/+6m)")
    .option("--estimate, --estimated-minutes <value>", "Estimated minutes")
    .option("--estimated_minutes <value>", "Alias for --estimated-minutes")
    .option("--acceptance-criteria <value>", "Acceptance criteria (allow empty string)")
    .option("--acceptance_criteria <value>", "Alias for --acceptance-criteria")
    .option("--ac <value>", "Alias for --acceptance-criteria")
    .option("--definition-of-ready <value>", "Definition of ready (allow empty string)")
    .option("--definition_of_ready <value>", "Alias for --definition-of-ready")
    .option("--order <value>", "Planning order/rank integer")
    .option("--rank <value>", "Alias for --order")
    .option("--goal <value>", "Goal identifier")
    .option("--objective <value>", "Objective identifier")
    .option("--value <value>", "Business value summary")
    .option("--impact <value>", "Business impact summary")
    .option("--outcome <value>", "Expected outcome summary")
    .option("--why-now <value>", "Why-now rationale")
    .option("--why_now <value>", "Alias for --why-now")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message (allow empty string)")
    .option("--assignee <value>", "Item assignee")
    .option("--parent <value>", "Parent item ID")
    .option("--reviewer <value>", "Reviewer")
    .option("--risk <value>", "Risk level: low|med|medium|high|critical (med persists as medium)")
    .option("--confidence <value>", "Confidence level: 0..100|low|med|medium|high (med persists as medium)")
    .option("--sprint <value>", "Sprint identifier")
    .option("--release <value>", "Release identifier")
    .option("--blocked-by <value>", "Blocked-by item ID or reason")
    .option("--blocked_by <value>", "Alias for --blocked-by")
    .option("--blocked-reason <value>", "Blocked reason")
    .option("--blocked_reason <value>", "Alias for --blocked-reason")
    .option("--unblock-note <value>", "Unblock rationale note")
    .option("--unblock_note <value>", "Alias for --unblock-note")
    .option("--reporter <value>", "Issue reporter")
    .option("--severity <value>", "Issue severity: low|med|medium|high|critical (med persists as medium)")
    .option("--environment <value>", "Issue environment context")
    .option("--repro-steps <value>", "Issue reproduction steps")
    .option("--repro_steps <value>", "Alias for --repro-steps")
    .option("--resolution <value>", "Issue resolution summary")
    .option("--expected-result <value>", "Issue expected behavior")
    .option("--expected_result <value>", "Alias for --expected-result")
    .option("--actual-result <value>", "Issue observed behavior")
    .option("--actual_result <value>", "Alias for --actual-result")
    .option("--affected-version <value>", "Affected version identifier")
    .option("--affected_version <value>", "Alias for --affected-version")
    .option("--fixed-version <value>", "Fixed version identifier")
    .option("--fixed_version <value>", "Alias for --fixed-version")
    .option("--component <value>", "Issue component ownership")
    .option("--regression <value>", "Regression marker: true|false|1|0")
    .option("--customer-impact <value>", "Customer impact summary")
    .option("--customer_impact <value>", "Alias for --customer-impact")
    .option("--dep <value>", "Seed dependency entry (key=value CSV, markdown key:value lines, or - for stdin; repeatable)", collect)
    .option("--type-option <value>", "Type option key=value or key=<name>,value=<value> (also accepts key:value and markdown pairs; use - for stdin; repeatable)", collect)
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
    .option("--reminder <value>", "Seed reminder entry at=<iso|relative>,text=<text> (also accepts markdown pairs and - for stdin; repeatable)", collect)
    .option("--event <value>", "Seed event entry start=<iso|relative>,end=<iso|relative>,title=<text>,all_day=<true|false>,recur_* fields (also accepts markdown pairs and - for stdin; repeatable)", collect)
    .option("--comment <value>", "Seed comment entry (text=<value> CSV/markdown pairs or - for stdin; repeatable)", collect)
    .option("--note <value>", "Seed note entry (text=<value> CSV/markdown pairs or - for stdin; repeatable)", collect)
    .option("--learning <value>", "Seed learning entry (text=<value> CSV/markdown pairs or - for stdin; repeatable)", collect)
    .option("--file <value>", "Seed linked file entry (CSV/markdown pairs or - for stdin; repeatable)", collect)
    .option("--test <value>", "Seed linked test entry (CSV/markdown pairs or - for stdin; repeatable)", collect)
    .option("--doc <value>", "Seed linked doc entry (CSV/markdown pairs or - for stdin; repeatable)", collect)
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const normalized = normalizeCreateOptions(options, { requireType: false });
      const result = await runCreate(normalized, globalOptions);
      await invalidateSearchCachesForMutation(globalOptions, result);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=create took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("update")
    .argument("<id>", "Item id")
    .description("Update item fields and metadata.")
    .option("--title, -t <value>", "Set title")
    .option("--description, -d <value>", "Set description")
    .option("--body, -b <value>", "Set body (allow empty string)")
    .option("--status, -s <value>", "Set status (use close command for closed)")
    .option("--close-reason <value>", "Set close reason")
    .option("--close_reason <value>", "Alias for --close-reason")
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
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "Mutation message")
    .option("--assignee <value>", "Set assignee")
    .option("--parent <value>", "Set parent item ID")
    .option("--reviewer <value>", "Set reviewer")
    .option("--risk <value>", "Set risk level: low|med|medium|high|critical (med persists as medium)")
    .option("--confidence <value>", "Set confidence level: 0..100|low|med|medium|high (med persists as medium)")
    .option("--sprint <value>", "Set sprint identifier")
    .option("--release <value>", "Set release identifier")
    .option("--blocked-by <value>", "Set blocked-by item ID or reason")
    .option("--blocked_by <value>", "Alias for --blocked-by")
    .option("--blocked-reason <value>", "Set blocked reason")
    .option("--blocked_reason <value>", "Alias for --blocked-reason")
    .option("--unblock-note <value>", "Set unblock rationale note")
    .option("--unblock_note <value>", "Alias for --unblock-note")
    .option("--reporter <value>", "Set issue reporter")
    .option("--severity <value>", "Set issue severity: low|med|medium|high|critical (med persists as medium)")
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
    .option("--dep <value>", "Add dependency entries id=<id>,kind=<value>,author=<value>,created_at=<iso|now>,source_kind=<value> (repeatable)", collect)
    .option("--dep-remove <value>", "Remove dependencies by id or id=<id>,kind=<value>,source_kind=<value> selectors (repeatable)", collect)
    .option("--dep_remove <value>", "Alias for --dep-remove", collect)
    .option("--replace-deps", "Atomically replace dependency entries with the provided --dep values")
    .option("--replace-tests", "Atomically replace linked test entries with the provided --test values")
    .option("--comment <value>", "Append comment seed author=<value>,created_at=<iso|now>,text=<value> (also accepts markdown pairs and - for stdin; repeatable)", collect)
    .option("--note <value>", "Append note seed author=<value>,created_at=<iso|now>,text=<value> (also accepts markdown pairs and - for stdin; repeatable)", collect)
    .option("--learning <value>", "Append learning seed author=<value>,created_at=<iso|now>,text=<value> (also accepts markdown pairs and - for stdin; repeatable)", collect)
    .option("--file <value>", "Append linked file path=<value>,scope=<project|global>,note=<text> (also accepts markdown pairs and - for stdin; repeatable)", collect)
    .option("--test <value>", "Append linked test command=<value>,path=<value>,scope=<project|global>,timeout_seconds=<n>,pm_context_mode=<schema|tracker|auto> (also accepts markdown pairs and - for stdin; repeatable)", collect)
    .option("--doc <value>", "Append linked doc path=<value>,scope=<project|global>,note=<text> (also accepts markdown pairs and - for stdin; repeatable)", collect)
    .option("--reminder <value>", "Set reminders at=<iso|relative>,text=<text> (also accepts markdown pairs and - for stdin; repeatable)", collect)
    .option("--event <value>", "Set events start=<iso|relative>,end=<iso|relative>,title=<text>,all_day=<true|false>,recur_* fields (also accepts markdown pairs and - for stdin; repeatable)", collect)
    .option("--type-option <value>", "Set type options key=value or key=<name>,value=<value> (also accepts key:value and markdown pairs; use - for stdin; repeatable)", collect)
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
    .option("--force", "Force ownership override")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
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
    .option("--reminder <value>", "Add reminder entry at=<iso|relative>,text=<text>", collect)
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
    .command("normalize")
    .description("Normalize lifecycle metadata with deterministic dry-run plans and optional apply mode.")
    .option("--filter-status <value>", "Filter by status before planning or apply")
    .option("--filter-type <value>", "Filter by item type before planning or apply")
    .option("--filter-tag <value>", "Filter by tag before planning or apply")
    .option("--filter-priority <value>", "Filter by priority before planning or apply")
    .option("--filter-deadline-before <value>", "Filter by deadline upper bound before planning or apply")
    .option("--filter-deadline-after <value>", "Filter by deadline lower bound before planning or apply")
    .option("--filter-assignee <value>", "Filter by assignee before planning or apply")
    .option("--filter-assignee-filter <value>", "Filter assignee presence: assigned|unassigned before planning or apply")
    .option("--filter-assignee_filter <value>", "Alias for --filter-assignee-filter")
    .option("--filter-parent <value>", "Filter by parent item ID before planning or apply")
    .option("--filter-sprint <value>", "Filter by sprint before planning or apply")
    .option("--filter-release <value>", "Filter by release before planning or apply")
    .option("--limit <n>", "Limit matched item count before planning/apply")
    .option("--offset <n>", "Skip first n matched rows before planning/apply")
    .option("--dry-run", "Preview normalize findings without mutating (default)")
    .option("--apply", "Apply normalize changes using update semantics")
    .option("--author <value>", "Mutation author for apply mode")
    .option("--message <value>", "Mutation message for apply mode")
    .option("--allow-audit-update", "Allow non-owner metadata-only audit updates without requiring --force")
    .option("--allow_audit_update", "Alias for --allow-audit-update")
    .option("--force", "Force ownership override for apply mode")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runNormalize(
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
          dryRun: options.dryRun === true ? true : undefined,
          apply: options.apply === true ? true : undefined,
          author: typeof options.author === "string" ? options.author : undefined,
          message: typeof options.message === "string" ? options.message : undefined,
          allowAuditUpdate:
            options.allowAuditUpdate === true || options.allow_audit_update === true || options.allowAudit_update === true
              ? true
              : undefined,
          force: options.force === true ? true : undefined,
        },
        globalOptions,
      );
      if (result.mode === "apply") {
        await invalidateSearchCachesForMutation(globalOptions, result);
      }
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=normalize took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("close")
    .argument("<id>", "Item id")
    .argument("<text>", "Close reason text")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--validate-close [mode]", 'Validate closure metadata before close: "off", "warn", or "strict" (default: settings governance preset)')
    .option("--force", "Force ownership override")
    .description("Close an item with a required reason.")
    .action(async (id: string, text: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runClose(
        id,
        text,
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
    .requiredOption("--body <value>", "Text to append to body (or - for stdin)")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "Mutation message")
    .option("--force", "Force ownership override")
    .description("Append text to an item's body.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runAppend(id, {
        body: typeof options.body === "string" ? options.body : "",
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

  program
    .command("comments")
    .argument("<id>", "Item id")
    .argument("[text]", "Optional comment text shorthand (equivalent to --add; use - for stdin)")
    .option("--add <text>", "Add one comment entry (plain text fallback, text=<value>, markdown pairs, or - for stdin; CSV-like key fragments are preserved as plain text unless text is explicit)")
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
      if (addFromOption !== undefined && addFromPositional !== undefined) {
        throw new PmCliError("Specify comment text either as positional [text] or with --add, not both", EXIT_CODE.USAGE);
      }
      const add = addFromOption ?? addFromPositional;
      const result = await runComments(id, {
        add,
        limit: typeof options.limit === "string" ? options.limit : undefined,
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        allowAuditComment: Boolean(options.allowAuditComment),
        force: Boolean(options.force),
      }, globalOptions);
      if (typeof add === "string") {
        await invalidateSearchCachesForMutation(globalOptions, result);
      }
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=comments took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("comments-audit")
    .option("--status <value>", "Filter by item status")
    .option("--type <value>", "Filter by item type")
    .option("--tag <value>", "Filter by tag")
    .option("--priority <value>", "Filter by priority")
    .option("--parent <value>", "Filter by parent item ID")
    .option("--sprint <value>", "Filter by sprint")
    .option("--release <value>", "Filter by release")
    .option("--assignee <value>", "Filter by assignee")
    .option("--assignee-filter <value>", "Filter assignee presence: assigned|unassigned")
    .option("--assignee_filter <value>", "Alias for --assignee-filter")
    .option("--limit-items <n>", "Limit returned item count")
    .option("--limit <n>", "Alias for --limit-items")
    .option("--full-history", "Export full comment history rows (cannot be combined with --latest)")
    .option("--latest <n>", "Return latest n comments per item (default: 1, use 0 for summary-only rows)")
    .description("Audit latest comments or full comment history across filtered items.")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runCommentsAudit({
        status: typeof options.status === "string" ? options.status : undefined,
        type: typeof options.type === "string" ? options.type : undefined,
        tag: typeof options.tag === "string" ? options.tag : undefined,
        priority: typeof options.priority === "string" ? options.priority : undefined,
        parent: typeof options.parent === "string" ? options.parent : undefined,
        sprint: typeof options.sprint === "string" ? options.sprint : undefined,
        release: typeof options.release === "string" ? options.release : undefined,
        assignee: typeof options.assignee === "string" ? options.assignee : undefined,
        assigneeFilter: typeof options.assigneeFilter === "string" ? options.assigneeFilter : undefined,
        limit: typeof options.limit === "string" ? options.limit : undefined,
        limitItems: typeof options.limitItems === "string" ? options.limitItems : undefined,
        fullHistory: options.fullHistory === true,
        latest: typeof options.latest === "string" ? options.latest : undefined,
      }, globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=comments-audit took_ms=${Date.now() - startedAt}`);
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
