#!/usr/bin/env node
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  activateExtensions,
  loadExtensions,
  runActiveCommandHandler,
  setActiveExtensionCommands,
  setActiveExtensionHooks,
  setActiveExtensionParsers,
  setActiveExtensionPreflight,
  setActiveExtensionRegistrations,
  setActiveExtensionRenderers,
  setActiveExtensionServices,
} from "../core/extensions/index.js";
import { pathExists } from "../core/fs/fs-utils.js";
import { projectMutationResult } from "../core/output/mutation-projection.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { asRecordClone } from "../core/shared/primitives.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import {
  runActivity,
  runAggregate,
  runAppend,
  runClaim,
  runClose,
  runComments,
  runContracts,
  runContext,
  runCreate,
  runConfig,
  runDelete,
  runDeps,
  runDocs,
  runExtension,
  runFiles,
  runFilesDiscover,
  runGc,
  runGet,
  runHealth,
  runHistory,
  runHistoryRedact,
  runHistoryRepair,
  runInit,
  runLearnings,
  runList,
  runNotes,
  runPlan,
  runRelease,
  runSchemaAddType,
  runSearch,
  runStats,
  runTest,
  runTestAll,
  runUpdate,
  runUpdateMany,
  runUpgrade,
  runValidate,
} from "../cli/commands/index.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

function resolvePmPackageRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

if (typeof process.env[PM_PACKAGE_ROOT_ENV] !== "string" || process.env[PM_PACKAGE_ROOT_ENV]?.trim().length === 0) {
  process.env[PM_PACKAGE_ROOT_ENV] = resolvePmPackageRoot();
}

const TOOL_SCHEMA_BASE = {
  type: "object",
  properties: {
    cwd: {
      type: "string",
      description: "Workspace directory to run the native pm operation in. Defaults to the MCP server process cwd.",
    },
    path: {
      type: "string",
      description: "Optional pm data root, equivalent to PM_PATH/global --path. Leave unset for real repository tracking.",
    },
    author: {
      type: "string",
      description: "Mutation author. Defaults to PM_AUTHOR or pm settings when supported by the underlying operation.",
    },
  },
  additionalProperties: true,
} as const;

const idSchema = {
  type: "string",
  description: "pm item id, for example pm-abc1.",
};

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    ...TOOL_SCHEMA_BASE,
    properties: {
      ...TOOL_SCHEMA_BASE.properties,
      ...properties,
    },
    required,
  };
}

const TOOLS: ToolDefinition[] = [
  {
    name: "pm_run",
    description:
      "Run any supported pm operation natively through the pm library. Use this for commands not covered by narrower pm_* tools.",
    inputSchema: objectSchema(
      {
        action: {
          type: "string",
          description:
            "Operation name: init, context, list, get, search, create, update, delete, claim, release, close, comments, notes, learnings, files, files-discover, docs, deps, test, test-all, validate, health, contracts, config, activity, aggregate, extension, extension-reload, package, package-install, package-catalog, install, upgrade, history, stats, append, update-many, gc. Package-owned actions (for example calendar/templates/guide/dedupe-audit/normalize/reindex/comments-audit/completion/test-runs-list/test-runs-status/test-runs-logs/test-runs-stop/test-runs-resume) are available dynamically when installed.",
        },
        id: idSchema,
        query: { type: "string", description: "Search query for action=search." },
        reason: { type: "string", description: "Close reason for action=close." },
        force: { type: "boolean", description: "Force ownership/terminal-state override when supported." },
        options: { type: "object", description: "Underlying pm command options using camelCase keys." },
        fullChangedFields: {
          type: "boolean",
          description:
            "For mutation actions, return the full changed_fields array instead of the default changed_field_count.",
        },
      },
      ["action"],
    ),
  },
  {
    name: "pm_context",
    description: "Return the agent-oriented project context snapshot.",
    inputSchema: objectSchema({ options: { type: "object" } }),
  },
  {
    name: "pm_search",
    description:
      "Search pm items with keyword, semantic, or hybrid search. " +
      "Defaults to a compact projection for token efficiency. " +
      "Pass options.mode=keyword|semantic|hybrid, options.limit=N to cap hits, " +
      "options.fields='id,title,score' for a custom projection, or options.full=true for full item bodies (can be large).",
    inputSchema: objectSchema({ query: { type: "string" }, options: { type: "object" } }, ["query"]),
  },
  {
    name: "pm_list",
    description:
      "List pm items with status/type/tag/priority filters. Defaults to compact projection for token efficiency. " +
      "options.status accepts CSV (open,in_progress). " +
      "Pass options.compact=false or options.includeBody=true for full bodies/comments. " +
      "Pass options.brief=true for ultra-terse (id/status/type/title only). " +
      "Pass options.fields='id,title,priority' for custom projection. " +
      "Pass options.limit=N to cap row count.",
    inputSchema: objectSchema({ options: { type: "object" } }),
  },
  {
    name: "pm_get",
    description:
      "Read one pm item. Pass options.depth='brief' or options.fields='id,title,status' for low-token inspection.",
    inputSchema: objectSchema({
      id: idSchema,
      options: { type: "object", description: "Get options such as depth=brief|standard|deep or fields=id,title,status." },
    }, ["id"]),
  },
  {
    name: "pm_create",
    description:
      "Create a pm item natively and write pm history. " +
      "Output is compact by default (changed_fields replaced with changed_field_count for token efficiency); pass fullChangedFields=true for the full changed_fields array.",
    inputSchema: objectSchema(
      {
        fullChangedFields: { type: "boolean", description: "Return full changed_fields instead of changed_field_count." },
        options: { type: "object", description: "Create options. title and description are required." },
      },
      ["options"],
    ),
  },
  {
    name: "pm_update",
    description:
      "Update pm item metadata/body/dependencies/log seeds natively. " +
      "Output is compact by default (changed_fields replaced with changed_field_count); pass fullChangedFields=true for the full changed_fields delta.",
    inputSchema: objectSchema(
      {
        id: idSchema,
        fullChangedFields: { type: "boolean", description: "Return full changed_fields instead of changed_field_count." },
        options: { type: "object" },
      },
      ["id", "options"],
    ),
  },
  {
    name: "pm_claim",
    description: "Claim a pm item.",
    inputSchema: objectSchema({ id: idSchema, force: { type: "boolean" }, options: { type: "object" } }, ["id"]),
  },
  {
    name: "pm_release",
    description: "Release a pm item claim.",
    inputSchema: objectSchema({ id: idSchema, force: { type: "boolean" }, options: { type: "object" } }, ["id"]),
  },
  {
    name: "pm_close",
    description:
      "Close a pm item with a reason and optional close validation. " +
      "Output is compact by default (changed_fields replaced with changed_field_count); pass fullChangedFields=true for the full changed_fields array.",
    inputSchema: objectSchema(
      {
        id: idSchema,
        reason: { type: "string" },
        fullChangedFields: { type: "boolean", description: "Return full changed_fields instead of changed_field_count." },
        options: { type: "object" },
      },
      ["id", "reason"],
    ),
  },
  {
    name: "pm_comments",
    description:
      "List or add comments on a pm item. Use options.add to append. " +
      "List calls default to the most recent 20 comments with total_count/has_more metadata for token efficiency. " +
      "Pass options.limit=N to choose a page size, options.limit=0 for summary-only metadata, or options.full=true for full history.",
    inputSchema: objectSchema({ id: idSchema, options: { type: "object" } }, ["id"]),
  },
  {
    name: "pm_files",
    description: "List, add, remove, audit, or validate linked files for a pm item.",
    inputSchema: objectSchema({ id: idSchema, options: { type: "object" } }, ["id"]),
  },
  {
    name: "pm_docs",
    description: "List, add, or remove linked docs for a pm item.",
    inputSchema: objectSchema({ id: idSchema, options: { type: "object" } }, ["id"]),
  },
  {
    name: "pm_test",
    description: "List, add, remove, or run linked tests for a pm item.",
    inputSchema: objectSchema({ id: idSchema, options: { type: "object" } }, ["id"]),
  },
  {
    name: "pm_validate",
    description: "Run pm validation checks.",
    inputSchema: objectSchema({ options: { type: "object" } }),
  },
  {
    name: "pm_health",
    description: "Run pm health diagnostics. Pass options.brief=true for compact low-token details, options.skipIntegrity=true, options.skipDrift=true, options.skipVectors=true for a fast status-only check, or options.full=true for the complete deep check.",
    inputSchema: objectSchema({ options: { type: "object" } }),
  },
  {
    name: "pm_contracts",
    description: "Inspect pm command, flag, schema, and availability contracts.",
    inputSchema: objectSchema({ options: { type: "object" } }),
  },
  {
    name: "pm_plan",
    description:
      "Run agent-optimized Plan workflows. options.subcommand selects: create|show|add-step|update-step|complete-step|block-step|reorder-step|remove-step|link|unlink|decision|discovery|validation|resume|approve|materialize. Provide id for all non-create subcommands; provide stepRef for step lifecycle subcommands. Plans store agent-readable steps with dependencies, decisions, discoveries, validation, and resume context.",
    inputSchema: objectSchema({
      id: { type: "string", description: "Plan id (required for all subcommands except create)." },
      stepRef: { type: "string", description: "Step id or order for step lifecycle subcommands." },
      reorderTo: { type: "number", description: "New order for reorder-step." },
      options: { type: "object", description: "Plan options including subcommand, stepRef, stepStatus, link, depth, etc." },
    }),
  },
];

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readRequiredString(args: Record<string, unknown>, key: string): string {
  const value = readString(args, key);
  if (!value) {
    throw new PmCliError(`Missing required argument: ${key}`, 64);
  }
  return value;
}

function globalOptions(args: Record<string, unknown>): GlobalOptions {
  return {
    json: true,
    quiet: true,
    path: readString(args, "path"),
    noPager: true,
  };
}

const ARRAY_TO_CSV_FIELDS = new Set(["tags", "blockedBy", "blocked_by", "skills"]);

const SCALAR_TO_ARRAY_FIELDS = new Set([
  "comment",
  "note",
  "learning",
  "reminder",
  "event",
  "dep",
  "depRemove",
  "dep_remove",
  "file",
  "doc",
  "test",
  "unset",
  "addGlob",
  "add_glob",
  "migrate",
  "envSet",
  "env_set",
  "envClear",
  "env_clear",
]);

// Actions where the linked-resource fields `add` and `remove` are string[] arrays.
// For other actions (comments/notes/learnings) `add` and `remove` are scalar strings
// and must NOT be auto-promoted.
const ARRAY_ADD_REMOVE_ACTIONS = new Set([
  "files",
  "files-discover",
  "docs",
  "test",
  "test-all",
]);

function normalizeOptionsArrays(
  options: Record<string, unknown>,
  action?: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const promoteAddRemove = action !== undefined && ARRAY_ADD_REMOVE_ACTIONS.has(action);
  for (const [key, value] of Object.entries(options)) {
    if (Array.isArray(value) && ARRAY_TO_CSV_FIELDS.has(key)) {
      result[key] = value.join(",");
      continue;
    }
    if (typeof value === "string" && SCALAR_TO_ARRAY_FIELDS.has(key)) {
      result[key] = [value];
      continue;
    }
    if (typeof value === "string" && promoteAddRemove && (key === "add" || key === "remove")) {
      result[key] = [value];
      continue;
    }
    result[key] = value;
  }
  return result;
}

function optionsWithAuthor(args: Record<string, unknown>, action?: string): Record<string, unknown> {
  const options = normalizeOptionsArrays(asRecordClone(args.options), action);
  const author = readString(args, "author");
  return author && options.author === undefined ? { ...options, author } : options;
}

function normalizeActionName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeCommandPath(value: string): string {
  return value.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry)).filter((entry) => entry.length > 0);
}

function extensionOptionsFromArgs(args: Record<string, unknown>, options: Record<string, unknown>): Record<string, unknown> {
  const reserved = new Set(["action", "args", "author", "cwd", "id", "options", "path", "query", "reason", "target"]);
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!reserved.has(key)) {
      passthrough[key] = value;
    }
  }
  const normalizedOptions = { ...passthrough, ...options };
  delete normalizedOptions.args;
  return normalizedOptions;
}

async function runDynamicExtensionAction(
  action: string,
  args: Record<string, unknown>,
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  if (global.noExtensions) {
    throw new PmCliError(`Unsupported native pm action: ${action}`, 64);
  }
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Unsupported native pm action: ${action}`, 64);
  }

  const settings = await readSettings(pmRoot);
  const loadResult = await loadExtensions({
    pmRoot,
    settings,
    cwd: process.cwd(),
    noExtensions: false,
  });
  const activationResult = await activateExtensions({
    ...loadResult,
    loaded: loadResult.loaded,
  });

  const normalizedAction = normalizeActionName(action);
  const definition = activationResult.registrations.commands.find((entry) =>
    normalizeActionName(entry.action) === normalizedAction
  );
  const command = definition?.command ??
    activationResult.commands.handlers.find((entry) => normalizeActionName(entry.command) === normalizedAction)?.command;
  if (!command) {
    throw new PmCliError(`Unsupported native pm action: ${action}`, 64);
  }

  setActiveExtensionHooks(activationResult.hooks);
  setActiveExtensionCommands(activationResult.commands);
  setActiveExtensionParsers(activationResult.parsers);
  setActiveExtensionPreflight(activationResult.preflight);
  setActiveExtensionServices(activationResult.services);
  setActiveExtensionRenderers(activationResult.renderers);
  setActiveExtensionRegistrations(activationResult.registrations);

  const handlerResult = await runActiveCommandHandler({
    command: normalizeCommandPath(command),
    args: readStringArray(options.args ?? args.args),
    options: extensionOptionsFromArgs(args, options),
    global,
    pm_root: pmRoot,
  });
  if (!handlerResult.handled) {
    const suffix = handlerResult.warnings.length > 0 ? ` (${handlerResult.warnings.join(", ")})` : "";
    throw new PmCliError(`Unsupported native pm action: ${action}${suffix}`, 64);
  }
  return handlerResult.result;
}

async function withCwd<T>(cwd: unknown, run: () => Promise<T>): Promise<T> {
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    return run();
  }
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

/**
 * Mutation tools (create/update/close/append/update-many) return a verbose
 * `changed_fields` array. On the agent path we drop it to a `changed_field_count`
 * by default for token efficiency, restoring the full array only when the caller
 * explicitly passes the MCP-level fullChangedFields=true control. Mutation options
 * are forwarded unchanged so runtime fields named `full` remain valid user data.
 */
function withMutationCompaction(args: Record<string, unknown>, options: Record<string, unknown>): {
  changedFields: "full" | "compact";
  runnerOptions: Record<string, unknown>;
} {
  return { changedFields: args.fullChangedFields === true ? "full" : "compact", runnerOptions: { ...options } };
}

async function runAction(args: Record<string, unknown>): Promise<unknown> {
  const action = readRequiredString(args, "action");
  const global = globalOptions(args);
  const options = optionsWithAuthor(args, action);
  const id = readString(args, "id");
  const force = args.force === true;

  switch (action) {
    case "init":
      return runInit(readString(args, "prefix"), global, options);
    case "context":
      return runContext(options, global);
    case "list": {
      const listOptions: Record<string, unknown> = { ...options };
      if (
        listOptions.compact === undefined &&
        listOptions.brief === undefined &&
        listOptions.fields === undefined &&
        listOptions.includeBody === undefined
      ) {
        listOptions.compact = true;
      }
      return runList(readString(args, "status"), listOptions as never, global);
    }
    case "get":
      return runGet(id ?? readRequiredString(options, "id"), global, options);
    case "search": {
      const searchOptions: Parameters<typeof runSearch>[1] = { ...options };
      if (
        searchOptions.compact === undefined &&
        searchOptions.full === undefined &&
        searchOptions.fields === undefined
      ) {
        searchOptions.compact = true;
      }
      return runSearch(readRequiredString(args, "query"), searchOptions, global);
    }
    case "create": {
      const { changedFields, runnerOptions } = withMutationCompaction(args, options);
      return projectMutationResult(await runCreate(runnerOptions as never, global), { changedFields });
    }
    case "update": {
      const { changedFields, runnerOptions } = withMutationCompaction(args, options);
      return projectMutationResult(
        await runUpdate(id ?? readRequiredString(runnerOptions, "id"), runnerOptions as never, global),
        { changedFields },
      );
    }
    case "claim":
      return runClaim(id ?? readRequiredString(options, "id"), force, global, options);
    case "release":
      return runRelease(id ?? readRequiredString(options, "id"), force, global, options);
    case "close": {
      const { changedFields, runnerOptions } = withMutationCompaction(args, options);
      return projectMutationResult(
        await runClose(
          id ?? readRequiredString(runnerOptions, "id"),
          readRequiredString(args, "reason"),
          runnerOptions as never,
          global,
        ),
        { changedFields },
      );
    }
    case "comments": {
      const commentOptions: Record<string, unknown> = { ...options };
      const isListing =
        commentOptions.add === undefined && commentOptions.stdin === undefined && commentOptions.file === undefined;
      if (isListing) {
        commentOptions.includeMeta = true;
        if (commentOptions.limit === undefined && commentOptions.full !== true) {
          commentOptions.limit = "20";
        }
      }
      delete commentOptions.full;
      return runComments(id ?? readRequiredString(options, "id"), commentOptions, global);
    }
    case "notes":
      return runNotes(id ?? readRequiredString(options, "id"), options, global);
    case "learnings":
      return runLearnings(id ?? readRequiredString(options, "id"), options, global);
    case "files":
      return runFiles(id ?? readRequiredString(options, "id"), options, global);
    case "docs":
      return runDocs(id ?? readRequiredString(options, "id"), options, global);
    case "test":
      return runTest(id ?? readRequiredString(options, "id"), options, global);
    case "test-all":
      return runTestAll(options, global);
    case "validate":
      return runValidate(options, global);
    case "health":
      return runHealth(global, options);
    case "contracts":
      return runContracts(options, global);
    case "config":
      return runConfig(
        readString(args, "scope") ?? readString(options, "scope") ?? "project",
        readString(args, "configAction") ?? readRequiredString(options, "action"),
        readString(args, "key") ?? readString(options, "key"),
        options,
        global,
        readString(args, "value") ?? readString(options, "value"),
      );
    case "activity": {
      const activityOptions = { ...options } as Parameters<typeof runActivity>[0] & { full?: unknown };
      if (activityOptions.compact === undefined) {
        activityOptions.compact = activityOptions.full === true ? false : true;
      }
      delete activityOptions.full;
      return runActivity(activityOptions, global);
    }
    case "aggregate":
      return runAggregate(options, global);
    case "extension":
      return runExtension(readString(args, "target") ?? readString(options, "target"), options, global);
    case "extension-reload":
      return runExtension(undefined, { ...options, reload: true }, global);
    case "package":
      return runExtension(readString(args, "target") ?? readString(options, "target"), options, global);
    case "package-install":
    case "install":
      return runExtension(readString(args, "target") ?? readString(options, "target"), { ...options, install: true }, global);
    case "package-catalog":
      return runExtension(undefined, { ...options, catalog: true, vocabulary: "package" }, global);
    case "upgrade":
      return runUpgrade(readString(args, "target") ?? readString(options, "target"), options, global);
    case "delete":
      return runDelete(id ?? readRequiredString(options, "id"), options, global);
    case "deps":
      return runDeps(id ?? readRequiredString(options, "id"), options, global);
    case "files-discover":
      return runFilesDiscover(id ?? readRequiredString(options, "id"), options, global);
    case "history":
      return runHistory(id ?? readRequiredString(options, "id"), options, global);
    case "history-redact":
      return runHistoryRedact(id ?? readRequiredString(options, "id"), options, global);
    case "history-repair":
      return runHistoryRepair(id ?? readRequiredString(options, "id"), options, global);
    case "plan": {
      const subcommand = readRequiredString(options, "subcommand");
      const planRecord = options as Record<string, unknown>;
      const reorderToken = planRecord.reorderTo ?? args.reorderTo;
      const reorderTo =
        typeof reorderToken === "number" && Number.isFinite(reorderToken)
          ? reorderToken
          : typeof reorderToken === "string" && reorderToken.trim().length > 0
            ? Number.parseInt(reorderToken, 10)
            : undefined;
      const stepRef = typeof planRecord.stepRef === "string"
        ? (planRecord.stepRef as string)
        : typeof args.stepRef === "string"
          ? (args.stepRef as string)
          : undefined;
      return runPlan({
        subcommand: subcommand as never,
        id: typeof id === "string" ? id : typeof planRecord.id === "string" ? (planRecord.id as string) : undefined,
        stepRef,
        reorderTo,
        options: options as never,
        global,
      });
    }
    case "schema": {
      // subcommand/name are top-level fields in the published action contract,
      // so accept them from args first and fall back to options for parity.
      const subcommand = readString(args, "subcommand") ?? readRequiredString(options, "subcommand");
      if (subcommand.trim().toLowerCase() !== "add-type") {
        throw new PmCliError(`Unknown pm schema subcommand "${subcommand}". Allowed: add-type`, 64);
      }
      const aliasSource = args.alias ?? options.alias;
      const aliases = aliasSource === undefined ? undefined : readStringArray(aliasSource);
      return runSchemaAddType(
        readString(args, "name") ?? readString(options, "name"),
        {
          description: readString(args, "description") ?? readString(options, "description"),
          defaultStatus:
            readString(args, "defaultStatus") ??
            readString(args, "default_status") ??
            readString(options, "defaultStatus") ??
            readString(options, "default_status"),
          folder: readString(args, "folder") ?? readString(options, "folder"),
          alias: aliases,
          author: readString(args, "author") ?? readString(options, "author"),
          force: args.force === true || options.force === true,
        },
        global,
      );
    }
    case "stats":
      return runStats(global);
    case "append": {
      const { changedFields, runnerOptions } = withMutationCompaction(args, options);
      return projectMutationResult(
        await runAppend(id ?? readRequiredString(runnerOptions, "id"), runnerOptions as never, global),
        { changedFields },
      );
    }
    case "update-many": {
      const { changedFields, runnerOptions } = withMutationCompaction(args, options);
      return projectMutationResult(await runUpdateMany(runnerOptions as never, global), { changedFields });
    }
    case "gc":
      return runGc(global, options);
    default:
      return runDynamicExtensionAction(action, args, options, global);
  }
}

const HANDLERS: Record<string, ToolHandler> = {
  pm_run: (args) => runAction(args),
  pm_context: (args) => runAction({ ...args, action: "context" }),
  pm_search: (args) => runAction({ ...args, action: "search" }),
  pm_list: (args) => runAction({ ...args, action: "list" }),
  pm_get: (args) => runAction({ ...args, action: "get" }),
  pm_create: (args) => runAction({ ...args, action: "create" }),
  pm_update: (args) => runAction({ ...args, action: "update" }),
  pm_claim: (args) => runAction({ ...args, action: "claim" }),
  pm_release: (args) => runAction({ ...args, action: "release" }),
  pm_close: (args) => runAction({ ...args, action: "close" }),
  pm_comments: (args) => runAction({ ...args, action: "comments" }),
  pm_files: (args) => runAction({ ...args, action: "files" }),
  pm_docs: (args) => runAction({ ...args, action: "docs" }),
  pm_test: (args) => runAction({ ...args, action: "test" }),
  pm_validate: (args) => runAction({ ...args, action: "validate" }),
  pm_health: (args) => runAction({ ...args, action: "health" }),
  pm_contracts: (args) => runAction({ ...args, action: "contracts" }),
  pm_plan: (args) => runAction({ ...args, action: "plan" }),
};

function resultContent(result: unknown): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: { result },
  };
}

function errorContent(error: unknown): Record<string, unknown> {
  const code = error instanceof PmCliError ? error.exitCode : 1;
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: message, code }, null, 2),
      },
    ],
    structuredContent: { error: message, code },
  };
}

export async function handleRequest(request: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
  if (!request.id && request.method?.startsWith("notifications/")) {
    return undefined;
  }
  if (request.method === "initialize") {
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "pm-mcp", version: "1.0.0" },
      instructions:
        "You have access to native pm CLI tools for git-based project management. " +
        "Use pm_context or pm_search before creating new work. " +
        "Prefer narrow tools (pm_context, pm_list, pm_get, pm_search, pm_create, pm_update, pm_claim, pm_release, pm_close, pm_comments, pm_files, pm_docs, pm_test, pm_validate, pm_health, pm_contracts, pm_plan) over pm_run when they cover the operation. " +
        "Use pm_plan for agent harness Plan workflows: it provides Codex/Claude/Cursor-style planning with durable steps, dependencies, decisions, discoveries, validation, and materialization. " +
        "Use pm_run with an explicit action for package-owned operations (calendar/templates/guide/dedupe-audit/normalize/reindex/comments-audit/completion/test-runs-list/test-runs-status/test-runs-logs/test-runs-stop/test-runs-resume), plus activity, aggregate, history, stats, append, notes, learnings, test-all, and gc. " +
        "Use history-redact for audited history-stream redaction workflows, and history-repair to re-anchor a drifted history chain so pm health/validate report ok. " +
        "Set author to 'claude-code-agent' on all mutations. " +
        "Do not pass path during real repository tracking — only pass path for sandbox or test runs.",
    };
  }
  if (request.method === "tools/list") {
    return { tools: TOOLS };
  }
  if (request.method === "tools/call") {
    const params = asRecordClone(request.params);
    const name = readRequiredString(params, "name");
    const handler = HANDLERS[name];
    if (!handler) {
      throw new PmCliError(`Unknown pm MCP tool: ${name}`, 64);
    }
    const args = asRecordClone(params.arguments);
    const result = await withCwd(args.cwd, () => handler(args));
    return resultContent(result);
  }
  throw new PmCliError(`Unsupported MCP method: ${request.method ?? "(missing)"}`, 64);
}

function writeResponse(id: JsonRpcRequest["id"], payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: payload })}\n`);
}

function writeError(id: JsonRpcRequest["id"], error: unknown): void {
  const code = error instanceof PmCliError ? error.exitCode : -32603;
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

export function startMcpServer(): void {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    void (async () => {
      if (line.trim().length === 0) {
        return;
      }
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch (error) {
        writeError(null, error);
        return;
      }
      try {
        const result = await handleRequest(request);
        if (result !== undefined) {
          writeResponse(request.id, result);
        }
      } catch (error) {
        if (request.method === "tools/call") {
          writeResponse(request.id, errorContent(error));
        } else {
          writeError(request.id, error);
        }
      }
    })();
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startMcpServer();
}
