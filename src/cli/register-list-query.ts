import type { Command } from "commander";
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

type ListQueryCommandsModule = typeof import("./commands/index.js");

let listQueryCommandsModulePromise: Promise<ListQueryCommandsModule> | null = null;

async function loadListQueryCommandsModule(): Promise<ListQueryCommandsModule> {
  listQueryCommandsModulePromise ??= import("./commands/index.js");
  return listQueryCommandsModulePromise;
}

export function registerListQueryCommands(program: Command): void {
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
      .option("--assignee <value>", "Filter by assignee")
      .option("--assignee-filter <value>", "Filter assignee presence: assigned|unassigned")
      .option("--assignee_filter <value>", "Alias for --assignee-filter")
      .option("--parent <value>", "Filter by parent item ID")
      .option("--sprint <value>", "Filter by sprint")
      .option("--release <value>", "Filter by release")
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
      .option("--sort <value>", "Sort field: priority|deadline|updated_at|created_at|title|parent")
      .option("--order <value>", "Sort order: asc|desc (requires --sort)")
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
        const { runList } = await loadListQueryCommandsModule();
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

  registerListCommand("list", "List active items with optional filters.", undefined, true, true, true);
  registerListCommand("list-all", "List all items with optional filters.", undefined, false, true);
  registerListCommand("list-draft", "List draft items with optional filters.", "draft");
  registerListCommand("list-open", "List open items with optional filters.", "open", false, false, true);
  registerListCommand("list-in-progress", "List in-progress items with optional filters.", "in_progress", false, false, true);
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
      const { runAggregate } = await loadListQueryCommandsModule();
      const result = await runAggregate(normalizeAggregateOptions(options), globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=aggregate took_ms=${Date.now() - startedAt}`);
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
    .option("--depth <value>", "Context depth: brief|standard|deep (default: settings or brief)")
    .option("--section <value...>", "Include specific sections (repeatable; overrides --depth)")
    .option("--activity-limit <n>", "Limit recent activity entries (default: settings or 10)")
    .option("--stale-threshold <value>", "Staleness cutoff in days (e.g. 7 or 7d; default: settings or 7)")
    .action(async (options: Record<string, unknown>, actionCommand) => {
      const globalOptions = getGlobalOptions(actionCommand);
      const startedAt = Date.now();
      const normalized = normalizeContextOptions(options);
      const commands = await loadListQueryCommandsModule();
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

  program
    .command("search")
    .argument("<keywords...>", "Keyword query tokens")
    .description("Search items with keyword, semantic, or hybrid retrieval.")
    .option("--mode <value>", "Search mode: keyword|semantic|hybrid (default: keyword)")
    .option("--semantic", "Shorthand for --mode semantic")
    .option("--hybrid", "Shorthand for --mode hybrid")
    .option("--include-linked", "Include linked files, docs, and tests in the searchable corpus")
    .option("--title-exact", "Require exact normalized title match for the full query string")
    .option("--phrase-exact", "Require exact normalized phrase match in searchable text")
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
      const { runSearch } = await loadListQueryCommandsModule();
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

  program
    .command("get")
    .argument("<id>", "Item id")
    .option("--depth <value>", "Detail depth: brief|standard|deep (default: deep)")
    .option("--fields <value>", "Render custom comma-separated item metadata fields (for example: --fields id,title,status,parent,type)")
    .description("Show item details by ID.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runGet } = await loadListQueryCommandsModule();
      const result = await runGet(
        id,
        globalOptions,
        {
          depth: typeof options.depth === "string" ? options.depth : undefined,
          fields: typeof options.fields === "string" ? options.fields : undefined,
        },
      );
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=get took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("history")
    .argument("<id>", "Item id")
    .option("--limit <n>", "Return only the latest n history entries")
    .option("--compact", "Condensed output: show entry index, timestamp, op, author, patch count, and changed fields")
    .option("--full", "Show full history entries with JSON Patch payloads")
    .option("--diff", "Include per-entry changed field summaries from history patches")
    .option("--verify", "Verify hash chain and replay integrity for the full history stream")
    .description("Show item history entries.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      if (options.compact === true && options.full === true) {
        throw new PmCliError("History projection options are mutually exclusive. Use either --compact or --full.", EXIT_CODE.USAGE);
      }
      const { runHistory } = await loadListQueryCommandsModule();
      const result = await runHistory(
        id,
        {
          limit: typeof options.limit === "string" ? options.limit : undefined,
          compact: options.full === true ? false : true,
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
      const { runActivity } = await loadListQueryCommandsModule();
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
