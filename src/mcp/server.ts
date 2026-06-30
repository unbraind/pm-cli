#!/usr/bin/env node
/**
 * @module mcp/server
 *
 * Runs the MCP server adapter that exposes pm actions and contracts to external agents.
 */
import { realpathSync } from "node:fs";
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
  runFocus,
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
  runHistoryRepairAll,
  assertHistoryRepairTarget,
  runInit,
  runLearnings,
  runList,
  runNext,
  runNotes,
  runPlan,
  runRelease,
  runSchemaAddStatus,
  runSchemaAddType,
  runSchemaAddField,
  runSchemaApplyPreset,
  runSchemaInferTypes,
  runSchemaList,
  runSchemaListFields,
  runSchemaRemoveStatus,
  runSchemaRemoveType,
  runSchemaRemoveField,
  runSchemaShow,
  runSchemaShowField,
  runSchemaShowStatus,
  runProfileApply,
  runProfileLint,
  runProfileList,
  runProfileShow,
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
    noExtensions: args.noExtensions === true || args.no_extensions === true,
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

// GH-170 (pm-pfnx): the narrow pm_files/pm_docs tools spell the CLI --note flag
// as `addNote` (the shared `note` parameter is the array-typed create/update
// note seed). Translate it onto the runner's `note` option; an explicit
// options.note (pm_run callers) wins.
function withAddNoteOption(options: Record<string, unknown>): Record<string, unknown> {
  if (options.addNote === undefined) {
    return options;
  }
  const next: Record<string, unknown> = { ...options };
  if (next.note === undefined && typeof next.addNote === "string") {
    next.note = next.addNote;
  }
  delete next.addNote;
  return next;
}

function withFilesDiscoveryOptions(options: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...options };
  if (next.discoveryNote !== undefined && next.note === undefined && typeof next.discoveryNote === "string") {
    next.note = next.discoveryNote;
  }
  delete next.discover;
  delete next.discoveryNote;
  return next;
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

// pm-bl6m / pm-zumn: every native MCP action runs inside an activation cycle that
// mutates the process-global active extension registries (set globals -> run -> clear
// globals in a finally). The stdio transport already processes JSON-RPC lines
// sequentially, but handleRequest is a public entry point (tests, future concurrent
// transports) — if two requests ever ran concurrently, the newer one would overwrite
// the globals mid-flight and whichever finished first would clear them out from under
// the other (its lazily-read hooks/overrides would silently vanish). Serialize the
// whole activation cycle (load -> activate -> set -> run -> clear -> deactivate) on a
// dedicated FIFO queue so the critical section can never interleave. Full
// request-scoped registry plumbing remains possible later if true intra-server
// concurrency is ever needed.
const extensionActivationQueue = createSerialQueue();

type ExtensionActivationResult = Awaited<ReturnType<typeof activateExtensions>>;

/**
 * The active extension runtime exposed to an action while it executes: the merged
 * registration registry (custom item types, fields, profiles) plus the command handler
 * registry used to dispatch extension-contributed actions. `null` when extensions are
 * disabled, no workspace exists yet, or activation failed (see {@link withActiveExtensions}).
 */
type ActiveExtensionRuntime = {
  registrations: ExtensionActivationResult["registrations"];
  commands: ExtensionActivationResult["commands"];
  pmRoot: string;
};

/**
 * Publishes empty active extension registries so built-in fallback actions cannot
 * observe stale or partially published extension state from a failed activation cycle.
 */
function resetActiveExtensionRegistries(): void {
  setActiveExtensionHooks(createEmptyExtensionHookRegistry());
  setActiveExtensionCommands(createEmptyExtensionCommandRegistry());
  setActiveExtensionParsers(createEmptyExtensionParserRegistry());
  setActiveExtensionPreflight(createEmptyExtensionPreflightRegistry());
  setActiveExtensionServices(createEmptyExtensionServiceRegistry());
  setActiveExtensionRenderers(createEmptyExtensionRendererRegistry());
  setActiveExtensionRegistrations(createEmptyExtensionRegistrationRegistry());
}

/**
 * Run `run` with workspace extensions loaded, activated, and published to the
 * process-global active registries, then torn down afterwards. pm-zumn: built-in native
 * actions (pm_list/pm_profile/pm_schema/pm_create/...) read
 * `getActiveExtensionRegistrations()` for custom item types, fields, and profiles, so
 * they must activate extensions exactly like the CLI (main.ts activates for every
 * command). Previously only the dynamic-extension dispatch activated, leaving
 * extension-contributed schema and profiles invisible over MCP for every built-in
 * action. Activation is skipped (`run` receives `null`) when extensions are disabled or
 * no workspace exists yet (for example `init`). EVERY action — activating or not — is
 * serialized on {@link extensionActivationQueue} so a built-in action's reads of the
 * process-global active registries can never interleave with another request's
 * activation cycle; per-request isolation therefore holds even if a truly concurrent
 * transport is added later (not just because the stdio transport is sequential today).
 */
async function withActiveExtensions<T>(
  global: GlobalOptions,
  explicitCwd: string | undefined,
  resolutionCwd: string,
  run: (active: ActiveExtensionRuntime | null) => Promise<T>,
): Promise<T> {
  // Run the whole cycle on the queue so registry mutations never interleave. Only an
  // EXPLICIT cwd mutates process.cwd() — pinned inside this serialized slot so the chdir
  // can't be clobbered mid-flight and the built-in handler resolves against it too. A
  // request without an explicit cwd runs in the server's current directory and never
  // touches process.cwd() (important so concurrent direct callers can't corrupt a shared
  // cwd). Either way activation resolves against resolutionCwd, the entry-time snapshot,
  // so it never depends on a deferred process.cwd() read.
  return extensionActivationQueue.enqueue(async () => {
    try {
      return explicitCwd === undefined
        ? await withActiveExtensionsExclusively(global, resolutionCwd, run)
        : await withCwd(explicitCwd, () => withActiveExtensionsExclusively(global, resolutionCwd, run));
    } finally {
      clearWorkspaceContractsCache();
    }
  });
}

/**
 * Body of the activation cycle. Must only ever run under {@link extensionActivationQueue}
 * (see {@link withActiveExtensions}): it is the exclusive owner of the process-global
 * active extension registries while it runs. Returns early with `run(null)` — still
 * inside the serialized critical section — when extensions are disabled or no workspace
 * exists yet, so those built-in actions also observe a stable (empty) registry. This MCP
 * server reloads + reactivates extensions per request, so each call is a fresh cycle with
 * teardown in a finally to release resources opened during activate() (the
 * long-running-server reload contract, pm-k1e4). Load/activate failures are swallowed and
 * `run` is invoked with `null`, mirroring the CLI's resilient snapshot loader
 * (loadRuntimeExtensionSnapshot) so a broken extension can never break a built-in action.
 */
async function withActiveExtensionsExclusively<T>(
  global: GlobalOptions,
  cwd: string,
  run: (active: ActiveExtensionRuntime | null) => Promise<T>,
): Promise<T> {
  if (global.noExtensions) {
    return run(null);
  }
  const pmRoot = resolvePmRoot(cwd, global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return run(null);
  }
  let active: ActiveExtensionRuntime | null = null;
  let activated: { loadResult: Awaited<ReturnType<typeof loadExtensions>>; activationResult: ExtensionActivationResult } | undefined;
  try {
    const settings = await readSettings(pmRoot);
    const loadResult = await loadExtensions({ pmRoot, settings, cwd, noExtensions: false });
    const activationResult = await activateExtensions({ ...loadResult, loaded: loadResult.loaded });
    // Record the teardown handle BEFORE publishing the registries so a throw from any
    // setActive* setter still runs deactivateExtensions for resources opened during
    // activate() instead of silently leaking them.
    activated = { loadResult, activationResult };
    setActiveExtensionHooks(activationResult.hooks);
    setActiveExtensionCommands(activationResult.commands);
    setActiveExtensionParsers(activationResult.parsers);
    setActiveExtensionPreflight(activationResult.preflight);
    setActiveExtensionServices(activationResult.services);
    setActiveExtensionRenderers(activationResult.renderers);
    setActiveExtensionRegistrations(activationResult.registrations);
    active = { registrations: activationResult.registrations, commands: activationResult.commands, pmRoot };
  } catch (error) {
    resetActiveExtensionRegistries();
    // CLI parity (loadRuntimeExtensionSnapshot): a load/activate failure must never
    // break a built-in action — fall back to running with no active extensions. Surface
    // the cause on stderr so a broken extension is diagnosable instead of being silently
    // indistinguishable from a workspace that simply has no extensions.
    console.error("[pm-mcp] extension activation failed; continuing without active extensions:", error);
    active = null;
  }
  try {
    return await run(active);
  } finally {
    // Reset the process-global active registries FIRST so a torn-down extension's
    // overrides/hooks cannot leak into a later request in this long-running server
    // (for example a subsequent pm_list/pm_create) even if teardown below misbehaves.
    resetActiveExtensionRegistries();
    // Best-effort teardown of extensions that activated successfully. Skipped when
    // activation never completed (nothing was set up); guarded so an unexpected throw
    // cannot escape the finally.
    if (activated) {
      await deactivateExtensions(activated.loadResult, activated.activationResult).catch(() => undefined);
    }
  }
}

/**
 * Resolve `action` against the active extension command registrations and dispatch it.
 * Reached by runAction's default case for dynamic (non-built-in) actions after
 * {@link withActiveExtensions} has published the active registries. `active` is `null`
 * when no extensions are active (disabled, no workspace, or activation failed), in
 * which case no extension command can match and the action is reported unsupported.
 */
async function dispatchActiveExtensionAction(
  action: string,
  args: Record<string, unknown>,
  options: Record<string, unknown>,
  global: GlobalOptions,
  active: ActiveExtensionRuntime | null,
): Promise<unknown> {
  if (!active) {
    throw new PmCliError(`Unsupported native pm action: ${action}`, 64);
  }
  const normalizedAction = normalizeActionName(action);
  const definition = active.registrations.commands.find((entry) => normalizeActionName(entry.action) === normalizedAction);
  const command = definition?.command ??
    active.commands.handlers.find((entry) => normalizeActionName(entry.command) === normalizedAction)?.command;
  if (!command) {
    throw new PmCliError(`Unsupported native pm action: ${action}`, 64);
  }
  const handlerResult = await runActiveCommandHandler({
    command: normalizeCommandPath(command),
    args: readStringArray(options.args ?? args.args),
    options: extensionOptionsFromArgs(args, options),
    global,
    pm_root: active.pmRoot,
  });
  if (!handlerResult.handled) {
    const suffix = handlerResult.warnings.length > 0 ? ` (${handlerResult.warnings.join(", ")})` : "";
    throw new PmCliError(`Unsupported native pm action: ${action}${suffix}`, 64);
  }
  return handlerResult.result;
}

async function withCwd<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  // Only ever called with an explicit, non-empty cwd (readString filters blanks), from
  // inside the serialized activation queue, so the chdir/restore is exclusive per request
  // and can never be clobbered by a concurrent caller.
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
  return { changedFields: args.fullChangedFields === true ? "full" : "compact", idOnly: args.idOnly === true, runnerOptions: { ...options } };
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
  // pm-zumn: dispatch every action (built-in and dynamic) inside one extension
  // activation cycle so built-in actions see extension-contributed item types, fields,
  // and profiles, consistent with the CLI. Snapshot the effective resolution cwd HERE,
  // at request entry (the explicit args.cwd, else the server's current directory), so the
  // queued cycle resolves against the directory the request arrived in rather than a value
  // process.cwd() might hold by the time the task runs. Only an explicit cwd additionally
  // pins process.cwd() (inside the serialized slot) for the built-in handler.
  const explicitCwd = readString(args, "cwd");
  const resolutionCwd = explicitCwd ?? process.cwd();
  return withActiveExtensions(global, explicitCwd, resolutionCwd, (activeExtensions) => dispatchAction(action, args, global, activeExtensions));
}

interface McpActionDispatchContext {
  action: string;
  args: Record<string, unknown>;
  options: Record<string, unknown>;
  id: string | undefined;
  force: boolean;
  global: GlobalOptions;
  activeExtensions: ActiveExtensionRuntime | null;
}

type McpActionHandler = (ctx: McpActionDispatchContext) => Promise<unknown> | unknown;

function getOwnHandler<T>(handlers: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(handlers, key) ? handlers[key] : undefined;
}

function readMcpTarget(ctx: McpActionDispatchContext): string | undefined {
  return readString(ctx.args, "target") ?? readString(ctx.options, "target");
}

function requireMcpItemId(ctx: McpActionDispatchContext, source: Record<string, unknown> = ctx.options): string {
  return ctx.id ?? readRequiredString(source, "id");
}

async function runMcpListAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const listOptions: Record<string, unknown> = { ...ctx.options };
  if (
    listOptions.compact === undefined &&
    listOptions.brief === undefined &&
    listOptions.fields === undefined &&
    listOptions.includeBody === undefined
  ) {
    listOptions.compact = true;
  }
  // pm-rmjy: echo applied filters + projection mode so agents get structured confirmation.
  return withQuerySummary(
    (await runList(readString(ctx.args, "status"), listOptions as never, ctx.global)) as unknown as Record<string, unknown>,
    listOptions,
  );
}

async function runMcpSearchAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const searchOptions: Parameters<typeof runSearch>[1] = { ...ctx.options };
  if (searchOptions.compact === undefined && searchOptions.full === undefined && searchOptions.fields === undefined) {
    searchOptions.compact = true;
  }
  return withQuerySummary(
    (await runSearch(readRequiredString(ctx.args, "query"), searchOptions, ctx.global)) as unknown as Record<string, unknown>,
    searchOptions as Record<string, unknown>,
  );
}

async function runMcpCreateAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(ctx.args, ctx.options);
  return projectMutationResult(await runCreate(runnerOptions as never, ctx.global), { changedFields, idOnly });
}

async function runMcpCopyAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(ctx.args, ctx.options);
  const copyOptions: Record<string, unknown> = {
    ...runnerOptions,
    ...(runnerOptions.title === undefined && typeof ctx.args.title === "string" ? { title: ctx.args.title } : {}),
    ...(runnerOptions.message === undefined && typeof ctx.args.message === "string" ? { message: ctx.args.message } : {}),
  };
  return projectMutationResult(await runCopy(requireMcpItemId(ctx, copyOptions), copyOptions as never, ctx.global), {
    changedFields,
    idOnly,
  });
}

async function runMcpUpdateAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(ctx.args, ctx.options);
  return projectMutationResult(await runUpdate(requireMcpItemId(ctx, runnerOptions), runnerOptions as never, ctx.global), {
    changedFields,
    idOnly,
  });
}

async function runMcpCloseAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(ctx.args, ctx.options);
  const closeReason =
    readString(ctx.args, "reason") ??
    readString(ctx.args, "text") ??
    readString(runnerOptions, "reason") ??
    readString(runnerOptions, "text");
  return projectMutationResult(
    await runClose(requireMcpItemId(ctx, runnerOptions), closeReason, runnerOptions as never, ctx.global),
    { changedFields, idOnly },
  );
}

function runMcpCommentsAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const commentOptions: Record<string, unknown> = { ...ctx.options };
  const isListing =
    commentOptions.add === undefined &&
    commentOptions.stdin === undefined &&
    commentOptions.file === undefined &&
    commentOptions.edit === undefined &&
    commentOptions.delete === undefined;
  if (isListing) {
    commentOptions.includeMeta = true;
    if (commentOptions.limit === undefined && commentOptions.full !== true) {
      commentOptions.limit = "20";
    }
  }
  delete commentOptions.full;
  return runComments(requireMcpItemId(ctx), commentOptions, ctx.global);
}

function runMcpFilesAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const fileId = requireMcpItemId(ctx);
  return ctx.options.discover === true
    ? runFilesDiscover(fileId, withFilesDiscoveryOptions(ctx.options), ctx.global)
    : runFiles(fileId, withAddNoteOption(ctx.options), ctx.global);
}

function runMcpTelemetryAction(ctx: McpActionDispatchContext): Promise<unknown> {
  return runTelemetry(
    {
      subcommand: readString(ctx.args, "subcommand") ?? readString(ctx.options, "subcommand"),
      limit: resolveMcpTelemetryLimit(ctx.args, ctx.options),
    },
    ctx.global,
  );
}

function resolveMcpTelemetryLimit(args: Record<string, unknown>, options: Record<string, unknown>): number | string | undefined {
  if (typeof args.limit === "number" && Number.isFinite(args.limit)) {
    return args.limit;
  }
  if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
    return options.limit;
  }
  return readString(args, "limit") ?? readString(options, "limit");
}

function runMcpHealthAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const healthOptions: Record<string, unknown> = { ...ctx.options };
  if (healthOptions.brief === undefined && healthOptions.summary === undefined && healthOptions.full === undefined) {
    healthOptions.summary = true;
  }
  return runHealth(ctx.global, healthOptions as never);
}

function runMcpConfigAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const configAction =
    readString(ctx.args, "configAction") ?? readString(ctx.options, "configAction") ?? readString(ctx.options, "action");
  if (configAction === undefined) {
    throw new PmCliError("Missing required argument: configAction", 64);
  }
  return runConfig(
    readString(ctx.args, "scope") ?? readString(ctx.options, "scope") ?? "project",
    configAction,
    readString(ctx.args, "key") ?? readString(ctx.options, "key"),
    ctx.options,
    ctx.global,
    readString(ctx.args, "value") ?? readString(ctx.options, "value"),
  );
}

function runMcpActivityAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const activityOptions = { ...ctx.options } as Parameters<typeof runActivity>[0] & { full?: unknown };
  if (activityOptions.compact === undefined) {
    activityOptions.compact = activityOptions.full === true ? false : true;
  }
  delete activityOptions.full;
  return runActivity(activityOptions, ctx.global);
}

function runMcpHistoryRepairAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const repairAll = ctx.options.all === true;
  const repairId = ctx.id ?? readString(ctx.options, "id");
  assertHistoryRepairTarget(repairId, repairAll);
  return repairAll ? runHistoryRepairAll(ctx.options, ctx.global) : runHistoryRepair(repairId as string, ctx.options, ctx.global);
}

function parseMcpInteger(value: unknown, label: string): number | undefined {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new PmCliError(`${label} must be a finite integer.`, 64);
    }
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      throw new PmCliError(`${label} must be a finite integer.`, 64);
    }
    return parsed;
  }
  return undefined;
}

function parseMcpIntegerPrefix(value: unknown, label: string): number | undefined {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new PmCliError(`${label} must be a finite integer.`, 64);
    }
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed)) {
      throw new PmCliError(`${label} must be a finite integer.`, 64);
    }
    return parsed;
  }
  return undefined;
}

function runMcpPlanAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const subcommand = readRequiredString(ctx.options, "subcommand");
  const planRecord = ctx.options as Record<string, unknown>;
  return runPlan({
    subcommand: subcommand as never,
    id: typeof ctx.id === "string" ? ctx.id : typeof planRecord.id === "string" ? (planRecord.id as string) : undefined,
    stepRef: readMcpPlanStepRef(ctx),
    reorderTo: parseMcpIntegerPrefix(planRecord.reorderTo ?? ctx.args.reorderTo, "plan reorderTo"),
    options: ctx.options as never,
    global: ctx.global,
  });
}

function readMcpPlanStepRef(ctx: McpActionDispatchContext): string | undefined {
  return typeof ctx.options.stepRef === "string"
    ? (ctx.options.stepRef as string)
    : typeof ctx.args.stepRef === "string"
      ? (ctx.args.stepRef as string)
      : undefined;
}

interface McpSchemaContext {
  ctx: McpActionDispatchContext;
  subcommand: string;
  name: string | undefined;
  author: string | undefined;
  force: boolean;
  aliases: string[] | undefined;
}

function createMcpSchemaContext(ctx: McpActionDispatchContext): McpSchemaContext {
  const subcommand = readString(ctx.args, "subcommand") ?? readRequiredString(ctx.options, "subcommand");
  const aliasSource = ctx.args.alias ?? ctx.options.alias;
  return {
    ctx,
    subcommand: subcommand.trim().toLowerCase(),
    name: readString(ctx.args, "name") ?? readString(ctx.options, "name"),
    author: readString(ctx.args, "author") ?? readString(ctx.options, "author"),
    force: ctx.args.force === true || ctx.options.force === true,
    aliases: aliasSource === undefined ? undefined : readStringArray(aliasSource),
  };
}

function runMcpSchemaReadOrRemoveAction(schema: McpSchemaContext): Promise<unknown> | unknown | null {
  const { ctx, subcommand, name, author, force } = schema;
  const simpleHandlers: Record<string, () => Promise<unknown> | unknown> = {
    list: () => runSchemaList(ctx.global),
    show: () => runSchemaShow(name, ctx.global),
    "show-status": () => runSchemaShowStatus(name, ctx.global),
    "list-fields": () => runSchemaListFields(ctx.global),
    "show-field": () => runSchemaShowField(name, ctx.global),
    "remove-type": () => runSchemaRemoveType(name, { author, force }, ctx.global),
    "remove-field": () => runSchemaRemoveField(name, { author, force }, ctx.global),
    "remove-status": () => runSchemaRemoveStatus(name, { author, force }, ctx.global),
    "apply-preset": () =>
      runSchemaApplyPreset(readString(ctx.args, "typePreset") ?? readString(ctx.options, "typePreset"), { author, force }, ctx.global),
  };
  const handler = getOwnHandler(simpleHandlers, subcommand);
  return handler ? handler() : null;
}

function runMcpSchemaAddFieldAction(schema: McpSchemaContext): Promise<unknown> {
  const { ctx, name, author, force, aliases } = schema;
  const commandsSource = ctx.args.commands ?? ctx.options.commands;
  const requiredTypesSource = ctx.args.requiredTypes ?? ctx.options.requiredTypes;
  return runSchemaAddField(
    name,
    {
      type: readString(ctx.args, "fieldType") ?? readString(ctx.options, "fieldType"),
      commands: commandsSource === undefined ? undefined : readStringArray(commandsSource),
      description: readString(ctx.args, "description") ?? readString(ctx.options, "description"),
      cliFlag: readString(ctx.args, "cliFlag") ?? readString(ctx.options, "cliFlag"),
      alias: aliases,
      required: ctx.args.required === true || ctx.options.required === true,
      requiredOnCreate: ctx.args.requiredOnCreate === true || ctx.options.requiredOnCreate === true,
      allowUnset: !(ctx.args.allowUnset === false || ctx.options.allowUnset === false),
      requiredTypes: requiredTypesSource === undefined ? undefined : readStringArray(requiredTypesSource),
      author,
      force,
    },
    ctx.global,
  );
}

function runMcpSchemaAddStatusAction(schema: McpSchemaContext): Promise<unknown> {
  const { ctx, name, author, force, aliases } = schema;
  const roleSource = ctx.args.role ?? ctx.options.role;
  return runSchemaAddStatus(
    name,
    {
      role: roleSource === undefined ? undefined : readStringArray(roleSource),
      alias: aliases,
      description: readString(ctx.args, "description") ?? readString(ctx.options, "description"),
      order: parseMcpInteger(ctx.args.order ?? ctx.options.order, "schema add-status order"),
      author,
      force,
    },
    ctx.global,
  );
}

function runMcpSchemaAddTypeAction(schema: McpSchemaContext): Promise<unknown> {
  const { ctx, name, author, force, aliases } = schema;
  return runSchemaAddType(
    name,
    {
      description: readString(ctx.args, "description") ?? readString(ctx.options, "description"),
      defaultStatus:
        readString(ctx.args, "defaultStatus") ??
        readString(ctx.args, "default_status") ??
        readString(ctx.options, "defaultStatus") ??
        readString(ctx.options, "default_status"),
      folder: readString(ctx.args, "folder") ?? readString(ctx.options, "folder"),
      alias: aliases,
      author,
      force,
    },
    ctx.global,
  );
}

function runMcpSchemaAction(ctx: McpActionDispatchContext): Promise<unknown> | unknown {
  const schema = createMcpSchemaContext(ctx);
  const simpleResult = runMcpSchemaReadOrRemoveAction(schema);
  if (simpleResult !== null) {
    return simpleResult;
  }
  if (schema.subcommand === "add-field") {
    return runMcpSchemaAddFieldAction(schema);
  }
  if (schema.subcommand === "add-status") {
    return runMcpSchemaAddStatusAction(schema);
  }
  if (schema.subcommand === "add-type") {
    if (ctx.args.infer === true || ctx.options.infer === true) {
      return runSchemaInferTypes(
        {
          minCount: parseMcpInteger(ctx.args.minCount ?? ctx.options.minCount, "schema infer minCount"),
          apply: ctx.args.apply === true || ctx.options.apply === true,
          author: schema.author,
          force: schema.force,
        },
        ctx.global,
      );
    }
    return runMcpSchemaAddTypeAction(schema);
  }
  throw new PmCliError(
    `Unknown pm schema subcommand "${schema.subcommand}". Allowed: add-type, remove-type, add-status, remove-status, add-field, remove-field, list-fields, show-field, apply-preset, list, show, show-status`,
    64,
  );
}

function runMcpProfileAction(ctx: McpActionDispatchContext): Promise<unknown> | unknown {
  const subcommand = readString(ctx.args, "subcommand") ?? readRequiredString(ctx.options, "subcommand");
  const normalizedSubcommand = subcommand.trim().toLowerCase();
  const profileName = readString(ctx.args, "name") ?? readString(ctx.options, "name");
  const handlers: Record<string, () => Promise<unknown> | unknown> = {
    list: () => runProfileList(),
    show: () => runProfileShow(profileName),
    lint: () => runProfileLint(profileName),
    apply: () =>
      runProfileApply(
        profileName,
        {
          dryRun: ctx.args.dryRun === true || ctx.options.dryRun === true,
          author: readString(ctx.args, "author") ?? readString(ctx.options, "author"),
          force: ctx.args.force === true || ctx.options.force === true,
        },
        ctx.global,
      ),
  };
  const handler = getOwnHandler(handlers, normalizedSubcommand);
  if (!handler) {
    throw new PmCliError(`Unknown pm profile subcommand "${subcommand}". Allowed: list, show, apply, lint`, 64);
  }
  return handler();
}

function runMcpStatsAction(ctx: McpActionDispatchContext): Promise<unknown> {
  return runStats(ctx.global, {
    storage: ctx.options.storage === true,
    metadataCoverage: ctx.options.metadataCoverage === true,
    fieldUtilization: ctx.options.fieldUtilization === true,
    byAssignee: ctx.options.byAssignee === true,
    byTag: ctx.options.byTag === true,
    byPriority: ctx.options.byPriority === true,
    tagPrefix: typeof ctx.options.tagPrefix === "string" ? ctx.options.tagPrefix : undefined,
  });
}

async function runMcpAppendAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const { changedFields, runnerOptions } = withMutationCompaction(ctx.args, ctx.options);
  return projectMutationResult(await runAppend(requireMcpItemId(ctx, runnerOptions), runnerOptions as never, ctx.global), {
    changedFields,
  });
}

async function runMcpUpdateManyAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const { changedFields, runnerOptions } = withMutationCompaction(ctx.args, ctx.options);
  return projectMutationResult(await runUpdateMany(updateManyOptionsFromFlat(runnerOptions), ctx.global), { changedFields });
}

async function runMcpCloseManyAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const { changedFields, runnerOptions } = withMutationCompaction(ctx.args, ctx.options);
  const topLevelReason = readString(ctx.args, "reason");
  const closeManyRunnerOptions: Record<string, unknown> =
    topLevelReason !== undefined && runnerOptions.reason === undefined
      ? { ...runnerOptions, reason: topLevelReason }
      : { ...runnerOptions };
  if (ctx.force && closeManyRunnerOptions.force === undefined) {
    closeManyRunnerOptions.force = true;
  }
  return projectMutationResult(await runCloseMany(closeManyOptionsFromFlat(closeManyRunnerOptions), ctx.global), { changedFields });
}

const MCP_ACTION_HANDLERS: Record<string, McpActionHandler> = {
  init: (ctx) => runInit(readString(ctx.args, "prefix"), ctx.global, ctx.options),
  context: (ctx) => runContext(ctx.options, ctx.global),
  next: (ctx) => runNext(ctx.options, ctx.global),
  list: runMcpListAction,
  get: (ctx) => runGet(requireMcpItemId(ctx), ctx.global, ctx.options),
  search: runMcpSearchAction,
  create: runMcpCreateAction,
  copy: runMcpCopyAction,
  focus: (ctx) => runFocus(ctx.id, { clear: ctx.options.clear === true || ctx.args.clear === true }, ctx.global),
  update: runMcpUpdateAction,
  claim: (ctx) => runClaim(requireMcpItemId(ctx), ctx.force, ctx.global, ctx.options),
  release: (ctx) => runRelease(requireMcpItemId(ctx), ctx.force, ctx.global, ctx.options),
  close: runMcpCloseAction,
  comments: runMcpCommentsAction,
  notes: (ctx) => runNotes(requireMcpItemId(ctx), ctx.options, ctx.global),
  learnings: (ctx) => runLearnings(requireMcpItemId(ctx), ctx.options, ctx.global),
  files: runMcpFilesAction,
  docs: (ctx) => runDocs(requireMcpItemId(ctx), withAddNoteOption(ctx.options), ctx.global),
  test: (ctx) => runTest(requireMcpItemId(ctx), ctx.options, ctx.global),
  "test-all": (ctx) => runTestAll(ctx.options, ctx.global),
  telemetry: runMcpTelemetryAction,
  validate: (ctx) => runValidate(ctx.options, ctx.global),
  health: runMcpHealthAction,
  contracts: (ctx) => runContracts(ctx.options, ctx.global),
  config: runMcpConfigAction,
  activity: runMcpActivityAction,
  aggregate: (ctx) => runAggregate(ctx.options, ctx.global),
  extension: (ctx) => runExtension(readMcpTarget(ctx), ctx.options, ctx.global),
  "extension-reload": (ctx) => runExtension(undefined, { ...ctx.options, reload: true }, ctx.global),
  package: (ctx) => runExtension(readMcpTarget(ctx), ctx.options, ctx.global),
  "package-install": (ctx) => runExtension(readMcpTarget(ctx), { ...ctx.options, install: true }, ctx.global),
  install: (ctx) => runExtension(readMcpTarget(ctx), { ...ctx.options, install: true }, ctx.global),
  "package-catalog": (ctx) => runExtension(undefined, { ...ctx.options, catalog: true, vocabulary: "package" }, ctx.global),
  upgrade: (ctx) => runUpgrade(readMcpTarget(ctx), ctx.options, ctx.global),
  delete: (ctx) => runDelete(requireMcpItemId(ctx), ctx.options, ctx.global),
  deps: (ctx) => runDeps(requireMcpItemId(ctx), ctx.options, ctx.global),
  "files-discover": (ctx) => runFilesDiscover(requireMcpItemId(ctx), ctx.options, ctx.global),
  history: (ctx) => runHistory(requireMcpItemId(ctx), ctx.options, ctx.global),
  "history-redact": (ctx) => runHistoryRedact(requireMcpItemId(ctx), ctx.options, ctx.global),
  "history-repair": runMcpHistoryRepairAction,
  "history-compact": (ctx) => runHistoryCompact(requireMcpItemId(ctx), ctx.options, ctx.global),
  plan: runMcpPlanAction,
  schema: runMcpSchemaAction,
  profile: runMcpProfileAction,
  stats: runMcpStatsAction,
  append: runMcpAppendAction,
  "update-many": runMcpUpdateManyAction,
  "close-many": runMcpCloseManyAction,
  gc: (ctx) => runGc(ctx.global, ctx.options),
};

async function dispatchAction(
  action: string,
  args: Record<string, unknown>,
  global: GlobalOptions,
  activeExtensions: ActiveExtensionRuntime | null,
): Promise<unknown> {
  const options = optionsWithAuthor(args, action);
  const ctx: McpActionDispatchContext = {
    action,
    args,
    options,
    id: readString(args, "id"),
    force: args.force === true,
    global,
    activeExtensions,
  };
  const handler = getOwnHandler(MCP_ACTION_HANDLERS, action);
  return handler ? handler(ctx) : dispatchActiveExtensionAction(action, args, options, global, activeExtensions);
}

const HANDLERS: Record<string, ToolHandler> = {
  pm_run: (args) => runAction(args),
  pm_context: (args) => runAction({ ...args, action: "context" }),
  pm_next: (args) => runAction({ ...args, action: "next" }),
  pm_search: (args) => runAction({ ...args, action: "search" }),
  pm_list: (args) => runAction({ ...args, action: "list" }),
  pm_get: (args) => runAction({ ...args, action: "get" }),
  pm_create: (args) => runAction({ ...args, action: "create" }),
  pm_copy: (args) => runAction({ ...args, action: "copy" }),
  pm_focus: (args) => runAction({ ...args, action: "focus" }),
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
  pm_profile: (args) => runAction({ ...args, action: "profile" }),
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

/**
 * Implements handle request for the public runtime surface of this module.
 */
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
        "Use pm_next to pick the next actionable item, or pm_context or pm_search before creating new work. " +
        "Prefer narrow tools (pm_next, pm_context, pm_list, pm_get, pm_search, pm_create, pm_copy, pm_focus, pm_update, pm_append, pm_claim, pm_release, pm_close, pm_comments, pm_files, pm_docs, pm_notes, pm_learnings, pm_deps, pm_test, pm_validate, pm_health, pm_contracts, pm_schema, pm_profile, pm_config, pm_plan) over pm_run when they cover the operation. " +
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
    const handler = getOwnHandler(HANDLERS, name);
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
    // cwd is applied inside the serialized activation cycle (see withActiveExtensions),
    // so the chdir/restore is exclusive per request and cannot race a concurrent caller.
    const result = await handler(args);
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
/**
 * Implements process rpc line for the public runtime surface of this module.
 */
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

/**
 * Implements start mcp server for the public runtime surface of this module.
 */
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

// npm bin entries are symlinks (node_modules/.bin/pm-mcp -> dist/mcp/server.js),
// so argv[1] must be realpath-resolved before comparing against this module's
// path — a plain equality check made the published `pm-mcp` bin exit 0 without
// ever starting the server (pm-qtbc).
/**
 * Implements check whether invoked as mcp main module for the public runtime surface of this module.
 */
export function isInvokedAsMcpMainModule(argvPath: string | undefined, moduleUrl: string): boolean {
  if (!argvPath) {
    return false;
  }
  const selfPath = fileURLToPath(moduleUrl);
  if (argvPath === selfPath) {
    return true;
  }
  try {
    return realpathSync(argvPath) === realpathSync(selfPath);
  } catch {
    return false;
  }
}

export const _testOnly = {
  closeManyOptionsFromFlat,
  detectUnexpectedTopLevelKeys,
  errorContent,
  extensionOptionsFromArgs,
  globalOptions,
  mutationListOptions,
  nearestDeclaredKey,
  normalizeActionName,
  normalizeCommandPath,
  normalizeMcpUpdateOptions,
  normalizeMcpOptionsArrays,
  optionsWithAuthor,
  readRequiredString,
  readScalarString,
  readScalarStringAllowBlank,
  readStringArray,
  runAction,
  updateManyOptionsFromFlat,
  withAddNoteOption,
  withFilesDiscoveryOptions,
  withMutationCompaction,
  writeError,
};

/* c8 ignore start */
if (isInvokedAsMcpMainModule(process.argv[1], import.meta.url)) {
  startMcpServer();
}
/* c8 ignore stop */
