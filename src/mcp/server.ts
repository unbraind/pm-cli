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
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import {
  runActivity,
  runAggregate,
  runAppend,
  runCalendar,
  runClaim,
  runClose,
  runComments,
  runCommentsAudit,
  runContracts,
  runContext,
  runCreate,
  runCompletion,
  runConfig,
  runDelete,
  runDedupeAudit,
  runDeps,
  runDocs,
  runExtension,
  runFiles,
  runFilesDiscover,
  runGc,
  runGet,
  runGuide,
  runHealth,
  runHistory,
  runInit,
  runLearnings,
  runList,
  runNormalize,
  runNotes,
  runReindex,
  runRelease,
  runSearch,
  runStats,
  runTemplatesList,
  runTemplatesSave,
  runTemplatesShow,
  runTest,
  runTestAll,
  runTestRunsList,
  runTestRunsLogs,
  runTestRunsResume,
  runTestRunsStatus,
  runTestRunsStop,
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
            "Operation name: init, context, list, get, search, create, update, delete, claim, release, close, comments, notes, learnings, files, files-discover, docs, deps, test, test-all, validate, health, contracts, completion, config, calendar, activity, aggregate, dedupe-audit, normalize, reindex, extension, extension-reload, package, package-install, package-catalog, install, upgrade, history, stats, append, update-many, comments-audit, gc, templates-list, templates-save, templates-show, test-runs-list, test-runs-status, test-runs-logs, test-runs-stop, test-runs-resume.",
        },
        id: idSchema,
        query: { type: "string", description: "Search query for action=search." },
        reason: { type: "string", description: "Close reason for action=close." },
        force: { type: "boolean", description: "Force ownership/terminal-state override when supported." },
        options: { type: "object", description: "Underlying pm command options using camelCase keys." },
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
    description: "Search pm items with keyword, semantic, or hybrid search.",
    inputSchema: objectSchema({ query: { type: "string" }, options: { type: "object" } }, ["query"]),
  },
  {
    name: "pm_list",
    description: "List pm items with status/type/tag/priority filters.",
    inputSchema: objectSchema({ options: { type: "object" } }),
  },
  {
    name: "pm_get",
    description: "Read one pm item with body, linked files/tests/docs, and claim state.",
    inputSchema: objectSchema({ id: idSchema }, ["id"]),
  },
  {
    name: "pm_create",
    description: "Create a pm item natively and write pm history.",
    inputSchema: objectSchema({ options: { type: "object", description: "Create options. title and description are required." } }, [
      "options",
    ]),
  },
  {
    name: "pm_update",
    description: "Update pm item metadata/body/dependencies/log seeds natively.",
    inputSchema: objectSchema({ id: idSchema, options: { type: "object" } }, ["id", "options"]),
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
    description: "Close a pm item with a reason and optional close validation.",
    inputSchema: objectSchema({ id: idSchema, reason: { type: "string" }, options: { type: "object" } }, ["id", "reason"]),
  },
  {
    name: "pm_comments",
    description: "List or add comments on a pm item. Use options.add to append.",
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
    description: "Run pm health diagnostics.",
    inputSchema: objectSchema({ options: { type: "object" } }),
  },
  {
    name: "pm_contracts",
    description: "Inspect pm command, flag, schema, and availability contracts.",
    inputSchema: objectSchema({ options: { type: "object" } }),
  },
  {
    name: "pm_guide",
    description: "Read progressive-disclosure pm guide topics.",
    inputSchema: objectSchema({ options: { type: "object" } }),
  },
];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } as Record<string, unknown> : {};
}

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

function optionsWithAuthor(args: Record<string, unknown>): Record<string, unknown> {
  const options = asRecord(args.options);
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

async function runAction(args: Record<string, unknown>): Promise<unknown> {
  const action = readRequiredString(args, "action");
  const global = globalOptions(args);
  const options = optionsWithAuthor(args);
  const id = readString(args, "id");
  const force = args.force === true;

  switch (action) {
    case "init":
      return runInit(readString(args, "prefix"), global, options);
    case "context":
      return runContext(options, global);
    case "list":
      return runList(readString(args, "status"), options, global);
    case "get":
      return runGet(id ?? readRequiredString(options, "id"), global);
    case "search":
      return runSearch(readRequiredString(args, "query"), options, global);
    case "create":
      return runCreate(options, global);
    case "update":
      return runUpdate(id ?? readRequiredString(options, "id"), options, global);
    case "claim":
      return runClaim(id ?? readRequiredString(options, "id"), force, global, options);
    case "release":
      return runRelease(id ?? readRequiredString(options, "id"), force, global, options);
    case "close":
      return runClose(id ?? readRequiredString(options, "id"), readRequiredString(args, "reason"), options, global);
    case "comments":
      return runComments(id ?? readRequiredString(options, "id"), options, global);
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
    case "completion":
      return runCompletion(
        readRequiredString(args, "shell"),
        Array.isArray(options.itemTypes) ? options.itemTypes.map(String) : undefined,
        Array.isArray(options.tags) ? options.tags.map(String) : undefined,
        options.eagerTags === true,
        asRecord(options.runtime) as never,
      );
    case "config":
      return runConfig(
        readString(args, "scope") ?? readString(options, "scope") ?? "project",
        readString(args, "configAction") ?? readRequiredString(options, "action"),
        readString(args, "key") ?? readString(options, "key"),
        options,
        global,
      );
    case "calendar":
      return runCalendar(options, global);
    case "activity":
      return runActivity(options, global);
    case "aggregate":
      return runAggregate(options, global);
    case "dedupe-audit":
      return runDedupeAudit(options, global);
    case "normalize":
      return runNormalize(options as never, global);
    case "reindex":
      return runReindex(options, global);
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
    case "stats":
      return runStats(global);
    case "append":
      return runAppend(id ?? readRequiredString(options, "id"), options as never, global);
    case "update-many":
      return runUpdateMany(options as never, global);
    case "comments-audit":
      return runCommentsAudit(options, global);
    case "gc":
      return runGc(global, options);
    case "templates-list":
      return runTemplatesList(global);
    case "templates-save":
      return runTemplatesSave(readRequiredString(options, "name"), options, global);
    case "templates-show":
      return runTemplatesShow(readRequiredString(options, "name"), global);
    case "test-runs-list":
      return runTestRunsList(options, global);
    case "test-runs-status":
      return runTestRunsStatus(readRequiredString(args, "runId"), global);
    case "test-runs-logs":
      return runTestRunsLogs(readRequiredString(args, "runId"), options, global);
    case "test-runs-stop":
      return runTestRunsStop(readRequiredString(args, "runId"), options, global);
    case "test-runs-resume":
      return runTestRunsResume(readRequiredString(args, "runId"), options, global);
    case "guide":
      return runGuide(options, global);
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
  pm_guide: (args) => runAction({ ...args, action: "guide" }),
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
      serverInfo: { name: "pm-cli-native", version: "1.0.0" },
      instructions:
        "You have access to native pm CLI tools for git-based project management. " +
        "Use pm_context or pm_search before creating new work. " +
        "Prefer narrow tools (pm_context, pm_list, pm_get, pm_search, pm_create, pm_update, pm_claim, pm_release, pm_close, pm_comments, pm_files, pm_docs, pm_test, pm_validate, pm_health, pm_contracts, pm_guide) over pm_run when they cover the operation. " +
        "Use pm_run with an explicit action for calendar, activity, aggregate, dedupe-audit, normalize, reindex, history, stats, append, notes, learnings, test-all, gc, and template operations. " +
        "Set author to 'claude-code-agent' on all mutations. " +
        "Do not pass path during real repository tracking — only pass path for sandbox or test runs.",
    };
  }
  if (request.method === "tools/list") {
    return { tools: TOOLS };
  }
  if (request.method === "tools/call") {
    const params = asRecord(request.params);
    const name = readRequiredString(params, "name");
    const handler = HANDLERS[name];
    if (!handler) {
      throw new PmCliError(`Unknown pm MCP tool: ${name}`, 64);
    }
    const args = asRecord(params.arguments);
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
