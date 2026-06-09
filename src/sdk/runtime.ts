import path from "node:path";
import {
  activateExtensions,
  loadExtensions,
  type ExtensionRegistrationRegistry,
} from "../core/extensions/index.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import { resolveRuntimeStatusRegistry } from "../core/schema/runtime-schema.js";
import { readSettings } from "../core/store/settings.js";
import {
  runContracts,
  type ContractsCommandOptions,
  type ContractsResult,
} from "../cli/commands/contracts.js";

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
  toImportPriority,
  toImportStatus,
  toImportTags,
  toNonEmptyImportString,
  type CommitImportedItemParams,
  type CommitImportedItemResult,
} from "./package-import-adapters.js";
export {
  canonicalDocument,
  normalizeFrontMatter,
  serializeItemDocument,
  splitFrontMatter,
} from "../core/item/item-format.js";
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
export { runNormalize, type NormalizeCommandOptions, type NormalizeResult } from "../cli/commands/normalize.js";
export { runReindex, type ReindexOptions, type ReindexResult } from "../cli/commands/reindex.js";
export { runSearch, type SearchOptions, type SearchResult } from "../cli/commands/search.js";
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

export interface GetContractsOptions extends ContractsCommandOptions {
  pmRoot?: string;
  cwd?: string;
  noExtensions?: boolean;
  quiet?: boolean;
  profile?: boolean;
}

export interface WorkspaceContractsOptions {
  extensionRegistrations?: ExtensionRegistrationRegistry | null;
  noExtensions?: boolean;
  cwd?: string;
}

export interface WorkspaceContracts {
  types: string[];
  statuses: string[];
  openStatus: string;
  closeStatus: string;
  canceledStatus: string;
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
const WORKSPACE_CONTRACTS_CACHE_LIMIT = 50;
const workspaceExtensionRegistrationsCache = new Map<string, Promise<ExtensionRegistrationRegistry | null>>();

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

/**
 * Drop all memoized workspace extension registrations so the next
 * `getWorkspaceContracts` call re-loads and re-activates extensions from disk.
 * Long-lived hosts should call this after any extension or settings mutation.
 */
export function clearWorkspaceContractsCache(): void {
  workspaceExtensionRegistrationsCache.clear();
}

async function resolveWorkspaceExtensionRegistrations(
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  cwd?: string,
): Promise<ExtensionRegistrationRegistry | null> {
  const cacheKey = buildWorkspaceExtensionRegistrationsCacheKey(pmRoot, settings, cwd);
  const cached = workspaceExtensionRegistrationsCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  if (workspaceExtensionRegistrationsCache.size >= WORKSPACE_CONTRACTS_CACHE_LIMIT) {
    const oldestKey = workspaceExtensionRegistrationsCache.keys().next().value!;
    workspaceExtensionRegistrationsCache.delete(oldestKey);
  }
  const registrations = loadWorkspaceExtensionRegistrations(pmRoot, settings, cwd);
  workspaceExtensionRegistrationsCache.set(cacheKey, registrations);
  return registrations;
}

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
  return activationResult.registrations;
}

export type { ContractsCommandOptions, ContractsResult };
