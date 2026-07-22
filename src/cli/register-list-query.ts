/**
 * @module cli/register-list-query
 *
 * Provides CLI runtime support for Register List Query.
 */
import type { Command } from "commander";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { renderRowsAsCsv, renderRowsAsTable } from "../core/output/tabular.js";
import { runActivity } from "./commands/activity.js";
import { runAggregate } from "./commands/aggregate.js";
import {
  renderContextMarkdown,
  runContext,
  resolveContextOutputFormat,
} from "./commands/context.js";
import { runEval } from "./commands/eval.js";
import { runGet } from "./commands/get.js";
import { runGraph } from "./commands/graph.js";
import { runHistory } from "./commands/history.js";
import { runList } from "./commands/list.js";
import {
  renderNextMarkdown,
  runNext,
  resolveNextOutputFormat,
} from "./commands/next.js";
import { runSearch } from "./commands/search.js";
import type { ItemStatus } from "../types/index.js";
import {
  addHiddenOption,
  collect,
  getGlobalOptions,
  normalizeAggregateOptions,
  normalizeActivityOptions,
  normalizeContextOptions,
  normalizeListOptions,
  normalizeNextOptions,
  normalizeSearchKeywordsInput,
  normalizeSearchOptions,
  printActivityJsonStream,
  printError,
  printListJsonStream,
  printResult,
  resolveActivityStreamMode,
  setActiveCommandResult,
  writeStdout,
} from "./registration-helpers.js";

/** Documents the register list query commands options payload exchanged by command, SDK, and package integrations. */
export interface RegisterListQueryCommandsOptions {
  /** Value that configures or reports command filter for this contract. */
  commandFilter?: Set<string>;
}

function shouldRegisterListQueryCommand(
  commandName: string,
  commandFilter?: Set<string>,
): boolean {
  if (!commandFilter || commandFilter.size === 0) {
    return true;
  }
  if (commandName === "context") {
    return commandFilter.has("context") || commandFilter.has("ctx");
  }
  return commandFilter.has(commandName);
}

type ReadCommandOutputFormat = "json" | "toon";

type ListOutputFormat = "csv" | "table" | "json" | "toon";

/** Parses the `pm list --format` value into a supported render mode. csv/table are human export modes; json/toon override the machine output format. Returns undefined when no `--format` was supplied so the global output format applies. */
function parseListFormat(rawFormat: unknown): ListOutputFormat | undefined {
  if (rawFormat === undefined) {
    return undefined;
  }
  if (typeof rawFormat !== "string") {
    throw new PmCliError(
      "List --format must be one of csv|table|json|toon",
      EXIT_CODE.USAGE,
    );
  }
  const normalized = rawFormat.trim().toLowerCase();
  if (
    normalized === "csv" ||
    normalized === "table" ||
    normalized === "json" ||
    normalized === "toon"
  ) {
    return normalized;
  }
  throw new PmCliError(
    "List --format must be one of csv|table|json|toon",
    EXIT_CODE.USAGE,
  );
}

function resolveReadCommandOutputFormat(
  commandLabel: string,
  rawFormat: unknown,
  globalOptions: ReturnType<typeof getGlobalOptions>,
): ReturnType<typeof getGlobalOptions> {
  if (rawFormat === undefined) {
    return globalOptions;
  }
  if (typeof rawFormat !== "string") {
    throw new PmCliError(
      `${commandLabel} --format must be one of json|toon`,
      EXIT_CODE.USAGE,
    );
  }
  const normalized = rawFormat.trim().toLowerCase() as ReadCommandOutputFormat;
  if (normalized !== "json" && normalized !== "toon") {
    throw new PmCliError(
      `${commandLabel} --format must be one of json|toon`,
      EXIT_CODE.USAGE,
    );
  }
  if (globalOptions.json === true && normalized === "toon") {
    throw new PmCliError(
      `${commandLabel} cannot combine --json with --format toon`,
      EXIT_CODE.USAGE,
    );
  }
  return {
    ...globalOptions,
    json: normalized === "json",
  };
}

function applyDefaultBriefListMode(
  listOptions: ReturnType<typeof normalizeListOptions>,
  defaultBrief: boolean | undefined,
): void {
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
}

function registerContentAndGovernanceFilters(command: Command): void {
  command
    .option("--has-notes", "Show only items that have notes")
    .option("--has-learnings", "Show only items that have learnings")
    .option("--has-files", "Show only items that have linked files")
    .option("--has-docs", "Show only items that have linked docs")
    .option("--has-tests", "Show only items that have linked tests")
    .option("--has-comments", "Show only items that have comments")
    .option("--has-deps", "Show only items that have dependencies")
    .option("--has-body", "Show only items that have a non-empty body")
    .option(
      "--has-linked-command",
      "Show only items whose linked tests carry a runnable command",
    )
    .option("--no-notes", "Show only items that have no notes")
    .option("--no-learnings", "Show only items that have no learnings")
    .option("--no-files", "Show only items that have no linked files")
    .option("--filter-files-missing", "Alias for --no-files")
    .option("--no-docs", "Show only items that have no linked docs")
    .option("--filter-docs-missing", "Alias for --no-docs")
    .option("--no-tests", "Show only items that have no linked tests")
    .option("--no-comments", "Show only items that have no comments")
    .option("--no-deps", "Show only items that have no dependencies")
    .option("--empty-body", "Show only items with an empty body")
    .option(
      "--no-linked-command",
      "Show only items whose linked tests carry no runnable command",
    )
    .option("--filter-reviewer-missing", "Show only items missing reviewer")
    .option("--filter-risk-missing", "Show only items missing risk")
    .option("--filter-confidence-missing", "Show only items missing confidence")
    .option("--filter-sprint-missing", "Show only items missing sprint")
    .option("--filter-release-missing", "Show only items missing release");
}

interface RegisteredListOutputContext {
  /** Whether rows are emitted as line-delimited JSON. */
  streamMode: boolean;
  /** Explicit list-specific format override, when supplied. */
  listFormat: ListOutputFormat | undefined;
  /** Global output settings after applying json/toon list overrides. */
  effectiveGlobal: ReturnType<typeof getGlobalOptions>;
}

/** Resolve and validate the mutually exclusive list rendering modes. */
function resolveRegisteredListOutputContext(
  options: Record<string, unknown>,
  globalOptions: ReturnType<typeof getGlobalOptions>,
): RegisteredListOutputContext {
  const streamMode = options.stream === true;
  const listFormat = parseListFormat(options.format);
  const tabular = listFormat === "csv" || listFormat === "table";
  const effectiveGlobal =
    listFormat === "json" || listFormat === "toon"
      ? resolveReadCommandOutputFormat("List", options.format, globalOptions)
      : globalOptions;
  if (streamMode && !effectiveGlobal.json) {
    throw new PmCliError(
      "--stream requires --json output mode.",
      EXIT_CODE.USAGE,
    );
  }
  if (tabular && streamMode) {
    throw new PmCliError(
      "--format csv|table cannot be combined with --stream (line-delimited JSON).",
      EXIT_CODE.USAGE,
    );
  }
  return { streamMode, listFormat, effectiveGlobal };
}

/** Render one list result through tabular, stream, or standard output paths. */
function renderRegisteredListResult(
  commandName: string,
  result: Awaited<ReturnType<typeof runList>>,
  output: RegisteredListOutputContext,
): void {
  if (output.listFormat === "csv" || output.listFormat === "table") {
    setActiveCommandResult(result);
    const rows = result.items as Array<Record<string, unknown>>;
    const rendered =
      output.listFormat === "csv"
        ? renderRowsAsCsv(rows)
        : renderRowsAsTable(rows);
    if (!output.effectiveGlobal.quiet && rendered.length > 0) {
      writeStdout(`${rendered}\n`);
    }
  } else if (output.streamMode) {
    printListJsonStream(commandName, result, output.effectiveGlobal);
  } else {
    printResult(result, output.effectiveGlobal);
  }
}

async function runRegisteredListCommand(params: {
  name: string;
  status?: ItemStatus;
  excludeTerminal?: boolean;
  defaultBrief?: boolean;
  dependencyBlocked?: boolean;
  options: Record<string, unknown>;
  actionCommand: Command;
}): Promise<void> {
  const globalOptions = getGlobalOptions(params.actionCommand);
  const startedAt = Date.now();
  const listOptions = normalizeListOptions(params.options);
  applyDefaultBriefListMode(listOptions, params.defaultBrief);
  if (params.excludeTerminal) listOptions.excludeTerminal = true;
  listOptions.dependencyBlocked = params.dependencyBlocked;
  const output = resolveRegisteredListOutputContext(
    params.options,
    globalOptions,
  );
  const result = await runList(
    params.dependencyBlocked ? undefined : params.status,
    listOptions,
    globalOptions,
  );
  renderRegisteredListResult(params.name, result, output);
  if (globalOptions.profile) {
    printError(
      `profile:command=${params.name} took_ms=${Date.now() - startedAt}`,
    );
  }
}

interface ListCommandDescriptor {
  name: string;
  description: string;
  status?: ItemStatus;
  excludeTerminal?: boolean;
  allowStatusFilter?: boolean;
  defaultBrief?: boolean;
  /** Select via the shared edge-aware blocked classification instead of a raw status filter (GH-578). */
  dependencyBlocked?: boolean;
}

function registerListCommand(
  program: Command,
  descriptor: ListCommandDescriptor,
): void {
  const {
    name,
    description,
    status,
    excludeTerminal,
    allowStatusFilter,
    defaultBrief,
    dependencyBlocked,
  } = descriptor;
  const command = program.command(name).description(description);
  if (allowStatusFilter) {
    command.option(
      "--status <value>",
      "Filter by status (use all for no status restriction)",
    );
  }
  command
    .option("--type <value>", "Filter by item type")
    .option("--tag <value>", "Filter by tag")
    .option("--priority <value>", "Filter by priority")
    .option(
      "--deadline-before <value>",
      "Filter by deadline upper bound (ISO/date string or relative)",
    )
    .option(
      "--deadline-after <value>",
      "Filter by deadline lower bound (ISO/date string or relative)",
    )
    .option("--today", "Filter to items updated since local midnight today")
    .option("--recent", "Filter to items updated in the last 7 days")
    .option(
      "--updated-after <value>",
      'Filter by updated_at lower bound: ISO timestamp or signed relative (e.g. "-2h"/"-7d" for the past). "Changed since my last window" → --updated-after <ISO>',
    )
    .option(
      "--updated-before <value>",
      "Filter by updated_at upper bound: ISO timestamp or signed relative (-2h/+1d)",
    )
    .option(
      "--created-after <value>",
      "Filter by created_at lower bound: ISO timestamp or signed relative (-2h/+1d)",
    )
    .option(
      "--created-before <value>",
      "Filter by created_at upper bound: ISO timestamp or signed relative (-2h/+1d)",
    )
    .option(
      "--ids <value>",
      "Filter by explicit item IDs (comma-separated or repeatable)",
    )
    .option("--assignee <value>", "Filter by assignee")
    .option(
      "--assignee-filter <value>",
      "Filter assignee presence: assigned|unassigned",
    )
    .option("--parent <value>", "Filter by parent item ID")
    .option("--sprint <value>", "Filter by sprint")
    .option("--release <value>", "Filter by release")
    .option(
      "--filter-ac-missing",
      "Show only items missing acceptance_criteria",
    )
    .option(
      "--filter-estimates-missing",
      "Show only items missing estimated_minutes",
    )
    .option(
      "--filter-resolution-missing",
      "Show only terminal items missing resolution",
    )
    .option(
      "--filter-metadata-missing",
      "Show only items missing any tracked metadata (AC, estimate, or resolution)",
    )
    .option("--limit <n>", "Limit returned item count")
    .option(
      "--offset <n>",
      "Skip the first n matching rows before limit is applied",
    )
    .option(
      "--after <cursor>",
      "Continue after an opaque next_cursor from a previous list response",
    )
    .option(
      "--no-truncate",
      "Return every matched row, overriding any --limit (alias: --all)",
    )
    .option("--include-body", "Include item body in each returned list row")
    .option(
      "--compact",
      "Render compact list projection fields (mutually exclusive with --brief/--full/--fields)",
    )
    .option(
      "--brief",
      "Ultra-compact output: id, status, type, title only (agent-optimized, mutually exclusive with --compact/--full/--fields)",
    )
    .option(
      "--full",
      "Render full list projection fields (mutually exclusive with --compact/--brief/--fields)",
    )
    .option(
      "--fields <value>",
      "Render custom comma-separated list fields (mutually exclusive with --compact/--brief/--full; valid: --fields id,title)",
    )
    .option(
      "--sort <value>",
      "Sort field: priority|deadline|updated_at|created_at|title|parent (aliases: updated, created)",
    )
    .option("--order <value>", "Sort order: asc|desc (requires --sort)")
    .option("--tree", "Render rows in parent/child tree order")
    .option(
      "--tree-depth <n>",
      "Maximum recursion depth with --tree (0 keeps root rows only)",
    )
    .option(
      "--format <value>",
      "Output render mode: csv|table (human export) or json|toon (machine output override)",
    )
    .option("--stream", "Emit line-delimited JSON rows (requires --json)");
  registerContentAndGovernanceFilters(command);
  command.action(async (options: Record<string, unknown>, actionCommand) => {
    await runRegisteredListCommand({
      name,
      status,
      excludeTerminal,
      defaultBrief,
      dependencyBlocked,
      options,
      actionCommand,
    });
  });
  // Positive alias for --no-truncate (Commander stores the negation as truncate=false).
  addHiddenOption(command, "--all", "Alias for --no-truncate");
  // Hidden pure snake_case underscore-duplicate alias (kept parse-functional).
  addHiddenOption(command, "--tags <value>", "Alias for --tag");
  addHiddenOption(
    command,
    "--assignee_filter <value>",
    "Alias for --assignee-filter",
  );
  addHiddenOption(command, "--tree_depth <n>", "Alias for --tree-depth");
  // Singular alias so `--filter-estimate-missing` works (matches update-many spelling).
  addHiddenOption(
    command,
    "--filter-estimate-missing",
    "Alias for --filter-estimates-missing",
  );
}

async function runAggregateAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const result = await runAggregate(
    normalizeAggregateOptions(options),
    globalOptions,
  );
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=aggregate took_ms=${Date.now() - startedAt}`);
  }
}

async function runContextAction(
  options: Record<string, unknown>,
  actionCommand: Command,
): Promise<void> {
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
}

async function runNextAction(
  options: Record<string, unknown>,
  actionCommand: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(actionCommand);
  const startedAt = Date.now();
  const nextOptions = normalizeNextOptions(options);
  const result = await runNext(nextOptions, globalOptions);
  const outputFormat = resolveNextOutputFormat(nextOptions, globalOptions);
  if (outputFormat === "markdown") {
    if (!globalOptions.quiet) {
      writeStdout(`${renderNextMarkdown(result)}\n`);
    }
  } else {
    printResult(result, { ...globalOptions, json: outputFormat === "json" });
  }
  if (globalOptions.profile) {
    printError(`profile:command=next took_ms=${Date.now() - startedAt}`);
  }
}

async function runSearchAction(
  keywords: string[],
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const searchOptions = normalizeSearchOptions(options);
  const result = await runSearch(
    normalizeSearchKeywordsInput(keywords),
    {
      ...searchOptions,
      mode:
        typeof searchOptions.mode === "string" &&
        searchOptions.mode.trim().length > 0
          ? searchOptions.mode
          : "keyword",
    },
    globalOptions,
  );
  printResult(
    result,
    resolveReadCommandOutputFormat("Search", options.format, globalOptions),
  );
  if (globalOptions.profile) {
    printError(`profile:command=search took_ms=${Date.now() - startedAt}`);
  }
}

async function runEvalAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const result = await runEval(
    {
      mode: typeof options.mode === "string" ? options.mode : undefined,
      k: typeof options.k === "string" ? options.k : undefined,
      failUnder:
        typeof options.failUnder === "string" ? options.failUnder : undefined,
      queries:
        typeof options.queries === "string" ? options.queries : undefined,
      format: typeof options.format === "string" ? options.format : undefined,
    },
    globalOptions,
  );
  printResult(
    result,
    resolveReadCommandOutputFormat("Eval", options.format, globalOptions),
  );
  if (globalOptions.profile) {
    printError(`profile:command=eval took_ms=${Date.now() - startedAt}`);
  }
  if (!result.passed) {
    throw new PmCliError(
      `Eval gate failed: aggregate nDCG@${result.k} ${result.aggregate.ndcg} is below --fail-under ${result.fail_under}`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
}

async function runGetAction(
  id: string,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const result = await runGet(id, globalOptions, {
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
    at: typeof options.at === "string" ? options.at : undefined,
  });
  printResult(
    result,
    resolveReadCommandOutputFormat("Get", options.format, globalOptions),
  );
  if (globalOptions.profile) {
    printError(`profile:command=get took_ms=${Date.now() - startedAt}`);
  }
}

async function runHistoryAction(
  id: string,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  if (options.compact === true && options.full === true) {
    throw new PmCliError(
      "History projection options are mutually exclusive. Use either --compact or --full.",
      EXIT_CODE.USAGE,
    );
  }
  const field = typeof options.field === "string" ? options.field : undefined;
  const strictExit =
    Boolean(options.strictExit) || Boolean(options.failOnWarn);
  if (strictExit && !options.verify) {
    throw new PmCliError(
      "--strict-exit requires --verify (it gates on the verification result).",
      EXIT_CODE.USAGE,
    );
  }
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
  printResult(
    result,
    resolveReadCommandOutputFormat("History", options.format, globalOptions),
  );
  // GH-604: without --strict-exit a broken chain still exits 0 (read-only
  // inspection default); with it, verification.ok:false becomes a nonzero exit
  // so CI and merge hooks can gate on `pm history <id> --verify --strict-exit`.
  if (strictExit && result.verification && !result.verification.ok) {
    process.exitCode = EXIT_CODE.GENERIC_FAILURE;
  }
  if (globalOptions.profile) {
    printError(`profile:command=history took_ms=${Date.now() - startedAt}`);
  }
}

async function runActivityAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  if (options.compact === true && options.full === true) {
    throw new PmCliError(
      "Activity projection options are mutually exclusive. Use either --compact or --full.",
      EXIT_CODE.USAGE,
    );
  }
  const normalized = normalizeActivityOptions(options);
  const result = await runActivity(normalized, globalOptions);
  const streamMode = resolveActivityStreamMode(options.stream);
  if (streamMode && !globalOptions.json) {
    throw new PmCliError(
      "--stream requires --json output mode.",
      EXIT_CODE.USAGE,
    );
  }
  if (streamMode) {
    printActivityJsonStream(result, normalized, globalOptions);
  } else {
    printResult(result, globalOptions);
  }
  if (globalOptions.profile) {
    printError(`profile:command=activity took_ms=${Date.now() - startedAt}`);
  }
}

async function runGraphAction(
  subcommand: string,
  id: string | undefined,
  target: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const result = await runGraph(
    subcommand,
    id,
    target,
    {
      ...(Array.isArray(options.kind) ? { kind: options.kind as string[] } : {}),
      maxDepth: typeof options.maxDepth === "string" ? options.maxDepth : undefined,
      limit: typeof options.limit === "string" ? options.limit : undefined,
      after: typeof options.after === "string" ? options.after : undefined,
      direction:
        typeof options.direction === "string" ? options.direction : undefined,
      maxPaths: typeof options.maxPaths === "string" ? options.maxPaths : undefined,
      sample: typeof options.sample === "string" ? options.sample : undefined,
      ...(Array.isArray(options.exemptIsolate)
        ? { exemptIsolate: options.exemptIsolate as string[] }
        : {}),
      ...(Array.isArray(options.exemptIsolateType)
        ? { exemptIsolateType: options.exemptIsolateType as string[] }
        : {}),
      saveBaseline: options.saveBaseline === true,
      rebuild: options.rebuild === true,
      clear: options.clear === true,
      summary: options.summary === true,
    },
    globalOptions,
  );
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=graph took_ms=${Date.now() - startedAt}`);
  }
}

/** Implements register list query commands for the public runtime surface of this module. */
export function registerListQueryCommands(
  program: Command,
  options?: RegisterListQueryCommandsOptions,
): void {
  const commandFilter = options?.commandFilter;
  const shouldRegister = (commandName: string): boolean =>
    shouldRegisterListQueryCommand(commandName, commandFilter);
  const listCommandDescriptors: ListCommandDescriptor[] = [
    {
      name: "list",
      description: "List active items with optional filters.",
      excludeTerminal: true,
      allowStatusFilter: true,
      defaultBrief: true,
    },
    {
      name: "list-all",
      description: "List all items with optional filters.",
      excludeTerminal: false,
      allowStatusFilter: true,
    },
    {
      name: "list-draft",
      description: "List draft items with optional filters.",
      status: "draft",
    },
    {
      name: "list-open",
      description: "List open items with optional filters.",
      status: "open",
      excludeTerminal: false,
      allowStatusFilter: false,
      defaultBrief: true,
    },
    {
      name: "list-in-progress",
      description: "List in-progress items with optional filters.",
      status: "in_progress",
      excludeTerminal: false,
      allowStatusFilter: false,
      defaultBrief: true,
    },
    {
      name: "list-blocked",
      description:
        "List blocked items (blocked status or open blocked_by dependencies, matching pm next) with optional filters.",
      dependencyBlocked: true,
      excludeTerminal: false,
      allowStatusFilter: false,
      defaultBrief: true,
    },
    {
      name: "list-closed",
      description: "List closed items with optional filters.",
      status: "closed",
    },
    {
      name: "list-canceled",
      description: "List canceled items with optional filters.",
      status: "canceled",
    },
  ];
  for (const descriptor of listCommandDescriptors) {
    if (shouldRegister(descriptor.name)) {
      registerListCommand(program, descriptor);
    }
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
      .option(
        "--completion",
        "Add open/in_progress/closed/other counts and completion_pct per group",
      )
      .option("--sum <field>", "Sum a numeric field per group")
      .option("--avg <field>", "Average a numeric field per group")
      .option(
        "--include-unparented",
        "Include unparented rows when grouping by parent",
      )
      .option("--status <value>", "Filter by item status")
      .option("--type <value>", "Filter by item type")
      .option("--tag <value>", "Filter by tag")
      .option("--priority <value>", "Filter by priority")
      .option(
        "--deadline-before <value>",
        "Filter by deadline upper bound (ISO/date string or relative)",
      )
      .option(
        "--deadline-after <value>",
        "Filter by deadline lower bound (ISO/date string or relative)",
      )
      .option("--assignee <value>", "Filter by assignee")
      .option(
        "--assignee-filter <value>",
        "Filter assignee presence: assigned|unassigned",
      )
      .option("--parent <value>", "Filter by parent item ID")
      .option("--sprint <value>", "Filter by sprint")
      .option("--release <value>", "Filter by release");
    // Hidden pure snake_case underscore-duplicate aliases (kept parse-functional).
    addHiddenOption(
      aggregateCommand,
      "--include_unparented",
      "Alias for --include-unparented",
    );
    addHiddenOption(
      aggregateCommand,
      "--assignee_filter <value>",
      "Alias for --assignee-filter",
    );
    aggregateCommand.action(runAggregateAction);
  }

  if (shouldRegister("context")) {
    const contextCommand = program
      .command("context")
      .alias("ctx")
      .description(
        "Show a token-efficient project context snapshot for next-work decisions.",
      )
      .option(
        "--date <value>",
        "Anchor date/time for agenda window calculations (ISO/date string or relative)",
      )
      .option(
        "--from <value>",
        "Agenda lower bound (ISO/date string or relative)",
      )
      .option(
        "--to <value>",
        "Agenda upper bound (ISO/date string or relative)",
      )
      .option("--past", "Include past agenda entries in bounded windows")
      .option("--type <value>", "Filter by item type")
      .option("--tag <value>", "Filter by tag")
      .option("--priority <value>", "Filter by priority")
      .option("--assignee <value>", "Filter by assignee")
      .option(
        "--assignee-filter <value>",
        "Filter assignee presence: assigned|unassigned",
      )
      .option("--sprint <value>", "Filter by sprint")
      .option("--release <value>", "Filter by release")
      .option(
        "--parent <id>",
        "Scope the snapshot to one item's subtree (the item plus all descendants)",
      )
      .option("--limit <n>", "Limit focus and agenda rows per section")
      .option(
        "--after <cursor>",
        "Continue ranked focus after a next_cursor from a previous context response",
      )
      .option(
        "--format <value>",
        "Context output format override: markdown|toon|json",
      )
      .option(
        "--depth <value>",
        "Context depth: brief|standard|deep|full (full = every section, no per-section cap)",
      )
      .option(
        "--section <value...>",
        "Include specific sections (repeatable; overrides --depth)",
      )
      .option(
        "--fields <value>",
        "Project focus rows to a comma-separated field subset (e.g. id,title,priority)",
      )
      .option(
        "--activity-limit <n>",
        "Limit recent activity entries (default: settings or 10)",
      )
      .option(
        "--stale-threshold <value>",
        "Staleness cutoff in days (e.g. 7 or 7d; default: settings or 7)",
      )
      .option(
        "--explain-ranking",
        "Include the scorer model, per-signal contributions, and ranked candidate ids",
      )
      .option(
        "--token-budget <n>",
        "Maximum estimated tokens spent on ranked focus rows",
      );
    // Hidden pure snake_case underscore-duplicate alias (kept parse-functional).
    addHiddenOption(
      contextCommand,
      "--assignee_filter <value>",
      "Alias for --assignee-filter",
    );
    addHiddenOption(contextCommand, "--max-items <n>", "Alias for --limit");
    addHiddenOption(
      contextCommand,
      "--explain_ranking",
      "Alias for --explain-ranking",
    );
    addHiddenOption(contextCommand, "--token_budget <n>", "Alias for --token-budget");
    contextCommand.action(runContextAction);
  }

  if (shouldRegister("next")) {
    const nextCommand = program
      .command("next")
      .description(
        "Recommend the next actionable (unblocked, ready) work item with rationale + blocked companion.",
      )
      .option("--type <value>", "Filter candidate items by type")
      .option("--tag <value>", "Filter candidate items by tag")
      .option("--priority <value>", "Filter candidate items by priority")
      .option("--assignee <value>", "Filter candidate items by assignee")
      .option(
        "--assignee-filter <value>",
        "Filter assignee presence: assigned|unassigned",
      )
      .option("--sprint <value>", "Filter candidate items by sprint")
      .option("--release <value>", "Filter candidate items by release")
      .option(
        "--parent <id>",
        "Scope to one item's subtree (the item plus all descendants)",
      )
      .option(
        "--limit <n>",
        "Limit ready rows (default: 5; non-positive falls back to default)",
      )
      .option(
        "--blocked-limit <n>",
        "Limit blocked rows (default: same as --limit)",
      )
      .option("--ready-only", "Omit the blocked companion list")
      .option(
        "--include-decisions",
        "Include human-gated Decision items in the claimable ready queue",
      )
      .option(
        "--format <value>",
        "Next output format override: markdown|toon|json",
      )
      .option(
        "--explain-ranking",
        "Include the scorer model, per-signal contributions, and ranked ready ids",
      )
      .option(
        "--token-budget <n>",
        "Maximum estimated tokens spent on the ranked ready queue",
      );
    addHiddenOption(
      nextCommand,
      "--assignee_filter <value>",
      "Alias for --assignee-filter",
    );
    addHiddenOption(
      nextCommand,
      "--blocked_limit <n>",
      "Alias for --blocked-limit",
    );
    addHiddenOption(nextCommand, "--ready_only", "Alias for --ready-only");
    addHiddenOption(
      nextCommand,
      "--explain_ranking",
      "Alias for --explain-ranking",
    );
    addHiddenOption(nextCommand, "--token_budget <n>", "Alias for --token-budget");
    nextCommand.action(runNextAction);
  }

  if (shouldRegister("search")) {
    const searchCommand = program
      .command("search")
      .argument("<keywords...>", "Keyword query tokens")
      .description(
        "Search items with keyword, semantic, or hybrid retrieval. Inline field:value tokens " +
          "(tag:/status:/type:/priority:) in the query are parsed as filters, e.g. 'auth tag:area:search status:open'.",
      )
      .option(
        "--mode <value>",
        "Search mode: keyword|semantic|hybrid (default: keyword)",
      )
      .option("--semantic", "Shorthand for --mode semantic")
      .option("--hybrid", "Shorthand for --mode hybrid")
      .option(
        "--match-mode <value>",
        "Token match mode: and|or|exact (default: or with all-terms ranking bonus; and = hard-require every token; exact = exact phrase)",
      )
      .option(
        "--min-score <value>",
        "Per-query minimum score threshold (finite number >= 0); overrides settings search.score_threshold for this query only",
      )
      .option(
        "--count",
        "Return only the count of matching items (post-filter/threshold, pre-limit); skips hit rows",
      )
      .option(
        "--semantic-weight <value>",
        "Override hybrid semantic weight for this query (0..1); invalid values fall back to settings",
      )
      .option(
        "--include-linked",
        "Include linked files, docs, and tests in the searchable corpus",
      )
      .option(
        "--title-exact",
        "Require exact normalized title match for the full query string",
      )
      .option(
        "--phrase-exact",
        "Require exact normalized phrase match in searchable text",
      )
      .option(
        "--highlight",
        "Emit per-field matched-text snippets (wrapped in «…») on each hit; off by default",
      )
      .option(
        "--status <value>",
        "Filter by status before query (all, open/closed/canceled aliases, or configured status id; CSV)",
      )
      .option("--type <value>", "Filter by item type")
      .option("--tag <value>", "Filter by tag")
      .option("--priority <value>", "Filter by priority")
      .option(
        "--deadline-before <value>",
        "Filter by deadline upper bound (ISO/date string or relative)",
      )
      .option(
        "--deadline-after <value>",
        "Filter by deadline lower bound (ISO/date string or relative)",
      )
      .option(
        "--updated-after <value>",
        'Filter by updated_at lower bound: ISO timestamp or signed relative (e.g. "-2h"/"-7d" for the past)',
      )
      .option(
        "--updated-before <value>",
        "Filter by updated_at upper bound: ISO timestamp or signed relative (-2h/+1d)",
      )
      .option(
        "--created-after <value>",
        "Filter by created_at lower bound: ISO timestamp or signed relative (-2h/+1d)",
      )
      .option(
        "--created-before <value>",
        "Filter by created_at upper bound: ISO timestamp or signed relative (-2h/+1d)",
      )
      .option("--assignee <value>", "Filter by assignee")
      .option("--sprint <value>", "Filter by sprint")
      .option("--release <value>", "Filter by release")
      .option("--parent <value>", "Filter by parent item ID")
      .option(
        "--compact",
        "Render compact search hits (default; mutually exclusive with --full/--fields)",
      )
      .option(
        "--full",
        "Render full search hits with nested item payloads (mutually exclusive with --compact/--fields)",
      )
      .option(
        "--fields <value>",
        "Render custom comma-separated search hit fields (mutually exclusive with --compact/--full; valid: --fields id,title,score; invalid: --full --fields id,title)",
      )
      .option("--format <value>", "Search output format override: json|toon")
      .option("--limit <n>", "Limit returned item count")
      .option(
        "--after <cursor>",
        "Continue after an opaque next_cursor from a previous search response",
      );
    registerContentAndGovernanceFilters(searchCommand);
    searchCommand.action(runSearchAction);
    addHiddenOption(searchCommand, "--tags <value>", "Alias for --tag");
  }

  if (shouldRegister("eval")) {
    program
      .command("eval")
      .description(
        "Evaluate search relevance against a curated golden-query set: reports nDCG@k, MRR@k, " +
          "precision@k, and recall@k per query plus the macro average. Use --fail-under as a CI gate.",
      )
      .option(
        "--mode <value>",
        "Default retrieval mode for queries without their own: keyword|semantic|hybrid (default: keyword)",
      )
      .option("--k <n>", "Metric cutoff @k (positive integer; default: 10)")
      .option(
        "--fail-under <value>",
        "Exit non-zero when aggregate nDCG@k falls below this threshold (0..1); CI gate",
      )
      .option(
        "--queries <path>",
        "Path to the golden-query JSON file (default: <pmRoot>/search/eval-queries.json)",
      )
      .option("--format <value>", "Eval output format override: json|toon")
      .action(runEvalAction);
  }

  if (shouldRegister("get")) {
    const getCommand = program
      .command("get")
      .argument("<id>", "Item id")
      .option(
        "--depth <value>",
        "Detail depth: brief|standard|deep|full (full aliases deep; default: standard)",
      )
      .option(
        "--full",
        "Explicit full item read; equivalent to --depth deep (mutually exclusive with --depth/--fields)",
      )
      .option(
        "--fields <value>",
        "Render custom comma-separated item metadata fields (for example: --fields id,title,status,parent,type)",
      )
      .option("--tree", "Include descendants rooted at the requested item")
      .option(
        "--tree-depth <n>",
        "Maximum subtree depth for --tree descendants",
      )
      .option(
        "--at <version-or-timestamp>",
        "Reconstruct a verified historical item state without mutating it",
      )
      .option("--format <value>", "Get output format override: json|toon")
      .description("Show item details by ID.")
      .action(runGetAction);
    addHiddenOption(getCommand, "--tree_depth <n>", "Alias for --tree-depth");
  }

  if (shouldRegister("history")) {
    program
      .command("history")
      .argument("<id>", "Item id")
      .option("--limit <n>", "Return only the latest n history entries")
      .option(
        "--compact",
        "Condensed output: show entry index, timestamp, op, author, patch count, and changed fields",
      )
      .option("--full", "Show full history entries with JSON Patch payloads")
      .option(
        "--diff",
        "Include per-entry field-level before/after value diffs computed by replaying the history chain",
      )
      .option(
        "--field <name>",
        "With --diff, show only entries that changed this field (implies --diff)",
      )
      .option(
        "--verify",
        "Verify hash chain and replay integrity for the full history stream",
      )
      .option(
        "--strict-exit",
        "With --verify, exit nonzero when verification fails (merge-safety gate parity with pm validate)",
      )
      .option("--fail-on-warn", "Alias for --strict-exit")
      .option("--format <value>", "History output format override: json|toon")
      .description("Show item history entries.")
      .action(runHistoryAction);
  }

  if (shouldRegister("activity")) {
    program
      .command("activity")
      .option("--id <value>", "Filter by item ID")
      .option("--op <value>", "Filter by history operation")
      .option("--author <value>", "Filter by history author")
      .option(
        "--from <value>",
        "Lower timestamp bound (ISO/date string or relative)",
      )
      .option(
        "--to <value>",
        "Upper timestamp bound (ISO/date string or relative)",
      )
      .option("--limit <n>", "Return only the latest n activity entries")
      .option(
        "--compact",
        "Condensed output: show only id, op, ts, author, msg per entry",
      )
      .option("--full", "Show full activity entries with JSON Patch payloads")
      .option(
        "--stream [mode]",
        "Emit line-delimited JSON rows (requires --json). Optional mode: rows|ndjson|jsonl",
      )
      .description("Show recent activity across items.")
      .action(runActivityAction);
  }

  if (shouldRegister("graph")) {
    program
      .command("graph")
      .argument(
        "<subcommand>",
        "Graph query (ancestors, descendants, predecessors, successors, paths, impact, analyze, audit, communities, redundancy, dominators, slack, centrality, articulation, plan, index)",
      )
      .argument("[id]", "Root item id (traversals, paths, impact, and dominators)")
      .argument("[target]", "Target item id (paths only)")
      .option(
        "--kind <value>",
        "Restrict traversal to registered relationship kinds (repeatable or comma-separated)",
        collect,
      )
      .option(
        "--max-depth <value>",
        "Maximum traversal depth (non-negative integer)",
      )
      .option("--limit <value>", "Maximum returned rows per bounded collection")
      .option(
        "--after <value>",
        "Resume a traversal after this previously returned node id",
      )
      .option(
        "--direction <value>",
        "Edge orientation for paths/impact (outgoing, incoming, or both)",
      )
      .option("--max-paths <value>", "Maximum enumerated paths (paths only)")
      .option(
        "--sample <value>",
        "Maximum evidence sample entries per audit finding (audit only)",
      )
      .option(
        "--exempt-isolate <value>",
        "Item ids treated as explicitly valid isolates by the audit (repeatable or comma-separated)",
        collect,
      )
      .option(
        "--exempt-isolate-type <value>",
        "Item types whose active isolates are policy-valid for the audit (repeatable or comma-separated)",
        collect,
      )
      .option(
        "--save-baseline",
        "Persist the audit census as the change-since-baseline comparison point (audit only)",
      )
      .option(
        "--rebuild",
        "Rebuild and warm the durable graph index (index only)",
      )
      .option("--clear", "Delete the durable graph index (index only)")
      .option("--summary", "Return counts-first envelopes without row collections")
      .description(
        "Bounded workspace relationship-graph queries, analytics, and governance audit.",
      )
      .action(runGraphAction);
  }
}

/** Public contract for test only register list query, shared by SDK and presentation-layer consumers. */
export const _testOnlyRegisterListQuery = {
  resolveReadCommandOutputFormat,
  parseListFormat,
};
