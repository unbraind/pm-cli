/**
 * @module cli/register-list-query
 *
 * Provides CLI runtime support for Register List Query.
 */
import type { Command } from "commander";
import {
  EXIT_CODE,
  PmCliError,
  readSettings,
  renderRowsAsCsv,
  renderRowsAsTable,
  resolvePmRoot,
} from "../sdk/runtime-primitives.js";
import {
  renderPmCommandAliasMigrationHint,
  resolvePmCommandAlias,
  type PmCommandAliasContract,
} from "../sdk/cli-contracts.js";
import { EVAL_QUERY_SET_SCHEMA_ID } from "../sdk/eval.js";
import { applyContextIntentProjection } from "../sdk/context-intent-contracts.js";
import { renderPmClosedDomainHelp } from "../sdk/agent/closed-domain-contracts.js";
import {
  serializeNdjsonRows,
  serializeNdjsonStream,
} from "../sdk/output.js";
import {
  listMutationEvents,
  subscribeMutationEventBatches,
  subscribeMutationEvents,
  type MutationEventPage,
} from "../sdk/mutation-events.js";
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
  LIST_COMMAND_DEFAULT_PROJECTIONS,
  type ListCommandName,
} from "../sdk/query/list.js";
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

type ReadCommandOutputFormat = "json" | "ndjson" | "toon";

type ListOutputFormat = "csv" | "table" | "json" | "ndjson" | "toon";

/** Parses the `pm list --format` value into a supported render mode. csv/table are human export modes; json/toon override the machine output format. Returns undefined when no `--format` was supplied so the global output format applies. */
function parseListFormat(rawFormat: unknown): ListOutputFormat | undefined {
  if (rawFormat === undefined) {
    return undefined;
  }
  if (typeof rawFormat !== "string") {
    throw new PmCliError(
      "List --format must be one of csv|table|json|ndjson|toon",
      EXIT_CODE.USAGE,
    );
  }
  const normalized = rawFormat.trim().toLowerCase();
  if (
    normalized === "csv" ||
    normalized === "table" ||
    normalized === "json" ||
    normalized === "ndjson" ||
    normalized === "toon"
  ) {
    return normalized;
  }
  throw new PmCliError(
    "List --format must be one of csv|table|json|ndjson|toon",
    EXIT_CODE.USAGE,
  );
}

function resolveReadCommandOutputFormat(
  commandLabel: string,
  rawFormat: unknown,
  globalOptions: ReturnType<typeof getGlobalOptions>,
  allowNdjson = false,
): ReturnType<typeof getGlobalOptions> {
  if (rawFormat === undefined) {
    return globalOptions;
  }
  if (typeof rawFormat !== "string") {
    throw new PmCliError(
      `${commandLabel} --format must be one of ${allowNdjson ? "json|ndjson|toon" : "json|toon"}`,
      EXIT_CODE.USAGE,
    );
  }
  const normalized = rawFormat.trim().toLowerCase() as ReadCommandOutputFormat;
  if (
    normalized !== "json" &&
    (normalized !== "ndjson" || !allowNdjson) &&
    normalized !== "toon"
  ) {
    throw new PmCliError(
      `${commandLabel} --format must be one of ${allowNdjson ? "json|ndjson|toon" : "json|toon"}`,
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
    json: normalized === "json" || normalized === "ndjson",
  };
}

function applyDefaultListProjection(
  listOptions: ReturnType<typeof normalizeListOptions>,
  commandName: ListCommandName,
): void {
  if (
    LIST_COMMAND_DEFAULT_PROJECTIONS[commandName] === "brief" &&
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

const CANONICAL_LIST_STATUS_VARIANTS: Readonly<
  Partial<
    Record<
      ItemStatus,
      {
        name: ListCommandName;
        dependencyBlocked: boolean;
      }
    >
  >
> = {
  draft: { name: "list-draft", dependencyBlocked: false },
  open: { name: "list-open", dependencyBlocked: false },
  in_progress: { name: "list-in-progress", dependencyBlocked: false },
  blocked: { name: "list-blocked", dependencyBlocked: true },
  closed: { name: "list-closed", dependencyBlocked: false },
  canceled: { name: "list-canceled", dependencyBlocked: false },
};

/** Resolve and validate the mutually exclusive list rendering modes. */
function resolveRegisteredListOutputContext(
  options: Record<string, unknown>,
  globalOptions: ReturnType<typeof getGlobalOptions>,
): RegisteredListOutputContext {
  const streamMode = options.stream === true;
  const listFormat = parseListFormat(options.format);
  const tabular = listFormat === "csv" || listFormat === "table";
  const effectiveGlobal =
    listFormat === "json" || listFormat === "ndjson" || listFormat === "toon"
      ? resolveReadCommandOutputFormat(
          "List",
          options.format,
          globalOptions,
          true,
        )
      : globalOptions;
  if (streamMode && !effectiveGlobal.json) {
    throw new PmCliError(
      "--stream requires --json output mode.",
      EXIT_CODE.USAGE,
    );
  }
  if ((tabular || listFormat === "ndjson") && streamMode) {
    throw new PmCliError(
      "--format csv|table|ndjson cannot be combined with --stream.",
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
  } else if (output.listFormat === "ndjson") {
    setActiveCommandResult(result);
    const rendered = serializeNdjsonRows(result.items);
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
  name: ListCommandName;
  status?: ItemStatus;
  excludeTerminal?: boolean;
  dependencyBlocked?: boolean;
  options: Record<string, unknown>;
  actionCommand: Command;
  aliasContract?: PmCommandAliasContract;
}): Promise<void> {
  const parsedGlobalOptions = getGlobalOptions(params.actionCommand);
  const globalOptions = params.aliasContract
    ? { ...parsedGlobalOptions, command: params.aliasContract.canonical }
    : parsedGlobalOptions;
  const startedAt = Date.now();
  if (params.aliasContract?.lifecycle === "deprecated") {
    const deprecationHints = await readSettings(
      resolvePmRoot(process.cwd(), globalOptions.path),
    ).then((settings) => settings.ux!.deprecation_hints!);
    if (deprecationHints) {
      printError(renderPmCommandAliasMigrationHint(params.aliasContract));
    }
  }
  const intentOptions = applyContextIntentProjection("list", params.options);
  const listOptions = normalizeListOptions(intentOptions);
  let effectiveName = params.name;
  let effectiveStatus = params.status;
  let effectiveDependencyBlocked = params.dependencyBlocked === true;
  let effectiveExcludeTerminal = params.excludeTerminal === true;
  const requestedStatus = listOptions.status?.trim().toLowerCase();
  const requestedVariant =
    params.name === "list" && requestedStatus !== undefined
      ? CANONICAL_LIST_STATUS_VARIANTS[requestedStatus as ItemStatus]
      : undefined;
  if (params.name === "list") {
    if (params.options.all === true || requestedStatus === "all") {
      effectiveName = "list-all";
      effectiveExcludeTerminal = false;
      listOptions.status = undefined;
    } else if (requestedStatus !== undefined && requestedVariant !== undefined) {
      effectiveName = requestedVariant.name;
      effectiveStatus = requestedStatus as ItemStatus;
      effectiveDependencyBlocked = requestedVariant.dependencyBlocked;
      effectiveExcludeTerminal = false;
      listOptions.status = undefined;
    }
  }
  applyDefaultListProjection(listOptions, effectiveName);
  if (effectiveExcludeTerminal) listOptions.excludeTerminal = true;
  listOptions.dependencyBlocked = effectiveDependencyBlocked;
  const output = resolveRegisteredListOutputContext(
    intentOptions,
    globalOptions,
  );
  const result = await runList(
    effectiveDependencyBlocked ? undefined : effectiveStatus,
    listOptions,
    globalOptions,
  );
  renderRegisteredListResult("list", result, output);
  if (globalOptions.profile) {
    printError(`profile:command=list took_ms=${Date.now() - startedAt}`);
  }
}

interface ListCommandDescriptor {
  name: ListCommandName;
  description: string;
  status?: ItemStatus;
  excludeTerminal?: boolean;
  allowStatusFilter?: boolean;
  /** Select via the shared edge-aware blocked classification instead of a raw status filter (GH-578). */
  dependencyBlocked?: boolean;
  /** Declarative compatibility contract when this spelling is an alias. */
  aliasContract?: PmCommandAliasContract;
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
    dependencyBlocked,
    aliasContract,
  } = descriptor;
  const command = program
    .command(name, { hidden: aliasContract?.hidden === true })
    .description(description);
  if (allowStatusFilter) {
    command.option(
      "--status <value>",
      "Filter by status (repeatable or comma-separated; matches any; all selects every status)",
      collect,
    );
  }
  if (name === "list") {
    command.option("--all", "Include every lifecycle status");
  }
  command
    .option(
      "--for <intent>",
      `Apply a declared context intent projection. ${renderPmClosedDomainHelp("list", "--for")}`,
    )
    .option(
      "--token-budget <n>",
      "Override the selected intent's maximum estimated output tokens",
    )
    .option(
      "--type <value>",
      "Filter by item type (repeatable or comma-separated; matches any)",
      collect,
    )
    .option(
      "--tag <value>",
      "Filter by tag (repeatable or comma-separated; matches any)",
      collect,
    )
    .option(
      "--priority <value>",
      "Filter by priority (repeatable or comma-separated; matches any)",
      collect,
    )
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
    .option("--assignee <value>", "Filter by assignee", collect)
    .option(
      "--assignee-filter <value>",
      "Filter assignee presence: assigned|unassigned",
    )
    .option("--parent <value>", "Filter by parent item ID")
    .option("--sprint <value>", "Filter by sprint", collect)
    .option("--release <value>", "Filter by release", collect)
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
      "Return every matched row after the explicit status and field filters",
    )
    .option("--include-body", "Include item body in each returned list row")
    .option(
      "--strict-read",
      "Fail closed if any item document or item directory cannot be read",
    )
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
      `Render custom comma-separated list fields (mutually exclusive with --compact/--brief/--full). ${renderPmClosedDomainHelp(name, "--fields")}`,
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
      "Output render mode: csv|table (human export) or json|ndjson|toon (machine output override)",
    )
    .option("--stream", "Emit line-delimited JSON rows (requires --json)");
  registerContentAndGovernanceFilters(command);
  command.action(async (options: Record<string, unknown>, actionCommand) => {
    await runRegisteredListCommand({
      name,
      status,
      excludeTerminal,
      dependencyBlocked,
      options,
      actionCommand,
      aliasContract,
    });
  });
  // Hidden pure snake_case underscore-duplicate alias (kept parse-functional).
  addHiddenOption(command, "--tags <value>", "Alias for --tag");
  addHiddenOption(
    command,
    "--assignee_filter <value>",
    "Alias for --assignee-filter",
  );
  addHiddenOption(command, "--tree_depth <n>", "Alias for --tree-depth");
  addHiddenOption(command, "--token_budget <n>", "Alias for --token-budget");
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
  const normalized = normalizeContextOptions(
    applyContextIntentProjection("context", options),
  );
  const result = await runContext(normalized, globalOptions);
  const outputFormat = resolveContextOutputFormat(normalized, globalOptions);
  if (outputFormat === "markdown") {
    if (!globalOptions.quiet) {
      writeStdout(`${renderContextMarkdown(result)}\n`);
    }
  } else if (outputFormat === "ndjson") {
    setActiveCommandResult(result);
    const rendered = serializeNdjsonRows([
      ...result.high_level,
      ...result.low_level,
      ...result.blocked_fallback,
    ]);
    if (!globalOptions.quiet && rendered.length > 0) {
      writeStdout(`${rendered}\n`);
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
  const nextOptions = normalizeNextOptions(
    applyContextIntentProjection("next", options),
  );
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
  const query = normalizeSearchKeywordsInput(keywords);
  const intentOptions = applyContextIntentProjection("search", options, [
    query,
  ]);
  const searchOptions = normalizeSearchOptions(intentOptions);
  const result = await runSearch(
    query,
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
  const outputFormat =
    typeof intentOptions.format === "string"
      ? intentOptions.format.trim().toLowerCase()
      : undefined;
  const effectiveGlobal = resolveReadCommandOutputFormat(
    "Search",
    intentOptions.format,
    globalOptions,
    true,
  );
  if (outputFormat === "ndjson") {
    setActiveCommandResult(result);
    const rendered = serializeNdjsonRows(result.items);
    if (!effectiveGlobal.quiet && rendered.length > 0) {
      writeStdout(`${rendered}\n`);
    }
  } else {
    printResult(result, effectiveGlobal);
  }
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
  const intentOptions = applyContextIntentProjection("get", options, [id]);
  const result = await runGet(id, globalOptions, {
    depth:
      typeof intentOptions.depth === "string" ? intentOptions.depth : undefined,
    fields:
      typeof intentOptions.fields === "string"
        ? intentOptions.fields
        : undefined,
    full: Boolean(intentOptions.full),
    tree: intentOptions.tree === true,
    treeDepth:
      typeof intentOptions.treeDepth === "string"
        ? intentOptions.treeDepth
        : typeof intentOptions.tree_depth === "string"
          ? intentOptions.tree_depth
          : undefined,
    at: typeof intentOptions.at === "string" ? intentOptions.at : undefined,
  });
  printResult(
    result,
    resolveReadCommandOutputFormat("Get", intentOptions.format, globalOptions),
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
  if (
    [options.compact, options.raw, options.full, options.provenance].filter(
      (value) => value === true,
    ).length > 1
  ) {
    throw new PmCliError(
      "History projection options are mutually exclusive. Use --compact, --provenance, or --full.",
      EXIT_CODE.USAGE,
    );
  }
  const field = typeof options.field === "string" ? options.field : undefined;
  const strictExit = Boolean(options.strictExit) || Boolean(options.failOnWarn);
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
      compact:
        options.full === true || options.provenance === true ? false : true,
      provenance: options.provenance === true,
      provenanceSummary: options.provenanceSummary === true,
      harness: readRepeatableStringOption(options, "harness"),
      agentInstance: readRepeatableStringOption(options, "agentInstance"),
      provenanceFilter: readRepeatableStringOption(
        options,
        "provenanceFilter",
      ),
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

function readRepeatableStringOption(
  options: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = options[key];
  return Array.isArray(value) ? (value as string[]) : undefined;
}

function buildMutationEventOptions(
  options: Record<string, unknown>,
  pmRoot: string | undefined,
) {
  const harness = readRepeatableStringOption(options, "harness");
  const agentInstance = readRepeatableStringOption(options, "agentInstance");
  const provenanceFilter = readRepeatableStringOption(
    options,
    "provenanceFilter",
  );
  const rawCursorMode =
    typeof options.cursorMode === "string" ? options.cursorMode : undefined;
  if (
    rawCursorMode !== undefined &&
    rawCursorMode !== "batch" &&
    rawCursorMode !== "row"
  ) {
    throw new PmCliError(
      "Events --cursor-mode must be batch or row.",
      EXIT_CODE.USAGE,
      { code: "invalid_event_cursor_mode" },
    );
  }
  const cursorMode: "batch" | "row" | undefined = rawCursorMode;
  return {
    pmRoot,
    since: typeof options.since === "string" ? options.since : undefined,
    type: readRepeatableStringOption(options, "type"),
    author: readRepeatableStringOption(options, "author"),
    item: readRepeatableStringOption(options, "item"),
    limit: typeof options.limit === "string" ? Number(options.limit) : undefined,
    full: options.full === true,
    ...(options.provenance === true ? { provenance: true } : {}),
    ...(options.provenanceSummary === true
      ? { provenanceSummary: true }
      : {}),
    ...(harness === undefined ? {} : { harness }),
    ...(agentInstance === undefined ? {} : { agentInstance }),
    ...(provenanceFilter === undefined ? {} : { provenanceFilter }),
    cursorMode,
  };
}

type MutationEventOptions = ReturnType<typeof buildMutationEventOptions>;

/** Follows mutation events using either compatibility row cursors or the default batch-boundary trailer contract. */
async function followMutationEvents(
  eventOptions: MutationEventOptions,
  options: Record<string, unknown>,
  quiet: boolean,
): Promise<void> {
  if (options.provenanceSummary === true) {
    throw new PmCliError(
      "Events --provenance-summary is bounded to one page and cannot be combined with --follow.",
      EXIT_CODE.USAGE,
    );
  }
  const intervalMs =
    typeof options.intervalMs === "string"
      ? Number(options.intervalMs)
      : undefined;
  if (eventOptions.cursorMode === "row") {
    for await (const event of subscribeMutationEvents({
      ...eventOptions,
      intervalMs,
    })) {
      if (!quiet) {
        writeStdout(`${JSON.stringify(event)}\n`);
      }
    }
    return;
  }
  for await (const page of subscribeMutationEventBatches({
    ...eventOptions,
    intervalMs,
  })) {
    if (!quiet) {
      writeStdout(
        `${serializeNdjsonStream(page.events, {
          count: page.count,
          has_more: page.has_more,
          next_cursor: page.next_cursor ?? null,
          source: page.source,
          heartbeat: page.count === 0,
        })}\n`,
      );
    }
  }
}

/** Serializes one bounded mutation-event page using its declared row or batch cursor mode. */
function renderMutationEventPage(page: MutationEventPage): string {
  if (page.cursor_mode === "row") {
    return serializeNdjsonRows(page.events);
  }
  return serializeNdjsonStream(page.events, {
    count: page.count,
    has_more: page.has_more,
    next_cursor: page.next_cursor ?? null,
    source: page.source,
    ...(page.provenance_summary === undefined
      ? {}
      : { provenance_summary: page.provenance_summary }),
  });
}

async function runEventsAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const eventOptions = buildMutationEventOptions(options, globalOptions.path);
  if (options.follow === true) {
    await followMutationEvents(
      eventOptions,
      options,
      globalOptions.quiet === true,
    );
    return;
  }
  const page = await listMutationEvents(eventOptions);
  setActiveCommandResult(page);
  if (globalOptions.json) {
    printResult(page, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=events took_ms=${Date.now() - startedAt}`);
    }
    return;
  }
  const rendered = renderMutationEventPage(page);
  if (!globalOptions.quiet && rendered.length > 0) {
    writeStdout(`${rendered}\n`);
  }
  if (globalOptions.profile) {
    printError(`profile:command=events took_ms=${Date.now() - startedAt}`);
  }
}

async function runActivityAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  if (
    [options.raw, options.compact, options.full, options.provenance].filter(
      (value) => value === true,
    ).length > 1
  ) {
    throw new PmCliError(
      "Activity projection options are mutually exclusive. Use --raw, --compact, --provenance, or --full.",
      EXIT_CODE.USAGE,
    );
  }
  const streamMode = resolveActivityStreamMode(options.stream);
  if (streamMode && !globalOptions.json) {
    throw new PmCliError(
      "--stream requires --json output mode.",
      EXIT_CODE.USAGE,
    );
  }
  const normalized = normalizeActivityOptions(options);
  const result = await runActivity(
    streamMode && options.full !== true && options.provenance !== true
      ? { ...normalized, raw: true, compact: true }
      : normalized,
    globalOptions,
  );
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
      ...(Array.isArray(options.kind)
        ? { kind: options.kind as string[] }
        : {}),
      maxDepth:
        typeof options.maxDepth === "string" ? options.maxDepth : undefined,
      limit: typeof options.limit === "string" ? options.limit : undefined,
      after: typeof options.after === "string" ? options.after : undefined,
      direction:
        typeof options.direction === "string" ? options.direction : undefined,
      maxPaths:
        typeof options.maxPaths === "string" ? options.maxPaths : undefined,
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
      full: options.full === true,
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
      description:
        "List active items with optional lifecycle-status and project filters.",
      excludeTerminal: true,
      allowStatusFilter: true,
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
    },
    {
      name: "list-in-progress",
      description: "List in-progress items with optional filters.",
      status: "in_progress",
      excludeTerminal: false,
      allowStatusFilter: false,
    },
    {
      name: "list-blocked",
      description:
        "List blocked items (blocked status or open blocked_by dependencies, matching pm next) with optional filters.",
      dependencyBlocked: true,
      excludeTerminal: false,
      allowStatusFilter: false,
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
      const aliasContract = resolvePmCommandAlias(descriptor.name);
      registerListCommand(program, {
        ...descriptor,
        ...(aliasContract?.registration === "commander"
          ? { aliasContract }
          : {}),
      });
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
        "--for <intent>",
        `Apply a declared context intent projection. ${renderPmClosedDomainHelp("context", "--for")}`,
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
        "Context output format override: markdown|toon|json|ndjson",
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
      )
      .option(
        "--no-extension-health",
        "Omit the installed extension health summary",
      )
      .option("--no-tags", "Omit tag arrays from context focus rows");
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
    addHiddenOption(
      contextCommand,
      "--token_budget <n>",
      "Alias for --token-budget",
    );
    contextCommand.action(runContextAction);
  }

  if (shouldRegister("next")) {
    const nextCommand = program
      .command("next")
      .description(
        "Recommend the next actionable (unblocked, ready) work item with rationale + blocked companion.",
      )
      .option(
        "--for <intent>",
        `Apply a declared context intent projection. ${renderPmClosedDomainHelp("next", "--for")}`,
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
    addHiddenOption(
      nextCommand,
      "--token_budget <n>",
      "Alias for --token-budget",
    );
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
        "--for <intent>",
        `Apply a declared context intent projection. ${renderPmClosedDomainHelp("search", "--for")}`,
      )
      .option(
        "--token-budget <n>",
        "Override the selected intent's maximum estimated output tokens",
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
        `Render custom comma-separated search hit fields (mutually exclusive with --compact/--full). ${renderPmClosedDomainHelp("search", "--fields")}`,
      )
      .option(
        "--format <value>",
        "Search output format override: json|ndjson|toon",
      )
      .option("--limit <n>", "Limit returned item count")
      .option(
        "--after <cursor>",
        "Continue after an opaque next_cursor from a previous search response",
      );
    registerContentAndGovernanceFilters(searchCommand);
    searchCommand.action(runSearchAction);
    addHiddenOption(searchCommand, "--tags <value>", "Alias for --tag");
    addHiddenOption(
      searchCommand,
      "--token_budget <n>",
      "Alias for --token-budget",
    );
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
        `Query JSON (${EVAL_QUERY_SET_SCHEMA_ID}); default: search/eval-queries.json; errors show an example`,
      )
      .option("--format <value>", "Eval output format override: json|toon")
      .action(runEvalAction);
  }

  if (shouldRegister("get")) {
    const getCommand = program
      .command("get")
      .argument("<id>", "Item id")
      .option(
        "--for <intent>",
        `Apply a declared context intent projection. ${renderPmClosedDomainHelp("get", "--for")}`,
      )
      .option(
        "--token-budget <n>",
        "Override the selected intent's maximum estimated output tokens",
      )
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
        `Render custom comma-separated item metadata fields. ${renderPmClosedDomainHelp("get", "--fields")}`,
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
    addHiddenOption(
      getCommand,
      "--token_budget <n>",
      "Alias for --token-budget",
    );
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
        "--provenance",
        "Show patch-free author, harness, instance, and extensible provenance",
      )
      .option(
        "--provenance-summary",
        "Include bounded provenance completeness counts",
      )
      .option(
        "--harness <value>",
        "Filter by recorded or vocabulary-resolved harness (repeatable)",
        collect,
      )
      .option(
        "--agent-instance <value>",
        "Filter by privacy-safe agent instance (repeatable)",
        collect,
      )
      .option(
        "--provenance-filter <dimension=value>",
        "Filter by an exact declared provenance value (repeatable)",
        collect,
      )
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

  if (shouldRegister("events")) {
    program
      .command("events")
      .option(
        "--since <cursor-or-timestamp>",
        "Resume strictly after a durable cursor, or include events from an ISO timestamp",
      )
      .option(
        "--type <value>",
        "Filter by mutation operation (repeatable or comma-separated)",
        collect,
      )
      .option(
        "--author <value>",
        "Filter by mutation author (repeatable or comma-separated)",
        collect,
      )
      .option(
        "--item <value>",
        "Filter by item or workspace stream id (repeatable or comma-separated)",
        collect,
      )
      .option("--limit <n>", "Return at most 1,000 events (default: 100)")
      .option(
        "--cursor-mode <mode>",
        "Cursor framing: batch emits one terminal trailer (default); row preserves one cursor per event",
      )
      .option("--full", "Include each complete authoritative history entry")
      .option(
        "--provenance",
        "Include patch-free author, harness, instance, and extensible provenance",
      )
      .option(
        "--provenance-summary",
        "Include bounded provenance completeness counts",
      )
      .option(
        "--harness <value>",
        "Filter by recorded or vocabulary-resolved harness (repeatable)",
        collect,
      )
      .option(
        "--agent-instance <value>",
        "Filter by privacy-safe agent instance (repeatable)",
        collect,
      )
      .option(
        "--provenance-filter <dimension=value>",
        "Filter by an exact declared provenance value (repeatable)",
        collect,
      )
      .option(
        "--follow",
        "Continue emitting committed events as newline-delimited JSON",
      )
      .option(
        "--interval-ms <n>",
        "Empty-read delay while following (minimum: 10ms; default: 250ms)",
      )
      .description(
        "Emit cursor-resumable committed mutation facts as newline-delimited JSON.",
      )
      .action(runEventsAction);
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
        "--unbounded",
        "Explicitly return every matching activity entry (disables the default bound)",
      )
      .option(
        "--compact",
        "Condensed output: show only id, op, ts, author, msg per entry",
      )
      .option(
        "--raw",
        "Show the legacy compact per-event stream instead of the item digest",
      )
      .option("--full", "Show full activity entries with JSON Patch payloads")
      .option(
        "--provenance",
        "Show patch-free author, harness, instance, and extensible provenance",
      )
      .option(
        "--provenance-summary",
        "Include bounded provenance completeness counts",
      )
      .option(
        "--harness <value>",
        "Filter by recorded or vocabulary-resolved harness (repeatable)",
        collect,
      )
      .option(
        "--agent-instance <value>",
        "Filter by privacy-safe agent instance (repeatable)",
        collect,
      )
      .option(
        "--provenance-filter <dimension=value>",
        "Filter by an exact declared provenance value (repeatable)",
        collect,
      )
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
      .argument(
        "[id]",
        "Root item id (traversals, paths, impact, and dominators)",
      )
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
      .option(
        "--summary",
        "Return counts-first envelopes without row collections",
      )
      .option("--full", "Return the complete graph row projection")
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
