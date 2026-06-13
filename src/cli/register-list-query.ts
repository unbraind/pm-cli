import { Option, type Command } from "commander";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import type { ItemStatus } from "../types/index.js";
import {
  getGlobalOptions,
  normalizeAggregateOptions,
  normalizeActivityOptions,
  normalizeContextOptions,
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



export interface RegisterListQueryCommandsOptions {
  commandFilter?: Set<string>;
}

function shouldRegisterListQueryCommand(commandName: string, commandFilter?: Set<string>): boolean {
  if (!commandFilter || commandFilter.size === 0) {
    return true;
  }
  if (commandName === "context") {
    return commandFilter.has("context") || commandFilter.has("ctx");
  }
  return commandFilter.has(commandName);
}

export function registerListQueryCommands(program: Command, options?: RegisterListQueryCommandsOptions): void {
  const commandFilter = options?.commandFilter;
  const shouldRegister = (commandName: string): boolean => shouldRegisterListQueryCommand(commandName, commandFilter);
  // Register a flag and hide it from --help text while keeping it functional as
  // a parse-time alias. Used for pure snake_case underscore-duplicate aliases
  // (e.g. --assignee_filter for --assignee-filter) so they no longer bloat
  // --help output. The option still appears in command.options, so JSON help
  // and completion are unchanged.
  function addHiddenOption(command: Command, flags: string, description: string): void {
    command.addOption(new Option(flags, description).hideHelp());
  }

  function registerListCommand(
    name: string,
    description: string,
    status?: ItemStatus,
    excludeTerminal?: boolean,
    allowStatusFilter?: boolean,
    defaultBrief?: boolean,
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
      .option("--updated-after <value>", 'Filter by updated_at lower bound: ISO timestamp or signed relative (e.g. "-2h"/"-7d" for the past). "Changed since my last window" → --updated-after <ISO>')
      .option("--updated-before <value>", "Filter by updated_at upper bound: ISO timestamp or signed relative (-2h/+1d)")
      .option("--created-after <value>", "Filter by created_at lower bound: ISO timestamp or signed relative (-2h/+1d)")
      .option("--created-before <value>", "Filter by created_at upper bound: ISO timestamp or signed relative (-2h/+1d)")
      .option("--ids <value>", "Filter by explicit item IDs (comma-separated or repeatable)")
      .option("--assignee <value>", "Filter by assignee")
      .option("--assignee-filter <value>", "Filter assignee presence: assigned|unassigned")
      .option("--parent <value>", "Filter by parent item ID")
      .option("--sprint <value>", "Filter by sprint")
      .option("--release <value>", "Filter by release")
      .option("--filter-ac-missing", "Show only items missing acceptance_criteria")
      .option("--filter-estimates-missing", "Show only items missing estimated_minutes")
      .option("--filter-resolution-missing", "Show only terminal items missing resolution")
      .option("--filter-metadata-missing", "Show only items missing any tracked metadata (AC, estimate, or resolution)")
      .option("--limit <n>", "Limit returned item count")
      .option("--offset <n>", "Skip the first n matching rows before limit is applied")
      .option("--include-body", "Include item body in each returned list row")
      .option("--compact", "Render compact list projection fields (mutually exclusive with --brief/--full/--fields)")
      .option("--brief", "Ultra-compact output: id, status, type, title only (agent-optimized, mutually exclusive with --compact/--full/--fields)")
      .option("--full", "Render full list projection fields (mutually exclusive with --compact/--brief/--fields)")
      .option(
        "--fields <value>",
        "Render custom comma-separated list fields (mutually exclusive with --compact/--brief/--full; valid: --fields id,title)",
      )
      .option("--sort <value>", "Sort field: priority|deadline|updated_at|created_at|title|parent (aliases: updated, created)")
      .option("--order <value>", "Sort order: asc|desc (requires --sort)")
      .option("--tree", "Render rows in parent/child tree order")
      .option("--tree-depth <n>", "Maximum recursion depth with --tree (0 keeps root rows only)")
      .option("--stream", "Emit line-delimited JSON rows (requires --json)")
      .action(async (options: Record<string, unknown>, actionCommand) => {
        const globalOptions = getGlobalOptions(actionCommand);
        const startedAt = Date.now();
        const listOptions = normalizeListOptions(options);
        if (
          defaultBrief === true &&
          listOptions.includeBody !== true &&
          listOptions.compact !== true &&
          listOptions.brief !== true &&
          listOptions.full !== true &&
          listOptions.fields === undefined
        ) {
          listOptions.brief = true;
        }
        if (excludeTerminal) listOptions.excludeTerminal = true;
        const { runList } = await import("./commands/list.js");
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
    // Hidden pure snake_case underscore-duplicate alias (kept parse-functional).
    addHiddenOption(command, "--tags <value>", "Alias for --tag");
    addHiddenOption(command, "--assignee_filter <value>", "Alias for --assignee-filter");
    addHiddenOption(command, "--tree_depth <n>", "Alias for --tree-depth");
    // Singular alias so `--filter-estimate-missing` works (matches update-many spelling).
    addHiddenOption(command, "--filter-estimate-missing", "Alias for --filter-estimates-missing");
  }

  if (shouldRegister("list")) {
    registerListCommand("list", "List active items with optional filters.", undefined, true, true, true);
  }
  if (shouldRegister("list-all")) {
    registerListCommand("list-all", "List all items with optional filters.", undefined, false, true);
  }
  if (shouldRegister("list-draft")) {
    registerListCommand("list-draft", "List draft items with optional filters.", "draft");
  }
  if (shouldRegister("list-open")) {
    registerListCommand("list-open", "List open items with optional filters.", "open", false, false, true);
  }
  if (shouldRegister("list-in-progress")) {
    registerListCommand("list-in-progress", "List in-progress items with optional filters.", "in_progress", false, false, true);
  }
  if (shouldRegister("list-blocked")) {
    registerListCommand("list-blocked", "List blocked items with optional filters.", "blocked");
  }
  if (shouldRegister("list-closed")) {
    registerListCommand("list-closed", "List closed items with optional filters.", "closed");
  }
  if (shouldRegister("list-canceled")) {
    registerListCommand("list-canceled", "List canceled items with optional filters.", "canceled");
  }

  if (shouldRegister("aggregate")) {
    const aggregateCommand = program
      .command("aggregate")
      .description("Aggregate grouped item counts for governance queries.")
      .option(
        "--group-by <value>",
        "Comma-separated group-by fields (supported: parent,type,priority,status,assignee,tags,sprint,release)",
      )
      .option("--count", "Return grouped counts (default behavior)")
      .option("--completion", "Add open/in_progress/closed/other counts and completion_pct per group")
      .option("--sum <field>", "Sum a numeric field per group")
      .option("--avg <field>", "Average a numeric field per group")
      .option("--include-unparented", "Include unparented rows when grouping by parent")
      .option("--status <value>", "Filter by item status")
      .option("--type <value>", "Filter by item type")
      .option("--tag <value>", "Filter by tag")
      .option("--priority <value>", "Filter by priority")
      .option("--deadline-before <value>", "Filter by deadline upper bound (ISO/date string or relative)")
      .option("--deadline-after <value>", "Filter by deadline lower bound (ISO/date string or relative)")
      .option("--assignee <value>", "Filter by assignee")
      .option("--assignee-filter <value>", "Filter assignee presence: assigned|unassigned")
      .option("--parent <value>", "Filter by parent item ID")
      .option("--sprint <value>", "Filter by sprint")
      .option("--release <value>", "Filter by release");
    // Hidden pure snake_case underscore-duplicate aliases (kept parse-functional).
    addHiddenOption(aggregateCommand, "--include_unparented", "Alias for --include-unparented");
    addHiddenOption(aggregateCommand, "--assignee_filter <value>", "Alias for --assignee-filter");
    aggregateCommand
      .action(async (options: Record<string, unknown>, command) => {
        const globalOptions = getGlobalOptions(command);
        const startedAt = Date.now();
        const { runAggregate } = await import("./commands/aggregate.js");
        const result = await runAggregate(normalizeAggregateOptions(options), globalOptions);
        printResult(result, globalOptions);
        if (globalOptions.profile) {
          printError(`profile:command=aggregate took_ms=${Date.now() - startedAt}`);
        }
      });
  }

  if (shouldRegister("context")) {
    const contextCommand = program
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
      .option("--sprint <value>", "Filter by sprint")
      .option("--release <value>", "Filter by release")
      .option("--limit <n>", "Limit focus and agenda rows per section")
      .option("--format <value>", "Context output format override: markdown|toon|json")
      .option("--depth <value>", "Context depth: brief|standard|deep (default: settings or brief)")
      .option("--section <value...>", "Include specific sections (repeatable; overrides --depth)")
      .option("--activity-limit <n>", "Limit recent activity entries (default: settings or 10)")
      .option("--stale-threshold <value>", "Staleness cutoff in days (e.g. 7 or 7d; default: settings or 7)");
    // Hidden pure snake_case underscore-duplicate alias (kept parse-functional).
    addHiddenOption(contextCommand, "--assignee_filter <value>", "Alias for --assignee-filter");
    contextCommand
      .action(async (options: Record<string, unknown>, actionCommand) => {
        const globalOptions = getGlobalOptions(actionCommand);
        const startedAt = Date.now();
        const normalized = normalizeContextOptions(options);
        const commands = await import("./commands/context.js");
        const result = await commands.runContext(normalized, globalOptions);
        const outputFormat = commands.resolveContextOutputFormat(normalized, globalOptions);
        if (outputFormat === "markdown") {
          if (!globalOptions.quiet) {
            writeStdout(`${commands.renderContextMarkdown(result)}\n`);
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
  }

  if (shouldRegister("search")) {
    const searchCommand = program
      .command("search")
      .argument("<keywords...>", "Keyword query tokens")
      .description("Search items with keyword, semantic, or hybrid retrieval.")
      .option("--mode <value>", "Search mode: keyword|semantic|hybrid (default: keyword)")
      .option("--semantic", "Shorthand for --mode semantic")
      .option("--hybrid", "Shorthand for --mode hybrid")
      .option(
        "--semantic-weight <value>",
        "Override hybrid semantic weight for this query (0..1); invalid values fall back to settings",
      )
      .option("--include-linked", "Include linked files, docs, and tests in the searchable corpus")
      .option("--title-exact", "Require exact normalized title match for the full query string")
      .option("--phrase-exact", "Require exact normalized phrase match in searchable text")
      .option("--status <value>", "Filter by status before query (open/closed/canceled aliases or configured status id; CSV)")
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
        const { runSearch } = await import("./commands/search.js");
        const searchOptions = normalizeSearchOptions(options);
        const result = await runSearch(
          normalizeSearchKeywordsInput(keywords),
          {
            ...searchOptions,
            mode:
              typeof searchOptions.mode === "string" && searchOptions.mode.trim().length > 0
                ? searchOptions.mode
                : "keyword",
          },
          globalOptions,
        );
        printResult(result, globalOptions);
        if (globalOptions.profile) {
          printError(`profile:command=search took_ms=${Date.now() - startedAt}`);
        }
      });
    addHiddenOption(searchCommand, "--tags <value>", "Alias for --tag");
  }

  if (shouldRegister("get")) {
    const getCommand = program
      .command("get")
      .argument("<id>", "Item id")
      .option("--depth <value>", "Detail depth: brief|standard|deep|full (full aliases deep; default: standard)")
      .option("--full", "Explicit full item read; equivalent to --depth deep (mutually exclusive with --depth/--fields)")
      .option("--fields <value>", "Render custom comma-separated item metadata fields (for example: --fields id,title,status,parent,type)")
      .option("--tree", "Include descendants rooted at the requested item")
      .option("--tree-depth <n>", "Maximum subtree depth for --tree descendants")
      .description("Show item details by ID.")
      .action(async (id: string, options: Record<string, unknown>, command) => {
        const globalOptions = getGlobalOptions(command);
        const startedAt = Date.now();
        const { runGet } = await import("./commands/get.js");
        const result = await runGet(
          id,
          globalOptions,
          {
            depth: typeof options.depth === "string" ? options.depth : undefined,
            fields: typeof options.fields === "string" ? options.fields : undefined,
            full: Boolean(options.full),
            tree: options.tree === true,
            treeDepth:
              typeof options.treeDepth === "string"
                ? options.treeDepth
                : typeof options.tree_depth === "string"
                  ? options.tree_depth
                  : undefined,
          },
        );
        printResult(result, globalOptions);
        if (globalOptions.profile) {
          printError(`profile:command=get took_ms=${Date.now() - startedAt}`);
        }
      });
    addHiddenOption(getCommand, "--tree_depth <n>", "Alias for --tree-depth");
  }

  if (shouldRegister("history")) {
    program
      .command("history")
      .argument("<id>", "Item id")
      .option("--limit <n>", "Return only the latest n history entries")
      .option("--compact", "Condensed output: show entry index, timestamp, op, author, patch count, and changed fields")
      .option("--full", "Show full history entries with JSON Patch payloads")
      .option("--diff", "Include per-entry field-level before/after value diffs computed by replaying the history chain")
      .option("--field <name>", "With --diff, show only entries that changed this field (implies --diff)")
      .option("--verify", "Verify hash chain and replay integrity for the full history stream")
      .description("Show item history entries.")
      .action(async (id: string, options: Record<string, unknown>, command) => {
        const globalOptions = getGlobalOptions(command);
        const startedAt = Date.now();
        if (options.compact === true && options.full === true) {
          throw new PmCliError("History projection options are mutually exclusive. Use either --compact or --full.", EXIT_CODE.USAGE);
        }
        const field = typeof options.field === "string" ? options.field : undefined;
        const { runHistory } = await import("./commands/history.js");
        const result = await runHistory(
          id,
          {
            limit: typeof options.limit === "string" ? options.limit : undefined,
            compact: options.full === true ? false : true,
            diff: Boolean(options.diff) || field !== undefined,
            field,
            verify: Boolean(options.verify),
          },
          globalOptions,
        );
        printResult(result, globalOptions);
        if (globalOptions.profile) {
          printError(`profile:command=history took_ms=${Date.now() - startedAt}`);
        }
      });
  }

  if (shouldRegister("activity")) {
    program
      .command("activity")
      .option("--id <value>", "Filter by item ID")
      .option("--op <value>", "Filter by history operation")
      .option("--author <value>", "Filter by history author")
      .option("--from <value>", "Lower timestamp bound (ISO/date string or relative)")
      .option("--to <value>", "Upper timestamp bound (ISO/date string or relative)")
      .option("--limit <n>", "Return only the latest n activity entries")
      .option("--compact", "Condensed output: show only id, op, ts, author, msg per entry")
      .option("--full", "Show full activity entries with JSON Patch payloads")
      .option("--stream [mode]", "Emit line-delimited JSON rows (requires --json). Optional mode: rows|ndjson|jsonl")
      .description("Show recent activity across items.")
      .action(async (options: Record<string, unknown>, command) => {
        const globalOptions = getGlobalOptions(command);
        const startedAt = Date.now();
        if (options.compact === true && options.full === true) {
          throw new PmCliError("Activity projection options are mutually exclusive. Use either --compact or --full.", EXIT_CODE.USAGE);
        }
        const normalized = normalizeActivityOptions(options);
        const { runActivity } = await import("./commands/activity.js");
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
}
