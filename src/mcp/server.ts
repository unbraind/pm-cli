#!/usr/bin/env node
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  createEmptyExtensionCommandRegistry,
  createEmptyExtensionHookRegistry,
  createEmptyExtensionParserRegistry,
  createEmptyExtensionPreflightRegistry,
  createEmptyExtensionRegistrationRegistry,
  createEmptyExtensionRendererRegistry,
  createEmptyExtensionServiceRegistry,
} from "../core/extensions/extension-registries.js";
import {
  activateExtensions,
  deactivateExtensions,
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
import { resolvePmCliVersion } from "../core/packages/root.js";
import { projectMutationResult } from "../core/output/mutation-projection.js";
import { withQuerySummary } from "../core/output/query-summary.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { decodeHtmlEntitiesInOptions } from "../core/shared/html-entity-decode.js";
import { levenshteinDistanceWithinLimit } from "../core/shared/levenshtein.js";
import { asRecordClone } from "../core/shared/primitives.js";
import { createSerialQueue } from "../core/shared/serial-queue.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import { normalizeListOptions, normalizeUpdateOptions } from "../cli/registration-helpers.js";
import { UPDATE_COMMANDER_STRING_OPTION_CONTRACTS } from "../sdk/cli-contracts/commander-mutation-options.js";
import { clearWorkspaceContractsCache } from "../sdk/runtime.js";
import { TOOLS } from "./tool-definitions.js";
import {
  runActivity,
  runAggregate,
  runAppend,
  runClaim,
  runClose,
  runCloseMany,
  runComments,
  runContracts,
  runContext,
  runCreate,
  runCopy,
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
  runHistoryCompact,
  runHistoryRedact,
  runHistoryRepair,
  runInit,
  runLearnings,
  runList,
  runNotes,
  runPlan,
  runRelease,
  runSchemaAddStatus,
  runSchemaAddType,
  runSchemaList,
  runSchemaRemoveStatus,
  runSchemaRemoveType,
  runSchemaShow,
  runSchemaShowStatus,
  runSearch,
  runStats,
  runTelemetry,
  runTest,
  runTestAll,
  runUpdate,
  runUpdateMany,
  runUpgrade,
  runValidate,
} from "../cli/commands/index.js";
import type { CloseManyCommandOptions } from "../cli/commands/close-many.js";
import type { ListOptions } from "../cli/commands/list.js";
import type { UpdateManyCommandOptions } from "../cli/commands/update-many.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

function resolvePmPackageRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

if (typeof process.env[PM_PACKAGE_ROOT_ENV] !== "string" || process.env[PM_PACKAGE_ROOT_ENV]?.trim().length === 0) {
  process.env[PM_PACKAGE_ROOT_ENV] = resolvePmPackageRoot();
}

// Reflect the real package.json version so agents/telemetry can identify the
// build serving requests (was hard-coded "1.0.0"; see pm-2nvw).
const PM_MCP_SERVER_VERSION = resolvePmCliVersion(import.meta.url, ["../.."]) ?? "0.0.0";

// Tool definitions (TOOLS) live in ./tool-definitions.ts so the `pm contracts`
// golden-file snapshot can import the surface without loading the server
// runtime (pm-4os2). This file owns dispatch, normalization, and transport.

// pm-qxwu: TOOL_SCHEMA_BASE keeps additionalProperties:true so legitimate
// passthrough keeps working, which means a typo'd top-level arg (e.g.
// "fullChangedField" missing the trailing "s") is silently swallowed and the
// agent gets default behavior with no signal. We precompute the declared
// top-level property keys for each tool and, on every tools/call, warn (without
// rejecting) when an unexpected top-level key appears. The warning is surfaced
// to stderr and additively in structuredContent.warnings.
const TOOL_DECLARED_KEYS: Map<string, string[]> = new Map(
  TOOLS.map((tool) => {
    const schema = tool.inputSchema as { properties?: Record<string, unknown> };
    const properties = schema.properties ?? {};
    return [tool.name, Object.keys(properties)] as const;
  }),
);

function nearestDeclaredKey(unexpected: string, declared: string[]): string | undefined {
  // Cheap did-you-mean: budget grows with key length but stays small so we only
  // suggest genuine near-misses (a single typo / transposition for short keys).
  const limit = Math.max(1, Math.min(3, Math.floor(unexpected.length / 4) + 1));
  let best: { key: string; distance: number } | undefined;
  for (const candidate of declared) {
    const distance = levenshteinDistanceWithinLimit(unexpected, candidate, limit);
    if (distance === null) {
      continue;
    }
    if (best === undefined || distance < best.distance) {
      best = { key: candidate, distance };
    }
  }
  return best?.key;
}

// pm_run is the explicit catch-all passthrough tool: extension/package actions
// accept arbitrary top-level keys (see extensionOptionsFromArgs), so unexpected
// keys there are by-design rather than typos and must not be flagged.
const UNEXPECTED_KEY_WARNING_EXEMPT_TOOLS = new Set(["pm_run"]);

function detectUnexpectedTopLevelKeys(toolName: string, args: Record<string, unknown>): string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return [];
  }
  if (UNEXPECTED_KEY_WARNING_EXEMPT_TOOLS.has(toolName)) {
    return [];
  }
  const declared = TOOL_DECLARED_KEYS.get(toolName);
  if (declared === undefined) {
    return [];
  }
  const declaredSet = new Set(declared);
  const warnings: string[] = [];
  for (const key of Object.keys(args)) {
    if (declaredSet.has(key)) {
      continue;
    }
    const suggestion = nearestDeclaredKey(key, declared);
    warnings.push(
      suggestion !== undefined
        ? `Unexpected top-level argument "${key}" for ${toolName} (did you mean "${suggestion}"?). It was passed through unchanged; declared arguments are: ${declared.join(", ")}.`
        : `Unexpected top-level argument "${key}" for ${toolName}. It was passed through unchanged; declared arguments are: ${declared.join(", ")}.`,
    );
  }
  return warnings;
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readScalarString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : undefined;
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function readScalarStringAllowBlank(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

const ARRAY_TO_CSV_FIELDS = new Set(["tags", "blockedBy", "blocked_by", "skills", "fields"]);

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

function normalizeMcpOptionsArrays(
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
  const baseOptions = asRecordClone(args.options);
  const hoistedTopLevel: Record<string, unknown> = {};
  const hoistKey = (key: string): void => {
    if (baseOptions[key] !== undefined || args[key] === undefined) {
      return;
    }
    hoistedTopLevel[key] = args[key];
  };
  if (action === "list") {
    hoistKey("status");
    hoistKey("type");
    hoistKey("tag");
    hoistKey("priority");
    hoistKey("limit");
    hoistKey("offset");
  } else if (action === "search") {
    hoistKey("mode");
    hoistKey("status");
    hoistKey("type");
    hoistKey("tag");
    hoistKey("priority");
    hoistKey("limit");
  } else if (action === "create") {
    hoistKey("allowMissingParent");
  } else if (action === "close") {
    hoistKey("duplicateOf");
  } else if (action === "append") {
    // pm-7u9j: the narrow pm_append tool declares `body` top-level; runAppend
    // reads it from options, so hoist unless options.body already wins.
    // (pm_schema/pm_config top-level args are consumed directly by runAction's
    // schema/config cases, which read args before options — no hoist needed.)
    hoistKey("body");
  }
  const options = normalizeMcpOptionsArrays({ ...hoistedTopLevel, ...baseOptions }, action);
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
  const reserved = new Set([
    "action",
    "args",
    "author",
    "cwd",
    "fullChangedFields",
    "id",
    "options",
    "path",
    "query",
    "reason",
    "target",
  ]);
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

// pm-bl6m: runDynamicExtensionAction mutates the process-global active extension
// registries (set globals -> run handler -> clear globals in a finally). The stdio
// transport already processes JSON-RPC lines sequentially, but handleRequest is a
// public entry point (tests, future concurrent transports) — if two native-action
// requests ever ran concurrently, the newer request would overwrite the globals
// mid-flight and whichever finished first would clear them out from under the
// other (its lazily-read hooks/overrides would silently vanish). Serialize the
// whole activation cycle (load -> activate -> set -> run -> clear -> deactivate)
// on a dedicated FIFO queue so the critical section can never interleave. Full
// request-scoped registry plumbing remains possible later if true intra-server
// concurrency is ever needed.
const dynamicExtensionActionQueue = createSerialQueue();

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
  return dynamicExtensionActionQueue.enqueue(async () => {
    try {
      return await runDynamicExtensionActionExclusively(action, args, options, global, pmRoot);
    } finally {
      clearWorkspaceContractsCache();
    }
  });
}

// Body of the dynamic-action activation cycle. Must only ever run under
// dynamicExtensionActionQueue (see runDynamicExtensionAction above): it is the
// exclusive owner of the process-global active extension registries while it runs.
async function runDynamicExtensionActionExclusively(
  action: string,
  args: Record<string, unknown>,
  options: Record<string, unknown>,
  global: GlobalOptions,
  pmRoot: string,
): Promise<unknown> {
  const settings = await readSettings(pmRoot);
  const loadResult = await loadExtensions({
    pmRoot,
    settings,
    cwd: process.cwd(),
    noExtensions: false,
  });
  // This MCP server reloads + reactivates extensions per native-action request,
  // so each request is a fresh activation cycle. Run the extension teardown
  // lifecycle in a finally to release any resources opened during activate(),
  // matching the long-running-server reload contract (pm-k1e4).
  let activationResult: Awaited<ReturnType<typeof activateExtensions>> | undefined;
  try {
    activationResult = await activateExtensions({
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
  } finally {
    // Reset the process-global active registries FIRST so a torn-down extension's
    // overrides/hooks cannot leak into a later request in this long-running server
    // (e.g. a subsequent pm_list/pm_create) even if teardown below misbehaves.
    setActiveExtensionHooks(createEmptyExtensionHookRegistry());
    setActiveExtensionCommands(createEmptyExtensionCommandRegistry());
    setActiveExtensionParsers(createEmptyExtensionParserRegistry());
    setActiveExtensionPreflight(createEmptyExtensionPreflightRegistry());
    setActiveExtensionServices(createEmptyExtensionServiceRegistry());
    setActiveExtensionRenderers(createEmptyExtensionRendererRegistry());
    setActiveExtensionRegistrations(createEmptyExtensionRegistrationRegistry());
    // Best-effort teardown of extensions that activated successfully. Skip
    // entirely if activation itself never produced a result (nothing was set
    // up), and guard so an unexpected throw cannot escape the finally.
    if (activationResult) {
      await deactivateExtensions(loadResult, activationResult).catch(() => undefined);
    }
  }
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
function withMutationCompaction(args: Record<string, unknown>, options?: Record<string, unknown> | null): {
  changedFields: "full" | "compact";
  idOnly: boolean;
  runnerOptions: Record<string, unknown>;
} {
  return { changedFields: args.fullChangedFields === true ? "full" : "compact", idOnly: args.idOnly === true, runnerOptions: { ...(options ?? {}) } };
}

function mutationListOptions(options: Record<string, unknown>): ListOptions {
  return {
    type: readScalarString(options, "filterType"),
    tag: readScalarString(options, "filterTag"),
    priority: readScalarString(options, "filterPriority"),
    deadlineBefore: readScalarString(options, "filterDeadlineBefore"),
    deadlineAfter: readScalarString(options, "filterDeadlineAfter"),
    updatedAfter: readScalarString(options, "filterUpdatedAfter"),
    updatedBefore: readScalarString(options, "filterUpdatedBefore"),
    createdAfter: readScalarString(options, "filterCreatedAfter"),
    createdBefore: readScalarString(options, "filterCreatedBefore"),
    ids: readScalarStringAllowBlank(options, "ids"),
    assignee: readScalarString(options, "filterAssignee"),
    assigneeFilter: readScalarString(options, "filterAssigneeFilter") ?? readScalarString(options, "filterAssignee_filter"),
    parent: readScalarString(options, "filterParent"),
    sprint: readScalarString(options, "filterSprint"),
    release: readScalarString(options, "filterRelease"),
    limit: readScalarString(options, "limit"),
    offset: readScalarString(options, "offset"),
  };
}

function closeManyOptionsFromFlat(options: Record<string, unknown>): CloseManyCommandOptions {
  return {
    status: readString(options, "filterStatus"),
    list: isRecord(options.list) ? normalizeListOptions(options.list) : mutationListOptions(options),
    reason: readString(options, "reason"),
    resolution: readString(options, "resolution"),
    expectedResult: readString(options, "expectedResult") ?? readString(options, "expected_result") ?? readString(options, "expected"),
    actualResult: readString(options, "actualResult") ?? readString(options, "actual_result") ?? readString(options, "actual"),
    validateClose: readString(options, "validateClose") ?? readString(options, "validate_close"),
    author: readString(options, "author"),
    message: readString(options, "message"),
    force: options.force === true ? true : undefined,
    dryRun: options.dryRun === true || options.dry_run === true ? true : undefined,
    rollback: readString(options, "rollback"),
    checkpoint: options.checkpoint === false || options.noCheckpoint === true || options.no_checkpoint === true ? false : undefined,
  };
}

const UPDATE_MANY_FLAT_CONTROL_KEYS = new Set([
  "filterStatus",
  "filterType",
  "filterTag",
  "filterPriority",
  "filterDeadlineBefore",
  "filterDeadlineAfter",
  "filterUpdatedAfter",
  "filterUpdatedBefore",
  "filterCreatedAfter",
  "filterCreatedBefore",
  "filterAssignee",
  "filterAssigneeFilter",
  "filterAssignee_filter",
  "filterParent",
  "filterSprint",
  "filterRelease",
  "ids",
  "list",
  "update",
  "limit",
  "offset",
  "dryRun",
  "dry_run",
  "rollback",
  "checkpoint",
  "noCheckpoint",
  "no_checkpoint",
]);

function updateManyUpdateOptionsFromFlat(options: Record<string, unknown>): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (UPDATE_MANY_FLAT_CONTROL_KEYS.has(key)) {
      continue;
    }
    update[key] = value;
  }
  return normalizeMcpUpdateOptions(update);
}

function normalizeMcpUpdateOptions(options: Record<string, unknown>): Record<string, unknown> {
  const normalizedInput: Record<string, unknown> = normalizeMcpOptionsArrays(options, "update-many");
  for (const contract of UPDATE_COMMANDER_STRING_OPTION_CONTRACTS) {
    for (const key of contract.keys) {
      const value = normalizedInput[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        normalizedInput[key] = String(value);
      }
    }
  }
  return normalizeUpdateOptions(normalizedInput);
}

function updateManyOptionsFromFlat(options: Record<string, unknown>): UpdateManyCommandOptions {
  if (isRecord(options.list) || isRecord(options.update)) {
    const updateSource = isRecord(options.update) ? options.update : updateManyUpdateOptionsFromFlat(options);
    return {
      status: readScalarString(options, "filterStatus"),
      list: isRecord(options.list) ? normalizeListOptions(options.list) : mutationListOptions(options),
      update: normalizeMcpUpdateOptions(updateSource) as never,
      dryRun: options.dryRun === true || options.dry_run === true ? true : undefined,
      rollback: readString(options, "rollback"),
      checkpoint: options.checkpoint === false || options.noCheckpoint === true || options.no_checkpoint === true ? false : undefined,
    };
  }
  return {
    status: readScalarString(options, "filterStatus"),
    list: mutationListOptions(options),
    update: updateManyUpdateOptionsFromFlat(options) as never,
    dryRun: options.dryRun === true || options.dry_run === true ? true : undefined,
    rollback: readString(options, "rollback"),
    checkpoint: options.checkpoint === false || options.noCheckpoint === true || options.no_checkpoint === true ? false : undefined,
  };
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
      // pm-rmjy: echo the applied filters + resolved projection mode so agents
      // get structured confirmation of what the server actually ran.
      return withQuerySummary(
        (await runList(readString(args, "status"), listOptions as never, global)) as unknown as Record<string, unknown>,
        listOptions,
      );
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
      // pm-rmjy: echo the applied filters + resolved projection mode (see list).
      return withQuerySummary(
        (await runSearch(readRequiredString(args, "query"), searchOptions, global)) as unknown as Record<string, unknown>,
        searchOptions as Record<string, unknown>,
      );
    }
    case "create": {
      const { changedFields, idOnly, runnerOptions } = withMutationCompaction(args, options);
      return projectMutationResult(await runCreate(runnerOptions as never, global), { changedFields, idOnly });
    }
    case "copy": {
      const { changedFields, idOnly, runnerOptions } = withMutationCompaction(args, options);
      const copyOptions: Record<string, unknown> = {
        ...runnerOptions,
        ...(runnerOptions.title === undefined && typeof args.title === "string" ? { title: args.title } : {}),
        ...(runnerOptions.message === undefined && typeof args.message === "string" ? { message: args.message } : {}),
        ...(runnerOptions.author === undefined && typeof args.author === "string" ? { author: args.author } : {}),
      };
      return projectMutationResult(
        await runCopy(
          id ?? readRequiredString(copyOptions, "id"),
          copyOptions as never,
          global,
        ),
        { changedFields, idOnly },
      );
    }
    case "update": {
      const { changedFields, idOnly, runnerOptions } = withMutationCompaction(args, options);
      return projectMutationResult(
        await runUpdate(id ?? readRequiredString(runnerOptions, "id"), runnerOptions as never, global),
        { changedFields, idOnly },
      );
    }
    case "claim":
      return runClaim(id ?? readRequiredString(options, "id"), force, global, options);
    case "release":
      return runRelease(id ?? readRequiredString(options, "id"), force, global, options);
    case "close": {
      const { changedFields, idOnly, runnerOptions } = withMutationCompaction(args, options);
      const closeReason =
        readString(args, "reason") ??
        readString(args, "text") ??
        readString(runnerOptions, "reason") ??
        readString(runnerOptions, "text");
      return projectMutationResult(
        await runClose(
          id ?? readRequiredString(runnerOptions, "id"),
          closeReason,
          runnerOptions as never,
          global,
        ),
        { changedFields, idOnly },
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
    case "telemetry":
      return runTelemetry(
        {
          subcommand: readString(args, "subcommand") ?? readString(options, "subcommand"),
          limit:
            typeof args.limit === "number" && Number.isFinite(args.limit)
              ? args.limit
              : typeof options.limit === "number" && Number.isFinite(options.limit)
                ? options.limit
              : readString(args, "limit") ?? readString(options, "limit"),
        },
        global,
      );
    case "validate":
      return runValidate(options, global);
    case "health": {
      // Default to the compact `summary` projection for agents (ok + per-check
      // status + warning samples; ~22x smaller than the full payload). Callers
      // opt into detail with brief/summary/full or the deep remediation payload
      // via full=true. Mirrors the compact-by-default list/search behavior (F2).
      const healthOptions: Record<string, unknown> = { ...options };
      if (
        healthOptions.brief === undefined &&
        healthOptions.summary === undefined &&
        healthOptions.full === undefined
      ) {
        healthOptions.summary = true;
      }
      return runHealth(global, healthOptions as never);
    }
    case "contracts":
      return runContracts(options, global);
    case "config": {
      // pm-v68d: the narrow pm_config tool declares configAction top-level;
      // options.configAction/options.action remain accepted for pm_run parity.
      const configAction =
        readString(args, "configAction") ?? readString(options, "configAction") ?? readString(options, "action");
      if (configAction === undefined) {
        throw new PmCliError("Missing required argument: configAction", 64);
      }
      return runConfig(
        readString(args, "scope") ?? readString(options, "scope") ?? "project",
        configAction,
        readString(args, "key") ?? readString(options, "key"),
        options,
        global,
        readString(args, "value") ?? readString(options, "value"),
      );
    }
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
    case "history-compact":
      return runHistoryCompact(id ?? readRequiredString(options, "id"), options, global);
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
      const normalizedSubcommand = subcommand.trim().toLowerCase();
      const schemaName = readString(args, "name") ?? readString(options, "name");
      const schemaAuthor = readString(args, "author") ?? readString(options, "author");
      const schemaForce = args.force === true || options.force === true;
      if (normalizedSubcommand === "list") {
        return runSchemaList(global);
      }
      if (normalizedSubcommand === "show") {
        return runSchemaShow(schemaName, global);
      }
      if (normalizedSubcommand === "show-status") {
        return runSchemaShowStatus(schemaName, global);
      }
      if (normalizedSubcommand === "remove-type") {
        return runSchemaRemoveType(schemaName, { author: schemaAuthor, force: schemaForce }, global);
      }
      const aliasSource = args.alias ?? options.alias;
      const aliases = aliasSource === undefined ? undefined : readStringArray(aliasSource);
      if (normalizedSubcommand === "add-status") {
        const roleSource = args.role ?? options.role;
        const roles = roleSource === undefined ? undefined : readStringArray(roleSource);
        const orderSource = args.order ?? options.order;
        let order: number | undefined;
        if (typeof orderSource === "number") {
          if (!Number.isInteger(orderSource)) {
            throw new PmCliError("schema add-status order must be a finite integer.", 64);
          }
          order = orderSource;
        } else if (typeof orderSource === "string" && orderSource.trim().length > 0) {
          const parsed = Number(orderSource);
          if (!Number.isInteger(parsed)) {
            throw new PmCliError("schema add-status order must be a finite integer.", 64);
          }
          order = parsed;
        }
        return runSchemaAddStatus(
          schemaName,
          {
            role: roles,
            alias: aliases,
            description: readString(args, "description") ?? readString(options, "description"),
            order,
            author: schemaAuthor,
            force: schemaForce,
          },
          global,
        );
      }
      if (normalizedSubcommand === "remove-status") {
        return runSchemaRemoveStatus(schemaName, { author: schemaAuthor, force: schemaForce }, global);
      }
      if (normalizedSubcommand !== "add-type") {
        throw new PmCliError(
          `Unknown pm schema subcommand "${subcommand}". Allowed: add-type, remove-type, add-status, remove-status, list, show, show-status`,
          64,
        );
      }
      return runSchemaAddType(
        schemaName,
        {
          description: readString(args, "description") ?? readString(options, "description"),
          defaultStatus:
            readString(args, "defaultStatus") ??
            readString(args, "default_status") ??
            readString(options, "defaultStatus") ??
            readString(options, "default_status"),
          folder: readString(args, "folder") ?? readString(options, "folder"),
          alias: aliases,
          author: schemaAuthor,
          force: schemaForce,
        },
        global,
      );
    }
    case "stats":
      return runStats(global, { storage: options.storage === true });
    case "append": {
      const { changedFields, runnerOptions } = withMutationCompaction(args, options);
      return projectMutationResult(
        await runAppend(id ?? readRequiredString(runnerOptions, "id"), runnerOptions as never, global),
        { changedFields },
      );
    }
    case "update-many": {
      const { changedFields, runnerOptions } = withMutationCompaction(args, options);
      return projectMutationResult(await runUpdateMany(updateManyOptionsFromFlat(runnerOptions), global), { changedFields });
    }
    case "close-many": {
      const { changedFields, runnerOptions } = withMutationCompaction(args, options);
      const topLevelReason = readString(args, "reason");
      const closeManyRunnerOptions: Record<string, unknown> =
        topLevelReason !== undefined && runnerOptions.reason === undefined
          ? { ...runnerOptions, reason: topLevelReason }
          : { ...runnerOptions };
      if (force && closeManyRunnerOptions.force === undefined) {
        closeManyRunnerOptions.force = true;
      }
      return projectMutationResult(await runCloseMany(closeManyOptionsFromFlat(closeManyRunnerOptions), global), { changedFields });
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
  pm_copy: (args) => runAction({ ...args, action: "copy" }),
  pm_update: (args) => runAction({ ...args, action: "update" }),
  pm_append: (args) => runAction({ ...args, action: "append" }),
  pm_claim: (args) => runAction({ ...args, action: "claim" }),
  pm_release: (args) => runAction({ ...args, action: "release" }),
  pm_close: (args) => runAction({ ...args, action: "close" }),
  pm_comments: (args) => runAction({ ...args, action: "comments" }),
  pm_files: (args) => runAction({ ...args, action: "files" }),
  pm_docs: (args) => runAction({ ...args, action: "docs" }),
  pm_notes: (args) => runAction({ ...args, action: "notes" }),
  pm_learnings: (args) => runAction({ ...args, action: "learnings" }),
  pm_deps: (args) => runAction({ ...args, action: "deps" }),
  pm_test: (args) => runAction({ ...args, action: "test" }),
  pm_validate: (args) => runAction({ ...args, action: "validate" }),
  pm_health: (args) => runAction({ ...args, action: "health" }),
  pm_contracts: (args) => runAction({ ...args, action: "contracts" }),
  pm_schema: (args) => runAction({ ...args, action: "schema" }),
  pm_config: (args) => runAction({ ...args, action: "config" }),
  pm_plan: (args) => runAction({ ...args, action: "plan" }),
};

function resultContent(result: unknown, warnings?: string[]): Record<string, unknown> {
  // pm-qxwu: warnings is additive — existing fields (content, structuredContent.result)
  // are never removed or renamed. The warnings array only appears when non-empty.
  const structuredContent: Record<string, unknown> =
    warnings !== undefined && warnings.length > 0 ? { result, warnings } : { result };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent,
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
    // Keep `result` present on the error envelope so consumers can read
    // `structuredContent.result` uniformly across success and failure (pm-l40h).
    structuredContent: { result: null, error: message, code },
  };
}

export async function handleRequest(request: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
  if (!request.id && request.method?.startsWith("notifications/")) {
    return undefined;
  }
  if (request.method === "ping") {
    return {};
  }
  if (request.method === "initialize") {
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "pm-mcp", version: PM_MCP_SERVER_VERSION },
      instructions:
        "You have access to native pm CLI tools for git-based project management. " +
        "Use pm_context or pm_search before creating new work. " +
        "Prefer narrow tools (pm_context, pm_list, pm_get, pm_search, pm_create, pm_copy, pm_update, pm_append, pm_claim, pm_release, pm_close, pm_comments, pm_files, pm_docs, pm_notes, pm_learnings, pm_deps, pm_test, pm_validate, pm_health, pm_contracts, pm_schema, pm_config, pm_plan) over pm_run when they cover the operation. " +
        "Use pm_plan for agent harness Plan workflows: it provides Codex/Claude/Cursor-style planning with durable steps, dependencies, decisions, discoveries, validation, and materialization. " +
        "Use pm_schema and pm_config for workspace configuration: pm_schema manages custom item types/statuses and pm_config reads or writes settings keys. " +
        "Use pm_run with an explicit action for package-owned operations (calendar/templates/guide/dedupe-audit/normalize/reindex/comments-audit/completion/test-runs-list/test-runs-status/test-runs-logs/test-runs-stop/test-runs-resume), plus activity, aggregate, history, stats, test-all, and gc. " +
        "Use history-redact for audited history-stream redaction workflows, history-repair to re-anchor a drifted history chain, and history-compact to checkpoint/prune long history streams while preserving replay integrity. " +
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
    // pm-ydkl: defensive HTML-entity decode for free-text fields. Claude / the
    // Anthropic MCP SDK HTML-encodes `<` / `>` (and friends) in tool arguments
    // before they reach pm-cli, which would otherwise leak `&lt;type&gt;` into
    // stored pm comments / notes / item bodies. Direct CLI calls are not
    // affected; decoding at the MCP boundary normalizes the agent path while
    // leaving normal text untouched.
    const args = decodeHtmlEntitiesInOptions(asRecordClone(params.arguments));
    // pm-qxwu: non-breaking detection of typo'd / unexpected top-level keys.
    // additionalProperties stays true so passthrough still works; we only warn.
    const warnings = detectUnexpectedTopLevelKeys(name, args);
    for (const warning of warnings) {
      console.error(`[pm-mcp] ${warning}`);
    }
    const result = await withCwd(args.cwd, () => handler(args));
    return resultContent(result, warnings);
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

// pm-3puw: parse one JSON-RPC line, dispatch it, and write the response. Kept
// as a standalone async unit so the stdio loop can enqueue it onto a serial
// queue (process lines in arrival order) and tests can drive it directly.
export async function processRpcLine(line: string): Promise<void> {
  if (line.trim().length === 0) {
    return;
  }
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeError(null, new PmCliError(`Parse error: ${message}`, -32700));
    return;
  }
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    writeError(null, new PmCliError("Invalid JSON-RPC request: expected an object", -32600));
    return;
  }
  const shouldRespond = Object.prototype.hasOwnProperty.call(request, "id");
  try {
    const result = await handleRequest(request);
    if (shouldRespond && result !== undefined) {
      writeResponse(request.id, result);
    }
  } catch (error) {
    if (!shouldRespond) {
      return;
    }
    if (request.method === "tools/call") {
      writeResponse(request.id, errorContent(error));
    } else {
      writeError(request.id, error);
    }
  }
}

export function startMcpServer(): void {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // pm-3puw: serialize line handling so pipelined requests are processed in
  // arrival order. The previous fire-and-forget handler ran requests
  // concurrently, so a client that pipelined two mutations on the same item
  // (without awaiting the first response) hit a lock conflict on the second.
  const queue = createSerialQueue();
  rl.on("line", (line) => {
    void queue.enqueue(() => processRpcLine(line));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startMcpServer();
}
