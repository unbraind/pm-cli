/**
 * @module sdk/runtime
 *
 * Defines public SDK APIs and package-author helpers for Runtime.
 */
export {
  PM_GITIGNORE_END,
  PM_GITIGNORE_START,
  ensurePmGitignore,
  getPmGitignoreBlock,
  type EnsurePmGitignoreResult,
} from "./workspace.js";
export { SEARCH_EXTENSION_FLAG_DEFINITIONS } from "./extension-contracts.js";
export type { FlagDefinition } from "../core/extensions/loader.js";
import { AsyncLocalStorage } from "node:async_hooks";
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
  runWithIsolatedExtensionRuntime,
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
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { asRecordClone } from "../core/shared/primitives.js";
import { createAsyncReadWriteGate } from "../core/shared/serial-queue.js";
import {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
} from "../core/schema/runtime-schema.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import type { ItemMetadata } from "../types/index.js";
import { listClientItemMetadataLight } from "./query/light-metadata.js";
import {
  buildWorkspaceExtensionCommandContracts,
  buildWorkspaceFieldContracts,
} from "./workspace-contracts.js";
export type {
  WorkspaceExtensionCommandContract,
  WorkspaceFieldContract,
} from "./workspace-contracts.js";
import { PM_TOOL_ACTIONS } from "./cli-contracts/enum-contracts.js";
import {
  clearWorkspaceContractsCache,
  memoizeWorkspaceExtensionRegistrations,
} from "./workspace-contracts-cache.js";
import { SDK_ACTION_ALIASES } from "./runtime-action-aliases.js";
import { createExtensionCommandSdk } from "./extension-command-context.js";
import { createUnknownSubcommandError } from "./agent/subcommand-recovery.js";
import {
  applyContextIntentProjection,
  attachReadOutputContracts,
} from "./context-intent-contracts.js";
import {
  runWithDiscoveredContextIntentContracts,
  type PmContextIntentPackageModule,
} from "./context-intent-runtime.js";
import {
  validateReadOutputOptions,
  type PmReadOutputOptions,
  type PmReadOutputResultFor,
} from "./read-output-contracts.js";
export type {
  PmReadOutputBudgetExceeded,
  PmReadOutputOptions,
  PmReadOutputResult,
  PmReadOutputResultFor,
  PmReadOutputSurfaceContract,
} from "./read-output-contracts.js";
export type {
  PmReadOutputSessionReceipt,
  PmReadOutputSessionState,
} from "./read-output-session.js";
export type { PmContextIntentContract } from "./context-intent-contracts.js";
export type { PmErrorCodeContract } from "./error-code-catalog.js";
export { clearWorkspaceContractsCache } from "./workspace-contracts-cache.js";
import { runActivity } from "./query/activity.js";
import { runAssuranceDispatch, type AssuranceActionInput, type AssuranceActionResult } from "./governance/assurance-action.js";
import {
  runAggregate,
  type AggregateOptions,
  type AggregateResult,
} from "./query/aggregate.js";
import { runAppend } from "./lifecycle/append.js";
import { runClaim, runClaimNext, runRelease } from "./lifecycle/claim.js";
import { runCloseMany } from "./lifecycle/close-many.js";
import { normalizeAnnotationTransportOptions } from "./annotations.js";
import { runComments } from "./comments.js";
import { runHistory } from "./query/history.js";
import { runLearnings } from "./learnings.js";
import { runNotes } from "./notes.js";
import { runUpdateMany } from "./lifecycle/update-many.js";
import {
  runUpgrade,
  type UpgradeCommandOptions,
  type UpgradeResult,
} from "./governance/upgrade.js";
import { runCreate, type CreateResult } from "./lifecycle/create.js";
import { runUpdate, type UpdateResult } from "./lifecycle/update.js";
import {
  runPlan,
  type PlanCommandOptions,
  type PlanCommandResult,
  type PlanSubcommand,
} from "./lifecycle/plan.js";
import {
  runContext,
  type ContextOptions,
  type ContextResult,
} from "./query/context.js";
import { runNext, type NextOptions, type NextResult } from "./query/next.js";
import { runClose } from "./lifecycle/close.js";
import { runCopy, type CopyResult } from "./lifecycle/copy.js";
import { runDelete, type DeleteResult } from "./lifecycle/delete.js";
import { runRestore, type RestoreResult } from "./lifecycle/restore.js";
import { runFocus, type FocusResult } from "./lifecycle/focus.js";
import { runGet, type GetOptions, type GetResult } from "./query/get.js";
import {
  runGc,
  type GcCommandOptions,
  type GcResult,
} from "./governance/gc.js";
import {
  runHealth,
  type HealthResult,
  type RunHealthOptions,
} from "./governance/health.js";
import {
  runValidate,
  type ValidateCommandOptions,
  type ValidateCountsResult,
  type ValidateResult,
} from "./governance/validate.js";
import {
  runExtension,
  type ExtensionCommandOptions,
  type ExtensionCommandResult,
} from "./extension.js";
import { runConfig } from "./config.js";
import { runInit } from "./init.js";
import {
  runRuntimeEvalAction,
  runRuntimeEventsAction,
  runRuntimeMergeAction,
  runRuntimeSchedulingAction,
  runRuntimeWorkspaceAction,
} from "./runtime-extended-actions.js";
import {
  acknowledgeUnknownAuthorHistoryEventsFromTransport,
  type AcknowledgeUnknownAuthorEventsOptions,
} from "./author-attribution.js";
import {
  PROFILE_SUBCOMMANDS,
  runProfileApply,
  runProfileLint,
  runProfileList,
  runProfileShow,
} from "./profile.js";
import {
  type HistoryCompactBulkCommandOptions,
  type HistoryCompactBulkResult,
  type HistoryCompactCommandOptions,
  type HistoryCompactResult,
} from "./history-compact.js";
import {
  runHistoryRedact,
  type HistoryRedactCommandOptions,
  type HistoryRedactResult,
} from "./history-redact.js";
import {
  type HistoryRepairAllResult,
  type HistoryRepairCommandOptions,
  type HistoryRepairResult,
} from "./history-repair.js";
import {
  runMcpHistoryCompactAction,
  runMcpHistoryRepairAction,
} from "./history-mcp.js";
import {
  actionGlobalOptions as globalOptions,
  closeManyOptionsFromFlat,
  extensionOptionsFromArgs,
  graphOptionsFromFlat,
  mutationListOptions,
  normalizeActionName,
  normalizeCommandPath,
  normalizeMcpOptionsArrays,
  normalizeMcpUpdateOptions,
  optionsWithAuthor,
  parseRuntimeInteger as parseMcpInteger,
  readRuntimeScalarString as readScalarString,
  readRuntimeScalarStringAllowBlank as readScalarStringAllowBlank,
  readRuntimeString as readString,
  readRuntimeStringArray as readStringArray,
  resolveRuntimeLimit,
  updateManyOptionsFromFlat,
  withAddNoteOption,
  withFilesDiscoveryOptions,
  withMutationCompaction,
} from "./runtime-input.js";
import { runDeps } from "./dependencies.js";
import { runDocs } from "./docs.js";
import type {
  PmCreateActionOptions,
  PmUpdateActionOptions,
} from "./cli-contracts/typed-action-inputs.js";
import {
  runGraph,
  type GraphCommandOptions,
  type GraphResult,
  type GraphSubcommand,
} from "./graph/run.js";
import { runFiles, runFilesDiscover, runFilesLookup } from "./files.js";
import { runtimeFilesLookupOptions } from "./traceability/runtime-files-lookup.js";
import type { AppendCommandOptions, AppendResult } from "./lifecycle/append.js";
import type {
  ClaimNextResult,
  ClaimResult,
  ReleaseResult,
} from "./lifecycle/claim.js";
import type { CloseResult } from "./lifecycle/close.js";
import {
  runContracts,
  type ContractsCommandOptions,
  type ContractsResult,
} from "./cli-contracts/runtime-contracts.js";
import { runList, type ListOptions, type ListResult } from "./query/list.js";
import {
  runSearch,
  type SearchOptions,
  type SearchResult,
} from "./query/search.js";
import {
  runStats,
  type StatsCommandOptions,
  type StatsResult,
} from "./stats.js";
import { statsCommandOptionsFromRuntime } from "./runtime-stats-options.js";
import {
  runDuplicates,
  type DuplicatesCommandOptions,
  type DuplicatesResult,
} from "./duplicates.js";
import { runTelemetry } from "./telemetry.js";
import { runTest } from "./test/execution.js";
import { runTestAll } from "./test/batch.js";
import { resolveStartTaskInProgressStatus } from "./start-task-status.js";
import type { CommentsCommandOptions, CommentsResult } from "./comments.js";
import type { ConfigCommandOptions, ConfigResult } from "./config.js";
import type { DepsCommandOptions, DepsResult } from "./dependencies.js";
import type { DocsCommandOptions, DocsResult } from "./docs.js";
import type {
  FilesCommandOptions,
  FilesDiscoverOptions,
  FilesDiscoverResult,
  FilesLookupOptions,
  FilesLookupResult,
  FilesResult,
} from "./files.js";
import type { InitCommandOptions, InitResult } from "./init.js";
import type { LearningsCommandOptions, LearningsResult } from "./learnings.js";
import type { NotesCommandOptions, NotesResult } from "./notes.js";
import type {
  ProfileApplyCommandOptions,
  ProfileApplyResult,
  ProfileLintResult,
  ProfileListResult,
  ProfileResult,
  ProfileShowResult,
  ProfileSubcommand,
} from "./profile.js";
import {
  SCHEMA_SUBCOMMANDS,
  runSchemaAddField,
  runSchemaAddStatus,
  runSchemaAddType,
  runSchemaApplyPreset,
  runSchemaInferTypes,
  runSchemaList,
  runSchemaListFields,
  runSchemaEvolutionMigration,
  runSchemaRemoveField,
  runSchemaRemoveStatus,
  runSchemaRemoveType,
  runSchemaShow,
  runSchemaShowField,
  runSchemaShowStatus,
  type SchemaAddFieldCommandOptions,
  type SchemaAddFieldResult,
  type SchemaAddStatusCommandOptions,
  type SchemaAddStatusResult,
  type SchemaAddTypeCommandOptions,
  type SchemaAddTypeInferCommandOptions,
  type SchemaAddTypeInferResult,
  type SchemaAddTypeResult,
  type SchemaApplyPresetCommandOptions,
  type SchemaApplyPresetResult,
  type SchemaInspectResult,
  type SchemaListFieldsResult,
  type SchemaListResult,
  type RunSchemaEvolutionMigrationOptions,
  type SchemaEvolutionMigrationRequest,
  type SchemaEvolutionMigrationResult,
  type SchemaRemoveFieldCommandOptions,
  type SchemaRemoveFieldResult,
  type SchemaRemoveStatusCommandOptions,
  type SchemaRemoveStatusResult,
  type SchemaRemoveTypeCommandOptions,
  type SchemaRemoveTypeResult,
  type SchemaShowFieldResult,
  type SchemaShowResult,
  type SchemaShowStatusResult,
  type SchemaSubcommand,
} from "./schema.js";

export type {
  ClaimResult,
  CloseResult,
  CreateResult,
  ReleaseResult,
  UpdateResult,
};

export {
  getActiveExtensionRegistrations,
  runActiveOnReadHooks,
  runActiveOnWriteHooks,
} from "../core/extensions/index.js";
export {
  pathExists,
  readFileIfExists,
  removeFileIfExists,
  writeFileAtomic,
} from "../core/fs/fs-utils.js";
export {
  appendHistoryEntry,
  createHistoryEntry,
} from "../core/history/history.js";
export {
  generateItemId,
  normalizeItemId,
  normalizeRawItemId,
} from "../core/item/id.js";
export {
  readBooleanOption,
  readCsvListOption,
  readStringOption,
} from "./package-runtime-options.js";
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
  normalizeItemMetadata,
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
export { isTerminalStatus, normalizeStatusInput } from "../core/item/status.js";
export { resolveItemTypeRegistry } from "../core/item/type-registry.js";
export { acquireLock } from "../core/lock/lock.js";
export {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
} from "../core/schema/runtime-schema.js";
export { EXIT_CODE };
export { PmCliError } from "../core/shared/errors.js";
export { isTimestampLiteral, nowIso } from "../core/shared/time.js";
export {
  jaccardSimilarity,
  normalizeSimilarityText,
  scoreItemSimilarity,
  tokenizeSimilarityText,
  type ItemSimilarityScore,
} from "./similarity-scoring.js";
export {
  listAllItemMetadata,
  listAllItemMetadataLight,
  locateItem,
  readLocatedItem,
} from "../core/store/item-store.js";
export {
  getHistoryPath,
  getItemPath,
  getSettingsPath,
  resolveImplicitPmRoot,
  resolvePmRoot,
} from "../core/store/paths.js";
export { readSettings } from "../core/store/settings.js";
export {
  runAggregate,
  type AggregateOptions,
  type AggregateResult,
  type AggregateRow,
} from "./query/aggregate.js";
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
} from "./query/context.js";
export { runGet, type GetOptions, type GetResult } from "./query/get.js";
export {
  runList,
  type ListFullResult,
  type ListCompactResult,
  type ListedItem,
  type ListOptions,
  type ListProjectedItem,
  type ListProjectedItemCore,
  type ListResult,
  type ListResultItem,
  type ListSortField,
  type ListSortOrder,
  type ListTreeItem,
  type ListTreeMetadata,
  type ListVerboseResult,
} from "./query/list.js";
export {
  closeItem,
  runClose,
  type CloseCommandOptions,
} from "./lifecycle/close.js";
export {
  runCopy,
  type CopyOptions,
  type CopyResult,
} from "./lifecycle/copy.js";
export {
  runDelete,
  type DeleteCommandOptions,
  type DeleteResult,
} from "./lifecycle/delete.js";
export {
  runFocus,
  type FocusOptions,
  type FocusResult,
} from "./lifecycle/focus.js";
export {
  runRestore,
  type RestoreCommandOptions,
  type RestoreResult,
} from "./lifecycle/restore.js";
export {
  DEFAULT_TERMINAL_TRANSITION_POLICY,
  applyTerminalOrderingPolicy,
  requireTerminalReason,
  resolveTerminalReason,
  type CloseOperationOptions,
  type CloseOperationResult,
  type TerminalOrderingMutation,
  type TerminalReasonInput,
  type TerminalReasonResolution,
  type TerminalReasonSource,
  type TerminalTransitionPolicy,
} from "./lifecycle-policy.js";
export { runUpdate, type UpdateCommandOptions } from "./lifecycle/update.js";
export {
  NEXT_OUTPUT_VALUES,
  runNext,
  type NextActionableItem,
  type NextBlockerRef,
  type NextOptions,
  type NextOutputFormat,
  type NextRecommendation,
  type NextResult,
} from "./query/next.js";
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
} from "./query/search.js";
export {
  runStats,
  type StatsCommandOptions,
  type StatsResult,
} from "./stats.js";
export {
  runDuplicates,
  type DuplicatesCommandOptions,
  type DuplicatesResult,
} from "./duplicates.js";
export {
  renderCalendarMarkdown,
  renderCalendarToon,
  resolveCalendarOutputFormat,
  runCalendar,
  type CalendarOptions,
  type CalendarResult,
} from "./query/calendar.js";
export {
  renderGuideMarkdown,
  resolveGuideOutputFormat,
  runGuide,
  type GuideDepth,
  type GuideOptions,
  type GuideOutputFormat,
  type GuideResult,
} from "./guide.js";
export {
  runCompletion,
  type CompletionResult,
  type CompletionShell,
} from "./completion.js";
export {
  runReindex,
  type ReindexOptions,
  type ReindexResult,
} from "./governance/reindex.js";
export {
  loadCreateTemplateOptions,
  runTemplatesList,
  runTemplatesSave,
  runTemplatesShow,
  type CreateTemplateOptions,
  type TemplatesListResult,
  type TemplatesSaveResult,
  type TemplatesShowResult,
} from "./templates.js";
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
} from "./test/runs.js";
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
/** Inputs that customize the package command operation. */
export type PackageCommandOptions = ExtensionCommandOptions;
/** Structured result returned by the package command operation. */
export type PackageCommandResult = ExtensionCommandResult;
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
import type {
  ClaimNextOptions,
  CloseTaskResult,
  GetContractsOptions,
  PauseTaskResult,
  PmActionInput,
  PmActionName,
  PmActionOptions,
  PmClientCloseActionOptions,
  PmClientFullMutationOptions,
  PmClientOptions,
  PmClientRunArgs,
  SchemaResult,
  StartTaskResult,
  WorkspaceContracts,
  WorkspaceContractsOptions,
} from "./runtime-public-contracts.js";
export type {
  ClaimNextOptions,
  CloseTaskResult,
  GetContractsOptions,
  PauseTaskResult,
  PmActionInput,
  PmActionName,
  PmActionOptions,
  PmClientCloseActionOptions,
  PmClientFullMutationOptions,
  PmClientMutationOptions,
  PmClientOptions,
  PmClientRunArgs,
  SchemaResult,
  StartTaskResult,
  WorkspaceContracts,
  WorkspaceContractsOptions,
} from "./runtime-public-contracts.js";

const ACTIVE_EXTENSION_HOST_CONTEXT = Symbol(
  "pm.active-extension-host-context",
);

interface PmClientDefaults {
  path?: string;
  cwd?: string;
  author?: string;
  noExtensions?: boolean;
  [ACTIVE_EXTENSION_HOST_CONTEXT]?: true;
}

type ReadOptions<Options> = Options & PmReadOutputOptions;
type ReadPromise<Result, Options> = Promise<
  PmReadOutputResultFor<Result, Options>
>;

function splitFullClientMutationOptions(
  options: PmClientFullMutationOptions,
): PmClientRunArgs {
  return { fullChangedFields: true, options };
}

/**
 * Programmatic pm client for custom tools, CI jobs, bots, and embedded runtimes.
 *
 * Extension registries are request-local, so calls that resolve workspaces from
 * `pmRoot` can activate and dispatch concurrently without leaking registrations
 * across clients. Calls with an explicit `cwd` remain serialized because
 * `process.chdir` is process-global.
 *
 * Convenience methods accept command options only. Use {@link PmClient.run} for
 * per-call runtime overrides such as `cwd`, `path`, or `noExtensions`.
 */
export class PmClient {
  private readonly defaults: PmClientDefaults;

  /** Create a client with workspace, author, and extension-loading defaults. */
  constructor(options: PmClientOptions = {}) {
    this.defaults = {
      ...(options.pmRoot === undefined ? {} : { path: options.pmRoot }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.author === undefined ? {} : { author: options.author }),
      ...(options.noExtensions === undefined
        ? {}
        : { noExtensions: options.noExtensions }),
    };
  }

  /** Create a native-action client that reuses an extension host's active schema context. */
  public static forActiveExtensionHost(options: PmClientOptions): PmClient {
    const client = new PmClient({ ...options, noExtensions: true });
    client.defaults[ACTIVE_EXTENSION_HOST_CONTEXT] = true;
    return client;
  }

  /** Run any native or extension-contributed action through the SDK dispatcher. */
  run(action: PmActionName, args: PmClientRunArgs = {}): Promise<unknown> {
    return runAction({ ...this.defaults, ...args, action });
  }

  private runTyped<Result>(
    action: PmActionName,
    args: PmClientRunArgs = {},
  ): Promise<Result> {
    return this.run(action, args) as Promise<Result>;
  }

  /** Return the same context snapshot produced by `pm context`. */
  context<Options extends ReadOptions<ContextOptions> = ContextOptions>(
    options: Options = {} as Options,
  ): ReadPromise<ContextResult, Options> {
    return this.runTyped("context", { options });
  }

  /** Read every item through the scalar-only metadata cache without materializing heavy collections or bodies. */
  listAllItemMetadataLight(): Promise<ItemMetadata[]> {
    return listClientItemMetadataLight(this.defaults.path, this.defaults.cwd);
  }

  /** List items with the MCP/agent compact defaults. */
  list<Options extends ReadOptions<ListOptions> = ListOptions>(
    options: Options = {} as Options,
  ): ReadPromise<ListResult, Options> {
    return this.runTyped("list", { options });
  }

  /** Search items with the MCP/agent compact defaults. */
  search<Options extends ReadOptions<SearchOptions> = SearchOptions>(
    query: string,
    options: Options = {} as Options,
  ): ReadPromise<SearchResult, Options> {
    return this.runTyped("search", { query, options });
  }

  /** Read one item by id. */
  get<Options extends ReadOptions<GetOptions> = GetOptions>(
    id: string,
    options: Options = {} as Options,
  ): ReadPromise<GetResult, Options> {
    return this.runTyped("get", { id, options });
  }

  /** Return the ranked next-work recommendation produced by `pm next`. */
  next<Options extends ReadOptions<NextOptions> = NextOptions>(
    options: Options = {} as Options,
  ): ReadPromise<NextResult, Options> {
    return this.runTyped("next", { options });
  }

  /** Group matching items with the same semantics as `pm aggregate`. */
  aggregate<Options extends ReadOptions<AggregateOptions> = AggregateOptions>(
    options: Options = {} as Options,
  ): ReadPromise<AggregateResult, Options> {
    return this.runTyped("aggregate", { options });
  }

  /** Return project tracker statistics with the same sections as `pm stats`. */
  stats<Options extends ReadOptions<StatsCommandOptions> = StatsCommandOptions>(
    options: Options = {} as Options,
  ): ReadPromise<StatsResult, Options> {
    return this.runTyped("stats", { options });
  }

  /** Discover existing duplicate clusters without mutating tracker state. */
  duplicates(
    options: DuplicatesCommandOptions = {},
  ): Promise<DuplicatesResult> {
    return this.runTyped("duplicates", { options });
  }

  /** List, add, edit, or delete item comments. */
  comments<
    Options extends ReadOptions<CommentsCommandOptions> =
      CommentsCommandOptions,
  >(
    id: string,
    options: Options = {} as Options,
  ): ReadPromise<CommentsResult, Options> {
    return this.runTyped("comments", { id, options });
  }

  /** List or append private item notes. */
  notes<Options extends ReadOptions<NotesCommandOptions> = NotesCommandOptions>(
    id: string,
    options: Options = {} as Options,
  ): ReadPromise<NotesResult, Options> {
    return this.runTyped("notes", { id, options });
  }

  /** List or append durable item learnings. */
  learnings(
    id: string,
    options: LearningsCommandOptions = {},
  ): Promise<LearningsResult> {
    return this.runTyped("learnings", { id, options });
  }

  /** Add, remove, clear, or list linked project files for an item. */
  files<Options extends ReadOptions<FilesCommandOptions> = FilesCommandOptions>(
    id: string,
    options: Options = {} as Options,
  ): ReadPromise<FilesResult, Options> {
    return this.runTyped("files", { id, options });
  }

  /** Discover and optionally attach changed files for an item. */
  filesDiscover(
    id: string,
    options: FilesDiscoverOptions = {},
  ): Promise<FilesDiscoverResult> {
    return this.runTyped("files-discover", { id, options });
  }

  /** Find the items that reference one or more source paths. */
  filesLookup(options: FilesLookupOptions): Promise<FilesLookupResult> {
    return this.runTyped("files-lookup", { options });
  }

  /** Add, remove, clear, or list linked documentation for an item. */
  docs<Options extends ReadOptions<DocsCommandOptions> = DocsCommandOptions>(
    id: string,
    options: Options = {} as Options,
  ): ReadPromise<DocsResult, Options> {
    return this.runTyped("docs", { id, options });
  }

  /** Inspect item dependency relationships. */
  deps<Options extends ReadOptions<DepsCommandOptions> = DepsCommandOptions>(
    id: string,
    options: Options = {} as Options,
  ): ReadPromise<DepsResult, Options> {
    return this.runTyped("deps", { id, options });
  }

  /** Run bounded workspace graph traversal, analytics, or governance-audit queries. */
  graph<Options extends ReadOptions<GraphCommandOptions> = GraphCommandOptions>(
    subcommand: GraphSubcommand,
    ids: { id?: string; target?: string } = {},
    options: Options = {} as Options,
  ): ReadPromise<GraphResult, Options> {
    return this.runTyped("graph", { subcommand, ...ids, options });
  }

  /** Append markdown/body text to an item through the mutation pipeline. */
  append(
    id: string,
    body: string,
    options: PmClientFullMutationOptions = {},
  ): Promise<AppendResult> {
    return this.runTyped("append", {
      id,
      ...splitFullClientMutationOptions({ ...options, body }),
    });
  }

  /** Initialize a workspace with the same semantics as `pm init`. */
  init(prefix?: string, options: InitCommandOptions = {}): Promise<InitResult> {
    return this.runTyped("init", {
      ...(prefix === undefined ? {} : { prefix }),
      options,
    });
  }

  /** Read or update project/global configuration. */
  config(
    scope: string,
    configAction: string,
    key?: string,
    value?: string,
    options: ConfigCommandOptions = {},
  ): Promise<ConfigResult> {
    return this.runTyped("config", {
      scope,
      configAction,
      ...(key === undefined ? {} : { key }),
      ...(value === undefined ? {} : { value }),
      options,
    });
  }

  /** Run the schema customization surface. */
  schema(
    subcommand: SchemaSubcommand,
    options: PmActionOptions = {},
  ): Promise<SchemaResult> {
    return this.runTyped("schema", { options: { ...options, subcommand } });
  }

  /** List built-in, custom, and extension-provided schema types/statuses. */
  schemaList(): Promise<SchemaListResult> {
    return this.runTyped("schema", { options: { subcommand: "list" } });
  }

  /** Show a schema item type definition. */
  schemaShow(name: string): Promise<SchemaShowResult> {
    return this.runTyped("schema", { name, options: { subcommand: "show" } });
  }

  /** Register or replace a custom item type. */
  schemaAddType(
    name: string,
    options: SchemaAddTypeCommandOptions = {},
  ): Promise<SchemaAddTypeResult> {
    return this.runTyped("schema", {
      name,
      options: { ...options, subcommand: "add-type" },
    });
  }

  /** Remove a custom item type. */
  schemaRemoveType(
    name: string,
    options: SchemaRemoveTypeCommandOptions = {},
  ): Promise<SchemaRemoveTypeResult> {
    return this.runTyped("schema", {
      name,
      options: { ...options, subcommand: "remove-type" },
    });
  }

  /** Register or replace a custom status. */
  schemaAddStatus(
    name: string,
    options: SchemaAddStatusCommandOptions = {},
  ): Promise<SchemaAddStatusResult> {
    return this.runTyped("schema", {
      name,
      options: { ...options, subcommand: "add-status" },
    });
  }

  /** Remove a custom status. */
  schemaRemoveStatus(
    name: string,
    options: SchemaRemoveStatusCommandOptions = {},
  ): Promise<SchemaRemoveStatusResult> {
    return this.runTyped("schema", {
      name,
      options: { ...options, subcommand: "remove-status" },
    });
  }

  /** Register or replace a runtime custom field. */
  schemaAddField(
    name: string,
    options: SchemaAddFieldCommandOptions = {},
  ): Promise<SchemaAddFieldResult> {
    return this.runTyped("schema", {
      name,
      options: { ...options, subcommand: "add-field" },
    });
  }

  /** Remove a runtime custom field. */
  schemaRemoveField(
    name: string,
    options: SchemaRemoveFieldCommandOptions = {},
  ): Promise<SchemaRemoveFieldResult> {
    return this.runTyped("schema", {
      name,
      options: { ...options, subcommand: "remove-field" },
    });
  }

  /** List runtime custom fields. */
  schemaListFields(): Promise<SchemaListFieldsResult> {
    return this.runTyped("schema", { options: { subcommand: "list-fields" } });
  }

  /** Show one runtime custom field definition. */
  schemaShowField(name: string): Promise<SchemaShowFieldResult> {
    return this.runTyped("schema", {
      name,
      options: { subcommand: "show-field" },
    });
  }

  /** Apply a built-in type preset to the workspace schema. */
  schemaApplyPreset(
    typePreset: string,
    options: SchemaApplyPresetCommandOptions = {},
  ): Promise<SchemaApplyPresetResult> {
    return this.runTyped("schema", {
      typePreset,
      options: { ...options, subcommand: "apply-preset" },
    });
  }

  /** Infer item types from the current tracker and optionally apply them. */
  schemaInferTypes(
    options: SchemaAddTypeInferCommandOptions = {},
  ): Promise<SchemaAddTypeInferResult> {
    return this.runTyped("schema", {
      options: { ...options, subcommand: "add-type", infer: true },
    });
  }

  /** Rename a custom item type and migrate every affected item atomically. */
  schemaRenameType(
    from: string,
    to: string,
    options: RunSchemaEvolutionMigrationOptions,
  ): Promise<SchemaEvolutionMigrationResult> {
    return this.runTyped("schema", {
      name: from,
      options: { ...options, subcommand: "rename-type", to },
    });
  }

  /** Rename a custom metadata field and migrate every affected item atomically. */
  schemaRenameField(
    from: string,
    to: string,
    options: RunSchemaEvolutionMigrationOptions,
    type?: string,
  ): Promise<SchemaEvolutionMigrationResult> {
    return this.runTyped("schema", {
      name: from,
      options: {
        ...options,
        subcommand: "rename-field",
        to,
        ...(type ? { fieldTypeScope: type } : {}),
      },
    });
  }

  /** Remap a custom lifecycle status and migrate every affected item atomically. */
  schemaRemapStatus(
    from: string,
    to: string,
    options: RunSchemaEvolutionMigrationOptions,
  ): Promise<SchemaEvolutionMigrationResult> {
    return this.runTyped("schema", {
      name: from,
      options: { ...options, subcommand: "remap-status", to },
    });
  }

  /** Show one runtime status definition. */
  schemaShowStatus(name: string): Promise<SchemaShowStatusResult> {
    return this.runTyped("schema", {
      name,
      options: { subcommand: "show-status" },
    });
  }

  /** Run the profile customization surface. */
  profile(
    subcommand: ProfileSubcommand,
    options: PmActionOptions = {},
  ): Promise<ProfileResult> {
    return this.runTyped("profile", { options: { ...options, subcommand } });
  }

  /** List available project profiles. */
  profileList(): Promise<ProfileListResult> {
    return this.runTyped("profile", { options: { subcommand: "list" } });
  }

  /** Show a project profile. */
  profileShow(name: string): Promise<ProfileShowResult> {
    return this.runTyped("profile", { name, options: { subcommand: "show" } });
  }

  /** Apply a project profile. */
  profileApply(
    name: string,
    options: ProfileApplyCommandOptions = {},
  ): Promise<ProfileApplyResult> {
    return this.runTyped("profile", {
      name,
      options: { ...options, subcommand: "apply" },
    });
  }

  /** Lint a project profile. */
  profileLint(name: string): Promise<ProfileLintResult> {
    return this.runTyped("profile", { name, options: { subcommand: "lint" } });
  }

  /** Run project validation checks with counts-only diagnostics. */
  validate<
    Options extends ReadOptions<ValidateCommandOptions> & { counts: true },
  >(options: Options): ReadPromise<ValidateCountsResult, Options>;
  /** Run project validation checks with complete diagnostic arrays. */
  validate<
    Options extends ReadOptions<ValidateCommandOptions> & { counts?: false } =
      ValidateCommandOptions & { counts?: false },
  >(options?: Options): ReadPromise<ValidateResult, Options>;
  /** Run project validation checks with a dynamically selected projection. */
  validate<Options extends ReadOptions<ValidateCommandOptions>>(
    options: Options,
  ): ReadPromise<ValidateResult | ValidateCountsResult, Options>;
  /** Run project validation checks. */
  validate<
    Options extends ReadOptions<ValidateCommandOptions> =
      ValidateCommandOptions,
  >(
    options: Options = {} as Options,
  ): ReadPromise<ValidateResult | ValidateCountsResult, Options> {
    return this.runTyped("validate", { options });
  }

  /** Run project health checks. */
  health<Options extends ReadOptions<RunHealthOptions> = RunHealthOptions>(
    options: Options = {} as Options,
  ): ReadPromise<HealthResult, Options> {
    return this.runTyped("health", { options });
  }

  /** Run tracker cache/runtime garbage collection. */
  gc(options: GcCommandOptions = {}): Promise<GcResult> {
    return this.runTyped("gc", { options });
  }

  /** Declare, inspect, or evaluate a project assurance contract. */
  assurance(input: AssuranceActionInput): Promise<AssuranceActionResult> {
    return this.runTyped("assurance", { options: { ...input, subcommand: input.action } });
  }

  /** Redact sensitive values while preserving an audited, verified history chain. */
  historyRedact(
    id: string,
    options: HistoryRedactCommandOptions,
  ): Promise<HistoryRedactResult> {
    return this.runTyped("history-redact", { id, options });
  }

  /** Repair and re-anchor one drifted history stream. */
  historyRepair(
    id: string,
    options: HistoryRepairCommandOptions = {},
  ): Promise<HistoryRepairResult> {
    return this.runTyped("history-repair", { id, options });
  }

  /** Scan and repair every drifted history stream in one resilient pass. */
  historyRepairAll(
    options: HistoryRepairCommandOptions = {},
  ): Promise<HistoryRepairAllResult> {
    return this.runTyped("history-repair", {
      options: { ...options, all: true },
    });
  }

  /** Compact one history stream into a verified checkpoint and retained tail. */
  historyCompact(
    id: string,
    options: HistoryCompactCommandOptions = {},
  ): Promise<HistoryCompactResult> {
    return this.runTyped("history-compact", { id, options });
  }

  /** Compact an explicit or policy-selected set of history streams. */
  historyCompactBulk(
    options: HistoryCompactBulkCommandOptions,
  ): Promise<HistoryCompactBulkResult> {
    return this.runTyped("history-compact", { options });
  }

  /** Disposition immutable unknown-author events through append-only audit history. */
  historyAuthorAcknowledge(
    options: AcknowledgeUnknownAuthorEventsOptions,
  ): Promise<{ acknowledged: number; history_path: string }> {
    return this.runTyped("history-author-acknowledge", {
      historyEvent: (options.events ?? []).map(
        (event) => `${event.item_id}:${String(event.line)}`,
      ),
      allActionable: options.all_actionable === true,
      attributedAuthor: options.attributed_author,
      reviewer: options.reviewer,
      reason: options.reason,
    });
  }

  /** Run any typed plan workflow primitive through the shared CLI/MCP engine. */
  plan(
    subcommand: PlanSubcommand,
    id?: string,
    options: PlanCommandOptions = {},
    stepRef?: string,
    reorderTo?: number,
  ): Promise<PlanCommandResult> {
    return this.runTyped("plan", {
      ...(id === undefined ? {} : { id }),
      ...(stepRef === undefined ? {} : { stepRef }),
      ...(reorderTo === undefined ? {} : { reorderTo }),
      options: { ...options, subcommand },
    });
  }

  /** Create a durable plan with optional ordered seed steps. */
  planCreate(options: PlanCommandOptions): Promise<PlanCommandResult> {
    return this.plan("create", undefined, options);
  }

  /** Read a plan using brief, standard, deep, or field-projected output. */
  planShow(
    id: string,
    options: PlanCommandOptions = {},
  ): Promise<PlanCommandResult> {
    return this.plan("show", id, options);
  }

  /** Append an ordered step to a plan. */
  planAddStep(
    id: string,
    options: PlanCommandOptions,
  ): Promise<PlanCommandResult> {
    return this.plan("add-step", id, options);
  }

  /** Update any mutable property of an existing plan step. */
  planUpdateStep(
    id: string,
    stepRef: string,
    options: PlanCommandOptions,
  ): Promise<PlanCommandResult> {
    return this.plan("update-step", id, options, stepRef);
  }

  /** Complete a plan step and record its evidence. */
  planCompleteStep(
    id: string,
    stepRef: string,
    options: PlanCommandOptions = {},
  ): Promise<PlanCommandResult> {
    return this.plan("complete-step", id, options, stepRef);
  }

  /** Block a plan step with an actionable reason. */
  planBlockStep(
    id: string,
    stepRef: string,
    options: PlanCommandOptions,
  ): Promise<PlanCommandResult> {
    return this.plan("block-step", id, options, stepRef);
  }

  /** Reorder a plan step while preserving stable step identifiers. */
  planReorderStep(
    id: string,
    stepRef: string,
    reorderTo: number,
    options: PlanCommandOptions = {},
  ): Promise<PlanCommandResult> {
    return this.plan("reorder-step", id, options, stepRef, reorderTo);
  }

  /** Remove a step from a plan and compact the remaining order. */
  planRemoveStep(
    id: string,
    stepRef: string,
    options: PlanCommandOptions = {},
  ): Promise<PlanCommandResult> {
    return this.plan("remove-step", id, options, stepRef);
  }

  /** Link a tracker item to a plan step. */
  planLink(
    id: string,
    stepRef: string,
    options: PlanCommandOptions,
  ): Promise<PlanCommandResult> {
    return this.plan("link", id, options, stepRef);
  }

  /** Remove tracker-item links from a plan step. */
  planUnlink(
    id: string,
    stepRef: string,
    options: PlanCommandOptions,
  ): Promise<PlanCommandResult> {
    return this.plan("unlink", id, options, stepRef);
  }

  /** Append a durable plan decision. */
  planDecision(
    id: string,
    options: PlanCommandOptions,
  ): Promise<PlanCommandResult> {
    return this.plan("decision", id, options);
  }

  /** Append a durable plan discovery. */
  planDiscovery(
    id: string,
    options: PlanCommandOptions,
  ): Promise<PlanCommandResult> {
    return this.plan("discovery", id, options);
  }

  /** Append a plan validation expectation or result. */
  planValidation(
    id: string,
    options: PlanCommandOptions,
  ): Promise<PlanCommandResult> {
    return this.plan("validation", id, options);
  }

  /** Update the bounded resume context for a stateless future agent. */
  planResume(
    id: string,
    options: PlanCommandOptions,
  ): Promise<PlanCommandResult> {
    return this.plan("resume", id, options);
  }

  /** Approve a plan for execution. */
  planApprove(
    id: string,
    options: PlanCommandOptions = {},
  ): Promise<PlanCommandResult> {
    return this.plan("approve", id, options);
  }

  /** Materialize selected plan steps into governed tracker items. */
  planMaterialize(
    id: string,
    options: PlanCommandOptions,
  ): Promise<PlanCommandResult> {
    return this.plan("materialize", id, options);
  }

  /** Create an item using the same mutation path as `pm create`. Options are contract-typed (pm-x29o): unknown keys and non-scalar values fail `tsc`; runtime-schema custom fields go through the repeatable `field` option, and {@link PmClient.run} stays the wide escape hatch. */
  create(options: PmCreateActionOptions = {}): Promise<CreateResult> {
    return this.runTyped("create", splitFullClientMutationOptions(options));
  }

  /** Update an item using the same mutation path as `pm update`. Options are contract-typed (pm-x29o): unknown keys and non-scalar values fail `tsc`; runtime-schema custom fields go through the repeatable `field` option, and {@link PmClient.run} stays the wide escape hatch. */
  update(
    id: string,
    options: PmUpdateActionOptions = {},
  ): Promise<UpdateResult> {
    return this.runTyped("update", {
      id,
      ...splitFullClientMutationOptions(options),
    });
  }

  /** Close an item using the same mutation path as `pm close`. Options are contract-typed (pm-x29o); the close reason is the positional parameter, so the option bag omits `reason`/`text`. */
  close(
    id: string,
    reason: string,
    options: PmClientCloseActionOptions = {},
  ): Promise<CloseResult> {
    return this.runTyped("close", {
      id,
      reason,
      ...splitFullClientMutationOptions(options),
    });
  }

  /** Claim an item using the same mutation path as `pm claim`. */
  claim(
    id: string,
    options: PmClientFullMutationOptions = {},
  ): Promise<ClaimResult> {
    return this.runTyped("claim", {
      id,
      ...splitFullClientMutationOptions(options),
    });
  }

  /** Atomically claim the highest-ranked available item using the public next-work filters. */
  claimNext(options: ClaimNextOptions = {}): Promise<ClaimNextResult> {
    return this.runTyped("claim", {
      next: true,
      ...splitFullClientMutationOptions(options),
    });
  }

  /** Release an item's active claim using the same mutation path as `pm release`. */
  release(
    id: string,
    options: PmClientFullMutationOptions = {},
  ): Promise<ReleaseResult> {
    return this.runTyped("release", {
      id,
      ...splitFullClientMutationOptions(options),
    });
  }

  /** Copy an item using the same mutation path as `pm copy`. */
  copy(
    id: string,
    options: PmClientFullMutationOptions = {},
  ): Promise<CopyResult> {
    return this.runTyped("copy", {
      id,
      ...splitFullClientMutationOptions(options),
    });
  }

  /** Delete an item using the same mutation path as `pm delete`. */
  delete(
    id: string,
    options: PmClientFullMutationOptions = {},
  ): Promise<DeleteResult> {
    return this.runTyped("delete", {
      id,
      ...splitFullClientMutationOptions(options),
    });
  }

  /** Restore an item to a history version or timestamp using `pm restore`. */
  restore(
    id: string,
    target: string,
    options: PmClientFullMutationOptions = {},
  ): Promise<RestoreResult> {
    return this.runTyped("restore", {
      fullChangedFields: true,
      id,
      options: { ...options, target },
    });
  }

  /** Set, clear, or read workspace focus using the same path as `pm focus`. */
  focus(
    id?: string,
    options: PmClientFullMutationOptions = {},
  ): Promise<FocusResult> {
    return this.runTyped("focus", {
      ...(id === undefined ? {} : { id }),
      ...splitFullClientMutationOptions(options),
    });
  }

  /** Claim an item and transition it to the workspace in-progress status. */
  startTask(
    id: string,
    options: PmClientFullMutationOptions = {},
  ): Promise<StartTaskResult> {
    return this.runTyped("start-task", {
      id,
      ...splitFullClientMutationOptions(options),
    });
  }

  /** Move an item back to the workspace open status and release the claim. */
  pauseTask(
    id: string,
    options: PmClientFullMutationOptions = {},
  ): Promise<PauseTaskResult> {
    return this.runTyped("pause-task", {
      id,
      ...splitFullClientMutationOptions(options),
    });
  }

  /** Close an item and release its active assignment. */
  closeTask(
    id: string,
    reason: string,
    options: PmClientFullMutationOptions = {},
  ): Promise<CloseTaskResult> {
    return this.runTyped("close-task", {
      id,
      reason,
      ...splitFullClientMutationOptions(options),
    });
  }

  /** Run the extension lifecycle surface with the same result shape as `pm extension`. */
  extension(
    target?: string,
    options: ExtensionCommandOptions = {},
  ): Promise<ExtensionCommandResult> {
    return this.runTyped("extension", {
      ...(target === undefined ? {} : { target }),
      options,
    });
  }

  /** List project or global extensions without constructing command-line argv. */
  extensionList(
    options: ExtensionCommandOptions = {},
  ): Promise<ExtensionCommandResult> {
    return this.extension("list", options);
  }

  /** Enable an installed extension using the same action as `pm extension activate`. */
  extensionActivate(
    target: string,
    options: ExtensionCommandOptions = {},
  ): Promise<ExtensionCommandResult> {
    return this.runTyped("extension-activate", { target, options });
  }

  /** Disable an installed extension using the same action as `pm extension deactivate`. */
  extensionDeactivate(
    target: string,
    options: ExtensionCommandOptions = {},
  ): Promise<ExtensionCommandResult> {
    return this.runTyped("extension-deactivate", { target, options });
  }

  /** Run the package lifecycle surface with package vocabulary preserved. */
  package(
    target?: string,
    options: PackageCommandOptions = {},
  ): Promise<PackageCommandResult> {
    return this.runTyped("package", {
      ...(target === undefined ? {} : { target }),
      options: { ...options, vocabulary: "package" },
    });
  }

  /** List project or global packages through the package lifecycle primitive. */
  packageList(
    options: PackageCommandOptions = {},
  ): Promise<PackageCommandResult> {
    return this.package("list", options);
  }

  /** Install a package or extension source using the same action as `pm package install`. */
  packageInstall(
    target: string,
    options: PackageCommandOptions = {},
  ): Promise<PackageCommandResult> {
    return this.runTyped("package-install", { target, options });
  }

  /** Uninstall a package or extension using the same action as `pm package uninstall`. */
  packageUninstall(
    target: string,
    options: PackageCommandOptions = {},
  ): Promise<PackageCommandResult> {
    return this.runTyped("package-uninstall", { target, options });
  }

  /** Read package lifecycle diagnostics using the same action as `pm package doctor`. */
  packageDoctor(
    options: PackageCommandOptions = {},
  ): Promise<PackageCommandResult> {
    return this.runTyped("package-doctor", { options });
  }

  /** Inspect managed package state using the same action as `pm package manage`. */
  packageManage(
    target?: string,
    options: PackageCommandOptions = {},
  ): Promise<PackageCommandResult> {
    return this.runTyped("package-manage", {
      ...(target === undefined ? {} : { target }),
      options,
    });
  }

  /** Describe installed package surfaces using the same action as `pm package describe`. */
  packageDescribe(
    target?: string,
    options: PackageCommandOptions = {},
  ): Promise<PackageCommandResult> {
    return this.runTyped("package-describe", {
      ...(target === undefined ? {} : { target }),
      options,
    });
  }

  /** Reload installed package extensions using the same action as `pm package reload`. */
  packageReload(
    options: PackageCommandOptions = {},
  ): Promise<PackageCommandResult> {
    return this.runTyped("package-reload", { options });
  }

  /** Read bundled package catalog metadata using the same action as `pm package catalog`. */
  packageCatalog(
    options: PackageCommandOptions = {},
  ): Promise<PackageCommandResult> {
    return this.runTyped("package-catalog", { options });
  }

  /** Enable an installed package using the same action as `pm package activate`. */
  packageActivate(
    target: string,
    options: PackageCommandOptions = {},
  ): Promise<PackageCommandResult> {
    return this.runTyped("package-activate", { target, options });
  }

  /** Disable an installed package using the same action as `pm package deactivate`. */
  packageDeactivate(
    target: string,
    options: PackageCommandOptions = {},
  ): Promise<PackageCommandResult> {
    return this.runTyped("package-deactivate", { target, options });
  }

  /** Plan or apply active package migrations with durable workspace receipts. */
  packageMigrate(
    options: PackageCommandOptions = {},
  ): Promise<PackageCommandResult> {
    return this.package(undefined, { ...options, migrate: true });
  }

  /** Upgrade the pm CLI and/or managed packages through the public SDK dispatcher. */
  upgrade(
    target?: string,
    options: UpgradeCommandOptions = {},
  ): Promise<UpgradeResult> {
    return this.runTyped("upgrade", {
      ...(target === undefined ? {} : { target }),
      options,
    });
  }
}

/** Return the same context snapshot produced by `pm context` without constructing a reusable client. */
export function context<
  Options extends ReadOptions<ContextOptions> = ContextOptions,
>(
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<ContextResult, Options> {
  return new PmClient(clientOptions).context(options);
}

/** List items with the MCP/agent compact defaults without constructing a reusable client. */
export function list<Options extends ReadOptions<ListOptions> = ListOptions>(
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<ListResult, Options> {
  return new PmClient(clientOptions).list(options);
}

/** Search items with the MCP/agent compact defaults without constructing a reusable client. */
export function search<
  Options extends ReadOptions<SearchOptions> = SearchOptions,
>(
  query: string,
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<SearchResult, Options> {
  return new PmClient(clientOptions).search(query, options);
}

/** Read one item by id without constructing a reusable client. */
export function get<Options extends ReadOptions<GetOptions> = GetOptions>(
  id: string,
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<GetResult, Options> {
  return new PmClient(clientOptions).get(id, options);
}

/** Return the ranked next-work recommendation produced by `pm next` without constructing a reusable client. */
export function next<Options extends ReadOptions<NextOptions> = NextOptions>(
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<NextResult, Options> {
  return new PmClient(clientOptions).next(options);
}

/** Group matching items with the same semantics as `pm aggregate` without constructing a reusable client. */
export function aggregate<
  Options extends ReadOptions<AggregateOptions> = AggregateOptions,
>(
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<AggregateResult, Options> {
  return new PmClient(clientOptions).aggregate(options);
}

/** Return project tracker statistics with the same sections as `pm stats` without constructing a reusable client. */
export function stats<
  Options extends ReadOptions<StatsCommandOptions> = StatsCommandOptions,
>(
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<StatsResult, Options> {
  return new PmClient(clientOptions).stats(options);
}

/** Discover duplicate clusters without constructing a reusable client. */
export function duplicates(
  options: DuplicatesCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<DuplicatesResult> {
  return new PmClient(clientOptions).duplicates(options);
}

/** List, add, edit, or delete item comments without constructing a reusable client. */
export function comments<
  Options extends ReadOptions<CommentsCommandOptions> = CommentsCommandOptions,
>(
  id: string,
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<CommentsResult, Options> {
  return new PmClient(clientOptions).comments(id, options);
}

/** List or append private item notes without constructing a reusable client. */
export function notes<
  Options extends ReadOptions<NotesCommandOptions> = NotesCommandOptions,
>(
  id: string,
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<NotesResult, Options> {
  return new PmClient(clientOptions).notes(id, options);
}

/** List or append durable item learnings without constructing a reusable client. */
export function learnings(
  id: string,
  options: LearningsCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<LearningsResult> {
  return new PmClient(clientOptions).learnings(id, options);
}

/** Manage linked item files without constructing a reusable client. */
export function files<
  Options extends ReadOptions<FilesCommandOptions> = FilesCommandOptions,
>(
  id: string,
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<FilesResult, Options> {
  return new PmClient(clientOptions).files(id, options);
}

/** Discover linked item files without constructing a reusable client. */
export function filesDiscover(
  id: string,
  options: FilesDiscoverOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<FilesDiscoverResult> {
  return new PmClient(clientOptions).filesDiscover(id, options);
}

/** Resolve items linked to source paths without constructing a reusable client. */
export function filesLookup(
  options: FilesLookupOptions,
  clientOptions: PmClientOptions = {},
): Promise<FilesLookupResult> {
  return new PmClient(clientOptions).filesLookup(options);
}

/** Manage linked item docs without constructing a reusable client. */
export function docs<
  Options extends ReadOptions<DocsCommandOptions> = DocsCommandOptions,
>(
  id: string,
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<DocsResult, Options> {
  return new PmClient(clientOptions).docs(id, options);
}

/** Inspect item dependency relationships without constructing a reusable client. */
export function deps<
  Options extends ReadOptions<DepsCommandOptions> = DepsCommandOptions,
>(
  id: string,
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<DepsResult, Options> {
  return new PmClient(clientOptions).deps(id, options);
}

/** Run bounded workspace graph queries without constructing a reusable client. */
export function graph<
  Options extends ReadOptions<GraphCommandOptions> = GraphCommandOptions,
>(
  subcommand: GraphSubcommand,
  ids: { id?: string; target?: string } = {},
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<GraphResult, Options> {
  return new PmClient(clientOptions).graph(subcommand, ids, options);
}

/** Append markdown/body text to an item without constructing a reusable client. */
export function append(
  id: string,
  body: string,
  options: PmClientFullMutationOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<AppendResult> {
  return new PmClient(clientOptions).append(id, body, options);
}

/** Initialize a workspace without constructing a reusable client. */
export function init(
  prefix?: string,
  options: InitCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<InitResult> {
  return new PmClient(clientOptions).init(prefix, options);
}

/** Read or update configuration without constructing a reusable client. */
export function config(
  scope: string,
  configAction: string,
  key?: string,
  value?: string,
  options: ConfigCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<ConfigResult> {
  return new PmClient(clientOptions).config(
    scope,
    configAction,
    key,
    value,
    options,
  );
}

/** Run the schema customization surface without constructing a reusable client. */
export function schema(
  subcommand: SchemaSubcommand,
  options: PmActionOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<SchemaResult> {
  return new PmClient(clientOptions).schema(subcommand, options);
}

/** List schema definitions without constructing a reusable client. */
export function schemaList(
  clientOptions: PmClientOptions = {},
): Promise<SchemaListResult> {
  return new PmClient(clientOptions).schemaList();
}

/** Show a schema item type without constructing a reusable client. */
export function schemaShow(
  name: string,
  clientOptions: PmClientOptions = {},
): Promise<SchemaShowResult> {
  return new PmClient(clientOptions).schemaShow(name);
}

/** Register a custom item type without constructing a reusable client. */
export function schemaAddType(
  name: string,
  options: SchemaAddTypeCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<SchemaAddTypeResult> {
  return new PmClient(clientOptions).schemaAddType(name, options);
}

/** Remove a custom item type without constructing a reusable client. */
export function schemaRemoveType(
  name: string,
  options: SchemaRemoveTypeCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<SchemaRemoveTypeResult> {
  return new PmClient(clientOptions).schemaRemoveType(name, options);
}

/** Register a custom status without constructing a reusable client. */
export function schemaAddStatus(
  name: string,
  options: SchemaAddStatusCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<SchemaAddStatusResult> {
  return new PmClient(clientOptions).schemaAddStatus(name, options);
}

/** Remove a custom status without constructing a reusable client. */
export function schemaRemoveStatus(
  name: string,
  options: SchemaRemoveStatusCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<SchemaRemoveStatusResult> {
  return new PmClient(clientOptions).schemaRemoveStatus(name, options);
}

/** Register a custom field without constructing a reusable client. */
export function schemaAddField(
  name: string,
  options: SchemaAddFieldCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<SchemaAddFieldResult> {
  return new PmClient(clientOptions).schemaAddField(name, options);
}

/** Remove a custom field without constructing a reusable client. */
export function schemaRemoveField(
  name: string,
  options: SchemaRemoveFieldCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<SchemaRemoveFieldResult> {
  return new PmClient(clientOptions).schemaRemoveField(name, options);
}

/** List custom fields without constructing a reusable client. */
export function schemaListFields(
  clientOptions: PmClientOptions = {},
): Promise<SchemaListFieldsResult> {
  return new PmClient(clientOptions).schemaListFields();
}

/** Show a custom field without constructing a reusable client. */
export function schemaShowField(
  name: string,
  clientOptions: PmClientOptions = {},
): Promise<SchemaShowFieldResult> {
  return new PmClient(clientOptions).schemaShowField(name);
}

/** Apply a schema preset without constructing a reusable client. */
export function schemaApplyPreset(
  typePreset: string,
  options: SchemaApplyPresetCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<SchemaApplyPresetResult> {
  return new PmClient(clientOptions).schemaApplyPreset(typePreset, options);
}

/** Infer schema types without constructing a reusable client. */
export function schemaInferTypes(
  options: SchemaAddTypeInferCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<SchemaAddTypeInferResult> {
  return new PmClient(clientOptions).schemaInferTypes(options);
}

/** Rename a custom item type without constructing a reusable client. */
export function schemaRenameType(
  from: string,
  to: string,
  options: RunSchemaEvolutionMigrationOptions,
  clientOptions: PmClientOptions = {},
): Promise<SchemaEvolutionMigrationResult> {
  return new PmClient(clientOptions).schemaRenameType(from, to, options);
}

/** Rename a custom field without constructing a reusable client. */
export function schemaRenameField(
  from: string,
  to: string,
  options: RunSchemaEvolutionMigrationOptions,
  type?: string,
  clientOptions: PmClientOptions = {},
): Promise<SchemaEvolutionMigrationResult> {
  return new PmClient(clientOptions).schemaRenameField(from, to, options, type);
}

/** Remap a custom status without constructing a reusable client. */
export function schemaRemapStatus(
  from: string,
  to: string,
  options: RunSchemaEvolutionMigrationOptions,
  clientOptions: PmClientOptions = {},
): Promise<SchemaEvolutionMigrationResult> {
  return new PmClient(clientOptions).schemaRemapStatus(from, to, options);
}

/** Show a custom status without constructing a reusable client. */
export function schemaShowStatus(
  name: string,
  clientOptions: PmClientOptions = {},
): Promise<SchemaShowStatusResult> {
  return new PmClient(clientOptions).schemaShowStatus(name);
}

/** Run the profile customization surface without constructing a reusable client. */
export function profile(
  subcommand: ProfileSubcommand,
  options: PmActionOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<ProfileResult> {
  return new PmClient(clientOptions).profile(subcommand, options);
}

/** List profiles without constructing a reusable client. */
export function profileList(
  clientOptions: PmClientOptions = {},
): Promise<ProfileListResult> {
  return new PmClient(clientOptions).profileList();
}

/** Show a profile without constructing a reusable client. */
export function profileShow(
  name: string,
  clientOptions: PmClientOptions = {},
): Promise<ProfileShowResult> {
  return new PmClient(clientOptions).profileShow(name);
}

/** Apply a profile without constructing a reusable client. */
export function profileApply(
  name: string,
  options: ProfileApplyCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<ProfileApplyResult> {
  return new PmClient(clientOptions).profileApply(name, options);
}

/** Lint a profile without constructing a reusable client. */
export function profileLint(
  name: string,
  clientOptions: PmClientOptions = {},
): Promise<ProfileLintResult> {
  return new PmClient(clientOptions).profileLint(name);
}

/** Validate a tracker without constructing a reusable client using counts-only diagnostics. */
export function validate<
  Options extends ReadOptions<ValidateCommandOptions> & { counts: true },
>(
  options: Options,
  clientOptions?: PmClientOptions,
): ReadPromise<ValidateCountsResult, Options>;
/** Validate a tracker without constructing a reusable client using complete diagnostics. */
export function validate<
  Options extends ReadOptions<ValidateCommandOptions> & { counts?: false } =
    ValidateCommandOptions & { counts?: false },
>(
  options?: Options,
  clientOptions?: PmClientOptions,
): ReadPromise<ValidateResult, Options>;
/** Validate a tracker without constructing a reusable client with a dynamic projection. */
export function validate<Options extends ReadOptions<ValidateCommandOptions>>(
  options: Options,
  clientOptions?: PmClientOptions,
): ReadPromise<ValidateResult | ValidateCountsResult, Options>;
/** Validate a tracker without constructing a reusable client. */
export function validate<
  Options extends ReadOptions<ValidateCommandOptions> = ValidateCommandOptions,
>(
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<ValidateResult | ValidateCountsResult, Options> {
  return new PmClient(clientOptions).validate(options);
}

/** Run health checks without constructing a reusable client. */
export function health<
  Options extends ReadOptions<RunHealthOptions> = RunHealthOptions,
>(
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<HealthResult, Options> {
  return new PmClient(clientOptions).health(options);
}

/** Run cache/runtime garbage collection without constructing a reusable client. */
export function gc(
  options: GcCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<GcResult> {
  return new PmClient(clientOptions).gc(options);
}

/** Redact one history stream without constructing a reusable client. */
export function historyRedact(
  id: string,
  options: HistoryRedactCommandOptions,
  clientOptions: PmClientOptions = {},
): Promise<HistoryRedactResult> {
  return new PmClient(clientOptions).historyRedact(id, options);
}

/** Repair one history stream without constructing a reusable client. */
export function historyRepair(
  id: string,
  options: HistoryRepairCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<HistoryRepairResult> {
  return new PmClient(clientOptions).historyRepair(id, options);
}

/** Repair all drifted history streams without constructing a reusable client. */
export function historyRepairAll(
  options: HistoryRepairCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<HistoryRepairAllResult> {
  return new PmClient(clientOptions).historyRepairAll(options);
}

/** Compact one history stream without constructing a reusable client. */
export function historyCompact(
  id: string,
  options: HistoryCompactCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<HistoryCompactResult> {
  return new PmClient(clientOptions).historyCompact(id, options);
}

/** Compact selected history streams without constructing a reusable client. */
export function historyCompactBulk(
  options: HistoryCompactBulkCommandOptions,
  clientOptions: PmClientOptions = {},
): Promise<HistoryCompactBulkResult> {
  return new PmClient(clientOptions).historyCompactBulk(options);
}

/** Create an item without constructing a reusable client. */
export function create(
  options: PmCreateActionOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<CreateResult> {
  return new PmClient(clientOptions).create(options);
}

/** Update an item without constructing a reusable client. */
export function update(
  id: string,
  options: PmUpdateActionOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<UpdateResult> {
  return new PmClient(clientOptions).update(id, options);
}

/** Close an item without constructing a reusable client. */
export function close(
  id: string,
  reason: string,
  options: PmClientCloseActionOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<CloseResult> {
  return new PmClient(clientOptions).close(id, reason, options);
}

/** Claim an item without constructing a reusable client. */
export function claim(
  id: string,
  options: PmClientFullMutationOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<ClaimResult> {
  return new PmClient(clientOptions).claim(id, options);
}

/** Atomically select and claim ranked work without constructing a reusable client. */
export function claimNext(
  options: ClaimNextOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<ClaimNextResult> {
  return new PmClient(clientOptions).claimNext(options);
}

/** Release an item's active claim without constructing a reusable client. */
export function release(
  id: string,
  options: PmClientFullMutationOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<ReleaseResult> {
  return new PmClient(clientOptions).release(id, options);
}

/** Copy an item without constructing a reusable client. */
export function copy(
  id: string,
  options: PmClientFullMutationOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<CopyResult> {
  return new PmClient(clientOptions).copy(id, options);
}

/** Delete an item without constructing a reusable client. */
export function deleteItem(
  id: string,
  options: PmClientFullMutationOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<DeleteResult> {
  return new PmClient(clientOptions).delete(id, options);
}

/** Restore an item without constructing a reusable client. */
export function restore(
  id: string,
  target: string,
  options: PmClientFullMutationOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<RestoreResult> {
  return new PmClient(clientOptions).restore(id, target, options);
}

/** Set, clear, or read workspace focus without constructing a reusable client. */
export function focus(
  id?: string,
  options: PmClientFullMutationOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<FocusResult> {
  return new PmClient(clientOptions).focus(id, options);
}

/** Claim an item and transition it to in-progress without constructing a client. */
export function startTask(
  id: string,
  options: PmClientFullMutationOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<StartTaskResult> {
  return new PmClient(clientOptions).startTask(id, options);
}

/** Move an item to open and release it without constructing a client. */
export function pauseTask(
  id: string,
  options: PmClientFullMutationOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<PauseTaskResult> {
  return new PmClient(clientOptions).pauseTask(id, options);
}

/** Close an item and release its active assignment without constructing a client. */
export function closeTask(
  id: string,
  reason: string,
  options: PmClientFullMutationOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<CloseTaskResult> {
  return new PmClient(clientOptions).closeTask(id, reason, options);
}

/** Run the extension lifecycle surface without constructing a reusable client. */
export function extension(
  target?: string,
  options: ExtensionCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<ExtensionCommandResult> {
  return new PmClient(clientOptions).extension(target, options);
}

/** List extensions without constructing a reusable client. */
export function extensionList(
  options: ExtensionCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<ExtensionCommandResult> {
  return new PmClient(clientOptions).extensionList(options);
}

/** Enable an extension without constructing a reusable client. */
export function extensionActivate(
  target: string,
  options: ExtensionCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<ExtensionCommandResult> {
  return new PmClient(clientOptions).extensionActivate(target, options);
}

/** Disable an extension without constructing a reusable client. */
export function extensionDeactivate(
  target: string,
  options: ExtensionCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<ExtensionCommandResult> {
  return new PmClient(clientOptions).extensionDeactivate(target, options);
}

/** Run the package lifecycle surface without constructing a reusable client. */
export function packageLifecycle(
  target?: string,
  options: PackageCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<PackageCommandResult> {
  return new PmClient(clientOptions).package(target, options);
}

/** List packages without constructing a reusable client. */
export function packageList(
  options: PackageCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<PackageCommandResult> {
  return new PmClient(clientOptions).packageList(options);
}

/** Install a package or extension source without constructing a reusable client. */
export function packageInstall(
  target: string,
  options: PackageCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<PackageCommandResult> {
  return new PmClient(clientOptions).packageInstall(target, options);
}

/** Uninstall a package or extension without constructing a reusable client. */
export function packageUninstall(
  target: string,
  options: PackageCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<PackageCommandResult> {
  return new PmClient(clientOptions).packageUninstall(target, options);
}

/** Read package lifecycle diagnostics without constructing a reusable client. */
export function packageDoctor(
  options: PackageCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<PackageCommandResult> {
  return new PmClient(clientOptions).packageDoctor(options);
}

/** Inspect managed package state without constructing a reusable client. */
export function packageManage(
  target?: string,
  options: PackageCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<PackageCommandResult> {
  return new PmClient(clientOptions).packageManage(target, options);
}

/** Describe package surfaces without constructing a reusable client. */
export function packageDescribe(
  target?: string,
  options: PackageCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<PackageCommandResult> {
  return new PmClient(clientOptions).packageDescribe(target, options);
}

/** Reload package extensions without constructing a reusable client. */
export function packageReload(
  options: PackageCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<PackageCommandResult> {
  return new PmClient(clientOptions).packageReload(options);
}

/** Read bundled package catalog metadata without constructing a reusable client. */
export function packageCatalog(
  options: PackageCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<PackageCommandResult> {
  return new PmClient(clientOptions).packageCatalog(options);
}

/** Enable a package without constructing a reusable client. */
export function packageActivate(
  target: string,
  options: PackageCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<PackageCommandResult> {
  return new PmClient(clientOptions).packageActivate(target, options);
}

/** Disable a package without constructing a reusable client. */
export function packageDeactivate(
  target: string,
  options: PackageCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<PackageCommandResult> {
  return new PmClient(clientOptions).packageDeactivate(target, options);
}

/** Upgrade the pm CLI and/or managed packages without constructing a reusable client. */
export function upgrade(
  target?: string,
  options: UpgradeCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<UpgradeResult> {
  return new PmClient(clientOptions).upgrade(target, options);
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
  const cacheKey = buildWorkspaceExtensionRegistrationsCacheKey(
    pmRoot,
    settings,
    cwd,
  );
  return memoizeWorkspaceExtensionRegistrations(cacheKey, () =>
    loadWorkspaceExtensionRegistrations(pmRoot, settings, cwd),
  );
}

/** Implements get workspace contracts for the public runtime surface of this module. */
export async function getWorkspaceContracts(
  pmRoot: string,
  options: WorkspaceContractsOptions = {},
): Promise<WorkspaceContracts> {
  const settings = await readSettings(pmRoot);
  const extensionRegistrations =
    options.extensionRegistrations ??
    (options.noExtensions === true
      ? null
      : await resolveWorkspaceExtensionRegistrations(
          pmRoot,
          settings,
          options.cwd,
        ));
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    extensionRegistrations,
  );
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const fieldRegistry = resolveRuntimeFieldRegistry(settings.schema);

  return {
    types: [...typeRegistry.types],
    statuses: statusRegistry.definitions.map((definition) => definition.id),
    openStatus: statusRegistry.open_status,
    closeStatus: statusRegistry.close_status,
    canceledStatus: statusRegistry.canceled_status,
    fields: buildWorkspaceFieldContracts(fieldRegistry.definitions),
    extensionCommands: buildWorkspaceExtensionCommandContracts(
      extensionRegistrations?.commands ?? [],
    ),
  };
}

/** Implements get contracts for the public runtime surface of this module. */
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

/** Read a required non-empty string from an action argument bag. */
export function readRequiredString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = readString(args, key);
  if (!value) {
    throw new PmCliError(`Missing required argument: ${key}`, 64);
  }
  return value;
}

// pm-zpoyg9: request-local registries permit independent activation cycles to
// overlap, but explicit cwd calls still mutate process-global state. The gate
// retains reader concurrency while making cwd mutation exclusive against every
// activation path, including callers that resolve paths through process.cwd().
const extensionActivationGate = createAsyncReadWriteGate();
const activeExtensionScope = new AsyncLocalStorage<boolean>();

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
  packages: readonly PmContextIntentPackageModule[];
};

/** Publishes empty active extension registries so built-in fallback actions cannot observe stale or partially published extension state from a failed activation cycle. */
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
 * isolated through an async-local registry context. Calls with an explicit `cwd`
 * acquire exclusive access because `process.chdir` is process-global; calls that use
 * workspace/path arguments share read access and remain concurrent when no cwd writer
 * was already scheduled.
 */
async function withActiveExtensions<T>(
  global: GlobalOptions,
  explicitCwd: string | undefined,
  resolutionCwd: string,
  run: (active: ActiveExtensionRuntime | null) => Promise<T>,
): Promise<T> {
  return runWithIsolatedExtensionRuntime(() =>
    explicitCwd === undefined
      ? extensionActivationGate.read(() =>
          withActiveExtensionsExclusively(global, resolutionCwd, run),
        )
      : extensionActivationGate.write(() =>
          withCwd(explicitCwd, () =>
            withActiveExtensionsExclusively(global, resolutionCwd, run),
          ),
        ),
  );
}

/** Options for executing direct SDK work inside the workspace extension lifecycle. */
export interface ActiveExtensionScopeOptions {
  /** Workspace resolution directory; defaults to the process working directory. */
  cwd?: string;
  /** Explicit tracker root override for sandboxed or test execution. */
  path?: string;
  /** Disable workspace extension activation for this scope. */
  noExtensions?: boolean;
}

/**
 * Execute direct SDK work while workspace extensions are loaded and published
 * to request-local active registries. Use this for SDK operations that bypass
 * {@link runAction} but still create or update extension-owned item shapes.
 */
export async function runWithActiveExtensions<T>(
  options: ActiveExtensionScopeOptions,
  run: () => Promise<T>,
): Promise<T> {
  const explicitCwd = options.cwd;
  const resolutionCwd = explicitCwd ?? process.cwd();
  return withActiveExtensions(
    globalOptions({ path: options.path, noExtensions: options.noExtensions }),
    explicitCwd,
    resolutionCwd,
    () => activeExtensionScope.run(true, run),
  );
}

/**
 * Body of one activation cycle. {@link withActiveExtensions} supplies an
 * async-local registry context; explicit-cwd callers additionally hold the
 * process-wide cwd queue. Returns early with `run(null)` when extensions are
 * disabled or no workspace
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
  const pmRoot = resolvePmRoot(cwd, global.path);
  if (global.noExtensions) {
    resetActiveExtensionRegistries();
    return runWithDiscoveredContextIntentContracts({ pmRoot }, () => run(null));
  }
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    resetActiveExtensionRegistries();
    return run(null);
  }
  let active: ActiveExtensionRuntime | null = null;
  let activated:
    | {
        loadResult: Awaited<ReturnType<typeof loadExtensions>>;
        activationResult: ExtensionActivationResult;
      }
    | undefined;
  try {
    const settings = await readSettings(pmRoot);
    const loadResult = await loadExtensions({
      pmRoot,
      settings,
      cwd,
      noExtensions: false,
    });
    const activationResult = await activateExtensions({
      ...loadResult,
      loaded: loadResult.loaded,
    });
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
    active = {
      registrations: activationResult.registrations,
      commands: activationResult.commands,
      pmRoot,
      packages: loadResult.loaded,
    };
  } catch (error) {
    resetActiveExtensionRegistries();
    // CLI parity (loadRuntimeExtensionSnapshot): a load/activate failure must never
    // break a built-in action — fall back to running with no active extensions. Surface
    // the cause on stderr so a broken extension is diagnosable instead of being silently
    // indistinguishable from a workspace that simply has no extensions.
    console.error(
      "[pm-sdk] extension activation failed; continuing without active extensions:",
      error,
    );
  }
  try {
    return await runWithDiscoveredContextIntentContracts(
      { pmRoot, packages: active?.packages },
      () => run(active),
    );
  } finally {
    // Reset the process-global active registries FIRST so a torn-down extension's
    // overrides/hooks cannot leak into a later request in this long-running server
    // (for example a subsequent pm_list/pm_create) even if teardown below misbehaves.
    resetActiveExtensionRegistries();
    // Best-effort teardown of extensions that activated successfully. Skipped when
    // activation never completed (nothing was set up); guarded so an unexpected throw
    // cannot escape the finally.
    if (activated) {
      await deactivateExtensions(
        activated.loadResult,
        activated.activationResult,
      ).catch(() => undefined);
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
    throw new PmCliError(
      `Unsupported native pm action: ${action}`,
      EXIT_CODE.USAGE,
    );
  }
  const normalizedAction = normalizeActionName(action);
  const definition = active.registrations.commands.find(
    (entry) => normalizeActionName(entry.action) === normalizedAction,
  );
  const command =
    definition?.command ??
    active.commands.handlers.find(
      (entry) => normalizeActionName(entry.command) === normalizedAction,
    )?.command;
  if (!command) {
    throw new PmCliError(
      `Unsupported native pm action: ${action}`,
      EXIT_CODE.USAGE,
    );
  }
  const handlerResult = await runActiveCommandHandler({
    command: normalizeCommandPath(command),
    args: readStringArray(options.args ?? args.args),
    options: extensionOptionsFromArgs(args, options),
    global,
    pm_root: active.pmRoot,
    sdk: createExtensionCommandSdk(
      active.pmRoot,
      PmClient.forActiveExtensionHost({
        pmRoot: active.pmRoot,
        author:
          typeof global.author === "string" && global.author.trim()
            ? global.author.trim()
            : "pm-extension",
      }),
    ),
  });
  if (!handlerResult.handled) {
    const suffix =
      handlerResult.warnings.length > 0
        ? ` (${handlerResult.warnings.join(", ")})`
        : "";
    throw new PmCliError(
      `Unsupported native pm action: ${action}${suffix}`,
      EXIT_CODE.USAGE,
    );
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

const WORKSPACE_CONTRACTS_CACHE_PRESERVING_ACTIONS = new Set([
  "activity",
  "aggregate",
  "context",
  "contracts",
  "deps",
  "files-discover",
  "get",
  "graph",
  "health",
  "history",
  "list",
  "next",
  "search",
  "stats",
  "telemetry",
  "validate",
]);

function resolveSdkActionInput(args: PmActionInput): {
  action: string;
  args: Record<string, unknown>;
} {
  const rawAction = readRequiredString(args, "action");
  const normalizedAction = normalizeActionName(rawAction);
  const alias = getOwnHandler(SDK_ACTION_ALIASES, normalizedAction);
  const action = alias?.action ?? normalizedAction;
  const resolvedArgs: Record<string, unknown> = { ...args, action };
  if (alias?.options !== undefined) {
    resolvedArgs.options = { ...alias.options, ...asRecordClone(args.options) };
  }
  if (action === "package") {
    resolvedArgs.options = {
      ...asRecordClone(resolvedArgs.options),
      vocabulary: "package",
    };
  }
  return { action, args: resolvedArgs };
}

function shouldInvalidateWorkspaceContractsCacheAfterAction(
  action: string,
): boolean {
  return !WORKSPACE_CONTRACTS_CACHE_PRESERVING_ACTIONS.has(
    normalizeActionName(action),
  );
}

/** Execute one native or extension-contributed pm action in-process. */
export async function runAction(args: PmActionInput): Promise<unknown> {
  const resolved = resolveSdkActionInput(args);
  const global = globalOptions(resolved.args);
  const invalidateWorkspaceContractsCache =
    shouldInvalidateWorkspaceContractsCacheAfterAction(resolved.action);
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
    if (
      (args as PmActionInput & { [ACTIVE_EXTENSION_HOST_CONTEXT]?: true })[
        ACTIVE_EXTENSION_HOST_CONTEXT
      ] === true ||
      activeExtensionScope.getStore() === true
    ) {
      return await dispatchAction(resolved.action, resolved.args, global, null);
    }
    return await withActiveExtensions(
      global,
      explicitCwd,
      resolutionCwd,
      (activeExtensions) =>
        dispatchAction(
          resolved.action,
          resolved.args,
          global,
          activeExtensions,
        ),
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

type McpActionHandler = (
  ctx: McpActionDispatchContext,
) => Promise<unknown> | unknown;

function getOwnHandler<T>(
  handlers: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.prototype.hasOwnProperty.call(handlers, key)
    ? handlers[key]
    : undefined;
}

function readMcpTarget(ctx: McpActionDispatchContext): string | undefined {
  return readString(ctx.args, "target") ?? readString(ctx.options, "target");
}

function requireMcpItemId(
  ctx: McpActionDispatchContext,
  source: Record<string, unknown> = ctx.options,
): string {
  return ctx.id ?? readRequiredString(source, "id");
}

async function runMcpListAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const listOptions = applyContextIntentProjection("list", ctx.options);
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

async function runMcpSearchAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const searchOptions = applyContextIntentProjection(
    "search",
    ctx.options,
  ) as Parameters<typeof runSearch>[1];
  if (
    searchOptions.compact === undefined &&
    searchOptions.full === undefined &&
    searchOptions.fields === undefined
  ) {
    searchOptions.compact = true;
  }
  return withQuerySummary(
    (await runSearch(
      readRequiredString(ctx.args, "query"),
      searchOptions,
      ctx.global,
    )) as unknown as Record<string, unknown>,
    searchOptions as Record<string, unknown>,
  );
}

async function runMcpCreateAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(
    ctx.args,
    ctx.options,
  );
  return projectMutationResult(
    await runCreate(runnerOptions as never, ctx.global),
    {
      changedFields,
      compactEnvelope: changedFields === "compact" && !idOnly,
      idOnly,
    },
  );
}

async function runMcpCopyAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(
    ctx.args,
    ctx.options,
  );
  const copyOptions: Record<string, unknown> = {
    ...runnerOptions,
    ...(runnerOptions.title === undefined && typeof ctx.args.title === "string"
      ? { title: ctx.args.title }
      : {}),
    ...(runnerOptions.message === undefined &&
    typeof ctx.args.message === "string"
      ? { message: ctx.args.message }
      : {}),
  };
  return projectMutationResult(
    await runCopy(
      requireMcpItemId(ctx, copyOptions),
      copyOptions as never,
      ctx.global,
    ),
    {
      changedFields,
      compactEnvelope: changedFields === "compact" && !idOnly,
      idOnly,
    },
  );
}

async function runMcpUpdateAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(
    ctx.args,
    ctx.options,
  );
  return projectMutationResult(
    await runUpdate(
      requireMcpItemId(ctx, runnerOptions),
      runnerOptions as never,
      ctx.global,
    ),
    {
      changedFields,
      compactEnvelope: changedFields === "compact" && !idOnly,
      idOnly,
    },
  );
}

async function runMcpCloseAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(
    ctx.args,
    ctx.options,
  );
  const closeReason =
    readString(ctx.args, "reason") ??
    readString(ctx.args, "text") ??
    readString(runnerOptions, "reason") ??
    readString(runnerOptions, "text");
  return projectMutationResult(
    await runClose(
      requireMcpItemId(ctx, runnerOptions),
      closeReason,
      runnerOptions as never,
      ctx.global,
    ),
    {
      changedFields,
      compactEnvelope: changedFields === "compact" && !idOnly,
      idOnly,
    },
  );
}

function runMcpCommentsAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const commentOptions = normalizeAnnotationTransportOptions(ctx.options);
  const isListing =
    commentOptions.add === undefined &&
    commentOptions.stdin === undefined &&
    commentOptions.file === undefined &&
    commentOptions.edit === undefined &&
    commentOptions.delete === undefined;
  if (isListing) {
    commentOptions.includeMeta = true;
    if (
      commentOptions.limit === undefined &&
      commentOptions.fullHistory !== true
    ) {
      commentOptions.limit = "20";
    }
  }
  return runComments(requireMcpItemId(ctx), commentOptions, ctx.global);
}

function runMcpFilesLookupAction(
  ctx: McpActionDispatchContext,
  paths: string[],
): Promise<FilesLookupResult> {
  return runFilesLookup(
    runtimeFilesLookupOptions(ctx.options, paths, parseMcpInteger),
    ctx.global,
  );
}

function runMcpFilesAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const lookupPaths = readStringArray(ctx.options.lookupPath);
  if (lookupPaths && lookupPaths.length > 0) {
    return runMcpFilesLookupAction(ctx, lookupPaths);
  }
  const fileId = requireMcpItemId(ctx);
  return ctx.options.discover === true
    ? runFilesDiscover(
        fileId,
        withFilesDiscoveryOptions(ctx.options),
        ctx.global,
      )
    : runFiles(fileId, withAddNoteOption(ctx.options), ctx.global);
}

function runMcpTelemetryAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  return runTelemetry(
    {
      subcommand:
        readString(ctx.args, "subcommand") ??
        readString(ctx.options, "subcommand"),
      limit: resolveRuntimeLimit(ctx.args, ctx.options),
    },
    ctx.global,
  );
}

function runMcpHealthAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const healthOptions: Record<string, unknown> = { ...ctx.options };
  if (
    healthOptions.brief === undefined &&
    healthOptions.summary === undefined &&
    healthOptions.full === undefined
  ) {
    healthOptions.summary = true;
  }
  return runHealth(ctx.global, healthOptions as never);
}

function runMcpConfigAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const configAction =
    readString(ctx.args, "configAction") ??
    readString(ctx.options, "configAction") ??
    readString(ctx.options, "action");
  if (configAction === undefined) {
    throw new PmCliError("Missing required argument: configAction", 64);
  }
  return runConfig(
    readString(ctx.args, "scope") ??
      readString(ctx.options, "scope") ??
      "project",
    configAction,
    readString(ctx.args, "key") ?? readString(ctx.options, "key"),
    ctx.options,
    ctx.global,
    readString(ctx.args, "value") ?? readString(ctx.options, "value"),
  );
}

function runMcpActivityAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const activityOptions = { ...ctx.options } as Parameters<
    typeof runActivity
  >[0] & { full?: unknown };
  if (activityOptions.compact === undefined) {
    activityOptions.compact = activityOptions.full === true ? false : true;
  }
  delete activityOptions.full;
  return runActivity(activityOptions, ctx.global);
}

function parseMcpIntegerPrefix(
  value: unknown,
  label: string,
): number | undefined {
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
  const subcommand =
    readString(ctx.args, "subcommand") ??
    readRequiredString(ctx.options, "subcommand");
  const planRecord = ctx.options as Record<string, unknown>;
  return runPlan({
    subcommand: subcommand as never,
    id:
      typeof ctx.id === "string"
        ? ctx.id
        : typeof planRecord.id === "string"
          ? (planRecord.id as string)
          : undefined,
    stepRef: readMcpPlanStepRef(ctx),
    reorderTo: parseMcpIntegerPrefix(
      planRecord.reorderTo ?? ctx.args.reorderTo,
      "plan reorderTo",
    ),
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

function createMcpSchemaContext(
  ctx: McpActionDispatchContext,
): McpSchemaContext {
  const subcommand =
    readString(ctx.args, "subcommand") ??
    readRequiredString(ctx.options, "subcommand");
  const aliasSource = ctx.args.alias ?? ctx.options.alias;
  return {
    ctx,
    subcommand: subcommand.trim().toLowerCase(),
    name: readString(ctx.args, "name") ?? readString(ctx.options, "name"),
    author: readString(ctx.args, "author") ?? readString(ctx.options, "author"),
    force: ctx.args.force === true || ctx.options.force === true,
    aliases:
      aliasSource === undefined ? undefined : readStringArray(aliasSource),
  };
}

function runMcpSchemaReadOrRemoveAction(
  schema: McpSchemaContext,
): Promise<unknown> | unknown | null {
  const { ctx, subcommand, name, author, force } = schema;
  const simpleHandlers: Record<string, () => Promise<unknown> | unknown> = {
    list: () => runSchemaList(ctx.global),
    show: () => runSchemaShow(name, ctx.global),
    "show-status": () => runSchemaShowStatus(name, ctx.global),
    "list-fields": () => runSchemaListFields(ctx.global),
    "show-field": () => runSchemaShowField(name, ctx.global),
    "remove-type": () =>
      runSchemaRemoveType(name, { author, force }, ctx.global),
    "remove-field": () =>
      runSchemaRemoveField(name, { author, force }, ctx.global),
    "remove-status": () =>
      runSchemaRemoveStatus(name, { author, force }, ctx.global),
    "apply-preset": () =>
      runSchemaApplyPreset(
        readString(ctx.args, "typePreset") ??
          readString(ctx.options, "typePreset"),
        { author, force },
        ctx.global,
      ),
  };
  const handler = getOwnHandler(simpleHandlers, subcommand);
  return handler ? handler() : null;
}

function runMcpSchemaAddFieldAction(
  schema: McpSchemaContext,
): Promise<unknown> {
  const { ctx, name, author, force, aliases } = schema;
  const commandsSource = ctx.args.commands ?? ctx.options.commands;
  const requiredTypesSource =
    ctx.args.requiredTypes ?? ctx.options.requiredTypes;
  return runSchemaAddField(
    name,
    {
      type:
        readString(ctx.args, "fieldType") ??
        readString(ctx.options, "fieldType"),
      commands:
        commandsSource === undefined
          ? undefined
          : readStringArray(commandsSource),
      description:
        readString(ctx.args, "description") ??
        readString(ctx.options, "description"),
      cliFlag:
        readString(ctx.args, "cliFlag") ?? readString(ctx.options, "cliFlag"),
      alias: aliases,
      required: ctx.args.required === true || ctx.options.required === true,
      requiredOnCreate:
        ctx.args.requiredOnCreate === true ||
        ctx.options.requiredOnCreate === true,
      allowUnset: !(
        ctx.args.allowUnset === false || ctx.options.allowUnset === false
      ),
      requiredTypes:
        requiredTypesSource === undefined
          ? undefined
          : readStringArray(requiredTypesSource),
      author,
      force,
    },
    ctx.global,
  );
}

function runMcpSchemaAddStatusAction(
  schema: McpSchemaContext,
): Promise<unknown> {
  const { ctx, name, author, force, aliases } = schema;
  const roleSource = ctx.args.role ?? ctx.options.role;
  return runSchemaAddStatus(
    name,
    {
      role: roleSource === undefined ? undefined : readStringArray(roleSource),
      alias: aliases,
      description:
        readString(ctx.args, "description") ??
        readString(ctx.options, "description"),
      order: parseMcpInteger(
        ctx.args.order ?? ctx.options.order,
        "schema add-status order",
      ),
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
      description:
        readString(ctx.args, "description") ??
        readString(ctx.options, "description"),
      defaultStatus:
        readString(ctx.args, "defaultStatus") ??
        readString(ctx.args, "default_status") ??
        readString(ctx.options, "defaultStatus") ??
        readString(ctx.options, "default_status"),
      folder:
        readString(ctx.args, "folder") ?? readString(ctx.options, "folder"),
      alias: aliases,
      author,
      force,
    },
    ctx.global,
  );
}

function runMcpSchemaMigrationAction(
  schema: McpSchemaContext,
): Promise<SchemaEvolutionMigrationResult> {
  const { ctx, subcommand, name, author, force } = schema;
  const to =
    readString(ctx.args, "to") ?? readRequiredString(ctx.options, "to");
  const migrationId =
    readString(ctx.args, "migrationId") ??
    readString(ctx.args, "migration_id") ??
    readString(ctx.options, "migrationId") ??
    readString(ctx.options, "migration_id");
  const fieldTypeScope =
    readString(ctx.args, "fieldTypeScope") ??
    readString(ctx.options, "fieldTypeScope") ??
    readString(ctx.args, "type") ??
    readString(ctx.options, "type");
  const request: SchemaEvolutionMigrationRequest =
    subcommand === "rename-type"
      ? { kind: "rename-type", from: name ?? "", to }
      : subcommand === "rename-field"
        ? {
            kind: "rename-field",
            from: name ?? "",
            to,
            ...(fieldTypeScope === undefined ? {} : { type: fieldTypeScope }),
          }
        : { kind: "remap-status", from: name ?? "", to };
  return runSchemaEvolutionMigration(
    request,
    {
      migrationId,
      dryRun: ctx.args.dryRun === true || ctx.options.dryRun === true,
      author,
      force,
    },
    ctx.global,
  );
}

function runMcpSchemaAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> | unknown {
  const schema = createMcpSchemaContext(ctx);
  const simpleResult = runMcpSchemaReadOrRemoveAction(schema);
  if (simpleResult !== null) {
    return simpleResult;
  }
  if (
    schema.subcommand === "rename-type" ||
    schema.subcommand === "rename-field" ||
    schema.subcommand === "remap-status"
  ) {
    return runMcpSchemaMigrationAction(schema);
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
          minCount: parseMcpInteger(
            ctx.args.minCount ?? ctx.options.minCount,
            "schema infer minCount",
          ),
          apply: ctx.args.apply === true || ctx.options.apply === true,
          author: schema.author,
          force: schema.force,
        },
        ctx.global,
      );
    }
    return runMcpSchemaAddTypeAction(schema);
  }
  throw createUnknownSubcommandError({
    command_path: "schema",
    token: schema.subcommand,
    allowed: SCHEMA_SUBCOMMANDS,
    exit_code: 64,
  });
}

function runMcpProfileAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> | unknown {
  const subcommand =
    readString(ctx.args, "subcommand") ??
    readRequiredString(ctx.options, "subcommand");
  const normalizedSubcommand = subcommand.trim().toLowerCase();
  const profileName =
    readString(ctx.args, "name") ?? readString(ctx.options, "name");
  const handlers: Record<string, () => Promise<unknown> | unknown> = {
    list: () => runProfileList(),
    show: () => runProfileShow(profileName),
    lint: () => runProfileLint(profileName),
    apply: () =>
      runProfileApply(
        profileName,
        {
          dryRun: ctx.args.dryRun === true || ctx.options.dryRun === true,
          author:
            readString(ctx.args, "author") ?? readString(ctx.options, "author"),
          force: ctx.args.force === true || ctx.options.force === true,
        },
        ctx.global,
      ),
  };
  const handler = getOwnHandler(handlers, normalizedSubcommand);
  if (!handler) {
    throw createUnknownSubcommandError({
      command_path: "profile",
      token: subcommand,
      allowed: PROFILE_SUBCOMMANDS,
      exit_code: 64,
    });
  }
  return handler();
}

async function runMcpAppendAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(
    ctx.args,
    ctx.options,
  );
  return projectMutationResult(
    await runAppend(
      requireMcpItemId(ctx, runnerOptions),
      runnerOptions as never,
      ctx.global,
    ),
    {
      changedFields,
      compactEnvelope: changedFields === "compact" && !idOnly,
      idOnly,
    },
  );
}

async function runMcpUpdateManyAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const { changedFields, runnerOptions } = withMutationCompaction(
    ctx.args,
    ctx.options,
  );
  return projectMutationResult(
    await runUpdateMany(updateManyOptionsFromFlat(runnerOptions), ctx.global),
    { changedFields },
  );
}

async function runMcpCloseManyAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const { changedFields, runnerOptions } = withMutationCompaction(
    ctx.args,
    ctx.options,
  );
  const topLevelReason = readString(ctx.args, "reason");
  const closeManyRunnerOptions: Record<string, unknown> =
    topLevelReason !== undefined && runnerOptions.reason === undefined
      ? { ...runnerOptions, reason: topLevelReason }
      : { ...runnerOptions };
  if (ctx.force && closeManyRunnerOptions.force === undefined) {
    closeManyRunnerOptions.force = true;
  }
  return projectMutationResult(
    await runCloseMany(
      closeManyOptionsFromFlat(closeManyRunnerOptions),
      ctx.global,
    ),
    { changedFields },
  );
}

async function runMcpRestoreAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(
    ctx.args,
    ctx.options,
  );
  const target =
    readString(runnerOptions, "target") ??
    readRequiredString(ctx.args, "target");
  return projectMutationResult(
    await runRestore(
      requireMcpItemId(ctx, runnerOptions),
      target,
      runnerOptions,
      ctx.global,
    ),
    {
      changedFields,
      compactEnvelope: changedFields === "compact" && !idOnly,
      idOnly,
    },
  );
}

function withoutLifecycleAssigneeAlias(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const updateOptions = { ...options };
  delete updateOptions.assignee;
  return updateOptions;
}

async function runMcpStartTaskAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const pmRoot = resolvePmRoot(process.cwd(), ctx.global.path);
  const settings = await readSettings(pmRoot);
  const inProgressStatus = resolveStartTaskInProgressStatus(
    resolveRuntimeStatusRegistry(settings.schema),
  );
  const id = requireMcpItemId(ctx);
  const claimResult = await runClaim(id, ctx.force, ctx.global, ctx.options);
  const updateResult = await runUpdate(
    id,
    {
      ...withoutLifecycleAssigneeAlias(ctx.options),
      status: inProgressStatus,
      force: ctx.force,
    },
    ctx.global,
  );
  return { id, action: "start_task", claim: claimResult, update: updateResult };
}

async function runMcpPauseTaskAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const pmRoot = resolvePmRoot(process.cwd(), ctx.global.path);
  const settings = await readSettings(pmRoot);
  const id = requireMcpItemId(ctx);
  const openStatus = resolveRuntimeStatusRegistry(settings.schema).open_status;
  const updateResult = await runUpdate(
    id,
    {
      ...withoutLifecycleAssigneeAlias(ctx.options),
      status: openStatus,
      force: ctx.force,
    },
    ctx.global,
  );
  const releaseResult = await runRelease(
    id,
    ctx.force,
    ctx.global,
    ctx.options,
  );
  return {
    id,
    action: "pause_task",
    update: updateResult,
    release: releaseResult,
  };
}

async function runMcpCloseTaskAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const id = requireMcpItemId(ctx);
  const closeReason =
    readString(ctx.args, "reason") ??
    readString(ctx.args, "text") ??
    readString(ctx.options, "reason") ??
    readString(ctx.options, "text");
  const closeResult = await runClose(
    id,
    closeReason,
    { ...ctx.options, force: ctx.force },
    ctx.global,
  );
  const releaseResult = await runRelease(
    id,
    ctx.force,
    ctx.global,
    ctx.options,
  );
  return {
    id,
    action: "close_task",
    close: closeResult,
    release: releaseResult,
  };
}

/** Dispatch the graph action merging flat MCP parameters onto runner options. */
function runMcpGraphAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const merged = { ...ctx.args, ...ctx.options };
  return runGraph(
    readRequiredString(merged, "subcommand"),
    readString(merged, "id") ?? ctx.id,
    readString(merged, "target"),
    graphOptionsFromFlat(merged),
    ctx.global,
  );
}

function runMcpHistoryAuthorAcknowledgeAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  return acknowledgeUnknownAuthorHistoryEventsFromTransport(
    resolvePmRoot(process.cwd(), ctx.global.path),
    { ...ctx.args, ...ctx.options },
  );
}

const SDK_ACTION_HANDLERS: Record<string, McpActionHandler> = {
  init: (ctx) =>
    runInit(readString(ctx.args, "prefix"), ctx.global, ctx.options),
  context: (ctx) =>
    runContext(
      applyContextIntentProjection("context", ctx.options),
      ctx.global,
    ),
  next: (ctx) =>
    runNext(applyContextIntentProjection("next", ctx.options), ctx.global),
  eval: runRuntimeEvalAction,
  events: runRuntimeEventsAction,
  merge: runRuntimeMergeAction,
  workspace: runRuntimeWorkspaceAction,
  meet: runRuntimeSchedulingAction,
  event: runRuntimeSchedulingAction,
  remind: runRuntimeSchedulingAction,
  list: runMcpListAction,
  get: (ctx) =>
    runGet(
      requireMcpItemId(ctx),
      ctx.global,
      applyContextIntentProjection("get", ctx.options),
    ),
  search: runMcpSearchAction,
  duplicates: (ctx) => {
    const status =
      typeof ctx.options.status === "string"
        ? [ctx.options.status]
        : readStringArray(ctx.options.status);
    return runDuplicates(ctx.global, {
      ...(status.length === 0 ? {} : { status }),
      since: readString(ctx.options, "since"),
      threshold:
        typeof ctx.options.threshold === "number"
          ? ctx.options.threshold
          : undefined,
      limit:
        ctx.options.limit === "default"
          ? undefined
          : parseMcpInteger(ctx.options.limit, "limit"),
    });
  },
  create: runMcpCreateAction,
  copy: runMcpCopyAction,
  focus: (ctx) =>
    runFocus(
      ctx.id,
      { clear: ctx.options.clear === true || ctx.args.clear === true },
      ctx.global,
    ),
  update: runMcpUpdateAction,
  restore: runMcpRestoreAction,
  claim: (ctx) =>
    ctx.options.next === true || ctx.args.next === true
      ? runClaimNext(
          ctx.force,
          ctx.global,
          { ...ctx.options, ...ctx.args },
          { ...ctx.options, ...ctx.args },
        )
      : runClaim(requireMcpItemId(ctx), ctx.force, ctx.global, ctx.options),
  release: (ctx) =>
    runRelease(requireMcpItemId(ctx), ctx.force, ctx.global, ctx.options),
  "start-task": runMcpStartTaskAction,
  "pause-task": runMcpPauseTaskAction,
  "close-task": runMcpCloseTaskAction,
  close: runMcpCloseAction,
  comments: runMcpCommentsAction,
  notes: (ctx) =>
    runNotes(
      requireMcpItemId(ctx),
      normalizeAnnotationTransportOptions(ctx.options),
      ctx.global,
    ),
  learnings: (ctx) =>
    runLearnings(
      requireMcpItemId(ctx),
      normalizeAnnotationTransportOptions(ctx.options),
      ctx.global,
    ),
  files: runMcpFilesAction,
  docs: (ctx) =>
    runDocs(requireMcpItemId(ctx), withAddNoteOption(ctx.options), ctx.global),
  test: (ctx) => runTest(requireMcpItemId(ctx), ctx.options, ctx.global),
  "test-all": (ctx) => runTestAll(ctx.options, ctx.global),
  telemetry: runMcpTelemetryAction,
  validate: (ctx) =>
    runValidate(ctx.options, ctx.global, {
      runUpdate: (id, options, global) => runUpdate(id, options, global),
    }),
  health: runMcpHealthAction,
  assurance: (ctx) => runAssuranceDispatch(ctx.args, ctx.options, ctx.global),
  contracts: (ctx) => runContracts(ctx.options, ctx.global),
  config: runMcpConfigAction,
  activity: runMcpActivityAction,
  aggregate: (ctx) => runAggregate(ctx.options, ctx.global),
  extension: (ctx) => runExtension(readMcpTarget(ctx), ctx.options, ctx.global),
  package: (ctx) => runExtension(readMcpTarget(ctx), ctx.options, ctx.global),
  install: (ctx) =>
    runExtension(
      readMcpTarget(ctx),
      { ...ctx.options, install: true },
      ctx.global,
    ),
  upgrade: (ctx) => runUpgrade(readMcpTarget(ctx), ctx.options, ctx.global),
  delete: (ctx) => runDelete(requireMcpItemId(ctx), ctx.options, ctx.global),
  deps: (ctx) => runDeps(requireMcpItemId(ctx), ctx.options, ctx.global),
  graph: runMcpGraphAction,
  "files-discover": (ctx) =>
    runFilesDiscover(requireMcpItemId(ctx), ctx.options, ctx.global),
  "files-lookup": (ctx) =>
    runMcpFilesLookupAction(ctx, readStringArray(ctx.options.paths)),
  history: (ctx) => runHistory(requireMcpItemId(ctx), ctx.options, ctx.global),
  "history-redact": (ctx) =>
    runHistoryRedact(requireMcpItemId(ctx), ctx.options, ctx.global),
  "history-repair": runMcpHistoryRepairAction,
  "history-compact": runMcpHistoryCompactAction,
  "history-author-acknowledge": runMcpHistoryAuthorAcknowledgeAction,
  plan: runMcpPlanAction,
  schema: runMcpSchemaAction,
  profile: runMcpProfileAction,
  stats: (ctx) =>
    runStats(ctx.global, statsCommandOptionsFromRuntime(ctx.options)),
  append: runMcpAppendAction,
  "update-many": runMcpUpdateManyAction,
  "close-many": runMcpCloseManyAction,
  gc: (ctx) => runGc(ctx.global, ctx.options),
};

/** One action's static SDK dispatch-resolution proof. */
export interface SdkActionCoverageRow {
  /** Public action being analyzed. */
  action: string;
  /** Canonical native action selected after alias normalization. */
  resolved_action: string;
  /** Whether the canonical action has an in-process SDK handler. */
  covered: boolean;
  /** How the public action reaches its handler. */
  route: "native" | "alias" | "missing";
}

/**
 * Derive the SDK dispatch coverage matrix from the live action and alias
 * registries instead of a hand-maintained test list.
 */
export function analyzeSdkActionCoverage(
  actions: readonly string[] = PM_TOOL_ACTIONS,
): SdkActionCoverageRow[] {
  return actions.map((action) => {
    const normalized = normalizeActionName(action);
    const alias = getOwnHandler(SDK_ACTION_ALIASES, normalized);
    const resolvedAction = alias?.action ?? normalized;
    const covered =
      getOwnHandler(SDK_ACTION_HANDLERS, resolvedAction) !== undefined;
    return {
      action,
      resolved_action: resolvedAction,
      covered,
      route: covered ? (alias ? "alias" : "native") : "missing",
    };
  });
}

async function dispatchAction(
  action: string,
  args: Record<string, unknown>,
  global: GlobalOptions,
  activeExtensions: ActiveExtensionRuntime | null,
): Promise<unknown> {
  const options = optionsWithAuthor(args, action);
  validateReadOutputOptions(action, options);
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
  const result = handler
    ? await handler(ctx)
    : await dispatchActiveExtensionAction(
        action,
        args,
        options,
        global,
        activeExtensions,
      );
  return attachReadOutputContracts(action, options, result);
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

if (
  process.env.NODE_ENV === "test" ||
  process.env.VITEST !== undefined ||
  process.env.VITEST_WORKER_ID !== undefined
) {
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
export type {
  AppendCommandOptions,
  AppendResult,
  CommentsCommandOptions,
  CommentsResult,
  ConfigCommandOptions,
  ConfigResult,
  DepsCommandOptions,
  DepsResult,
  DocsCommandOptions,
  DocsResult,
  ExtensionCommandOptions,
  ExtensionCommandResult,
  FilesCommandOptions,
  FilesDiscoverOptions,
  FilesDiscoverResult,
  FilesLookupOptions,
  FilesLookupResult,
  FilesResult,
  GcCommandOptions,
  GcResult,
  HealthResult,
  InitCommandOptions,
  InitResult,
  LearningsCommandOptions,
  LearningsResult,
  NotesCommandOptions,
  NotesResult,
  ProfileApplyCommandOptions,
  ProfileApplyResult,
  ProfileLintResult,
  ProfileListResult,
  ProfileResult,
  ProfileShowResult,
  ProfileSubcommand,
  RunHealthOptions,
  SchemaAddFieldCommandOptions,
  SchemaAddFieldResult,
  SchemaAddStatusCommandOptions,
  SchemaAddStatusResult,
  SchemaAddTypeCommandOptions,
  SchemaAddTypeInferCommandOptions,
  SchemaAddTypeInferResult,
  SchemaAddTypeResult,
  SchemaApplyPresetCommandOptions,
  SchemaApplyPresetResult,
  SchemaInspectResult,
  SchemaListFieldsResult,
  SchemaListResult,
  RunSchemaEvolutionMigrationOptions,
  SchemaEvolutionMigrationRequest,
  SchemaEvolutionMigrationResult,
  SchemaRemoveFieldCommandOptions,
  SchemaRemoveFieldResult,
  SchemaRemoveStatusCommandOptions,
  SchemaRemoveStatusResult,
  SchemaRemoveTypeCommandOptions,
  SchemaRemoveTypeResult,
  SchemaShowFieldResult,
  SchemaShowResult,
  SchemaShowStatusResult,
  SchemaSubcommand,
  UpgradeCommandOptions,
  UpgradeResult,
  ValidateCommandOptions,
  ValidateCountsResult,
  ValidateResult,
};
