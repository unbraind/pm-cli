/**
 * @module sdk/runtime-primitives
 *
 * Public host primitives shared by the CLI, MCP server, embedded runtimes, and
 * package adapters. Presentation layers import this SDK seam instead of
 * reaching into private core modules, while higher-level consumers should
 * prefer the typed operations exported by the main SDK barrel.
 */
export {
  type MutationCheckpointItem,
  createCheckpointId,
  loadMutationCheckpoint,
  restoreCheckpointItems,
  writeMutationCheckpoint,
} from "../core/checkpoint/mutation-checkpoint.js";
export {
  flattenFlagListValue,
  resolveFlagValueKind,
} from "../core/extensions/flag-value-types.js";
export {
  type ActiveExtensionHookContext,
  type ExtensionCommandRegistry,
  type ExtensionDiscoveryResult,
  type ExtensionHookRegistry,
  type ExtensionParserRegistry,
  type ExtensionPreflightRegistry,
  type ExtensionRegistrationRegistry,
  type ExtensionRendererRegistry,
  type ExtensionServiceRegistry,
  type PreflightRuntimeDecision,
  type RegisteredExtensionCommandDefinition,
  type RegisteredExtensionFlagDefinitions,
  type RegisteredExtensionSchemaMigrationDefinition,
  activateExtensions,
  clearActiveExtensionHooks,
  consumeAfterCommandAffectedItems,
  createCoreCommandHookContext,
  createEmptyExtensionRegistrationRegistry,
  discoverExtensions,
  getActiveCommandResult,
  getActiveExtensionRegistrations,
  loadExtensions,
  projectAfterCommandItemSnapshot,
  recordAfterCommandAffectedItem,
  resetActiveExtensionRuntimeState,
  runActiveCommandHandler,
  runActiveOnIndexHooks,
  runActiveOnReadHooks,
  runActiveOnWriteHooks,
  runActiveParserOverride,
  runActivePreflightOverride,
  runActiveServiceOverride,
  runAfterCommandHooks,
  runBeforeCommandHooks,
  setActiveCommandContext,
  setActiveCommandResult,
  setActiveExtensionCommands,
  setActiveExtensionHooks,
  setActiveExtensionParsers,
  setActiveExtensionPreflight,
  setActiveExtensionRegistrations,
  setActiveExtensionRenderers,
  setActiveExtensionServices,
} from "../core/extensions/index.js";
export {
  applyRegisteredItemFieldDefaultsAndValidation,
  collectRegisteredItemFieldNames,
  parseRegisteredItemFieldAssignments,
} from "../core/extensions/item-fields.js";
export { resolveExtensionRoots } from "../core/extensions/loader.js";
export {
  resolveRegisteredSearchProvider,
  resolveRegisteredVectorStoreAdapter,
} from "../core/extensions/runtime-registrations.js";
export {
  pathExists,
  readFileIfExists,
  removeFileIfExists,
  writeFileAtomic,
} from "../core/fs/fs-utils.js";
export {
  type HistoryDiffValueEntry,
  computeHistoryDiff,
  patchPathToChangedField,
} from "../core/history/history-diff.js";
export {
  enforceHistoryStreamPolicyForItem,
  enforceHistoryStreamPolicyForItems,
} from "../core/history/history-stream-policy.js";
export {
  appendHistoryEntry,
  createHistoryEntry,
  hashDocument,
  hashEmptyDocument,
} from "../core/history/history.js";
export {
  appendWorkspaceHistoryChange,
  getWorkspaceHistoryPath,
  WORKSPACE_HISTORY_ID,
  writeWorkspaceJsonWithHistory,
  type WorkspaceHistoryChange,
  type WorkspaceJsonWriteOptions,
} from "../core/history/workspace-history.js";
export {
  normalizeReplayPatchOps,
  replayToCanonicalItemDocument,
  replayToItemDocument,
  toReplayDocument,
  verifyHistoryChain,
} from "../core/history/replay.js";
export { resolveBodyFileContent } from "../core/io/body-file.js";
export {
  generateItemId,
  normalizeItemId,
  normalizeRawItemId,
} from "../core/item/id.js";
export {
  canonicalDocument,
  normalizeItemMetadata,
  parseItemDocument,
  serializeItemDocument,
} from "../core/item/item-format.js";
export { toItemRecord } from "../core/item/item-record.js";
export {
  assertParentReferenceIsNotSelf,
  isPlaceholderReferenceToken,
  normalizeParentReferenceValue,
  validateMissingParentReference,
} from "../core/item/parent-reference-policy.js";
export {
  applyAcceptanceCriteriaMutations,
  applyTagRemovals,
  assertNoUnknownCsvKeys,
  createStdinTokenResolver,
  looksLikeGenericKeyValueEntry,
  mergeAdditiveTags,
  parseCsvKv,
  parseOptionalNonNegativeInteger,
  parseOptionalNumber,
  parseTags,
  splitAcceptanceCriteria,
} from "../core/item/parse.js";
export { resolvePriority } from "../core/item/priority.js";
export { validateSprintOrReleaseValue } from "../core/item/sprint-release-format.js";
export { parseStatusFilterCsv } from "../core/item/status-filter.js";
export {
  isTerminalStatus,
  normalizeStatusForRegistry,
  normalizeStatusInput,
} from "../core/item/status.js";
export {
  COMMON_MUTATION_COMMAND_OPTION_KEYS,
  type ItemTypeRegistry,
  type ResolvedItemTypeDefinition,
  canonicalizeCommandOptionKey,
  commandOptionFlagLabel,
  resolveCommandOptionPolicyState,
  resolveItemTypeRegistry,
  resolveTypeDefinition,
  resolveTypeName,
  validateTypeOptions,
} from "../core/item/type-registry.js";
export { resolveTypeSynonym } from "../core/item/type-synonyms.js";
export { acquireLock } from "../core/lock/lock.js";
export { printError, printResult, writeStdout } from "../core/output/output.js";
export { renderRowsAsCsv, renderRowsAsTable } from "../core/output/tabular.js";
export {
  resolveConfiguredPmPackageRoot,
  resolvePmCliVersion,
  resolvePmPackageRootFromModule,
} from "../core/packages/root.js";
export { buildInvalidTypeError } from "../core/schema/item-types-file.js";
export {
  collectRuntimeFilterValues,
  matchesRuntimeFilters,
} from "../core/schema/runtime-field-filters.js";
export {
  collectRuntimeCreateFieldValues,
  collectRuntimeUpdateFieldValues,
} from "../core/schema/runtime-field-values.js";
export {
  type RuntimeFieldCommand,
  type RuntimeFieldRegistry,
  type RuntimeStatusRegistry,
  normalizeStatusInputWithRegistry,
  resolveItemTypesFilePath,
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  statusIsTerminal,
} from "../core/schema/runtime-schema.js";
export {
  type NormalizedTypeWorkflow,
  describeAllowedTransitions,
  evaluateTransition,
  resolveTypeWorkflows,
} from "../core/schema/type-workflows.js";
export {
  REINDEX_LOCK_ID,
  shouldRunSearchRefreshInForeground,
} from "../core/search/background-refresh.js";
export {
  readVectorizationStatusLedger,
  refreshSearchArtifactsForMutation,
  writeVectorizationStatusLedger,
} from "../core/search/cache.js";
export {
  buildSearchCorpus,
  buildSemanticCorpusInput,
  resolveSearchCorpusFields,
  resolveSemanticCorpusCharacterLimit,
} from "../core/search/corpus.js";
export { executeEmbeddingBatchesWithRetry } from "../core/search/embedding-batches.js";
export { resolveEmbeddingProviders } from "../core/search/providers.js";
export { resolveSettingsWithSemanticRuntimeDefaults } from "../core/search/semantic-defaults.js";
export {
  executeVectorDelete,
  executeVectorReset,
  executeVectorUpsert,
  resolveVectorStores,
} from "../core/search/vector-stores.js";
export {
  type VectorizationEmbeddingIdentity,
  type VectorizationEmbeddingMetadata,
  buildVectorizationEmbeddingIdentity,
  buildVectorizationEmbeddingMetadata,
  hasVectorizationEmbeddingIdentityChanged,
  hasVectorizationVectorDimensionChanged,
  inferConsistentVectorDimension,
} from "../core/search/vectorization-metadata.js";
export {
  sentryCaptureCliError,
  sentryFinishCommandSpan,
  sentryFlush,
  sentryLogCliUsageError,
  sentrySetCommandContext,
  sentryStartCommandSpan,
} from "../core/sentry/helpers.js";
export { ensureSentryInit } from "../core/sentry/instrument.js";
export {
  clearFocusedItem,
  getFocusedItem,
  setFocusedItem,
} from "../core/session/session-state.js";
export { resolveAuthor } from "../core/shared/author.js";
export type { GlobalOptions } from "../core/shared/command-types.js";
export {
  CREATE_DIRECT_CLOSE_REASON_DEFAULT,
  EXIT_CODE,
  ITEM_METADATA_KEY_ORDER,
  SETTINGS_DEFAULTS,
  TYPE_TO_FOLDER,
  type TelemetryErrorCategory,
  resolveTelemetryErrorCategory,
} from "../core/shared/constants.js";
export {
  PmCliError,
  type PmCliErrorContext,
  type PmCliErrorRecoveryPayload,
} from "../core/shared/errors.js";
export { decodeHtmlEntitiesInOptions } from "../core/shared/html-entity-decode.js";
export { createLazyModule } from "../core/shared/lazy-module.js";
export { levenshteinDistanceWithinLimit } from "../core/shared/levenshtein.js";
export { isPureSnakeCaseAlias } from "../core/shared/option-alias-visibility.js";
export {
  asRecordClone,
  asRecordOrNull,
  toErrorMessage,
  toNonEmptyStringOrUndefined,
} from "../core/shared/primitives.js";
export { createSerialQueue } from "../core/shared/serial-queue.js";
export { stableValueEquals } from "../core/shared/serialization.js";
export { splitCommaList } from "../core/shared/split-comma-list.js";
export {
  compareTimestampStrings,
  nowIso,
  resolveIsoOrRelative,
} from "../core/shared/time.js";
export { migrateItemFilesToFormat } from "../core/store/item-format-migration.js";
export {
  type CachedDocumentCandidate,
  listAllDocumentCandidatesCached,
} from "../core/store/item-metadata-cache.js";
export {
  buildItemNotFoundError,
  deleteItem,
  listAllItemMetadataLight,
  locateItem,
  mutateItem,
  readLocatedItem,
} from "../core/store/item-store.js";
export {
  getHistoryPath,
  getItemPath,
  getSettingsPath,
  resolvePmRoot,
} from "../core/store/paths.js";
export {
  readSettings,
  readSettingsWithMetadata,
  writeSettings,
} from "../core/store/settings.js";
export { maybeRunFirstUseTelemetryPrompt } from "../core/telemetry/consent.js";
export {
  type TelemetryCommandResolution,
  type TelemetryResolutionStage,
  deriveTelemetryCommandResolution,
} from "../core/telemetry/observability.js";
export {
  type ActiveTelemetryCommand,
  type TelemetryCommandOutcome,
  emitTelemetryErrorEvent,
  finishTelemetryCommand,
  startTelemetryCommand,
} from "../core/telemetry/runtime.js";
