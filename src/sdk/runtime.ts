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
import {
  normalizeListOptions,
  normalizeUpdateOptions,
} from "../cli/registration-helpers.js";
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
  runActivity,
  runAggregate,
  runAppend,
  runClaim,
  runClaimNext,
  runClose,
  runCloseMany,
  runComments,
  runContext,
  runCopy,
  runCreate,
  runDelete,
  runFocus,
  runGet,
  runHistory,
  runLearnings,
  runList,
  runNext,
  runNotes,
  runPlan,
  runRestore,
  runRelease,
  runSearch,
  runUpdate,
  runUpdateMany,
  runUpgrade,
  type UpgradeCommandOptions,
  type UpgradeResult,
} from "../cli/commands/index.js";
import {
  runStats,
  type StatsCommandOptions,
  type StatsResult,
} from "./diagnostics/stats.js";
import {
  runTelemetry,
  type TelemetryCommandOptions,
  type TelemetryResult,
} from "./diagnostics/telemetry.js";
import {
  runTest,
  type TestCommandOptions,
  type TestResult,
} from "./test/execution.js";
import {
  runTestAll,
  type TestAllCommandOptions,
  type TestAllResult,
} from "./test/batch.js";
import {
  runTestRunsAction,
} from "./test/runs.js";
import {
  runSearchEval,
  type EvalOptions,
  type EvalResult,
} from "./eval.js";
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
  isRuntimeRecord as isRecord,
  parseRuntimeInteger as parseMcpInteger,
  readRuntimeScalarString as readScalarString,
  readRuntimeScalarStringAllowBlank as readScalarStringAllowBlank,
  readRuntimeString as readString,
} from "./runtime-input.js";
import { runDeps } from "./dependencies.js";
import { runDocs } from "./docs.js";
import { runFiles, runFilesDiscover } from "./files.js";
import type { ContextOptions, ContextResult } from "../cli/commands/context.js";
import type { GetOptions, GetResult } from "../cli/commands/get.js";
import type { CloseManyCommandOptions } from "../cli/commands/close-many.js";
import type {
  AppendCommandOptions,
  AppendResult,
} from "../cli/commands/append.js";
import type {
  ClaimNextResult,
  ClaimResult,
  ReleaseResult,
} from "../cli/commands/claim.js";
import type { CloseResult } from "../cli/commands/close.js";
import {
  runContracts,
  type ContractsCommandOptions,
  type ContractsResult,
} from "../cli/commands/contracts.js";
import type { CopyResult } from "../cli/commands/copy.js";
import type { CreateResult } from "../cli/commands/create.js";
import type { DeleteResult } from "../cli/commands/delete.js";
import type { ListOptions, ListResult } from "../cli/commands/list.js";
import type { NextOptions, NextResult } from "../cli/commands/next.js";
import type {
  PlanCommandOptions,
  PlanCommandResult,
  PlanSubcommand,
} from "../cli/commands/plan.js";
import type { SearchOptions, SearchResult } from "../cli/commands/search.js";
import { resolveStartTaskInProgressStatus } from "./start-task-status.js";
import type { FocusResult } from "../cli/commands/focus.js";
import type { RestoreResult } from "../cli/commands/restore.js";
import type { UpdateResult } from "../cli/commands/update.js";
import type { UpdateManyCommandOptions } from "../cli/commands/update-many.js";
import type {
  CommentsCommandOptions,
  CommentsResult,
} from "../cli/commands/comments.js";
import type {
  ConfigCommandOptions,
  ConfigResult,
} from "../cli/commands/config.js";
import type { DepsCommandOptions, DepsResult } from "./dependencies.js";
import type { DocsCommandOptions, DocsResult } from "./docs.js";
import type {
  FilesCommandOptions,
  FilesDiscoverOptions,
  FilesDiscoverResult,
  FilesResult,
} from "./files.js";
import type { InitCommandOptions, InitResult } from "../cli/commands/init.js";
import type {
  LearningsCommandOptions,
  LearningsResult,
} from "../cli/commands/learnings.js";
import type {
  NotesCommandOptions,
  NotesResult,
} from "../cli/commands/notes.js";
import type {
  ProfileApplyCommandOptions,
  ProfileApplyResult,
  ProfileLintResult,
  ProfileListResult,
  ProfileResult,
  ProfileShowResult,
  ProfileSubcommand,
} from "../cli/commands/profile.js";
import {
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
  CopyResult,
  CreateResult,
  DeleteResult,
  FocusResult,
  ReleaseResult,
  RestoreResult,
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
export { EXIT_CODE } from "../core/shared/constants.js";
export { PmCliError } from "../core/shared/errors.js";
export { isTimestampLiteral, nowIso } from "../core/shared/time.js";
export {
  listAllItemMetadata,
  locateItem,
  readLocatedItem,
} from "../core/store/item-store.js";
export {
  getHistoryPath,
  getItemPath,
  getSettingsPath,
  resolvePmRoot,
} from "../core/store/paths.js";
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
export { runClose, type CloseCommandOptions } from "../cli/commands/close.js";
export {
  runUpdate,
  type UpdateCommandOptions,
} from "../cli/commands/update.js";
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
} from "./diagnostics/stats.js";
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
export {
  runCompletion,
  type CompletionResult,
  type CompletionShell,
} from "../cli/commands/completion.js";
export {
  runReindex,
  type ReindexOptions,
  type ReindexResult,
} from "../cli/commands/reindex.js";
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
export * from "./test/runs.js";
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

/** Documents the get contracts options payload exchanged by command, SDK, and package integrations. */
export interface GetContractsOptions extends ContractsCommandOptions {
  /** Value that configures or reports pm root for this contract. */
  pmRoot?: string;
  /** Value that configures or reports cwd for this contract. */
  cwd?: string;
  /** Value that configures or reports no extensions for this contract. */
  noExtensions?: boolean;
  /** Value that configures or reports quiet for this contract. */
  quiet?: boolean;
  /** Value that configures or reports profile for this contract. */
  profile?: boolean;
}

/** Documents the workspace contracts options payload exchanged by command, SDK, and package integrations. */
export interface WorkspaceContractsOptions {
  /** Value that configures or reports extension registrations for this contract. */
  extensionRegistrations?: ExtensionRegistrationRegistry | null;
  /** Value that configures or reports no extensions for this contract. */
  noExtensions?: boolean;
  /** Value that configures or reports cwd for this contract. */
  cwd?: string;
}

/** Documents the workspace contracts payload exchanged by command, SDK, and package integrations. */
export interface WorkspaceContracts {
  /** Value that configures or reports types for this contract. */
  types: string[];
  /** Value that configures or reports statuses for this contract. */
  statuses: string[];
  /** Lifecycle state reported for openthe record. */
  openStatus: string;
  /** Lifecycle state reported for closethe record. */
  closeStatus: string;
  /** Lifecycle state reported for canceledthe record. */
  canceledStatus: string;
}

/**
 * Names a native pm action or an extension-contributed action accepted by {@link runAction}.
 */
export type PmActionName = PmToolAction | (string & {});

/** Plain object option bag forwarded to the same command runners used by MCP. */
export type PmActionOptions = Record<string, unknown>;

/** Union returned by the generic schema customization helper. */
export type SchemaResult =
  | SchemaInspectResult
  | SchemaListResult
  | SchemaShowResult
  | SchemaShowStatusResult
  | SchemaListFieldsResult
  | SchemaShowFieldResult
  | SchemaAddTypeResult
  | SchemaRemoveTypeResult
  | SchemaAddStatusResult
  | SchemaRemoveStatusResult
  | SchemaAddFieldResult
  | SchemaRemoveFieldResult
  | SchemaApplyPresetResult
  | SchemaAddTypeInferResult;

/** Result returned by the SDK `startTask` lifecycle shortcut. */
export interface StartTaskResult {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports action for this contract. */
  action: "start_task";
  /** Value that configures or reports claim for this contract. */
  claim: ClaimResult;
  /** Value that configures or reports update for this contract. */
  update: UpdateResult;
}

/** Result returned by the SDK `pauseTask` lifecycle shortcut. */
export interface PauseTaskResult {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports action for this contract. */
  action: "pause_task";
  /** Value that configures or reports update for this contract. */
  update: UpdateResult;
  /** Value that configures or reports release for this contract. */
  release: ReleaseResult;
}

/** Result returned by the SDK `closeTask` lifecycle shortcut. */
export interface CloseTaskResult {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports action for this contract. */
  action: "close_task";
  /** Value that configures or reports close for this contract. */
  close: CloseResult;
  /** Value that configures or reports release for this contract. */
  release: ReleaseResult;
}

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
  /** Return full `changed_fields` arrays for mutation actions instead of the default compact `changed_field_count` projection. */
  fullChangedFields?: boolean;
  /** Return only mutation item ids when supported by the action. */
  idOnly?: boolean;
  action?: never;
};

/** Command options accepted by PmClient mutation convenience methods. */
export type PmClientMutationOptions = PmActionOptions & {
  /** Return full `changed_fields` arrays for this mutation instead of the compact SDK default. */
  fullChangedFields?: boolean;
  /** Return only mutation item ids when supported by the action. */
  idOnly?: boolean;
};

/** Mutation options accepted by typed SDK convenience helpers that always return full command result envelopes. */
export type PmClientFullMutationOptions = Omit<
  PmClientMutationOptions,
  "fullChangedFields" | "idOnly"
>;

/** Options for atomic next-work selection. `maxAttempts` accepts 1 through 100 inclusive and is validated at runtime for both numeric SDK input and CLI-style strings. */
export interface ClaimNextOptions extends PmClientFullMutationOptions {
  /** Maximum ranked candidates to attempt, from 1 through 100 inclusive. */
  maxAttempts?: number | string;
}

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

function splitFullClientMutationOptions(
  options: PmClientFullMutationOptions,
): PmClientRunArgs {
  return { fullChangedFields: true, options };
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
  context(options: ContextOptions = {}): Promise<ContextResult> {
    return this.runTyped("context", { options });
  }

  /** List items with the MCP/agent compact defaults. */
  list(options: ListOptions = {}): Promise<ListResult> {
    return this.runTyped("list", { options });
  }

  /** Search items with the MCP/agent compact defaults. */
  search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    return this.runTyped("search", { query, options });
  }

  /** Read one item by id. */
  get(id: string, options: GetOptions = {}): Promise<GetResult> {
    return this.runTyped("get", { id, options });
  }

  /** Return the ranked next-work recommendation produced by `pm next`. */
  next(options: NextOptions = {}): Promise<NextResult> {
    return this.runTyped("next", { options });
  }

  /** Group matching items with the same semantics as `pm aggregate`. */
  aggregate(options: AggregateOptions = {}): Promise<AggregateResult> {
    return this.runTyped("aggregate", { options });
  }

  /** Return project tracker statistics with the same sections as `pm stats`. */
  stats(options: StatsCommandOptions = {}): Promise<StatsResult> {
    return this.runTyped("stats", { options });
  }

  /** Add, inspect, or execute one item's linked tests. */
  test(id: string, options: TestCommandOptions = {}): Promise<TestResult> {
    return this.runTyped("test", { id, options });
  }

  /** Execute linked tests across the selected tracker items. */
  testAll(options: TestAllCommandOptions = {}): Promise<TestAllResult> {
    return this.runTyped("test-all", { options });
  }

  /** Inspect, flush, aggregate, or clear the local telemetry queue. */
  telemetry(options: TelemetryCommandOptions = {}): Promise<TelemetryResult> {
    return this.runTyped("telemetry", { options });
  }

  /** Evaluate canonical search rankings against a golden query set. */
  evaluate(options: EvalOptions = {}): Promise<EvalResult> {
    return this.runTyped("eval", { options });
  }

  /** List, add, edit, or delete item comments. */
  comments(
    id: string,
    options: CommentsCommandOptions = {},
  ): Promise<CommentsResult> {
    return this.runTyped("comments", { id, options });
  }

  /** List or append private item notes. */
  notes(id: string, options: NotesCommandOptions = {}): Promise<NotesResult> {
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
  files(id: string, options: FilesCommandOptions = {}): Promise<FilesResult> {
    return this.runTyped("files", { id, options });
  }

  /** Discover and optionally attach changed files for an item. */
  filesDiscover(
    id: string,
    options: FilesDiscoverOptions = {},
  ): Promise<FilesDiscoverResult> {
    return this.runTyped("files-discover", { id, options });
  }

  /** Add, remove, clear, or list linked documentation for an item. */
  docs(id: string, options: DocsCommandOptions = {}): Promise<DocsResult> {
    return this.runTyped("docs", { id, options });
  }

  /** Inspect item dependency relationships. */
  deps(id: string, options: DepsCommandOptions = {}): Promise<DepsResult> {
    return this.runTyped("deps", { id, options });
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

  /** Run project validation checks. */
  validate(options: ValidateCommandOptions = {}): Promise<ValidateResult> {
    return this.runTyped("validate", { options });
  }

  /** Run project health checks. */
  health(options: RunHealthOptions = {}): Promise<HealthResult> {
    return this.runTyped("health", { options });
  }

  /** Run tracker cache/runtime garbage collection. */
  gc(options: GcCommandOptions = {}): Promise<GcResult> {
    return this.runTyped("gc", { options });
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

  /** Create an item using the same mutation path as `pm create`. */
  create(options: PmClientFullMutationOptions = {}): Promise<CreateResult> {
    return this.runTyped("create", splitFullClientMutationOptions(options));
  }

  /** Update an item using the same mutation path as `pm update`. */
  update(
    id: string,
    options: PmClientFullMutationOptions = {},
  ): Promise<UpdateResult> {
    return this.runTyped("update", {
      id,
      ...splitFullClientMutationOptions(options),
    });
  }

  /** Close an item using the same mutation path as `pm close`. */
  close(
    id: string,
    reason: string,
    options: PmClientFullMutationOptions = {},
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

export {
  aggregate, context, evaluate, get, list, next, search, stats, telemetry, test, testAll,
} from "./client-read-operations.js";

/** List, add, edit, or delete item comments without constructing a reusable client. */
export function comments(
  id: string,
  options: CommentsCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<CommentsResult> {
  return new PmClient(clientOptions).comments(id, options);
}

/** List or append private item notes without constructing a reusable client. */
export function notes(
  id: string,
  options: NotesCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<NotesResult> {
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
export function files(
  id: string,
  options: FilesCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<FilesResult> {
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

/** Manage linked item docs without constructing a reusable client. */
export function docs(
  id: string,
  options: DocsCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<DocsResult> {
  return new PmClient(clientOptions).docs(id, options);
}

/** Inspect item dependency relationships without constructing a reusable client. */
export function deps(
  id: string,
  options: DepsCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<DepsResult> {
  return new PmClient(clientOptions).deps(id, options);
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

/** Validate a tracker without constructing a reusable client. */
export function validate(
  options: ValidateCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<ValidateResult> {
  return new PmClient(clientOptions).validate(options);
}

/** Run health checks without constructing a reusable client. */
export function health(
  options: RunHealthOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<HealthResult> {
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
  options: PmClientFullMutationOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<CreateResult> {
  return new PmClient(clientOptions).create(options);
}

/** Update an item without constructing a reusable client. */
export function update(
  id: string,
  options: PmClientFullMutationOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<UpdateResult> {
  return new PmClient(clientOptions).update(id, options);
}

/** Close an item without constructing a reusable client. */
export function close(
  id: string,
  reason: string,
  options: PmClientFullMutationOptions = {},
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

  return {
    types: [...typeRegistry.types],
    statuses: statusRegistry.definitions.map((definition) => definition.id),
    openStatus: statusRegistry.open_status,
    closeStatus: statusRegistry.close_status,
    canceledStatus: statusRegistry.canceled_status,
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

function globalOptions(args: Record<string, unknown>): GlobalOptions {
  return {
    json: true,
    quiet: true,
    path: readString(args, "path"),
    noExtensions: args.noExtensions === true || args.no_extensions === true,
    noPager: true,
  };
}

const ARRAY_TO_CSV_FIELDS = new Set([
  "tags",
  "blockedBy",
  "blocked_by",
  "skills",
  "fields",
]);

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

const LIFECYCLE_AUTHOR_ALIAS_ACTIONS = new Set([
  "claim",
  "release",
  "start-task",
  "pause-task",
  "close-task",
]);

function normalizeMcpOptionsArrays(
  options: Record<string, unknown>,
  action?: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const promoteAddRemove =
    action !== undefined && ARRAY_ADD_REMOVE_ACTIONS.has(action);
  const preserveStandaloneNote =
    action === "files" || action === "files-discover" || action === "docs";
  for (const [key, value] of Object.entries(options)) {
    if (Array.isArray(value) && ARRAY_TO_CSV_FIELDS.has(key)) {
      result[key] = value.join(",");
      continue;
    }
    if (key === "note" && preserveStandaloneNote) {
      result[key] = value;
      continue;
    }
    if (typeof value === "string" && SCALAR_TO_ARRAY_FIELDS.has(key)) {
      result[key] = [value];
      continue;
    }
    if (
      typeof value === "string" &&
      promoteAddRemove &&
      (key === "add" || key === "remove")
    ) {
      result[key] = [value];
      continue;
    }
    result[key] = value;
  }
  return result;
}

function optionsWithAuthor(
  args: Record<string, unknown>,
  action?: string,
): Record<string, unknown> {
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
    hoistKey("title");
    hoistKey("type");
    hoistKey("status");
    hoistKey("description");
    hoistKey("body");
    hoistKey("priority");
    hoistKey("tags");
    hoistKey("parent");
    hoistKey("createMode");
    hoistKey("create_mode");
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
  const options = normalizeMcpOptionsArrays(
    { ...hoistedTopLevel, ...baseOptions },
    action,
  );
  const author = readString(args, "author");
  const authorFromAssignee =
    action !== undefined && LIFECYCLE_AUTHOR_ALIAS_ACTIONS.has(action)
      ? (readString(args, "assignee") ?? readString(options, "assignee"))
      : undefined;
  if (author && options.author === undefined) {
    return { ...options, author };
  }
  if (authorFromAssignee && options.author === undefined) {
    return { ...options, author: authorFromAssignee };
  }
  return options;
}

// GH-170 (pm-pfnx): the narrow pm_files/pm_docs tools spell the CLI --note flag
// as `addNote` (the shared `note` parameter is the array-typed create/update
// note seed). Translate it onto the runner's `note` option; an explicit
// options.note (pm_run callers) wins.
function withAddNoteOption(
  options: Record<string, unknown>,
): Record<string, unknown> {
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

function withFilesDiscoveryOptions(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...options };
  if (
    next.discoveryNote !== undefined &&
    next.note === undefined &&
    typeof next.discoveryNote === "string"
  ) {
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
    const isAlphaNumeric =
      (character >= "a" && character <= "z") ||
      (character >= "0" && character <= "9");
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
  return value
    .map((entry) => String(entry))
    .filter((entry) => entry.length > 0);
}

function extensionOptionsFromArgs(
  args: Record<string, unknown>,
  options: Record<string, unknown>,
): Record<string, unknown> {
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
      : await withCwd(explicitCwd, () =>
          withActiveExtensionsExclusively(global, resolutionCwd, run),
        ),
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
    throw new PmCliError(`Unsupported native pm action: ${action}`, 64);
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
    const suffix =
      handlerResult.warnings.length > 0
        ? ` (${handlerResult.warnings.join(", ")})`
        : "";
    throw new PmCliError(
      `Unsupported native pm action: ${action}${suffix}`,
      64,
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

/** Mutation tools (create/update/close/append/update-many) return a verbose `changed_fields` array. On the agent path we drop it to a `changed_field_count` by default for token efficiency, restoring the full array only when the caller explicitly passes the MCP-level fullChangedFields=true control. Mutation options are forwarded unchanged so runtime fields named `full` remain valid user data. */
function withMutationCompaction(
  args: Record<string, unknown>,
  options?: Record<string, unknown> | null,
): {
  changedFields: "full" | "compact";
  idOnly: boolean;
  runnerOptions: Record<string, unknown>;
} {
  return {
    changedFields: args.fullChangedFields === true ? "full" : "compact",
    idOnly: args.idOnly === true,
    runnerOptions: { ...options },
  };
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
    assigneeFilter:
      readScalarString(options, "filterAssigneeFilter") ??
      readScalarString(options, "filterAssignee_filter"),
    parent: readScalarString(options, "filterParent"),
    sprint: readScalarString(options, "filterSprint"),
    release: readScalarString(options, "filterRelease"),
    limit: readScalarString(options, "limit"),
    offset: readScalarString(options, "offset"),
  };
}

function closeManyOptionsFromFlat(
  options: Record<string, unknown>,
): CloseManyCommandOptions {
  return {
    status: readString(options, "filterStatus"),
    list: isRecord(options.list)
      ? normalizeListOptions(options.list)
      : mutationListOptions(options),
    reason: readString(options, "reason"),
    resolution: readString(options, "resolution"),
    expectedResult:
      readString(options, "expectedResult") ??
      readString(options, "expected_result") ??
      readString(options, "expected"),
    actualResult:
      readString(options, "actualResult") ??
      readString(options, "actual_result") ??
      readString(options, "actual"),
    validateClose:
      readString(options, "validateClose") ??
      readString(options, "validate_close"),
    author: readString(options, "author"),
    message: readString(options, "message"),
    force: options.force === true ? true : undefined,
    dryRun:
      options.dryRun === true || options.dry_run === true ? true : undefined,
    rollback: readString(options, "rollback"),
    checkpoint:
      options.checkpoint === false ||
      options.noCheckpoint === true ||
      options.no_checkpoint === true
        ? false
        : undefined,
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

function updateManyUpdateOptionsFromFlat(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (UPDATE_MANY_FLAT_CONTROL_KEYS.has(key)) {
      continue;
    }
    update[key] = value;
  }
  return normalizeMcpUpdateOptions(update);
}

function normalizeMcpUpdateOptions(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedInput: Record<string, unknown> = normalizeMcpOptionsArrays(
    options,
    "update-many",
  );
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

function updateManyOptionsFromFlat(
  options: Record<string, unknown>,
): UpdateManyCommandOptions {
  if (isRecord(options.list) || isRecord(options.update)) {
    const updateSource = isRecord(options.update)
      ? options.update
      : updateManyUpdateOptionsFromFlat(options);
    return {
      status: readScalarString(options, "filterStatus"),
      list: isRecord(options.list)
        ? normalizeListOptions(options.list)
        : mutationListOptions(options),
      update: normalizeMcpUpdateOptions(updateSource) as never,
      dryRun:
        options.dryRun === true || options.dry_run === true ? true : undefined,
      rollback: readString(options, "rollback"),
      checkpoint:
        options.checkpoint === false ||
        options.noCheckpoint === true ||
        options.no_checkpoint === true
          ? false
          : undefined,
    };
  }
  return {
    status: readScalarString(options, "filterStatus"),
    list: mutationListOptions(options),
    update: updateManyUpdateOptionsFromFlat(options) as never,
    dryRun:
      options.dryRun === true || options.dry_run === true ? true : undefined,
    rollback: readString(options, "rollback"),
    checkpoint:
      options.checkpoint === false ||
      options.noCheckpoint === true ||
      options.no_checkpoint === true
        ? false
        : undefined,
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
  "list-draft": {
    action: "list",
    options: { status: "draft", excludeTerminal: false },
  },
  "list-open": {
    action: "list",
    options: { status: "open", excludeTerminal: false },
  },
  "list-in-progress": {
    action: "list",
    options: { status: "in_progress", excludeTerminal: false },
  },
  "list-blocked": {
    action: "list",
    options: { status: "blocked", excludeTerminal: false },
  },
  "list-closed": {
    action: "list",
    options: { status: "closed", excludeTerminal: false },
  },
  "list-canceled": {
    action: "list",
    options: { status: "canceled", excludeTerminal: false },
  },
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
  "extension-deactivate": {
    action: "extension",
    options: { deactivate: true },
  },
};

const PACKAGE_ACTION_ALIASES: Record<string, SdkActionAlias> = {
  "package-init": {
    action: "package",
    options: { init: true, vocabulary: "package" },
  },
  "package-install": {
    action: "package",
    options: { install: true, vocabulary: "package" },
  },
  "package-uninstall": {
    action: "package",
    options: { uninstall: true, vocabulary: "package" },
  },
  "package-explore": {
    action: "package",
    options: { explore: true, vocabulary: "package" },
  },
  "package-manage": {
    action: "package",
    options: { manage: true, vocabulary: "package" },
  },
  "package-describe": {
    action: "package",
    options: { describe: true, vocabulary: "package" },
  },
  "package-reload": {
    action: "package",
    options: { reload: true, vocabulary: "package" },
  },
  "package-doctor": {
    action: "package",
    options: { doctor: true, vocabulary: "package" },
  },
  "package-catalog": {
    action: "package",
    options: { catalog: true, vocabulary: "package" },
  },
  "package-adopt": {
    action: "package",
    options: { adopt: true, vocabulary: "package" },
  },
  "package-adopt-all": {
    action: "package",
    options: { adoptAll: true, vocabulary: "package" },
  },
  "package-activate": {
    action: "package",
    options: { activate: true, vocabulary: "package" },
  },
  "package-deactivate": {
    action: "package",
    options: { deactivate: true, vocabulary: "package" },
  },
};

const SDK_ACTION_ALIASES: Record<string, SdkActionAlias> = {
  ctx: { action: "context" },
  ...LIST_ACTION_ALIASES,
  ...EXTENSION_ACTION_ALIASES,
  ...PACKAGE_ACTION_ALIASES,
};

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

async function runMcpSearchAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const searchOptions: Parameters<typeof runSearch>[1] = { ...ctx.options };
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
    { changedFields, idOnly },
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
      limit: resolveMcpTelemetryLimit(ctx.args, ctx.options),
    },
    ctx.global,
  );
}

function resolveMcpTelemetryLimit(
  args: Record<string, unknown>,
  options: Record<string, unknown>,
): number | string | undefined {
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

function runMcpSchemaAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> | unknown {
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
  throw new PmCliError(
    `Unknown pm schema subcommand "${schema.subcommand}". Allowed: add-type, remove-type, add-status, remove-status, add-field, remove-field, list-fields, show-field, apply-preset, list, show, show-status`,
    64,
  );
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
    throw new PmCliError(
      `Unknown pm profile subcommand "${subcommand}". Allowed: list, show, apply, lint`,
      64,
    );
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
    tagPrefix:
      typeof ctx.options.tagPrefix === "string"
        ? ctx.options.tagPrefix
        : undefined,
  });
}

async function runMcpAppendAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const { changedFields, runnerOptions } = withMutationCompaction(
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

const SDK_ACTION_HANDLERS: Record<string, McpActionHandler> = {
  init: (ctx) =>
    runInit(readString(ctx.args, "prefix"), ctx.global, ctx.options),
  context: (ctx) => runContext(ctx.options, ctx.global),
  next: (ctx) => runNext(ctx.options, ctx.global),
  list: runMcpListAction,
  get: (ctx) => runGet(requireMcpItemId(ctx), ctx.global, ctx.options),
  search: runMcpSearchAction,
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
  notes: (ctx) => runNotes(requireMcpItemId(ctx), ctx.options, ctx.global),
  learnings: (ctx) =>
    runLearnings(requireMcpItemId(ctx), ctx.options, ctx.global),
  files: runMcpFilesAction,
  docs: (ctx) =>
    runDocs(requireMcpItemId(ctx), withAddNoteOption(ctx.options), ctx.global),
  test: (ctx) => runTest(requireMcpItemId(ctx), ctx.options, ctx.global),
  "test-all": (ctx) => runTestAll(ctx.options, ctx.global),
  "test-runs": (ctx) => runTestRunsAction(readString(ctx.args, "subcommand") ?? readRequiredString(ctx.options, "subcommand"), readString(ctx.args, "runId") ?? readString(ctx.options, "runId"), ctx.options, ctx.global),
  "test-runs-list": (ctx) => runTestRunsAction("list", undefined, ctx.options, ctx.global),
  "test-runs-status": (ctx) => runTestRunsAction("status", readRequiredString(ctx.args, "runId"), ctx.options, ctx.global),
  "test-runs-logs": (ctx) => runTestRunsAction("logs", readRequiredString(ctx.options, "runId"), ctx.options, ctx.global),
  "test-runs-stop": (ctx) => runTestRunsAction("stop", readRequiredString(ctx.options, "runId"), ctx.options, ctx.global),
  "test-runs-resume": (ctx) => runTestRunsAction("resume", readRequiredString(ctx.options, "runId"), ctx.options, ctx.global),
  eval: (ctx) =>
    runSearchEval(ctx.options, ctx.global, (query, options, global) =>
      runSearch(query, options, global),
    ),
  telemetry: runMcpTelemetryAction,
  validate: (ctx) =>
    runValidate(ctx.options, ctx.global, {
      runUpdate: (id, options, global) => runUpdate(id, options, global),
    }),
  health: runMcpHealthAction,
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
  "files-discover": (ctx) =>
    runFilesDiscover(requireMcpItemId(ctx), ctx.options, ctx.global),
  history: (ctx) => runHistory(requireMcpItemId(ctx), ctx.options, ctx.global),
  "history-redact": (ctx) =>
    runHistoryRedact(requireMcpItemId(ctx), ctx.options, ctx.global),
  "history-repair": runMcpHistoryRepairAction,
  "history-compact": runMcpHistoryCompactAction,
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
  return handler
    ? handler(ctx)
    : dispatchActiveExtensionAction(
        action,
        args,
        options,
        global,
        activeExtensions,
      );
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
  ValidateResult,
  EvalOptions,
  EvalResult,
  TelemetryCommandOptions,
  TelemetryResult,
  TestAllCommandOptions,
  TestAllResult,
  TestCommandOptions,
  TestResult,
};
