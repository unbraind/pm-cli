/**
 * @module sdk/runtime
 * Provides the public client and coordinates isolated extension lifecycles.
 */
import { AsyncLocalStorage } from "node:async_hooks";
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
} from "../core/extensions/index.js";
import { pathExists } from "../core/fs/fs-utils.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { asRecordClone } from "../core/shared/primitives.js";
import { createAsyncReadWriteGate } from "../core/shared/serial-queue.js";
import { getSettingsPath,resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import type { ItemMetadata } from "../types/index.js";
import {
  type AcknowledgeUnknownAuthorEventsOptions,
  type UnknownAuthorAcknowledgmentResult
} from "./author-attribution.js";
import { PM_TOOL_ACTIONS } from "./cli-contracts/enum-contracts.js";
import {
  runContracts,
  type ContractsCommandOptions,
  type ContractsResult,
} from "./cli-contracts/runtime-contracts.js";
import type {
  PmCreateActionOptions,
  PmUpdateActionOptions,
} from "./cli-contracts/typed-action-inputs.js";
import type { CommentsCommandOptions,CommentsResult } from "./comments.js";
import type { ConfigCommandOptions,ConfigResult } from "./config.js";
import {
  attachReadOutputContracts
} from "./context-intent-contracts.js";
import {
  runWithDiscoveredContextIntentContracts
} from "./context-intent-runtime.js";
import { finalizeContextUsageEgress } from "./context/usage-egress.js";
import type { DepsCommandOptions,DepsResult } from "./dependencies.js";
import type { DocsCommandOptions,DocsResult } from "./docs.js";
import {
  type DuplicatesCommandOptions,
  type DuplicatesResult
} from "./duplicates.js";
import { createExtensionCommandSdk } from "./extension-command-context.js";
import {
  type ExtensionCommandOptions,
  type ExtensionCommandResult
} from "./extension.js";
import type {
  FilesCommandOptions,
  FilesDiscoverOptions,
  FilesDiscoverResult,
  FilesLookupOptions,
  FilesLookupResult,
  FilesResult,
} from "./files.js";
import { type AssuranceActionInput,type AssuranceActionResult } from "./governance/assurance-action.js";
import {
  type GcCommandOptions,
  type GcResult
} from "./governance/gc.js";
import {
  type HealthResult,
  type RunHealthOptions
} from "./governance/health.js";
import {
  type UpgradeCommandOptions,
  type UpgradeResult
} from "./governance/upgrade.js";
import {
  type ValidateCommandOptions,
  type ValidateCountsResult,
  type ValidateResult
} from "./governance/validate.js";
import { type WorkflowPolicyAction,type WorkflowPolicyActionOptions,type WorkflowPolicyActionResult } from "./governance/workflow-policy.js";
import {
  type GraphCommandOptions,
  type GraphResult,
  type GraphSubcommand
} from "./graph/run.js";
import {
  type HistoryCompactBulkCommandOptions,
  type HistoryCompactBulkResult,
  type HistoryCompactCommandOptions,
  type HistoryCompactResult,
} from "./history-compact.js";
import {
  type HistoryRedactCommandOptions,
  type HistoryRedactResult
} from "./history-redact.js";
import {
  type HistoryRepairAllResult,
  type HistoryRepairCommandOptions,
  type HistoryRepairResult,
} from "./history-repair.js";
import { runHistoryAttest,type HistoryAttestCommandOptions } from "./history/attestation-command.js";
import type { InitCommandOptions,InitResult } from "./init.js";
import { INIT_INVOCATION_CWD } from "./init.js";
import type { LearningsCommandOptions,LearningsResult } from "./learnings.js";
import type { AppendCommandOptions,AppendResult } from "./lifecycle/append.js";
import type {
  ClaimNextResult,
  ClaimResult,
  ReleaseResult,
} from "./lifecycle/claim.js";
import type { CloseResult } from "./lifecycle/close.js";
import { type CopyResult } from "./lifecycle/copy.js";
import { type CreateResult } from "./lifecycle/create.js";
import { type DeleteResult } from "./lifecycle/delete.js";
import { type FocusResult } from "./lifecycle/focus.js";
import {
  type PlanCommandOptions,
  type PlanCommandResult,
  type PlanSubcommand
} from "./lifecycle/plan.js";
import type { ReopenCommandOptions,ReopenResult } from "./lifecycle/reopen.js";
import { type RestoreResult } from "./lifecycle/restore.js";
import { type UpdateResult } from "./lifecycle/update.js";
import type { NotesCommandOptions,NotesResult } from "./notes.js";
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
  type AggregateOptions,
  type AggregateResult
} from "./query/aggregate.js";
import { certifyCompleteListResult,createCompleteListOptions,type PmCompleteListOptions,type PmCompleteListResult } from "./query/complete-list.js";
import {
  type ContextOptions,
  type ContextResult
} from "./query/context.js";
import { type GetOptions,type GetResult } from "./query/get.js";
import { listClientItemMetadataLight } from "./query/light-metadata.js";
import { type ListOptions,type ListResult } from "./query/list.js";
import { type NextOptions,type NextResult } from "./query/next.js";
import {
  type SearchOptions,
  type SearchResult
} from "./query/search.js";
import {
  normalizeReadOutputIncludeModeOptions,validateReadOutputOptions,
  type PmReadOutputOptions,
  type PmReadOutputResultFor,
} from "./read-output-contracts.js";
import { SDK_ACTION_ALIASES } from "./runtime-action-aliases.js";
import {
  closeManyOptionsFromFlat,
  extensionOptionsFromArgs,
  actionGlobalOptions as globalOptions,
  mutationListOptions,
  mutationOptionsWithOverrides,
  normalizeActionName,
  normalizeCommandPath,
  normalizeMcpOptionsArrays,
  normalizeMcpUpdateOptions,
  optionsWithAuthor,
  readRuntimeScalarString as readScalarString,
  readRuntimeScalarStringAllowBlank as readScalarStringAllowBlank,
  readRuntimeString as readString,
  readRuntimeStringArray as readStringArray,
  shouldInvalidateWorkspaceContractsCacheAfterAction,
  updateManyOptionsFromFlat,
  withAddNoteOption,
  withFilesDiscoveryOptions,
  withMutationCompaction
} from "./runtime-input.js";
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
} from "./runtime-public-contracts.js";
import { SDK_ACTION_HANDLERS } from "./runtime/actions.js";
import type { ActiveExtensionRuntime,ExtensionActivationResult,McpActionDispatchContext } from "./runtime/context.js";
import { getOwnHandler,readRequiredString } from "./runtime/context.js";
import {
  type RunSchemaEvolutionMigrationOptions,
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
  type SchemaEvolutionMigrationRequest,
  type SchemaEvolutionMigrationResult,
  type SchemaInspectResult,
  type SchemaListFieldsResult,
  type SchemaListResult,
  type SchemaRemoveFieldCommandOptions,
  type SchemaRemoveFieldResult,
  type SchemaRemoveStatusCommandOptions,
  type SchemaRemoveStatusResult,
  type SchemaRemoveTypeCommandOptions,
  type SchemaRemoveTypeResult,
  type SchemaShowFieldResult,
  type SchemaShowResult,
  type SchemaShowStatusResult,
  type SchemaSubcommand
} from "./schema.js";
import {
  type StatsCommandOptions,
  type StatsResult
} from "./stats.js";
import {
  clearWorkspaceContractsCache,
} from "./workspace-contracts-cache.js";

export {
  PM_GITIGNORE_END,
  PM_GITIGNORE_START,
  ensurePmGitignore,
  getPmGitignoreBlock,
  type EnsurePmGitignoreResult
} from "./workspace.js";

export { SEARCH_EXTENSION_FLAG_DEFINITIONS } from "./extension-contracts.js";

export type { FlagDefinition } from "../core/extensions/loader.js";

export * from "./cli-contracts/agent-output-contracts.js";

export { PmCompleteListValidationError,assertCompleteListResult,certifyCompleteListResult,createCompleteListOptions,inspectCompleteListResult,type PmCompleteListCertificate,type PmCompleteListFailureReceipt,type PmCompleteListFinding,type PmCompleteListFindingCode,type PmCompleteListInspection,type PmCompleteListOptions,type PmCompleteListResult } from "./query/complete-list.js";

export { getWorkspaceContracts } from "./query/workspace-contracts.js";

export type {
  WorkspaceExtensionCommandContract,
  WorkspaceFieldContract
} from "./workspace-contracts.js";

export type {
  PmReadOutputBudgetExceeded,
  PmReadOutputOptions,
  PmReadOutputResult,
  PmReadOutputResultFor,
  PmReadOutputSurfaceContract
} from "./read-output-contracts.js";

export type {
  PmReadOutputSessionReceipt,
  PmReadOutputSessionState
} from "./read-output-session.js";

export type { PmContextIntentContract } from "./context-intent-contracts.js";

export type { PmErrorCodeContract } from "./error-code-catalog.js";

export { clearWorkspaceContractsCache } from "./workspace-contracts-cache.js";

export * from "./governance/workflow-policy.js";

export type * from "./governance/assurance-action-contracts.js";

export { runCloseTask,runPauseTask,runStartTask,type TaskCompositionOptions } from "./lifecycle/task-composition.js";

export type {
  ClaimResult,
  CloseResult,
  CreateResult,
  ReleaseResult,
  UpdateResult
};

  export {
    getActiveExtensionRegistrations,
    runActiveOnReadHooks,
    runActiveOnWriteHooks
  } from "../core/extensions/index.js";

export {
  pathExists,
  readFileIfExists,
  removeFileIfExists,
  writeFileAtomic
} from "../core/fs/fs-utils.js";

export {
  appendHistoryEntry,
  createHistoryEntry
} from "../core/history/history.js";

export { HISTORY_EVENT_CLASSIFICATION_VERSION,MAINTENANCE_HISTORY_OPERATIONS,SUBSTANTIVE_HISTORY_OPERATIONS,classifyHistoryEvent,type HistoryEventClass } from "../core/history/event-classification.js";

export {
  generateItemId,
  normalizeItemId,
  normalizeRawItemId
} from "../core/item/id.js";

export {
  readBooleanOption,
  readCsvListOption,
  readStringOption
} from "./package-runtime-options.js";

export {
  PM_CLI_EXPECTED_ERROR_NAME,
  createPmCliExpectedError,
  isPmCliExpectedError,
  type CreatePmCliExpectedErrorOptions,
  type PmCliExpectedError
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
  type ToImportLogEntriesOptions
} from "./package-import-adapters.js";

export {
  canonicalDocument,
  normalizeItemMetadata,
  serializeItemDocument,
  splitFrontMatter
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
  type ItemFormatVersionStatus
} from "../core/item/item-format-version.js";

export { parseTags } from "../core/item/parse.js";

export { isTerminalStatus,normalizeStatusInput } from "../core/item/status.js";

export { resolveItemTypeRegistry } from "../core/item/type-registry.js";

export { acquireLock } from "../core/lock/lock.js";

export {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry
} from "../core/schema/runtime-schema.js";

export { EXIT_CODE };

  export { PmCliError } from "../core/shared/errors.js";

export { isTimestampLiteral,nowIso } from "../core/shared/time.js";

export {
  jaccardSimilarity,
  normalizeSimilarityText,
  scoreItemSimilarity,
  tokenizeSimilarityText,
  type ItemSimilarityScore
} from "./similarity-scoring.js";

export {
  listAllItemMetadata,
  listAllItemMetadataLight,
  locateItem,
  readLocatedItem
} from "../core/store/item-store.js";

export {
  getHistoryPath,
  getItemPath,
  getSettingsPath,
  resolveImplicitPmRoot,
  resolvePmRoot
} from "../core/store/paths.js";

export { readSettings } from "../core/store/settings.js";

export {
  runAggregate,
  type AggregateOptions,
  type AggregateResult,
  type AggregateRow
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
  type WorkloadEntry
} from "./query/context.js";

export { runGet,type GetOptions,type GetResult } from "./query/get.js";

export {
  runList,type ListCompactResult,type ListFullResult,type ListOptions,
  type ListProjectedItem,
  type ListProjectedItemCore,
  type ListResult,
  type ListResultItem,
  type ListSortField,
  type ListSortOrder,
  type ListTreeItem,
  type ListTreeMetadata,
  type ListVerboseResult,type ListedItem
} from "./query/list.js";

export {
  closeItem,
  runClose,
  type CloseCommandOptions
} from "./lifecycle/close.js";

export {
  runCopy,
  type CopyOptions,
  type CopyResult
} from "./lifecycle/copy.js";

export {
  runDelete,
  type DeleteCommandOptions,
  type DeleteResult
} from "./lifecycle/delete.js";

export {
  runFocus,
  type FocusOptions,
  type FocusResult
} from "./lifecycle/focus.js";

export {
  runRestore,
  type RestoreCommandOptions,
  type RestoreResult
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
  type TerminalTransitionPolicy
} from "./lifecycle-policy.js";

export { runUpdate,type UpdateCommandOptions } from "./lifecycle/update.js";

export { runReopen,type PreviousTerminalEvidence,type RecurrenceReceipt,type ReopenCommandOptions,type ReopenResult } from "./lifecycle/reopen.js";

export {
  NEXT_OUTPUT_VALUES,
  runNext,
  type NextActionableItem,
  type NextBlockerRef,
  type NextOptions,
  type NextOutputFormat,
  type NextRecommendation,
  type NextResult
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
  type SearchVerboseResult
} from "./query/search.js";

export {
  runStats,
  type StatsCommandOptions,
  type StatsResult
} from "./stats.js";

export {
  runDuplicates,
  type DuplicatesCommandOptions,
  type DuplicatesResult
} from "./duplicates.js";

export {
  renderCalendarMarkdown,
  renderCalendarToon,
  resolveCalendarOutputFormat,
  runCalendar,
  type CalendarOptions,
  type CalendarResult
} from "./query/calendar.js";

export {
  renderGuideMarkdown,
  resolveGuideOutputFormat,
  runGuide,
  type GuideDepth,
  type GuideOptions,
  type GuideOutputFormat,
  type GuideResult
} from "./guide.js";

export {
  runCompletion,
  type CompletionResult,
  type CompletionShell
} from "./completion.js";

export {
  runReindex,
  type ReindexOptions,
  type ReindexResult
} from "./governance/reindex.js";

export {
  loadCreateTemplateOptions,
  runTemplatesList,
  runTemplatesSave,
  runTemplatesShow,
  type CreateTemplateOptions,
  type TemplatesListResult,
  type TemplatesSaveResult,
  type TemplatesShowResult
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
  type TestRunsStopCommandOptions
} from "./test/runs.js";

export {
  BUILTIN_ITEM_TYPE_VALUES,CONFIDENCE_TEXT_VALUES,
  DEPENDENCY_KIND_VALUES,ISSUE_SEVERITY_VALUES,
  ITEM_TYPE_VALUES,
  RISK_VALUES,
  STATUS_VALUES
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
  PmSettings
} from "../types/index.js";

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
  WorkspaceContractsOptions
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

  /** Return every status and full item row only after fail-closed corpus certification. */
  async listAllComplete(options: PmCompleteListOptions = {}): Promise<PmCompleteListResult> { return certifyCompleteListResult(await this.list(createCompleteListOptions(options))); }

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
  duplicates<Options extends ReadOptions<DuplicatesCommandOptions> = DuplicatesCommandOptions>(
    options: Options = {} as Options,
  ): ReadPromise<DuplicatesResult, Options> {
    return this.runTyped("duplicates", { options });
  }

  /** List or mutate comments, including lock-scoped idempotent appends. */
  comments<
    Options extends ReadOptions<CommentsCommandOptions> =
      CommentsCommandOptions,
  >(
    id: string,
    options: Options = {} as Options,
  ): ReadPromise<CommentsResult, Options> {
    return this.runTyped("comments", { id, options });
  }

  /** List or mutate private notes, including lock-scoped idempotent appends. */
  notes<Options extends ReadOptions<NotesCommandOptions> = NotesCommandOptions>(
    id: string,
    options: Options = {} as Options,
  ): ReadPromise<NotesResult, Options> {
    return this.runTyped("notes", { id, options });
  }

  /** List or mutate durable learnings, including lock-scoped idempotent appends. */
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
      ...splitFullClientMutationOptions(
        mutationOptionsWithOverrides(options, { body }),
      ),
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

  /** Author, preview, or approve workflow policies in this client's workspace. */
  workflowPolicy(action: WorkflowPolicyAction, name?: string, options: WorkflowPolicyActionOptions = {}): Promise<WorkflowPolicyActionResult> {
    return this.runTyped("schema", { name, options: { ...options, subcommand: action } });
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

  /** Export or verify a detached history proof without activating workspace extensions. */
  historyAttest(options: HistoryAttestCommandOptions = {}): ReturnType<typeof runHistoryAttest> {
    return this.runTyped("history-attest", { options });
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
  historyAuthorAcknowledge(options: AcknowledgeUnknownAuthorEventsOptions): Promise<UnknownAuthorAcknowledgmentResult> {
    return this.runTyped("history-author-acknowledge", {
      historyEvent: (options.events ?? []).map(
        (event) => `${event.item_id}:${String(event.line)}`,
      ),
      allActionable: options.all_actionable === true,
      dryRun: options.dry_run === true, planFingerprint: options.plan_fingerprint, limit: options.coordinate_limit,
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
      options: mutationOptionsWithOverrides(options, { subcommand }),
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

  /** Reopen terminal work as a recurrence through the canonical update path. */
  reopen(
    id: string,
    reason: string,
    options: ReopenCommandOptions = {},
  ): Promise<ReopenResult> {
    return this.runTyped("item-reopen", {
      id,
      reason,
      fullChangedFields: true,
      options,
    });
  }

  /** Close an item using the same mutation path as `pm close`. Options are contract-typed (pm-x29o); the close reason is the positional parameter, so the option bag omits `reason`/`text`. */
  close(
    id: string,
    reason: string,
    options: PmClientCloseActionOptions & { releaseAssignment: true },
  ): Promise<CloseTaskResult>;
  /** Return the base receipt when composition is disabled or omitted. */
  close(
    id: string,
    reason: string,
    options?: PmClientCloseActionOptions & { releaseAssignment?: false },
  ): Promise<CloseResult>;
  /** Preserve both receipt shapes when the composition flag is dynamic. */
  close(
    id: string,
    reason: string,
    options?: PmClientCloseActionOptions & { releaseAssignment?: boolean },
  ): Promise<CloseResult | CloseTaskResult>;
  /** Dispatch lifecycle mutation options through the shared SDK runtime. */
  close(
    id: string,
    reason: string,
    options: PmClientCloseActionOptions & { releaseAssignment?: boolean } = {},
  ): Promise<CloseResult | CloseTaskResult> {
    return this.runTyped("close", {
      id,
      reason,
      ...splitFullClientMutationOptions(options),
    });
  }

  /** Claim an item using the same mutation path as `pm claim`. */
  claim(
    id: string,
    options: PmClientFullMutationOptions & { start: true },
  ): Promise<StartTaskResult>;
  /** Return the base receipt when composition is disabled or omitted. */
  claim(
    id: string,
    options?: PmClientFullMutationOptions & { start?: false },
  ): Promise<ClaimResult>;
  /** Preserve both receipt shapes when the composition flag is dynamic. */
  claim(
    id: string,
    options?: PmClientFullMutationOptions & { start?: boolean },
  ): Promise<ClaimResult | StartTaskResult>;
  /** Dispatch lifecycle mutation options through the shared SDK runtime. */
  claim(
    id: string,
    options: PmClientFullMutationOptions & { start?: boolean } = {},
  ): Promise<ClaimResult | StartTaskResult> {
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
    options: PmClientFullMutationOptions & { pause: true },
  ): Promise<PauseTaskResult>;
  /** Return the base receipt when composition is disabled or omitted. */
  release(
    id: string,
    options?: PmClientFullMutationOptions & { pause?: false },
  ): Promise<ReleaseResult>;
  /** Preserve both receipt shapes when the composition flag is dynamic. */
  release(
    id: string,
    options?: PmClientFullMutationOptions & { pause?: boolean },
  ): Promise<ReleaseResult | PauseTaskResult>;
  /** Dispatch lifecycle mutation options through the shared SDK runtime. */
  release(
    id: string,
    options: PmClientFullMutationOptions & { pause?: boolean } = {},
  ): Promise<ReleaseResult | PauseTaskResult> {
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
  packageCatalog<Options extends ReadOptions<PackageCommandOptions> = PackageCommandOptions>(options: Options = {} as Options): ReadPromise<PackageCommandResult, Options> { return this.runTyped("package-catalog", { options }); }

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

/** Return every status and full item row with fail-closed corpus proof. */
export function listAllComplete(options: PmCompleteListOptions = {}, clientOptions: PmClientOptions = {}): Promise<PmCompleteListResult> { return new PmClient(clientOptions).listAllComplete(options); }

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
export function duplicates<Options extends ReadOptions<DuplicatesCommandOptions> = DuplicatesCommandOptions>(
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<DuplicatesResult, Options> {
  return new PmClient(clientOptions).duplicates(options);
}

/** List or mutate comments with optional idempotency without constructing a client. */
export function comments<
  Options extends ReadOptions<CommentsCommandOptions> = CommentsCommandOptions,
>(
  id: string,
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<CommentsResult, Options> {
  return new PmClient(clientOptions).comments(id, options);
}

/** List or mutate private notes with optional idempotency without constructing a client. */
export function notes<
  Options extends ReadOptions<NotesCommandOptions> = NotesCommandOptions,
>(
  id: string,
  options: Options = {} as Options,
  clientOptions: PmClientOptions = {},
): ReadPromise<NotesResult, Options> {
  return new PmClient(clientOptions).notes(id, options);
}

/** List or mutate durable learnings with optional idempotency without constructing a client. */
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

/** Reopen terminal work as a recurrence without constructing a reusable client. */
export function reopen(
  id: string,
  reason: string,
  options: ReopenCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<ReopenResult> {
  return new PmClient(clientOptions).reopen(id, reason, options);
}

/** Close an item without constructing a reusable client. */
export function close(
  id: string,
  reason: string,
  options: PmClientCloseActionOptions & { releaseAssignment: true },
  clientOptions?: PmClientOptions,
): Promise<CloseTaskResult>;

/** Return the base receipt when composition is disabled or omitted. */
export function close(
  id: string,
  reason: string,
  options?: PmClientCloseActionOptions & { releaseAssignment?: false },
  clientOptions?: PmClientOptions,
): Promise<CloseResult>;

/** Preserve both receipt shapes when the composition flag is dynamic. */
export function close(
  id: string,
  reason: string,
  options?: PmClientCloseActionOptions & { releaseAssignment?: boolean },
  clientOptions?: PmClientOptions,
): Promise<CloseResult | CloseTaskResult>;

/** Dispatch lifecycle mutation options through the shared SDK runtime. */
export function close(
  id: string,
  reason: string,
  options: PmClientCloseActionOptions & { releaseAssignment?: boolean } = {},
  clientOptions: PmClientOptions = {},
): Promise<CloseResult | CloseTaskResult> {
  return new PmClient(clientOptions).close(id, reason, options);
}

/** Claim an item without constructing a reusable client. */
export function claim(
  id: string,
  options: PmClientFullMutationOptions & { start: true },
  clientOptions?: PmClientOptions,
): Promise<StartTaskResult>;

/** Return the base receipt when composition is disabled or omitted. */
export function claim(
  id: string,
  options?: PmClientFullMutationOptions & { start?: false },
  clientOptions?: PmClientOptions,
): Promise<ClaimResult>;

/** Preserve both receipt shapes when the composition flag is dynamic. */
export function claim(
  id: string,
  options?: PmClientFullMutationOptions & { start?: boolean },
  clientOptions?: PmClientOptions,
): Promise<ClaimResult | StartTaskResult>;

/** Dispatch lifecycle mutation options through the shared SDK runtime. */
export function claim(
  id: string,
  options: PmClientFullMutationOptions & { start?: boolean } = {},
  clientOptions: PmClientOptions = {},
): Promise<ClaimResult | StartTaskResult> {
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
  options: PmClientFullMutationOptions & { pause: true },
  clientOptions?: PmClientOptions,
): Promise<PauseTaskResult>;

/** Return the base receipt when composition is disabled or omitted. */
export function release(
  id: string,
  options?: PmClientFullMutationOptions & { pause?: false },
  clientOptions?: PmClientOptions,
): Promise<ReleaseResult>;

/** Preserve both receipt shapes when the composition flag is dynamic. */
export function release(
  id: string,
  options?: PmClientFullMutationOptions & { pause?: boolean },
  clientOptions?: PmClientOptions,
): Promise<ReleaseResult | PauseTaskResult>;

/** Dispatch lifecycle mutation options through the shared SDK runtime. */
export function release(
  id: string,
  options: PmClientFullMutationOptions & { pause?: boolean } = {},
  clientOptions: PmClientOptions = {},
): Promise<ReleaseResult | PauseTaskResult> {
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
export function packageCatalog<Options extends ReadOptions<PackageCommandOptions> = PackageCommandOptions>(options: Options = {} as Options, clientOptions: PmClientOptions = {}): ReadPromise<PackageCommandResult, Options> { return new PmClient(clientOptions).packageCatalog(options); }

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

// pm-zpoyg9: request-local registries permit independent activation cycles to
// overlap, but explicit cwd calls still mutate process-global state. The gate
// retains reader concurrency while making cwd mutation exclusive against every
// activation path, including callers that resolve paths through process.cwd().
const extensionActivationGate = createAsyncReadWriteGate();

const activeExtensionScope = new AsyncLocalStorage<boolean>();

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
  if (resolved.action === "init") {
    (global as GlobalOptions & { [key: symbol]: unknown })[
      INIT_INVOCATION_CWD
    ] = resolutionCwd;
  }
  if (
    resolved.action !== "init" ||
    global.path !== undefined ||
    (process.env.PM_PATH?.trim().length ?? 0) > 0
  ) {
    global.path = resolvePmRoot(resolutionCwd, global.path);
  }
  try {
    if (resolved.action === "history-attest") {
      return await dispatchAction(resolved.action, resolved.args, global, null);
    }
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

/** Normalize transport options, dispatch the SDK or extension action, and finalize read projections. Detached attestations return complete proof data without lossy projection. */
async function dispatchAction(
  action: string,
  args: Record<string, unknown>,
  global: GlobalOptions,
  activeExtensions: ActiveExtensionRuntime | null,
): Promise<unknown> {
  const options = optionsWithAuthor(args, action);
  validateReadOutputOptions(action, options);
  normalizeReadOutputIncludeModeOptions(action, options);
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
  if (action === "history-attest") {
    return result;
  } else {
    options.resolvedOutputFormat = "json";
    const projected = attachReadOutputContracts(action, options, result);
    await finalizeContextUsageEgress(resolvePmRoot(process.cwd(), global.path), projected);
    return projected;
  }
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

export type { ContractsCommandOptions,ContractsResult };

  export { readRequiredString } from "./runtime/context.js";
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
    RunHealthOptions,RunSchemaEvolutionMigrationOptions,SchemaAddFieldCommandOptions,
    SchemaAddFieldResult,
    SchemaAddStatusCommandOptions,
    SchemaAddStatusResult,
    SchemaAddTypeCommandOptions,
    SchemaAddTypeInferCommandOptions,
    SchemaAddTypeInferResult,
    SchemaAddTypeResult,
    SchemaApplyPresetCommandOptions,
    SchemaApplyPresetResult,SchemaEvolutionMigrationRequest,
    SchemaEvolutionMigrationResult,SchemaInspectResult,
    SchemaListFieldsResult,
    SchemaListResult,SchemaRemoveFieldCommandOptions,
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
    ValidateResult
  };
