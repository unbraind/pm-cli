/**
 * @module pm-governance-audit/sdk
 *
 * Resolves the host pm SDK runtime and exposes the typed subset consumed by
 * the governance-audit package without copying core command implementations.
 */
import * as runtime from "@unbrained/pm-cli/sdk/runtime";

/** Host SDK values used by package-owned audit commands and runtime decorators. */
export const {
  EXIT_CODE,
  PmCliError,
  PmClient,
  getActiveExtensionRegistrations,
  getSettingsPath,
  isTerminalStatus,
  jaccardSimilarity,
  locateItem,
  normalizeStatusInput,
  normalizeSimilarityText,
  nowIso,
  pathExists,
  readBooleanOption,
  readCsvListOption,
  readLocatedItem,
  readSettings,
  readStringOption,
  resolveItemTypeRegistry,
  resolvePmRoot,
  resolveRuntimeStatusRegistry,
  runClose,
  runUpdate,
  scoreItemSimilarity,
} = runtime;

/** Preserve the host SDK list overloads across the dynamic runtime boundary. */
export const runList: typeof runtime.runList = runtime.runList;

/** Runtime status registry inferred from the host SDK's schema resolver. */
export type RuntimeStatusRegistry = ReturnType<
  typeof resolveRuntimeStatusRegistry
>;

export type {
  GlobalOptions,
  ItemMetadata,
  ItemStatus,
  ListedItem,
  ListOptions,
  UpdateCommandOptions,
} from "@unbrained/pm-cli/sdk/runtime";
