/**
 * @module sdk/runtime
 *
 * Defines public SDK APIs and package-author helpers for Runtime.
 */
import path from "node:path";
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
  type ExtensionRegistrationRegistry,
} from "../core/extensions/index.js";
import { pathExists } from "../core/fs/fs-utils.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import { projectMutationResult } from "../core/output/mutation-projection.js";
import { withQuerySummary } from "../core/output/query-summary.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { asRecordClone } from "../core/shared/primitives.js";
import { createSerialQueue } from "../core/shared/serial-queue.js";
import { resolveRuntimeStatusRegistry } from "../core/schema/runtime-schema.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import { normalizeListOptions, normalizeUpdateOptions } from "../cli/registration-helpers.js";
import { UPDATE_COMMANDER_STRING_OPTION_CONTRACTS } from "./cli-contracts/commander-mutation-options.js";
import type { PmToolAction } from "./cli-contracts/enum-contracts.js";
import {
  clearWorkspaceContractsCache,
  memoizeWorkspaceExtensionRegistrations,
} from "./workspace-contracts-cache.js";
export { clearWorkspaceContractsCache } from "./workspace-contracts-cache.js";
import {
  type AggregateOptions,
  type AggregateResult,
  assertHistoryRepairTarget,
  runActivity,
  runAggregate,
  runAppend,
  runClaim,
  runClose,
  runCloseMany,
  runComments,
  runConfig,
  runContext,
  runCopy,
  runCreate,
  runDelete,
  runDeps,
  runDocs,
  runExtension,
  runFiles,
  runFilesDiscover,
  runFocus,
  runGc,
  runGet,
  runHealth,
  runHistory,
  runHistoryCompact,
  runHistoryRedact,
  runHistoryRepair,
  runHistoryRepairAll,
  runInit,
  runLearnings,
  runList,
  runNext,
  runNotes,
  runPlan,
  runProfileApply,
  runProfileLint,
  runProfileList,
  runProfileShow,
  runRestore,
  runRelease,
  runSchemaAddField,
  runSchemaAddStatus,
  runSchemaAddType,
  runSchemaApplyPreset,
  runSchemaInferTypes,
  runSchemaList,
  runSchemaListFields,
  runSchemaRemoveField,
  runSchemaRemoveStatus,
  runSchemaRemoveType,
  runSchemaShow,
  runSchemaShowField,
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
import type { ContextOptions, ContextResult } from "../cli/commands/context.js";
import type { GetOptions, GetResult } from "../cli/commands/get.js";
import type { CloseManyCommandOptions } from "../cli/commands/close-many.js";
import {
  runContracts,
  type ContractsCommandOptions,
  type ContractsResult,
} from "../cli/commands/contracts.js";
import type { ListOptions, ListResult } from "../cli/commands/list.js";
import type { NextOptions, NextResult } from "../cli/commands/next.js";
import type { SearchOptions, SearchResult } from "../cli/commands/search.js";
import type { StatsCommandOptions, StatsResult } from "../cli/commands/stats.js";
import { resolveStartTaskInProgressStatus } from "../cli/register-operations.js";
import type { UpdateManyCommandOptions } from "../cli/commands/update-many.js";

export {
  getActiveExtensionRegistrations,
  runActiveOnReadHooks,
  runActiveOnWriteHooks,
} from "../core/extensions/index.js";
export { pathExists, readFileIfExists, removeFileIfExists, writeFileAtomic } from "../core/fs/fs-utils.js";
export { appendHistoryEntry, createHistoryEntry } from "../core/history/history.js";
export { generateItemId, normalizeItemId, normalizeRawItemId } from "../core/item/id.js";
export { readBooleanOption, readCsvListOption, readStringOption } from "./package-runtime-options.js";
export {
  PM_CLI_EXPECTED_ERROR_NAME,
  createPmCliExpectedError,
  isPmCliExpectedError,
  type CreatePmCliExpectedErrorOptions,
  type PmCliExpectedError,
} from "./errors.js";
export {
  commitImportedItem,
  emptyImportedDocument,
  ensureTrackerInitialized,
  selectImportAuthor,
  toEstimatedMinutesValue,
  toImportBoolean,
  toImportConfidence,
  toImportInteger,
  toImportLinkedDocs,
  toImportLinkedFiles,
  toImportLinkedTests,
  toImportLogEntries,
  toImportNormalizedEnum,
  toImportNumberMap,
  toImportPriority,
  toImportStatus,
  toImportStringList,
  toImportStringMap,
  toImportTags,
  toNonEmptyImportString,
  type CommitImportedItemParams,
  type CommitImportedItemResult,
  type ImportLinkedScope,
  type ImportPriorityValue,
  type ToImportLinkedArtifactsOptions,
  type ToImportLinkedTestsOptions,
  type ToImportLogEntriesOptions,
} from "./package-import-adapters.js";
export {
  canonicalDocument,
  normalizeFrontMatter,
  serializeItemDocument,
  splitFrontMatter,
} from "../core/item/item-format.js";
export {
  BASELINE_ITEM_FORMAT_VERSION,
  CURRENT_ITEM_FORMAT_VERSION,
  classifyItemFormatVersion,
  effectiveItemFormatVersion,
  normalizeItemFormatVersion,
  scanItemFormatVersions,
  type ItemFormatVersionScanEntry,
  type ItemFormatVersionScanResult,
  type ItemFormatVersionStatus,
} from "../core/item/item-format-version.js";
export { parseTags } from "../core/item/parse.js";
export { normalizeStatusInput } from "../core/item/status.js";
export { resolveItemTypeRegistry } from "../core/item/type-registry.js";
export { acquireLock } from "../core/lock/lock.js";
export { resolveRuntimeFieldRegistry, resolveRuntimeStatusRegistry } from "../core/schema/runtime-schema.js";
export { EXIT_CODE } from "../core/shared/constants.js";
export { PmCliError } from "../core/shared/errors.js";
export { isTimestampLiteral, nowIso } from "../core/shared/time.js";
export { listAllFrontMatter, locateItem, readLocatedItem } from "../core/store/item-store.js";
export { getHistoryPath, getItemPath, getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
export { readSettings } from "../core/store/settings.js";
export {
  runAggregate,
  type AggregateOptions,
  type AggregateResult,
  type AggregateRow,
} from "../cli/commands/aggregate.js";
export {
  CONTEXT_OUTPUT_VALUES,
  runContext,
  type BlockerEntry,
  type ContextFocusItem,
  type ContextOptions,
  type ContextOutputFormat,
  type ContextResult,
  type HierarchyChild,
  type HierarchyNode,
  type HotFile,
  type ProgressEntry,
  type RecentContextItem,
  type StaleEntry,
  type TestHealthSummary,
  type WorkloadEntry,
} from "../cli/commands/context.js";
export {
  runGet,
  type GetOptions,
  type GetResult,
} from "../cli/commands/get.js";
export {
  runList,
  type ListCompactResult,
  type ListedItem,
  type ListOptions,
  type ListResult,
  type ListSortField,
  type ListSortOrder,
  type ListVerboseResult,
} from "../cli/commands/list.js";
export {
  NEXT_OUTPUT_VALUES,
  runNext,
  type NextActionableItem,
  type NextBlockerRef,
  type NextOptions,
  type NextOutputFormat,
  type NextRecommendation,
  type NextResult,
} from "../cli/commands/next.js";
export {
  runSearch,
  type SearchCompactResult,
  type SearchHit,
  type SearchHitHighlight,
  type SearchMatchMode,
  type SearchOptions,
  type SearchResult,
  type SearchResultItem,
  type SearchVerboseResult,
} from "../cli/commands/search.js";
export {
  runStats,
  type StatsCommandOptions,
  type StatsResult,
} from "../cli/commands/stats.js";
export {
  renderCalendarMarkdown,
  renderCalendarToon,
  resolveCalendarOutputFormat,
  runCalendar,
  type CalendarOptions,
  type CalendarResult,
} from "../cli/commands/calendar.js";
export {
  renderGuideMarkdown,
  resolveGuideOutputFormat,
  runGuide,
  type GuideDepth,
  type GuideOptions,
  type GuideOutputFormat,
  type GuideResult,
} from "../cli/commands/guide.js";
export { runCompletion, type CompletionResult, type CompletionShell } from "../cli/commands/completion.js";
export {
  runCommentsAudit,
  type CommentsAuditEntry,
  type CommentsAuditHistoryRow,
  type CommentsAuditOptions,
  type CommentsAuditResult,
  type CommentsAuditSummary,
  type CommentsAuditTypeSummary,
} from "../cli/commands/comments-audit.js";
export {
  runDedupeAudit,
  type DedupeAuditCandidate,
  type DedupeAuditCluster,
  type DedupeAuditOptions,
  type DedupeAuditResult,
} from "../cli/commands/dedupe-audit.js";
export {
  runDedupeMerge,
  type DedupeMergeChildReparent,
  type DedupeMergeCloseAction,
  type DedupeMergeDuplicateOutcome,
  type DedupeMergeOptions,
  type DedupeMergeResult,
} from "../cli/commands/dedupe-merge.js";
export { runNormalize, type NormalizeCommandOptions, type NormalizeResult } from "../cli/commands/normalize.js";
export { runReindex, type ReindexOptions, type ReindexResult } from "../cli/commands/reindex.js";
export {
  loadCreateTemplateOptions,
  runTemplatesList,
  runTemplatesSave,
  runTemplatesShow,
  type CreateTemplateOptions,
  type TemplatesListResult,
  type TemplatesSaveResult,
  type TemplatesShowResult,
} from "../cli/commands/templates.js";
export {
  runTestRunsList,
  runTestRunsLogs,
  runTestRunsResume,
  runTestRunsStatus,
  runTestRunsStop,
  type TestRunsListCommandOptions,
  type TestRunsLogsCommandOptions,
  type TestRunsResumeCommandOptions,
  type TestRunsStopCommandOptions,
} from "../cli/commands/test-runs.js";
export {
  CONFIDENCE_TEXT_VALUES,
  DEPENDENCY_KIND_VALUES,
  BUILTIN_ITEM_TYPE_VALUES,
  ISSUE_SEVERITY_VALUES,
  ITEM_TYPE_VALUES,
  RISK_VALUES,
  STATUS_VALUES,
} from "../types/index.js";
export type { GlobalOptions } from "../core/shared/command-types.js";
export type {
  Dependency,
  ItemDocument,
  ItemMetadata,
  ItemStatus,
  ItemType,
  LinkedDoc,
  LinkedFile,
  LinkedTest,
  LogNote,
  PmSettings,
} from "../types/index.js";

/**
 * Documents the get contracts options payload exchanged by command, SDK, and package integrations.
 */
export interface GetContractsOptions extends ContractsCommandOptions {
  pmRoot?: string;
  cwd?: string;
  noExtensions?: boolean;
  quiet?: boolean;
  profile?: boolean;
}

/**
 * Documents the workspace contracts options payload exchanged by command, SDK, and package integrations.
 */
export interface WorkspaceContractsOptions {
  extensionRegistrations?: ExtensionRegistrationRegistry | null;
  noExtensions?: boolean;
  cwd?: string;
}

/**
 * Documents the workspace contracts payload exchanged by command, SDK, and package integrations.
 */
export interface WorkspaceContracts {
  types: string[];
  statuses: string[];
  openStatus: string;
  closeStatus: string;
  canceledStatus: string;
}

/**
 * Names a native pm action or an extension-contributed action accepted by {@link runAction}.
 */
export type PmActionName = PmToolAction | (string & {});

/**
 * Plain object option bag forwarded to the same command runners used by MCP.
 */
export type PmActionOptions = Record<string, unknown>;

/**
 * Complete high-level action request for {@link runAction}.
 */
export type PmActionInput = PmActionOptions & {
  /** Native or extension-contributed action name to dispatch. */
  action: PmActionName;
  /** Command-runner options forwarded after MCP-compatible normalization. */
  options?: PmActionOptions;
};

/**
 * Per-call arguments accepted by {@link PmClient.run}. The action name is passed
 * as the first parameter, so an `action` property inside the args bag is rejected
 * at compile time.
 */
export type PmClientRunArgs = Omit<PmActionInput, "action"> & {
  /**
   * Return full `changed_fields` arrays for mutation actions instead of the
   * default compact `changed_field_count` projection.
   */
  fullChangedFields?: boolean;
  /** Return only mutation item ids when supported by the action. */
  idOnly?: boolean;
  action?: never;
};

/**
 * Command options accepted by PmClient mutation convenience methods.
 */
export type PmClientMutationOptions = PmActionOptions & {
  /**
   * Return full `changed_fields` arrays for this mutation instead of the compact
   * SDK default.
   */
  fullChangedFields?: boolean;
  /** Return only mutation item ids when supported by the action. */
  idOnly?: boolean;
};

/**
 * Stable defaults applied by {@link PmClient} to every action it runs.
 */
export interface PmClientOptions {
  /** Tracker root to pass as the SDK equivalent of `--path`. */
  pmRoot?: string;
  /** Working directory used for workspace and extension resolution. */
  cwd?: string;
  /** Default mutation author forwarded to action options when absent. */
  author?: string;
  /** Disable extension loading for every action this client runs. */
  noExtensions?: boolean;
}

interface PmClientDefaults {
  path?: string;
  cwd?: string;
  author?: string;
  noExtensions?: boolean;
}

function splitClientMutationOptions(options: PmClientMutationOptions): PmClientRunArgs {
  const { fullChangedFields, idOnly, ...runnerOptions } = options;
  return {
    ...(fullChangedFields === undefined ? {} : { fullChangedFields }),
    ...(idOnly === undefined ? {} : { idOnly }),
    options: runnerOptions,
  };
}

/**
 * Programmatic pm client for custom tools, CI jobs, bots, and embedded runtimes.
 *
 * Action execution shares the same process-wide extension activation queue used
 * by MCP. Concurrent calls from one process are serialized across extension
 * load, activation, dispatch, cleanup, and deactivate so active registries cannot
 * interleave.
 *
 * Convenience methods accept command options only. Use {@link PmClient.run} for
 * per-call runtime overrides such as `cwd`, `path`, or `noExtensions`.
 */
export class PmClient {
  private readonly defaults: PmClientDefaults;

  /**
   * Create a client with workspace, author, and extension-loading defaults.
   */
  constructor(options: PmClientOptions = {}) {
    this.defaults = {
      ...(options.pmRoot === undefined ? {} : { path: options.pmRoot }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.author === undefined ? {} : { author: options.author }),
      ...(options.noExtensions === undefined ? {} : { noExtensions: options.noExtensions }),
    };
  }

  /**
   * Run any native or extension-contributed action through the SDK dispatcher.
   */
  run(action: PmActionName, args: PmClientRunArgs = {}): Promise<unknown> {
    return runAction({ ...this.defaults, ...args, action });
  }

  private runTyped<Result>(action: PmActionName, args: PmClientRunArgs = {}): Promise<Result> {
    return this.run(action, args) as Promise<Result>;
  }

  /**
   * Return the same context snapshot produced by `pm context`.
   */
  context(options: ContextOptions = {}): Promise<ContextResult> {
    return this.runTyped("context", { options });
  }

  /**
   * List items with the MCP/agent compact defaults.
   */
  list(options: ListOptions = {}): Promise<ListResult> {
    return this.runTyped("list", { options });
  }

  /**
   * Search items with the MCP/agent compact defaults.
   */
  search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    return this.runTyped("search", { query, options });
  }

  /**
   * Read one item by id.
   */
  get(id: string, options: GetOptions = {}): Promise<GetResult> {
    return this.runTyped("get", { id, options });
  }

  /**
   * Return the ranked next-work recommendation produced by `pm next`.
   */
  next(options: NextOptions = {}): Promise<NextResult> {
    return this.runTyped("next", { options });
  }

  /**
   * Group matching items with the same semantics as `pm aggregate`.
   */
  aggregate(options: AggregateOptions = {}): Promise<AggregateResult> {
    return this.runTyped("aggregate", { options });
  }

  /**
   * Return project tracker statistics with the same sections as `pm stats`.
   */
  stats(options: StatsCommandOptions = {}): Promise<StatsResult> {
    return this.runTyped("stats", { options });
  }

  /**
   * Create an item using the same mutation path as `pm create`.
   */
  create(options: PmClientMutationOptions): Promise<unknown> {
    return this.run("create", splitClientMutationOptions(options));
  }

  /**
   * Update an item using the same mutation path as `pm update`.
   */
  update(id: string, options: PmClientMutationOptions): Promise<unknown> {
    return this.run("update", { id, ...splitClientMutationOptions(options) });
  }

  /**
   * Close an item using the same mutation path as `pm close`.
   */
  close(id: string, reason: string, options: PmClientMutationOptions = {}): Promise<unknown> {
    return this.run("close", { id, reason, ...splitClientMutationOptions(options) });
  }
}

/**
 * Return the same context snapshot produced by `pm context` without constructing
 * a reusable client.
 */
export function context(options: ContextOptions = {}, clientOptions: PmClientOptions = {}): Promise<ContextResult> {
  return new PmClient(clientOptions).context(options);
}

/**
 * List items with the MCP/agent compact defaults without constructing a
 * reusable client.
 */
export function list(options: ListOptions = {}, clientOptions: PmClientOptions = {}): Promise<ListResult> {
  return new PmClient(clientOptions).list(options);
}

/**
 * Search items with the MCP/agent compact defaults without constructing a
 * reusable client.
 */
export function search(
  query: string,
  options: SearchOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<SearchResult> {
  return new PmClient(clientOptions).search(query, options);
}

/**
 * Read one item by id without constructing a reusable client.
 */
export function get(id: string, options: GetOptions = {}, clientOptions: PmClientOptions = {}): Promise<GetResult> {
  return new PmClient(clientOptions).get(id, options);
}

/**
 * Return the ranked next-work recommendation produced by `pm next` without
 * constructing a reusable client.
 */
export function next(options: NextOptions = {}, clientOptions: PmClientOptions = {}): Promise<NextResult> {
  return new PmClient(clientOptions).next(options);
}

/**
 * Group matching items with the same semantics as `pm aggregate` without
 * constructing a reusable client.
 */
export function aggregate(
  options: AggregateOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<AggregateResult> {
  return new PmClient(clientOptions).aggregate(options);
}

/**
 * Return project tracker statistics with the same sections as `pm stats`
 * without constructing a reusable client.
 */
export function stats(
  options: StatsCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<StatsResult> {
  return new PmClient(clientOptions).stats(options);
}

/**
 * Process-lifetime memo of activated extension registrations, keyed by resolved
 * pm root + cwd + extension settings. `getWorkspaceContracts` is frequently
 * called by importers and package runtimes that cannot thread a registry
 * through; without the memo each call re-discovers, re-imports, and re-activates
 * every extension.
 *
 * Invalidation story: entries are size-bounded and otherwise live until cleared.
 * One-shot CLI processes are trivially correct. Long-lived hosts (e.g. the MCP
 * server) must either pass `options.extensionRegistrations` (which bypasses the
 * memo) or call {@link clearWorkspaceContractsCache} after installing/removing/
 * toggling extensions or editing settings. Settings themselves are re-read on
 * every call — only the extension load+activate step is memoized.
 */
function buildWorkspaceExtensionRegistrationsCacheKey(
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  cwd?: string,
): string {
  return JSON.stringify([
    path.resolve(pmRoot),
    path.resolve(cwd ?? process.cwd()),
    settings.extensions.enabled,
    settings.extensions.disabled,
    settings.extensions.policy,
  ]);
}

async function resolveWorkspaceExtensionRegistrations(
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  cwd?: string,
): Promise<ExtensionRegistrationRegistry | null> {
  const cacheKey = buildWorkspaceExtensionRegistrationsCacheKey(pmRoot, settings, cwd);
  return memoizeWorkspaceExtensionRegistrations(cacheKey, () => loadWorkspaceExtensionRegistrations(pmRoot, settings, cwd));
}

/**
 * Implements get workspace contracts for the public runtime surface of this module.
 */
export async function getWorkspaceContracts(
  pmRoot: string,
  options: WorkspaceContractsOptions = {},
): Promise<WorkspaceContracts> {
  const settings = await readSettings(pmRoot);
  const extensionRegistrations =
    options.extensionRegistrations ??
    (options.noExtensions === true ? null : await resolveWorkspaceExtensionRegistrations(pmRoot, settings, options.cwd));
  const typeRegistry = resolveItemTypeRegistry(settings, extensionRegistrations);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);

  return {
    types: [...typeRegistry.types],
    statuses: statusRegistry.definitions.map((definition) => definition.id),
    openStatus: statusRegistry.open_status,
    closeStatus: statusRegistry.close_status,
    canceledStatus: statusRegistry.canceled_status,
  };
}

/**
 * Implements get contracts for the public runtime surface of this module.
 */
export async function getContracts(
  pmRootOrOptions?: string | GetContractsOptions,
  options: GetContractsOptions = {},
): Promise<ContractsResult> {
  const resolvedOptions =
    typeof pmRootOrOptions === "string"
      ? { ...options, pmRoot: pmRootOrOptions }
      : (pmRootOrOptions ?? options);
  const global: GlobalOptions = {
    json: true,
    quiet: resolvedOptions.quiet ?? true,
    noExtensions: resolvedOptions.noExtensions ?? false,
    noPager: true,
    profile: resolvedOptions.profile ?? false,
    path: resolvedOptions.pmRoot,
  };

  return runContracts(resolvedOptions, global);
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

/**
 * Read a required non-empty string from an action argument bag.
 */
export function readRequiredString(args: Record<string, unknown>, key: string): string {
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
  const chunks: string[] = [];
  let lastWasSeparator = true;
  for (const character of value.trim().toLowerCase()) {
    const isAlphaNumeric = (character >= "a" && character <= "z") || (character >= "0" && character <= "9");
    if (isAlphaNumeric) {
      chunks.push(character);
      lastWasSeparator = false;
      continue;
    }
    if (!lastWasSeparator) {
      chunks.push("-");
      lastWasSeparator = true;
    }
  }
  if (chunks.at(-1) === "-") {
    chunks.pop();
  }
  return chunks.join("");
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
  return extensionActivationQueue.enqueue(async () =>
    explicitCwd === undefined
      ? await withActiveExtensionsExclusively(global, resolutionCwd, run)
      : await withCwd(explicitCwd, () => withActiveExtensionsExclusively(global, resolutionCwd, run)),
  );
}

/**
 * Body of the activation cycle. Must only ever run under {@link extensionActivationQueue}
 * (see {@link withActiveExtensions}): it is the exclusive owner of the process-global
 * active extension registries while it runs. Returns early with `run(null)` — still
 * inside the serialized critical section — when extensions are disabled or no workspace
 * exists yet, so those built-in actions also observe a stable (empty) registry. MCP and
 * PmClient callers reload + reactivate extensions per request, so each call is a fresh
 * cycle with teardown in a finally to release resources opened during activate() (the
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
    resetActiveExtensionRegistries();
    return run(null);
  }
  const pmRoot = resolvePmRoot(cwd, global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    resetActiveExtensionRegistries();
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
    console.error("[pm-sdk] extension activation failed; continuing without active extensions:", error);
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

const WORKSPACE_CONTRACTS_CACHE_PRESERVING_ACTIONS = new Set([
  "activity",
  "aggregate",
  "context",
  "contracts",
  "deps",
  "files-discover",
  "get",
  "health",
  "history",
  "list",
  "next",
  "search",
  "stats",
  "telemetry",
  "validate",
]);

interface SdkActionAlias {
  action: string;
  options?: Record<string, unknown>;
}

const LIST_ACTION_ALIASES: Record<string, SdkActionAlias> = {
  "list-all": { action: "list", options: { excludeTerminal: false } },
  "list-draft": { action: "list", options: { status: "draft", excludeTerminal: false } },
  "list-open": { action: "list", options: { status: "open", excludeTerminal: false } },
  "list-in-progress": { action: "list", options: { status: "in_progress", excludeTerminal: false } },
  "list-blocked": { action: "list", options: { status: "blocked", excludeTerminal: false } },
  "list-closed": { action: "list", options: { status: "closed", excludeTerminal: false } },
  "list-canceled": { action: "list", options: { status: "canceled", excludeTerminal: false } },
};

const EXTENSION_ACTION_ALIASES: Record<string, SdkActionAlias> = {
  "extension-init": { action: "extension", options: { init: true } },
  "extension-install": { action: "extension", options: { install: true } },
  "extension-uninstall": { action: "extension", options: { uninstall: true } },
  "extension-explore": { action: "extension", options: { explore: true } },
  "extension-manage": { action: "extension", options: { manage: true } },
  "extension-describe": { action: "extension", options: { describe: true } },
  "extension-reload": { action: "extension", options: { reload: true } },
  "extension-doctor": { action: "extension", options: { doctor: true } },
  "extension-catalog": { action: "extension", options: { catalog: true } },
  "extension-adopt": { action: "extension", options: { adopt: true } },
  "extension-adopt-all": { action: "extension", options: { adoptAll: true } },
  "extension-activate": { action: "extension", options: { activate: true } },
  "extension-deactivate": { action: "extension", options: { deactivate: true } },
};

const PACKAGE_ACTION_ALIASES: Record<string, SdkActionAlias> = {
  "package-init": { action: "package", options: { init: true, vocabulary: "package" } },
  "package-install": { action: "package", options: { install: true, vocabulary: "package" } },
  "package-uninstall": { action: "package", options: { uninstall: true, vocabulary: "package" } },
  "package-explore": { action: "package", options: { explore: true, vocabulary: "package" } },
  "package-manage": { action: "package", options: { manage: true, vocabulary: "package" } },
  "package-describe": { action: "package", options: { describe: true, vocabulary: "package" } },
  "package-reload": { action: "package", options: { reload: true, vocabulary: "package" } },
  "package-doctor": { action: "package", options: { doctor: true, vocabulary: "package" } },
  "package-catalog": { action: "package", options: { catalog: true, vocabulary: "package" } },
  "package-adopt": { action: "package", options: { adopt: true, vocabulary: "package" } },
  "package-adopt-all": { action: "package", options: { adoptAll: true, vocabulary: "package" } },
  "package-activate": { action: "package", options: { activate: true, vocabulary: "package" } },
  "package-deactivate": { action: "package", options: { deactivate: true, vocabulary: "package" } },
};

const SDK_ACTION_ALIASES: Record<string, SdkActionAlias> = {
  ctx: { action: "context" },
  ...LIST_ACTION_ALIASES,
  ...EXTENSION_ACTION_ALIASES,
  ...PACKAGE_ACTION_ALIASES,
};

function resolveSdkActionInput(args: PmActionInput): { action: string; args: Record<string, unknown> } {
  const rawAction = readRequiredString(args, "action");
  const normalizedAction = normalizeActionName(rawAction);
  const alias = getOwnHandler(SDK_ACTION_ALIASES, normalizedAction);
  const action = alias?.action ?? normalizedAction;
  const resolvedArgs: Record<string, unknown> = { ...args, action };
  if (alias?.options !== undefined) {
    resolvedArgs.options = { ...alias.options, ...asRecordClone(args.options) };
  }
  return { action, args: resolvedArgs };
}

function shouldInvalidateWorkspaceContractsCacheAfterAction(action: string): boolean {
  return !WORKSPACE_CONTRACTS_CACHE_PRESERVING_ACTIONS.has(normalizeActionName(action));
}

/**
 * Execute one native or extension-contributed pm action in-process.
 */
export async function runAction(args: PmActionInput): Promise<unknown> {
  const resolved = resolveSdkActionInput(args);
  const global = globalOptions(resolved.args);
  const invalidateWorkspaceContractsCache = shouldInvalidateWorkspaceContractsCacheAfterAction(resolved.action);
  // pm-zumn: dispatch every action (built-in and dynamic) inside one extension
  // activation cycle so built-in actions see extension-contributed item types, fields,
  // and profiles, consistent with the CLI. Snapshot the effective resolution cwd HERE,
  // at request entry (the explicit args.cwd, else the server's current directory), so the
  // queued cycle resolves against the directory the request arrived in rather than a value
  // process.cwd() might hold by the time the task runs. Only an explicit cwd additionally
  // pins process.cwd() (inside the serialized slot) for the built-in handler.
  const explicitCwd = readString(resolved.args, "cwd");
  const resolutionCwd = explicitCwd ?? process.cwd();
  try {
    return await withActiveExtensions(global, explicitCwd, resolutionCwd, (activeExtensions) =>
      dispatchAction(resolved.action, resolved.args, global, activeExtensions),
    );
  } finally {
    if (invalidateWorkspaceContractsCache) {
      clearWorkspaceContractsCache();
    }
  }
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
    (await runList(
      readString(ctx.args, "status") ?? readString(listOptions, "status"),
      listOptions as never,
      ctx.global,
    )) as unknown as Record<string, unknown>,
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
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new PmCliError(`${label} must be a finite integer.`, 64);
    }
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const trimmed = value.trim();
    if (!/^[+-]?\d+(?:st|nd|rd|th)?$/i.test(trimmed)) {
      throw new PmCliError(`${label} must be a finite integer.`, 64);
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(parsed)) {
      throw new PmCliError(`${label} must be a finite integer.`, 64);
    }
    return parsed;
  }
  return undefined;
}

function runMcpPlanAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const subcommand = readString(ctx.args, "subcommand") ?? readRequiredString(ctx.options, "subcommand");
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

async function runMcpRestoreAction(ctx: McpActionDispatchContext): Promise<unknown> {
  return runRestore(requireMcpItemId(ctx), readRequiredString(ctx.options, "target"), ctx.options, ctx.global);
}

async function runMcpStartTaskAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const pmRoot = resolvePmRoot(process.cwd(), ctx.global.path);
  const settings = await readSettings(pmRoot);
  const inProgressStatus = resolveStartTaskInProgressStatus(resolveRuntimeStatusRegistry(settings.schema));
  const id = requireMcpItemId(ctx);
  const claimResult = await runClaim(id, ctx.force, ctx.global, ctx.options);
  const updateResult = await runUpdate(id, { ...ctx.options, status: inProgressStatus, force: ctx.force }, ctx.global);
  return { id, action: "start_task", claim: claimResult, update: updateResult };
}

async function runMcpPauseTaskAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const pmRoot = resolvePmRoot(process.cwd(), ctx.global.path);
  const settings = await readSettings(pmRoot);
  const id = requireMcpItemId(ctx);
  const openStatus = resolveRuntimeStatusRegistry(settings.schema).open_status;
  const updateResult = await runUpdate(id, { ...ctx.options, status: openStatus, force: ctx.force }, ctx.global);
  const releaseResult = await runRelease(id, ctx.force, ctx.global, ctx.options);
  return { id, action: "pause_task", update: updateResult, release: releaseResult };
}

async function runMcpCloseTaskAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const id = requireMcpItemId(ctx);
  const closeReason =
    readString(ctx.args, "reason") ??
    readString(ctx.args, "text") ??
    readString(ctx.options, "reason") ??
    readString(ctx.options, "text");
  const closeResult = await runClose(id, closeReason, { ...ctx.options, force: ctx.force }, ctx.global);
  const releaseResult = await runRelease(id, ctx.force, ctx.global, ctx.options);
  return { id, action: "close_task", close: closeResult, release: releaseResult };
}

const SDK_ACTION_HANDLERS: Record<string, McpActionHandler> = {
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
  restore: runMcpRestoreAction,
  claim: (ctx) => runClaim(requireMcpItemId(ctx), ctx.force, ctx.global, ctx.options),
  release: (ctx) => runRelease(requireMcpItemId(ctx), ctx.force, ctx.global, ctx.options),
  "start-task": runMcpStartTaskAction,
  "pause-task": runMcpPauseTaskAction,
  "close-task": runMcpCloseTaskAction,
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
  package: (ctx) => runExtension(readMcpTarget(ctx), ctx.options, ctx.global),
  install: (ctx) => runExtension(readMcpTarget(ctx), { ...ctx.options, install: true }, ctx.global),
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
    force: args.force === true || options.force === true,
    global,
    activeExtensions,
  };
  const handler = getOwnHandler(SDK_ACTION_HANDLERS, action);
  return handler ? handler(ctx) : dispatchActiveExtensionAction(action, args, options, global, activeExtensions);
}

const actionRunnerTestHooks = {
  closeManyOptionsFromFlat,
  extensionOptionsFromArgs,
  globalOptions,
  mutationListOptions,
  normalizeActionName,
  normalizeCommandPath,
  normalizeMcpUpdateOptions,
  normalizeMcpOptionsArrays,
  optionsWithAuthor,
  readRequiredString,
  readScalarString,
  readScalarStringAllowBlank,
  readStringArray,
  updateManyOptionsFromFlat,
  withAddNoteOption,
  withFilesDiscoveryOptions,
  withMutationCompaction,
};

declare global {
  var __pmCliActionRunnerTestHooks: typeof actionRunnerTestHooks | undefined;
}

if (process.env.NODE_ENV === "test" || process.env.VITEST !== undefined || process.env.VITEST_WORKER_ID !== undefined) {
  globalThis.__pmCliActionRunnerTestHooks = actionRunnerTestHooks;
}

async function loadWorkspaceExtensionRegistrations(
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  cwd?: string,
): Promise<ExtensionRegistrationRegistry | null> {
  const loadResult = await loadExtensions({
    pmRoot,
    settings,
    cwd: cwd ?? process.cwd(),
    noExtensions: false,
  });
  const activationResult = await activateExtensions(loadResult);
  try {
    return activationResult.registrations;
  } finally {
    try {
      await deactivateExtensions(loadResult, activationResult);
    } catch {
      // Workspace contract reads should stay best-effort even if teardown itself fails.
    }
  }
}

export type { ContractsCommandOptions, ContractsResult };
