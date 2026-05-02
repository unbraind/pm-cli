import type { Command } from "commander";
import {
  runAggregate,
  runActivity,
  runCalendar,
  runContext,
  runDedupeAudit,
  runGet,
  runHistory,
  runList,
  runReindex,
  runSearch,
  renderCalendarMarkdown,
  renderContextMarkdown,
  resolveCalendarOutputFormat,
  resolveContextOutputFormat,
} from "./commands/index.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import type { ItemStatus } from "../types/index.js";
import {
  getGlobalOptions,
  normalizeAggregateOptions,
  normalizeActivityOptions,
  normalizeCalendarOptions,
  normalizeContextOptions,
  normalizeDedupeAuditOptions,
  normalizeListOptions,
  normalizeSearchKeywordsInput,
  normalizeSearchOptions,
  printActivityJsonStream,
  printError,
  printListJsonStream,
  printResult,
  resolveActivityStreamMode,
  writeStdout,
} from "./registration-helpers.js";

export function registerListQueryCommands(program: Command): void {
  function registerListCommand(
    name: string,
    description: string,
    status?: ItemStatus,
    excludeTerminal?: boolean,
    allowStatusFilter?: boolean,
  ): void {
    const command = program.command(name).description(description);
    if (allowStatusFilter) {
      command.option("--status <value>", "Filter by status");
    }
    command
      .option("--type <value>", "Filter by item type")
      .option("--tag <value>", "Filter by tag")
      .option("--priority <value>", "Filter by priority")
      .option("--deadline-before <value>", "Filter by deadline upper bound (ISO/date string or relative)")
      .option("--deadline-after <value>", "Filter by deadline lower bound (ISO/date string or relative)")
      .option("--assignee <value>", "Filter by assignee")
      .option("--assignee-filter <value>", "Filter assignee presence: assigned|unassigned")
      .option("--assignee_filter <value>", "Alias for --assignee-filter")
      .option("--parent <value>", "Filter by parent item ID")
      .option("--sprint <value>", "Filter by sprint")
      .option("--release <value>", "Filter by release")
      .option("--limit <n>", "Limit returned item count")
      .option("--offset <n>", "Skip the first n matching rows before limit is applied")
      .option("--include-body", "Include item body in each returned list row")
      .option("--compact", "Render compact list projection fields (mutually exclusive with --brief/--fields)")
      .option("--brief", "Ultra-compact output: id, status, type, title only (agent-optimized, mutually exclusive with --compact/--fields)")
      .option(
        "--fields <value>",
        "Render custom comma-separated list fields (mutually exclusive with --compact/--brief; valid: --fields id,title)",
      )
      .option("--sort <value>", "Sort field: priority|deadline|updated_at|created_at|title|parent")
      .option("--order <value>", "Sort order: asc|desc (requires --sort)")
      .option("--stream", "Emit line-delimited JSON rows (requires --json)")
      .action(async (options: Record<string, unknown>, actionCommand) => {
        const globalOptions = getGlobalOptions(actionCommand);
        const startedAt = Date.now();
        const listOptions = normalizeListOptions(options);
        if (excludeTerminal) listOptions.excludeTerminal = true;
        const result = await runList(status, listOptions, globalOptions);
        const streamMode = options.stream === true;
        if (streamMode && !globalOptions.json) {
          throw new PmCliError("--stream requires --json output mode.", EXIT_CODE.USAGE);
        }
        if (streamMode) {
          printListJsonStream(name, result, globalOptions);
        } else {
          printResult(result, globalOptions);
        }
        if (globalOptions.profile) {
          printError(`profile:command=${name} took_ms=${Date.now() - startedAt}`);
        }
      });
  }

  registerListCommand("list", "List active items with optional filters.", undefined, true, true);
  registerListCommand("list-all", "List all items with optional filters.", undefined, false, true);
  registerListCommand("list-draft", "List draft items with optional filters.", "draft");
  registerListCommand("list-open", "List open items with optional filters.", "open");
  registerListCommand("list-in-progress", "List in-progress items with optional filters.", "in_progress");
  registerListCommand("list-blocked", "List blocked items with optional filters.", "blocked");
  registerListCommand("list-closed", "List closed items with optional filters.", "closed");
  registerListCommand("list-canceled", "List canceled items with optional filters.", "canceled");

  program
    .command("aggregate")
    .description("Aggregate grouped item counts for governance queries.")
    .option(
      "--group-by <value>",
      "Comma-separated group-by fields (supported: parent,type,priority,status,assignee,tags,sprint,release)",
    )
    .option("--count", "Return grouped counts (default behavior)")
    .option("--include-unparented", "Include unparented rows when grouping by parent")
    .option("--include_unparented", "Alias for --include-unparented")
    .option("--status <value>", "Filter by item status")
    .option("--type <value>", "Filter by item type")
    .option("--tag <value>", "Filter by tag")
    .option("--priority <value>", "Filter by priority")
    .option("--deadline-before <value>", "Filter by deadline upper bound (ISO/date string or relative)")
    .option("--deadline-after <value>", "Filter by deadline lower bound (ISO/date string or relative)")
    .option("--assignee <value>", "Filter by assignee")
    .option("--assignee-filter <value>", "Filter assignee presence: assigned|unassigned")
    .option("--assignee_filter <value>", "Alias for --assignee-filter")
    .option("--parent <value>", "Filter by parent item ID")
    .option("--sprint <value>", "Filter by sprint")
    .option("--release <value>", "Filter by release")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runAggregate(normalizeAggregateOptions(options), globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=aggregate took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("dedupe-audit")
    .description("Audit potential duplicate items with exact, fuzzy, or parent-scoped matching.")
    .option("--mode <value>", "Dedupe mode: title_exact|title_fuzzy|parent_scope")
    .option("--limit <n>", "Limit returned duplicate clusters")
    .option("--threshold <value>", "Fuzzy mode token similarity threshold between 0 and 1")
    .option("--status <value>", "Filter by item status")
    .option("--type <value>", "Filter by item type")
    .option("--tag <value>", "Filter by tag")
    .option("--priority <value>", "Filter by priority")
    .option("--deadline-before <value>", "Filter by deadline upper bound (ISO/date string or relative)")
    .option("--deadline-after <value>", "Filter by deadline lower bound (ISO/date string or relative)")
    .option("--assignee <value>", "Filter by assignee")
    .option("--assignee-filter <value>", "Filter assignee presence: assigned|unassigned")
    .option("--assignee_filter <value>", "Alias for --assignee-filter")
    .option("--parent <value>", "Filter by parent item ID")
    .option("--sprint <value>", "Filter by sprint")
    .option("--release <value>", "Filter by release")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runDedupeAudit(normalizeDedupeAuditOptions(options), globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=dedupe-audit took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("calendar")
    .alias("cal")
    .description("Show deadline/reminder calendar views (agenda/day/week/month).")
    .option("--view <value>", "Calendar view: agenda|day|week|month (default: agenda)")
    .option("--date <value>", "Anchor date/time for view calculations (ISO/date string or relative)")
    .option("--from <value>", "Agenda lower bound (ISO/date string or relative)")
    .option("--to <value>", "Agenda upper bound (ISO/date string or relative)")
    .option("--past", "Include past entries in the selected view")
    .option("--full-period", "For day/week/month views, include the full anchored period without now-clipping")
    .option("--full_period", "Alias for --full-period")
    .option("--type <value>", "Filter by item type")
    .option("--tag <value>", "Filter by tag")
    .option("--priority <value>", "Filter by priority")
    .option("--status <value>", "Filter by status")
    .option("--assignee <value>", "Filter by assignee")
    .option("--assignee-filter <value>", "Filter assignee presence: assigned|unassigned")
    .option("--assignee_filter <value>", "Alias for --assignee-filter")
    .option("--sprint <value>", "Filter by sprint")
    .option("--release <value>", "Filter by release")
    .option("--include <value>", "Include sources: deadlines|reminders|events|all (comma or | separated)")
    .option("--recurrence-lookahead-days <n>", "Bound open-ended recurrence generation lookahead days")
    .option("--recurrence_lookahead_days <n>", "Alias for --recurrence-lookahead-days")
    .option("--recurrence-lookback-days <n>", "Bound open-ended recurrence generation lookback days")
    .option("--recurrence_lookback_days <n>", "Alias for --recurrence-lookback-days")
    .option("--occurrence-limit <n>", "Cap generated occurrences per recurring event")
    .option("--occurrence_limit <n>", "Alias for --occurrence-limit")
    .option("--limit <n>", "Limit returned event count")
    .option("--format <value>", "Calendar output format override: markdown|toon|json")
    .action(async (options: Record<string, unknown>, actionCommand) => {
      const globalOptions = getGlobalOptions(actionCommand);
      const startedAt = Date.now();
      const normalized = normalizeCalendarOptions(options);
      const result = await runCalendar(normalized, globalOptions);
      const outputFormat = resolveCalendarOutputFormat(normalized, globalOptions);
      if (outputFormat === "markdown") {
        if (!globalOptions.quiet) {
          writeStdout(`${renderCalendarMarkdown(result)}\n`);
        }
      } else {
        printResult(result, {
          ...globalOptions,
          json: outputFormat === "json",
        });
      }
      if (globalOptions.profile) {
        printError(`profile:command=calendar took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("context")
    .alias("ctx")
    .description("Show a token-efficient project context snapshot for next-work decisions.")
    .option("--date <value>", "Anchor date/time for agenda window calculations (ISO/date string or relative)")
    .option("--from <value>", "Agenda lower bound (ISO/date string or relative)")
    .option("--to <value>", "Agenda upper bound (ISO/date string or relative)")
    .option("--past", "Include past agenda entries in bounded windows")
    .option("--type <value>", "Filter by item type")
    .option("--tag <value>", "Filter by tag")
    .option("--priority <value>", "Filter by priority")
    .option("--assignee <value>", "Filter by assignee")
    .option("--assignee-filter <value>", "Filter assignee presence: assigned|unassigned")
    .option("--assignee_filter <value>", "Alias for --assignee-filter")
    .option("--sprint <value>", "Filter by sprint")
    .option("--release <value>", "Filter by release")
    .option("--limit <n>", "Limit focus and agenda rows per section")
    .option("--format <value>", "Context output format override: markdown|toon|json")
    .action(async (options: Record<string, unknown>, actionCommand) => {
      const globalOptions = getGlobalOptions(actionCommand);
      const startedAt = Date.now();
      const normalized = normalizeContextOptions(options);
      const result = await runContext(normalized, globalOptions);
      const outputFormat = resolveContextOutputFormat(normalized, globalOptions);
      if (outputFormat === "markdown") {
        if (!globalOptions.quiet) {
          writeStdout(`${renderContextMarkdown(result)}\n`);
        }
      } else {
        printResult(result, {
          ...globalOptions,
          json: outputFormat === "json",
        });
      }
      if (globalOptions.profile) {
        printError(`profile:command=context took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("search")
    .argument("<keywords...>", "Keyword query tokens")
    .description("Search items with keyword, semantic, or hybrid modes.")
    .option(
      "--mode <value>",
      "Search mode: keyword|semantic|hybrid (default: hybrid when semantic config or local Ollama auto-defaults are available, else keyword)",
    )
    .option("--include-linked", "Include readable linked docs/files/tests content in keyword and hybrid lexical scoring")
    .option("--title-exact", "Require exact normalized title match against the full query")
    .option("--phrase-exact", "Require exact normalized query phrase match in item text fields")
    .option("--type <value>", "Filter by item type")
    .option("--tag <value>", "Filter by tag")
    .option("--priority <value>", "Filter by priority")
    .option("--deadline-before <value>", "Filter by deadline upper bound (ISO/date string or relative)")
    .option("--deadline-after <value>", "Filter by deadline lower bound (ISO/date string or relative)")
    .option("--compact", "Render compact search hits (default; mutually exclusive with --full/--fields)")
    .option("--full", "Render full search hits with nested item payloads (mutually exclusive with --compact/--fields)")
    .option(
      "--fields <value>",
      "Render custom comma-separated search hit fields (mutually exclusive with --compact/--full; valid: --fields id,title,score; invalid: --full --fields id,title)",
    )
    .option("--limit <n>", "Limit returned item count")
    .action(async (keywords: string[], options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runSearch(normalizeSearchKeywordsInput(keywords), normalizeSearchOptions(options), globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=search took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("reindex")
    .description("Rebuild search artifacts for keyword, semantic, and hybrid modes.")
    .option("--mode <value>", "Reindex mode: keyword|semantic|hybrid", "keyword")
    .option("--progress", "Emit progress updates to stderr (always shown in TTY, opt-in for non-TTY)")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runReindex(
        {
          mode: typeof options.mode === "string" ? options.mode : undefined,
          progress: Boolean(options.progress),
        },
        globalOptions,
      );
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=reindex took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("get")
    .argument("<id>", "Item id")
    .description("Show item details by ID.")
    .action(async (id: string, _options: unknown, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runGet(id, globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=get took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("history")
    .argument("<id>", "Item id")
    .option("--limit <n>", "Return only the latest n history entries")
    .option("--diff", "Include per-entry changed field summaries from history patches")
    .option("--verify", "Verify hash chain and replay integrity for the full history stream")
    .description("Show item history entries.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runHistory(
        id,
        {
          limit: typeof options.limit === "string" ? options.limit : undefined,
          diff: Boolean(options.diff),
          verify: Boolean(options.verify),
        },
        globalOptions,
      );
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=history took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("activity")
    .option("--id <value>", "Filter by item ID")
    .option("--op <value>", "Filter by history operation")
    .option("--author <value>", "Filter by history author")
    .option("--from <value>", "Lower timestamp bound (ISO/date string or relative)")
    .option("--to <value>", "Upper timestamp bound (ISO/date string or relative)")
    .option("--limit <n>", "Return only the latest n activity entries")
    .option("--compact", "Condensed output: show only id, op, ts, author, msg per entry")
    .option("--stream [mode]", "Emit line-delimited JSON rows (requires --json). Optional mode: rows|ndjson|jsonl")
    .description("Show recent activity across items.")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const normalized = normalizeActivityOptions(options);
      const result = await runActivity(normalized, globalOptions);
      const streamMode = resolveActivityStreamMode(options.stream);
      if (streamMode && !globalOptions.json) {
        throw new PmCliError("--stream requires --json output mode.", EXIT_CODE.USAGE);
      }
      if (streamMode) {
        printActivityJsonStream(result, normalized, globalOptions);
      } else {
        printResult(result, globalOptions);
      }
      if (globalOptions.profile) {
        printError(`profile:command=activity took_ms=${Date.now() - startedAt}`);
      }
    });
}
