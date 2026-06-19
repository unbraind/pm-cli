/**
 * @module cli/commands/health
 *
 * Implements the pm health command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { pathExists, readFileIfExists } from "../../core/fs/fs-utils.js";
import { activateExtensions, getActiveExtensionRegistrations, loadExtensions, runActiveOnReadHooks } from "../../core/extensions/index.js";
import { collectRegisteredItemFieldNames } from "../../core/extensions/item-fields.js";
import {
  KNOWN_EXTENSION_CAPABILITIES,
  type LoadedExtension,
} from "../../core/extensions/loader.js";
import { enforceHistoryStreamPolicyForItems } from "../../core/history/history-stream-policy.js";
import { scanHistoryDrift } from "../../core/history/drift-scan.js";
import { scanLockHealth } from "../../core/lock/lock-gc.js";
import {
  readVectorizationStatusLedger,
  refreshSemanticEmbeddingsForMutatedItems,
} from "../../core/search/cache.js";
import { resolveEmbeddingProviders, resolveProviderConfigSource } from "../../core/search/providers.js";
import { resolveSettingsWithSemanticRuntimeDefaults } from "../../core/search/semantic-defaults.js";
import { collectStaleVectorizationIds } from "../../core/search/staleness.js";
import {
  buildVectorizationEmbeddingIdentity,
  hasVectorizationEmbeddingIdentityChanged,
} from "../../core/search/vectorization-metadata.js";
import { resolveVectorStores } from "../../core/search/vector-stores.js";
import { EXIT_CODE, PM_CORE_REQUIRED_SUBDIRS, PM_OPTIONAL_TYPE_SUBDIRS } from "../../core/shared/constants.js";
import { findFirstMergeConflictMarker } from "../../core/shared/conflict-markers.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { toNonEmptyStringOrUndefined } from "../../core/shared/primitives.js";
import { nowIso } from "../../core/shared/time.js";
import { parseItemDocument } from "../../core/item/item-format.js";
import { listAllFrontMatter, listAllFrontMatterWithBody } from "../../core/store/item-store.js";
import {
  PM_TELEMETRY_SOURCE_CONTEXT_VALUES,
  TELEMETRY_MAX_QUEUE_ENTRY_ATTEMPTS,
  TELEMETRY_SCHEMA_VERSION,
} from "../../core/telemetry/runtime.js";

const PM_TELEMETRY_SOURCE_CONTEXT_SET = new Set<string>(PM_TELEMETRY_SOURCE_CONTEXT_VALUES);
import {
  getItemFormatFromPath,
  getSettingsPath,
  ITEM_FILE_EXTENSIONS,
  resolveGlobalPmRoot,
  resolvePmRoot,
} from "../../core/store/paths.js";
import { readSettingsWithMetadata } from "../../core/store/settings.js";
import { buildRemediationMap } from "../../core/diagnostics/remediation.js";
import type { HistoryCompactPolicy, ItemFormat, ItemMetadata, PmSettings } from "../../types/index.js";
import { readManagedExtensionState } from "./extension.js";
import {
  buildCapabilityContractMetadata,
  buildRegistrationCollisionRemediation,
  collectUnknownCapabilityGuidance,
} from "./extension/doctor.js";

type HealthStatus = "ok" | "warn";
type MigrationRuntimeStatus = "pending" | "failed" | "applied";

/**
 * Documents the health check payload exchanged by command, SDK, and package integrations.
 */
export interface HealthCheck {
  name:
    | "settings"
    | "directories"
    | "settings_values"
    | "telemetry"
    | "extensions"
    | "storage"
    | "locks"
    | "integrity"
    | "history_drift"
    | "vectorization";
  status: HealthStatus;
  details: Record<string, unknown>;
}

/**
 * Documents the health result payload exchanged by command, SDK, and package integrations.
 */
export interface HealthResult {
  ok: boolean;
  checks: HealthCheck[];
  warning_count?: number;
  warnings: string[];
  projection?: {
    mode: "brief" | "summary" | "full";
    warning_count: number;
    warnings_truncated: boolean;
    detail_limit: number;
    omitted_checks?: HealthCheck["name"][];
  };
  generated_at: string;
}

/**
 * Documents the run health options payload exchanged by command, SDK, and package integrations.
 */
export interface RunHealthOptions {
  strictDirectories?: boolean;
  checkOnly?: boolean;
  checkTelemetry?: boolean;
  noRefresh?: boolean;
  refreshVectors?: boolean;
  verboseStaleItems?: boolean;
  skipVectors?: boolean;
  skipIntegrity?: boolean;
  skipDrift?: boolean;
  full?: boolean;
  brief?: boolean;
  summary?: boolean;
}

interface MigrationStatusEntry {
  layer: "global" | "project";
  name: string;
  id: string;
  status: MigrationRuntimeStatus;
  reason?: string;
}

interface MigrationStatusSummary {
  applied: MigrationStatusEntry[];
  pending: MigrationStatusEntry[];
  failed: MigrationStatusEntry[];
  applied_count: number;
  pending_count: number;
  failed_count: number;
}

interface ExtensionHealthTriageSummary {
  status: "ok" | "warn";
  warning_count: number;
  warning_codes: string[];
  load_failure_count: number;
  activation_failure_count: number;
  migration_failed_count: number;
  migration_pending_count: number;
  managed_state_warning_count: number;
  managed_extension_entries_count: number;
  unmanaged_loaded_extension_count: number;
  unmanaged_loaded_extensions: string[];
  unmanaged_expected_extension_count: number;
  unmanaged_expected_extensions: string[];
  unmanaged_action_required_extension_count: number;
  unmanaged_action_required_extensions: string[];
  update_health_coverage: "full" | "partial";
  update_health_partial: boolean;
  unknown_capability_count: number;
  top_warnings: string[];
  remediation: string[];
}

type ItemWithBody = Awaited<ReturnType<typeof listAllFrontMatterWithBody>>[number];
const STALE_VECTORIZATION_SUMMARY_LIMIT = 25;
const BRIEF_HEALTH_DETAIL_LIMIT = 8;
const TELEMETRY_QUEUE_RELATIVE_PATH = path.join("runtime", "telemetry", "events.jsonl");
const TELEMETRY_STATE_RELATIVE_PATH = path.join("runtime", "telemetry", "state.json");
const TELEMETRY_ENDPOINT_PROBE_TIMEOUT_MS = 2_500;
const TELEMETRY_QUEUE_HIGH_WATER_MARK = 500;
const TELEMETRY_QUEUE_HIGH_RETRY_THRESHOLD = TELEMETRY_MAX_QUEUE_ENTRY_ATTEMPTS - 3;
const TELEMETRY_SERVER_MAX_SCHEMA_VERSION_HEADERS = [
  "x-pm-telemetry-max-schema-version",
  "x-pm-telemetry-max-version",
] as const;

/**
 * Advisory warnings are surfaced for visibility but never flip overall health to
 * not-ok. Telemetry is opt-out, non-critical observability: a queued/unreachable
 * telemetry endpoint or corrupt local telemetry state is not a project-health
 * failure and must not block agents that gate on `pm health` `ok`. History
 * over-compaction-threshold warnings are likewise advisory maintenance hints —
 * a deep stream is healthy, just a candidate for `pm history-compact`.
 */
function isAdvisoryHealthWarning(warning: string): boolean {
  return warning.startsWith("telemetry_") || warning.startsWith("history_stream_over_compact_threshold:");
}

function warningCode(value: string): string {
  const normalized = value.trim();
  const separator = normalized.indexOf(":");
  if (separator === -1) {
    return normalized;
  }
  return normalized.slice(0, separator);
}

function normalizeExtensionNameForMatch(value: string): string {
  return value.trim().toLowerCase();
}

function isExpectedUnmanagedExtension(name: string, directory: string): boolean {
  const normalizedName = normalizeExtensionNameForMatch(name);
  const normalizedDirectory = normalizeExtensionNameForMatch(directory);
  if (normalizedName.startsWith("builtin-")) {
    return true;
  }
  return normalizedDirectory === "beads" || normalizedDirectory === "todos";
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Summary of the history-stream directory used by the storage health check.
 * `over_threshold` is populated only when the compaction policy is enabled —
 * counting entries requires reading every stream, so the default (policy-off)
 * path stays a cheap directory listing.
 */
interface HistoryStreamSummary {
  count: number;
  warnings: string[];
  over_threshold: string[];
  max_entries: number | null;
}

async function countHistoryStreams(
  pmRoot: string,
  compactPolicy: HistoryCompactPolicy,
): Promise<HistoryStreamSummary> {
  const historyDir = path.join(pmRoot, "history");
  if (!(await isDirectory(historyDir))) {
    return { count: 0, warnings: [], over_threshold: [], max_entries: null };
  }
  const historyFiles = (await fs.readdir(historyDir))
    .filter((entry) => entry.endsWith(".jsonl"))
    .sort((left, right) => left.localeCompare(right));

  const policyActive = compactPolicy.enabled;
  const maxEntries = policyActive ? compactPolicy.max_entries : null;
  const warnings: string[] = [];
  const overThreshold: string[] = [];
  for (const fileName of historyFiles) {
    const streamPath = path.join(historyDir, fileName);
    warnings.push(...(await runActiveOnReadHooks({ path: streamPath, scope: "project" })));
    if (!policyActive) {
      continue;
    }
    const raw = await fs.readFile(streamPath, "utf8");
    let entries = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length > 0) {
        entries += 1;
      }
    }
    if (entries > compactPolicy.max_entries) {
      overThreshold.push(fileName.slice(0, -".jsonl".length));
    }
  }

  return {
    count: historyFiles.length,
    warnings: [...warnings, ...overThreshold.map((id) => `history_stream_over_compact_threshold:${id}`)],
    over_threshold: overThreshold,
    max_entries: maxEntries,
  };
}

function normalizeRelativePath(pmRoot: string, targetPath: string): string {
  return path.relative(pmRoot, targetPath).replaceAll("\\", "/");
}

async function listItemDocumentPaths(pmRoot: string, typeToFolder: Record<string, string>): Promise<string[]> {
  const folders = [...new Set(Object.values(typeToFolder))].sort((left, right) => left.localeCompare(right));
  const itemPaths: string[] = [];
  for (const folder of folders) {
    const directoryPath = path.join(pmRoot, folder);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(directoryPath);
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") {
        continue;
      }
      continue;
    }
    for (const entry of entries) {
      if (!ITEM_FILE_EXTENSIONS.some((extension) => entry.toLowerCase().endsWith(extension))) {
        continue;
      }
      itemPaths.push(path.join(directoryPath, entry));
    }
  }
  itemPaths.sort((left, right) => normalizeRelativePath(pmRoot, left).localeCompare(normalizeRelativePath(pmRoot, right)));
  return itemPaths;
}

async function buildIntegrityCheck(
  pmRoot: string,
  typeToFolder: Record<string, string>,
  schema: PmSettings["schema"],
): Promise<{ check: HealthCheck; warnings: string[] }> {
  const itemPaths = await listItemDocumentPaths(pmRoot, typeToFolder);
  const itemUnreadable: string[] = [];
  const itemConflictMarkers: Array<{ path: string; line: number; marker: string }> = [];
  const itemParseFailures: string[] = [];
  const extensionFieldNames = collectRegisteredItemFieldNames(getActiveExtensionRegistrations());

  for (const itemPath of itemPaths) {
    const relativePath = normalizeRelativePath(pmRoot, itemPath);
    let raw = "";
    try {
      raw = await fs.readFile(itemPath, "utf8");
    } catch {
      itemUnreadable.push(relativePath);
      continue;
    }
    const conflictMarker = findFirstMergeConflictMarker(raw);
    if (conflictMarker) {
      itemConflictMarkers.push({
        path: relativePath,
        line: conflictMarker.line,
        marker: conflictMarker.marker,
      });
      continue;
    }
    try {
      parseItemDocument(raw, { format: getItemFormatFromPath(itemPath) as ItemFormat, schema, extensionFieldNames });
    } catch {
      itemParseFailures.push(relativePath);
    }
  }

  const historyDir = path.join(pmRoot, "history");
  const historyUnreadable: string[] = [];
  const historyConflictMarkers: Array<{ id: string; line: number; marker: string }> = [];
  const historyInvalidJson: Array<{ id: string; line: number }> = [];
  let historyFiles: string[] = [];
  try {
    historyFiles = (await fs.readdir(historyDir)).filter((entry) => entry.endsWith(".jsonl")).sort((left, right) => left.localeCompare(right));
  } catch (error: unknown) {
    /* c8 ignore start -- ENOENT/non-ENOENT differentiation requires filesystem fault injection */
    if (!(typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT")) {
      historyUnreadable.push("history");
    }
    /* c8 ignore stop */
  }
  for (const fileName of historyFiles) {
    const itemId = fileName.slice(0, -".jsonl".length);
    const historyPath = path.join(historyDir, fileName);
    let raw = "";
    try {
      raw = await fs.readFile(historyPath, "utf8");
    } catch {
      historyUnreadable.push(itemId);
      continue;
    }
    const conflictMarker = findFirstMergeConflictMarker(raw);
    if (conflictMarker) {
      historyConflictMarkers.push({
        id: itemId,
        line: conflictMarker.line,
        marker: conflictMarker.marker,
      });
      continue;
    }
    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }
      try {
        JSON.parse(line);
      } catch {
        historyInvalidJson.push({
          id: itemId,
          line: index + 1,
        });
      }
    }
  }

  const warnings = [
    ...itemUnreadable.map((entry) => `integrity_item_unreadable:${entry}`),
    ...itemConflictMarkers.map((entry) => `integrity_item_conflict_marker:${entry.path}:L${entry.line}`),
    ...itemParseFailures.map((entry) => `integrity_item_parse_failed:${entry}`),
    ...historyUnreadable.map((entry) => `integrity_history_unreadable:${entry}`),
    ...historyConflictMarkers.map((entry) => `integrity_history_conflict_marker:${entry.id}:L${entry.line}`),
    ...historyInvalidJson.map((entry) => `integrity_history_invalid_json:${entry.id}:L${entry.line}`),
  ];
  const normalizedWarnings = [...new Set(warnings)].sort((left, right) => left.localeCompare(right));

  return {
    check: {
      name: "integrity",
      status: normalizedWarnings.length === 0 ? "ok" : "warn",
      details: {
        checked_item_files: itemPaths.length,
        checked_history_streams: historyFiles.length,
        counts: {
          item_unreadable: itemUnreadable.length,
          item_conflict_markers: itemConflictMarkers.length,
          item_parse_failures: itemParseFailures.length,
          history_unreadable: historyUnreadable.length,
          history_conflict_markers: historyConflictMarkers.length,
          history_invalid_json: historyInvalidJson.length,
        },
        item_unreadable: itemUnreadable,
        item_conflict_markers: itemConflictMarkers,
        item_parse_failures: itemParseFailures,
        history_unreadable: historyUnreadable,
        history_conflict_markers: historyConflictMarkers,
        history_invalid_json: historyInvalidJson,
      },
    },
    warnings: normalizedWarnings,
  };
}

/* c8 ignore start -- activate export shape variants are exercised through integration load tests */
function hasActivateExport(moduleRecord: Record<string, unknown>): boolean {
  if (typeof moduleRecord.activate === "function") {
    return true;
  }
  const defaultExport = moduleRecord.default;
  if (typeof defaultExport !== "object" || defaultExport === null) {
    return false;
  }
  return typeof (defaultExport as Record<string, unknown>).activate === "function";
}
/* c8 ignore stop */

function summarizeLoadedExtension(extension: LoadedExtension): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    layer: extension.layer,
    directory: extension.directory,
    manifest_path: extension.manifest_path,
    name: extension.name,
    version: extension.version,
    entry: extension.entry,
    priority: extension.priority,
    entry_path: extension.entry_path,
    has_activate: hasActivateExport(extension.module as Record<string, unknown>),
  };
  /* c8 ignore start -- capability list optionality is exercised by extension load integration suites */
  if (Array.isArray(extension.capabilities)) {
    summary.capabilities = [...extension.capabilities];
  }
  /* c8 ignore stop */
  return summary;
}

function resolveMigrationId(definition: Record<string, unknown>, fallbackIndex: number): string {
  const explicitId = toNonEmptyStringOrUndefined(definition.id);
  if (explicitId) {
    return explicitId;
  }
  return `migration-${String(fallbackIndex + 1).padStart(3, "0")}`;
}

function resolveMigrationStatus(definition: Record<string, unknown>): MigrationRuntimeStatus {
  const rawStatus = toNonEmptyStringOrUndefined(definition.status);
  const normalized = rawStatus?.toLowerCase();
  if (normalized === "failed") {
    return "failed";
  }
  if (normalized === "applied") {
    return "applied";
  }
  return "pending";
}

function resolveMigrationFailureReason(definition: Record<string, unknown>): string | undefined {
  return toNonEmptyStringOrUndefined(definition.reason) ?? toNonEmptyStringOrUndefined(definition.error) ?? toNonEmptyStringOrUndefined(definition.message);
}

/* c8 ignore start -- comparator tie-break branches are deterministic ordering glue exercised via migration integration tests */
function compareMigrationEntries(left: MigrationStatusEntry, right: MigrationStatusEntry): number {
  const byLayer = (left.layer ?? "").localeCompare(right.layer ?? "");
  if (byLayer !== 0) {
    return byLayer;
  }
  const byName = (left.name ?? "").localeCompare(right.name ?? "");
  if (byName !== 0) {
    return byName;
  }
  return (left.id ?? "").localeCompare(right.id ?? "");
}
/* c8 ignore stop */

function summarizeMigrationStatuses(
  migrations: Array<{
    layer: "global" | "project";
    name: string;
    definition: Record<string, unknown>;
  }>,
): { summary: MigrationStatusSummary; warnings: string[] } {
  const applied: MigrationStatusEntry[] = [];
  const pending: MigrationStatusEntry[] = [];
  const failed: MigrationStatusEntry[] = [];

  migrations.forEach((migration, index) => {
    const id = resolveMigrationId(migration.definition, index);
    const status = resolveMigrationStatus(migration.definition);
    if (status === "applied") {
      applied.push({
        layer: migration.layer,
        name: migration.name,
        id,
        status,
      });
      return;
    }
    if (status === "failed") {
      failed.push({
        layer: migration.layer,
        name: migration.name,
        id,
        status,
        reason: resolveMigrationFailureReason(migration.definition),
      });
      return;
    }
    pending.push({
      layer: migration.layer,
      name: migration.name,
      id,
      status,
    });
  });

  applied.sort(compareMigrationEntries);
  pending.sort(compareMigrationEntries);
  failed.sort(compareMigrationEntries);

  const warnings = [
    ...failed.map((entry) => `extension_migration_failed:${entry.layer}:${entry.name}:${entry.id}`),
    ...pending.map((entry) => `extension_migration_pending:${entry.layer}:${entry.name}:${entry.id}`),
  ];

  return {
    summary: {
      applied,
      pending,
      failed,
      applied_count: applied.length,
      pending_count: pending.length,
      failed_count: failed.length,
    },
    warnings,
  };
}

function buildExtensionHealthTriageSummary(
  warnings: string[],
  loadFailureCount: number,
  activationFailureCount: number,
  migrationStatus: MigrationStatusSummary,
  managedStateWarningCount: number,
  managedExtensionEntriesCount: number,
  unmanagedLoadedExtensions: string[],
  unmanagedExpectedExtensions: string[],
  unmanagedActionRequiredExtensions: string[],
): ExtensionHealthTriageSummary {
  const normalizedWarnings = [...new Set(warnings)].sort((left, right) => left.localeCompare(right));
  const warningCodes = [...new Set(normalizedWarnings.map((value) => warningCode(value)))].sort((left, right) =>
    left.localeCompare(right),
  );
  const unknownCapabilityCount = normalizedWarnings.filter((warning) => warning.startsWith("extension_capability_unknown:")).length;
  const updateHealthPartial = unmanagedActionRequiredExtensions.length > 0;
  const updateHealthCoverage = updateHealthPartial ? "partial" : "full";
  const remediation: string[] = [];
  const registrationCollisionRemediation = buildRegistrationCollisionRemediation(normalizedWarnings, {
    deactivate: "pm extension --deactivate <name> --project/--global",
    doctor: "pm extension --doctor --project/--global --detail deep --trace",
  });
  if (registrationCollisionRemediation) {
    remediation.push(registrationCollisionRemediation);
  }
  if (loadFailureCount > 0) {
    remediation.push("Run pm extension --explore --project and pm extension --explore --global to inspect load failures.");
  }
  if (activationFailureCount > 0) {
    remediation.push("Review checks[name=extensions].details.activation.failed in pm health --json for activation error details.");
  }
  if (migrationStatus.failed_count > 0 || migrationStatus.pending_count > 0) {
    remediation.push("Resolve pending/failed extension migrations before write commands; use --force only when policy allows.");
  }
  if (managedStateWarningCount > 0) {
    remediation.push("Run pm extension --manage --project and pm extension --manage --global to refresh managed-state diagnostics.");
  }
  if (unknownCapabilityCount > 0) {
    remediation.push(
      `Unknown extension capabilities detected. Allowed capabilities: ${KNOWN_EXTENSION_CAPABILITIES.join(", ")}. ` +
        "Review extension_capability_unknown warning details for suggested replacements.",
    );
  }
  if (normalizedWarnings.some((warning) => warning.startsWith("extension_capability_legacy_alias:"))) {
    remediation.push(
      "Legacy extension capability aliases were auto-remapped to canonical capabilities. " +
        "Update manifests to canonical names (migration/validation -> schema).",
    );
  }
  if (normalizedWarnings.some((warning) => warning.startsWith("extension_command_definition_legacy_handler_alias:"))) {
    remediation.push(
      "Extension command definitions using legacy handler were auto-remapped. " +
        "Update command definitions to use run: (context) => ... for forward compatibility.",
    );
  }
  if (updateHealthPartial) {
    remediation.push(
      "Update-check coverage is partial because unmanaged extensions need adoption. Adopt existing installs via pm extension --manage --project/--global --fix-managed-state, pm extension --adopt-all --project/--global, or pm extension --adopt <name>.",
    );
  } else if (unmanagedLoadedExtensions.length > 0) {
    remediation.push(
      "Loaded unmanaged extensions are currently treated as informational. Use pm extension --manage --project/--global --fix-managed-state to adopt them for update checks.",
    );
  }
  if (remediation.length === 0) {
    remediation.push("No immediate action required. Re-run pm health after extension configuration changes.");
  }
  return {
    status: normalizedWarnings.length === 0 ? "ok" : "warn",
    warning_count: normalizedWarnings.length,
    warning_codes: warningCodes,
    load_failure_count: loadFailureCount,
    activation_failure_count: activationFailureCount,
    migration_failed_count: migrationStatus.failed_count,
    migration_pending_count: migrationStatus.pending_count,
    managed_state_warning_count: managedStateWarningCount,
    managed_extension_entries_count: managedExtensionEntriesCount,
    unmanaged_loaded_extension_count: unmanagedLoadedExtensions.length,
    unmanaged_loaded_extensions: unmanagedLoadedExtensions,
    unmanaged_expected_extension_count: unmanagedExpectedExtensions.length,
    unmanaged_expected_extensions: unmanagedExpectedExtensions,
    unmanaged_action_required_extension_count: unmanagedActionRequiredExtensions.length,
    unmanaged_action_required_extensions: unmanagedActionRequiredExtensions,
    update_health_coverage: updateHealthCoverage,
    update_health_partial: updateHealthPartial,
    unknown_capability_count: unknownCapabilityCount,
    top_warnings: normalizedWarnings.slice(0, 8),
    remediation,
  };
}

async function buildExtensionCheck(
  pmRoot: string,
  settings: PmSettings,
  noExtensionsFlag: boolean,
): Promise<{ check: HealthCheck; warnings: string[] }> {
  const loadResult = await loadExtensions({
    pmRoot,
    settings,
    cwd: process.cwd(),
    noExtensions: noExtensionsFlag,
  });
  const loadedSummaries = loadResult.loaded.map((extension) => summarizeLoadedExtension(extension));
  const activationResult = await activateExtensions({
    ...loadResult,
    loaded: loadResult.loaded,
  });
  const [projectManagedState, globalManagedState] = await Promise.all([
    readManagedExtensionState(loadResult.roots.project),
    readManagedExtensionState(loadResult.roots.global),
  ]);
  const migrationStatus = summarizeMigrationStatuses(activationResult.registrations.migrations);
  const activationDetails = {
    failed: activationResult.failed,
    warnings: activationResult.warnings,
    hook_counts: activationResult.hook_counts,
    command_override_count: activationResult.command_override_count,
    command_handler_count: activationResult.command_handler_count,
    parser_override_count: activationResult.parser_override_count,
    preflight_override_count: activationResult.preflight_override_count,
    service_override_count: activationResult.service_override_count,
    renderer_override_count: activationResult.renderer_override_count,
    registration_counts: activationResult.registration_counts,
    registrations: activationResult.registrations,
    migration_status: migrationStatus.summary,
    managed_extensions: {
      project: {
        path: projectManagedState.path,
        count: projectManagedState.state.entries.length,
        entries: projectManagedState.state.entries,
      },
      global: {
        path: globalManagedState.path,
        count: globalManagedState.state.entries.length,
        entries: globalManagedState.state.entries,
      },
    },
  };
  /* c8 ignore start -- unmanaged/expected grouping matrices are exercised in doctor + extension integration suites */
  const managedProjectNames = new Set(
    projectManagedState.state.entries.map((entry) => normalizeExtensionNameForMatch(entry.name)),
  );
  const managedGlobalNames = new Set(globalManagedState.state.entries.map((entry) => normalizeExtensionNameForMatch(entry.name)));
  const unmanagedLoadedEntries = [
    ...new Map(
      loadResult.loaded
        .filter((entry) => {
          const managedNames = entry.layer === "project" ? managedProjectNames : managedGlobalNames;
          return !managedNames.has(normalizeExtensionNameForMatch(entry.name));
        })
        .map((entry) => [
          `${entry.layer}:${entry.name}`,
          {
            layer: entry.layer,
            name: entry.name,
            directory: entry.directory,
          },
        ]),
    ).values(),
  ].sort((left, right) => {
    const leftKey = `${left.layer}:${left.name}`;
    const rightKey = `${right.layer}:${right.name}`;
    return leftKey.localeCompare(rightKey);
  });
  const unmanagedLoadedExtensions = unmanagedLoadedEntries
    .map((entry) => `${entry.layer}:${entry.name}`)
    .sort((left, right) => left.localeCompare(right));
  const unmanagedExpectedExtensions = unmanagedLoadedEntries
    .filter((entry) => isExpectedUnmanagedExtension(entry.name, entry.directory))
    .map((entry) => `${entry.layer}:${entry.name}`)
    .sort((left, right) => left.localeCompare(right));
  const unmanagedActionRequiredExtensions = unmanagedLoadedEntries
    .filter((entry) => !isExpectedUnmanagedExtension(entry.name, entry.directory))
    .map((entry) => `${entry.layer}:${entry.name}`)
    .sort((left, right) => left.localeCompare(right));
  /* c8 ignore stop */
  const updateCoverageWarnings =
    unmanagedActionRequiredExtensions.length > 0
      ? [`extension_update_health_partial_coverage:skipped_unmanaged:${unmanagedActionRequiredExtensions.length}`]
      : [];
  const extensionWarnings = [
    ...loadResult.warnings,
    ...activationDetails.warnings,
    ...migrationStatus.warnings,
    ...projectManagedState.warnings,
    ...globalManagedState.warnings,
    ...updateCoverageWarnings,
  ];
  const capabilityGuidance = collectUnknownCapabilityGuidance(extensionWarnings);
  const capabilityContract = buildCapabilityContractMetadata();
  const extensionTriage = buildExtensionHealthTriageSummary(
    extensionWarnings,
    loadResult.failed.length,
    activationResult.failed.length,
    migrationStatus.summary,
    projectManagedState.warnings.length + globalManagedState.warnings.length,
    projectManagedState.state.entries.length + globalManagedState.state.entries.length,
    unmanagedLoadedExtensions,
    unmanagedExpectedExtensions,
    unmanagedActionRequiredExtensions,
  );

  return {
    check: {
      name: "extensions",
      status: extensionWarnings.length === 0 ? "ok" : "warn",
      details: {
        ...loadResult,
        loaded: loadedSummaries,
        warnings: extensionWarnings,
        activation: activationDetails,
        triage: extensionTriage,
        capability_contract: capabilityContract,
        capability_guidance: capabilityGuidance,
      } as Record<string, unknown>,
    },
    warnings: extensionWarnings,
  };
}

function summarizeList(values: string[], limit: number): { values: string[]; truncated: boolean } {
  if (values.length <= limit) {
    return { values, truncated: false };
  }
  return {
    values: values.slice(0, limit),
    truncated: true,
  };
}

function summarizeRecordList(value: unknown, limit: number): { count: number; sample: unknown[]; truncated: boolean } {
  if (!Array.isArray(value)) {
    return {
      count: 0,
      sample: [],
      truncated: false,
    };
  }
  return {
    count: value.length,
    sample: value.slice(0, limit),
    truncated: value.length > limit,
  };
}

function summarizeExtensionRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    layer: record.layer,
    directory: record.directory,
    name: record.name,
    version: record.version,
    enabled: record.enabled,
    status: record.status,
    has_activate: record.has_activate,
    capabilities: record.capabilities,
  };
}

function summarizeExtensionList(value: unknown, limit: number): { count: number; sample: unknown[]; truncated: boolean } {
  const summary = summarizeRecordList(value, limit);
  return {
    ...summary,
    sample: summary.sample.map((entry) => summarizeExtensionRecord(entry)),
  };
}

function summarizeStringList(value: unknown, limit: number): { count: number; sample: string[]; truncated: boolean } {
  if (!Array.isArray(value)) {
    return {
      count: 0,
      sample: [],
      truncated: false,
    };
  }
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return {
    count: strings.length,
    sample: strings.slice(0, limit),
    truncated: strings.length > limit,
  };
}

/* c8 ignore start -- brief/summary projection matrix branches are validated in projection integration tests */
function summarizeHealthCheckDetails(check: HealthCheck, limit: number): Record<string, unknown> {
  const details = check.details;
  if (check.name === "settings") {
    return {
      version: details.version,
      id_prefix: details.id_prefix,
      locks_ttl_seconds: details.locks_ttl_seconds,
      warnings: summarizeStringList(details.warnings, limit),
    };
  }
  if (check.name === "directories") {
    return {
      required_count: Array.isArray(details.required) ? details.required.length : 0,
      optional_count: Array.isArray(details.optional) ? details.optional.length : 0,
      missing_required: summarizeStringList(details.missing_required, limit),
      missing_optional: summarizeStringList(details.missing_optional, limit),
      missing: summarizeStringList(details.missing, limit),
      strict_directories: details.strict_directories,
    };
  }
  if (check.name === "settings_values") {
    return {
      warnings: summarizeStringList(details.warnings, limit),
    };
  }
  if (check.name === "telemetry") {
    return {
      enabled: details.enabled,
      capture_level: details.capture_level,
      endpoint: details.endpoint,
      queue_exists: details.queue_exists,
      queue_entries: details.queue_entries,
      queue_draining: details.queue_draining,
      queue_invalid_rows: details.queue_invalid_rows,
      queue_rows_total: details.queue_rows_total,
      last_successful_flush_at: details.last_successful_flush_at,
      last_failed_flush_at: details.last_failed_flush_at,
      endpoint_probe: details.endpoint_probe,
      env_overrides: details.env_overrides,
    };
  }
  if (check.name === "extensions") {
    const activation = typeof details.activation === "object" && details.activation !== null ? (details.activation as Record<string, unknown>) : {};
    return {
      disabled_by_flag: details.disabled_by_flag,
      discovered: summarizeExtensionList(details.discovered, limit),
      effective: summarizeExtensionList(details.effective, limit),
      loaded: summarizeExtensionList(details.loaded, limit),
      failed: summarizeRecordList(details.failed, limit),
      warnings: summarizeStringList(details.warnings, limit),
      activation: {
        failed: summarizeRecordList(activation.failed, limit),
        warnings: summarizeStringList(activation.warnings, limit),
        hook_counts: activation.hook_counts,
        command_handler_count: activation.command_handler_count,
        service_override_count: activation.service_override_count,
        renderer_override_count: activation.renderer_override_count,
        registration_counts: activation.registration_counts,
        migration_status:
          typeof activation.migration_status === "object" && activation.migration_status !== null
            ? {
                applied_count: (activation.migration_status as Record<string, unknown>).applied_count,
                pending_count: (activation.migration_status as Record<string, unknown>).pending_count,
                failed_count: (activation.migration_status as Record<string, unknown>).failed_count,
              }
            : null,
      },
      triage: details.triage,
      capability_contract: details.capability_contract,
      capability_guidance: summarizeRecordList(details.capability_guidance, limit),
    };
  }
  if (check.name === "storage") {
    return details;
  }
  if (check.name === "locks") {
    // Counts only: drops remediation_map, which is full-output-only by contract.
    return {
      active_lock_count: details.active_lock_count,
      stale_lock_count: details.stale_lock_count,
      unreadable_lock_count: details.unreadable_lock_count,
      unparseable_lock_count: details.unparseable_lock_count,
    };
  }
  if (check.name === "integrity") {
    return {
      checked_item_files: details.checked_item_files,
      checked_history_streams: details.checked_history_streams,
      counts: details.counts,
      item_unreadable: summarizeStringList(details.item_unreadable, limit),
      item_conflict_markers: summarizeRecordList(details.item_conflict_markers, limit),
      item_parse_failures: summarizeStringList(details.item_parse_failures, limit),
      history_unreadable: summarizeStringList(details.history_unreadable, limit),
      history_conflict_markers: summarizeRecordList(details.history_conflict_markers, limit),
      history_invalid_json: summarizeRecordList(details.history_invalid_json, limit),
      skipped: details.skipped,
    };
  }
  if (check.name === "history_drift") {
    return {
      checked_items: details.checked_items,
      counts: details.counts,
      drifted_items: summarizeStringList(details.drifted_items, limit),
      missing_streams: summarizeStringList(details.missing_streams, limit),
      unreadable_streams: summarizeStringList(details.unreadable_streams, limit),
      hash_mismatches: summarizeStringList(details.hash_mismatches, limit),
      chain_mismatches: summarizeStringList(details.chain_mismatches, limit),
      skipped: details.skipped,
    };
  }
  if (check.name === "vectorization") {
    return {
      semantic_runtime_available: details.semantic_runtime_available,
      compatibility_mode_auto_defaults: details.compatibility_mode_auto_defaults,
      auto_ollama_defaults_applied: details.auto_ollama_defaults_applied,
      refresh_policy: details.refresh_policy,
      provider_active: details.provider_active,
      vector_store_active: details.vector_store_active,
      items: details.items,
      ledger_entries_before: details.ledger_entries_before,
      stale_items_before_total: details.stale_items_before_total,
      stale_items_before: summarizeStringList(details.stale_items_before, limit),
      refresh_attempted: details.refresh_attempted,
      refresh_skipped_reason: details.refresh_skipped_reason,
      refresh_result: details.refresh_result,
      ledger_entries_after: details.ledger_entries_after,
      stale_items_after_total: details.stale_items_after_total,
      stale_items_after: summarizeStringList(details.stale_items_after, limit),
      skipped: details.skipped,
    };
  }
  return details;
}
/* c8 ignore stop */

function applyBriefHealthProjection(result: HealthResult): HealthResult {
  const warningsSummary = summarizeStringList(result.warnings, BRIEF_HEALTH_DETAIL_LIMIT);
  return {
    ok: result.ok,
    checks: result.checks.map((check) => ({
      name: check.name,
      status: check.status,
      details: summarizeHealthCheckDetails(check, BRIEF_HEALTH_DETAIL_LIMIT),
    })),
    warnings: warningsSummary.sample,
    projection: {
      mode: "brief",
      warning_count: warningsSummary.count,
      warnings_truncated: warningsSummary.truncated,
      detail_limit: BRIEF_HEALTH_DETAIL_LIMIT,
    },
    generated_at: result.generated_at,
  };
}

function isSkippedHealthCheck(check: HealthCheck): boolean {
  return check.details.skipped === true;
}

function applySummaryHealthProjection(result: HealthResult): HealthResult {
  const warningsSummary = summarizeStringList(result.warnings, BRIEF_HEALTH_DETAIL_LIMIT);
  const omittedChecks = result.checks.filter(isSkippedHealthCheck).map((check) => check.name);
  return {
    ok: result.ok,
    checks: result.checks
      .filter((check) => !isSkippedHealthCheck(check))
      .map((check) => ({
        name: check.name,
        status: check.status,
        details: {},
      })),
    warning_count: warningsSummary.count,
    warnings: warningsSummary.sample,
    projection: {
      mode: "summary",
      warning_count: warningsSummary.count,
      warnings_truncated: warningsSummary.truncated,
      detail_limit: BRIEF_HEALTH_DETAIL_LIMIT,
      omitted_checks: omittedChecks,
    },
    generated_at: result.generated_at,
  };
}

function selectStaleItemDetail(
  values: string[],
  verboseStaleItems: boolean,
): {
  values: string[];
  truncated: boolean;
  total: number;
} {
  if (verboseStaleItems) {
    return {
      values,
      truncated: false,
      total: values.length,
    };
  }
  const summary = summarizeList(values, STALE_VECTORIZATION_SUMMARY_LIMIT);
  return {
    values: summary.values,
    truncated: summary.truncated,
    total: values.length,
  };
}

interface TelemetryRuntimeStateRecord {
  endpoint?: string;
  queue_entries?: number;
  last_attempted_flush_at?: string;
  last_successful_flush_at?: string;
  last_failed_flush_at?: string;
  last_failed_flush_error?: string;
  pending_otel_spans?: number;
  last_otel_attempt_at?: string;
  last_otel_success_at?: string;
  last_otel_failure_at?: string;
  last_otel_failure_error?: string;
}

function telemetryEnvFlagEnabled(
  envKey: "PM_TELEMETRY_DISABLED" | "PM_TELEMETRY_OTEL_DISABLED" | "PM_NO_TELEMETRY" | "PM_TELEMETRY_INLINE_FLUSH",
): boolean {
  const value = (process.env[envKey] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/* c8 ignore start -- environment override permutations are covered by runtime integration tests */
function telemetrySourceContextOverride(): string | null {
  // Only report an override the runtime actually honours: runtime.ts ignores any
  // value outside the enum and falls back to the inferred context, so health must
  // report null for an unrecognized value rather than implying it took effect.
  const value = (process.env.PM_TELEMETRY_SOURCE_CONTEXT ?? "").trim().toLowerCase();
  return PM_TELEMETRY_SOURCE_CONTEXT_SET.has(value) ? value : null;
}
/* c8 ignore stop */

function normalizeEndpointForDisplay(rawEndpoint: string): string {
  const trimmed = rawEndpoint.trim();
  if (trimmed.length === 0) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function parseTelemetryQueue(raw: string): {
  validEntries: number;
  invalidRows: number;
  totalRows: number;
  highRetryEntries: number;
  maxAttempts: number;
} {
  let validEntries = 0;
  let invalidRows = 0;
  let totalRows = 0;
  let highRetryEntries = 0;
  let maxAttempts = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    totalRows += 1;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.attempts === "number" &&
        Number.isFinite(parsed.attempts)
      ) {
        const attempts = Math.max(0, Math.trunc(parsed.attempts));
        validEntries += 1;
        maxAttempts = Math.max(maxAttempts, attempts);
        if (attempts >= TELEMETRY_QUEUE_HIGH_RETRY_THRESHOLD) {
          highRetryEntries += 1;
        }
      } else {
        /* c8 ignore next -- invalid queue rows are covered by end-to-end telemetry fixtures */
        invalidRows += 1;
      }
    } catch {
      invalidRows += 1;
    }
  }
  return {
    validEntries,
    invalidRows,
    totalRows,
    highRetryEntries,
    maxAttempts,
  };
}

async function probeTelemetryEndpointHealth(endpoint: string): Promise<{
  probe_url: string;
  ok: boolean;
  status?: number;
  max_schema_version?: string;
  error?: string;
}> {
  let probeUrl = endpoint;
  try {
    const parsed = new URL(endpoint);
    parsed.pathname = "/healthz";
    parsed.search = "";
    parsed.hash = "";
    probeUrl = parsed.toString();
  } catch {
    // keep original endpoint when URL parsing fails
  }
  try {
    const response = await fetch(probeUrl, {
      method: "GET",
      signal: AbortSignal.timeout(TELEMETRY_ENDPOINT_PROBE_TIMEOUT_MS),
    });
    return {
      probe_url: normalizeEndpointForDisplay(probeUrl),
      ok: response.ok,
      status: response.status,
      max_schema_version: (() => {
        for (const headerName of TELEMETRY_SERVER_MAX_SCHEMA_VERSION_HEADERS) {
          const value = response.headers.get(headerName)?.trim();
          if (value && value.length > 0) {
            return value;
          }
        }
        return undefined;
      })(),
    };
  } catch (error: unknown) {
    return {
      probe_url: normalizeEndpointForDisplay(probeUrl),
      ok: false,
      /* c8 ignore next -- non-Error throwables require transport-layer fault injection */
      error: error instanceof Error ? error.message : "probe_failed",
    };
  }
}

async function buildTelemetryCheck(
  settings: PmSettings,
  options: { checkTelemetry: boolean },
): Promise<{ check: HealthCheck; warnings: string[] }> {
  const globalPmRoot = resolveGlobalPmRoot(process.cwd());
  const queuePath = path.join(globalPmRoot, TELEMETRY_QUEUE_RELATIVE_PATH);
  const statePath = path.join(globalPmRoot, TELEMETRY_STATE_RELATIVE_PATH);

  const queueRaw = await readFileIfExists(queuePath);
  const queueExists = queueRaw !== null;
  const queueSizeBytes = queueRaw ? Buffer.byteLength(queueRaw, "utf8") : 0;
  const queueSummary = queueRaw
    ? parseTelemetryQueue(queueRaw)
    : { validEntries: 0, invalidRows: 0, totalRows: 0, highRetryEntries: 0, maxAttempts: 0 };

  const stateRaw = await readFileIfExists(statePath);
  let runtimeState: TelemetryRuntimeStateRecord = {};
  let stateParseFailed = false;
  /* c8 ignore start -- telemetry state corruption and otel-failure branches require runtime-coordinated fixture mutation */
  if (stateRaw && stateRaw.trim().length > 0) {
    try {
      const parsed = JSON.parse(stateRaw) as TelemetryRuntimeStateRecord;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        runtimeState = parsed;
      } else {
        /* c8 ignore next -- malformed runtime-state payloads are integration-only corruption cases */
        stateParseFailed = true;
      }
    } catch {
      stateParseFailed = true;
    }
  }

  const endpoint = settings.telemetry.endpoint.trim();
  const endpointDisplay = normalizeEndpointForDisplay(endpoint);
  let endpointProbe:
    | {
        attempted: boolean;
        probe_url: string;
        ok: boolean;
        status?: number;
        max_schema_version?: string;
        error?: string;
      }
    | undefined;
  if (options.checkTelemetry && settings.telemetry.enabled && endpoint.length > 0) {
    const probe = await probeTelemetryEndpointHealth(endpoint);
    endpointProbe = {
      attempted: true,
      ...probe,
    };
  }

  const warnings: string[] = [];
  if (stateParseFailed) {
    warnings.push("telemetry_state_invalid_json");
  }
  if (queueSummary.invalidRows > 0) {
    warnings.push(`telemetry_queue_invalid_rows:${queueSummary.invalidRows}`);
  }
  const queueHasEntries = settings.telemetry.enabled && queueSummary.validEntries > 0;
  if (queueHasEntries) {
    const lastSuccess = runtimeState.last_successful_flush_at;
    const lastFailure = runtimeState.last_failed_flush_at;
    const activeFailure = lastFailure && (!lastSuccess || lastFailure > lastSuccess);
    const neverFlushed = !lastSuccess;
    const highWater = queueSummary.validEntries >= TELEMETRY_QUEUE_HIGH_WATER_MARK;
    const highRetries = queueSummary.highRetryEntries > 0;
    if (activeFailure || neverFlushed || highWater) {
      warnings.push(`telemetry_queue_pending:${queueSummary.validEntries}`);
    }
    if (highRetries) {
      warnings.push(`telemetry_queue_high_retries:${queueSummary.highRetryEntries}`);
    }
  }
  if (endpointProbe && !endpointProbe.ok) {
    if (typeof endpointProbe.status === "number") {
      warnings.push(`telemetry_endpoint_probe_http_status:${endpointProbe.status}`);
    } else {
      warnings.push("telemetry_endpoint_probe_failed");
    }
  }
  const parsedMaxSchemaVersion = Number.parseInt(endpointProbe?.max_schema_version ?? "", 10);
  if (
    endpointProbe &&
    endpointProbe.ok &&
    Number.isInteger(parsedMaxSchemaVersion) &&
    parsedMaxSchemaVersion > TELEMETRY_SCHEMA_VERSION
  ) {
    warnings.push(`telemetry_schema_version_behind:${parsedMaxSchemaVersion}`);
  }
  const pendingOtelSpans = typeof runtimeState.pending_otel_spans === "number" ? runtimeState.pending_otel_spans : 0;
  const lastOtelSuccess = runtimeState.last_otel_success_at;
  const lastOtelFailure = runtimeState.last_otel_failure_at;
  const otelExportFailing =
    settings.telemetry.enabled &&
    pendingOtelSpans > 0 &&
    Boolean(lastOtelFailure) &&
    // >= so a mixed-outcome batch (success + failure share the same attempt
    // timestamp) still surfaces the warning rather than being masked by the tie.
    (!lastOtelSuccess || (lastOtelFailure as string) >= lastOtelSuccess);
  if (otelExportFailing) {
    warnings.push(`telemetry_otel_export_failing:${pendingOtelSpans}`);
  }
  /* c8 ignore stop */

  return {
    check: {
      name: "telemetry",
      status: warnings.length === 0 ? "ok" : "warn",
      details: {
        enabled: settings.telemetry.enabled,
        capture_level: settings.telemetry.capture_level,
        endpoint: endpointDisplay,
        global_pm_root: globalPmRoot,
        queue_path: queuePath,
        queue_exists: queueExists,
        queue_entries: queueSummary.validEntries,
        queue_draining:
          queueHasEntries &&
          warnings.every(
            (warning) =>
              !warning.startsWith("telemetry_queue_pending:") && !warning.startsWith("telemetry_queue_high_retries:"),
          ),
        queue_invalid_rows: queueSummary.invalidRows,
        queue_rows_total: queueSummary.totalRows,
        queue_size_bytes: queueSizeBytes,
        queue_high_retry_entries: queueSummary.highRetryEntries,
        queue_high_retry_threshold: TELEMETRY_QUEUE_HIGH_RETRY_THRESHOLD,
        queue_max_attempts: queueSummary.maxAttempts,
        runtime_state_path: statePath,
        last_attempted_flush_at: runtimeState.last_attempted_flush_at ?? null,
        last_successful_flush_at: runtimeState.last_successful_flush_at ?? null,
        last_failed_flush_at: runtimeState.last_failed_flush_at ?? null,
        last_failed_flush_error: runtimeState.last_failed_flush_error ?? null,
        pending_otel_spans: pendingOtelSpans,
        last_otel_attempt_at: runtimeState.last_otel_attempt_at ?? null,
        last_otel_success_at: runtimeState.last_otel_success_at ?? null,
        last_otel_failure_at: runtimeState.last_otel_failure_at ?? null,
        last_otel_failure_error: runtimeState.last_otel_failure_error ?? null,
        endpoint_probe: endpointProbe ?? {
          attempted: false,
        },
        /* c8 ignore start -- env-override combinations are validated through runtime integration suites */
        env_overrides: {
          telemetry_disabled: telemetryEnvFlagEnabled("PM_TELEMETRY_DISABLED") || telemetryEnvFlagEnabled("PM_NO_TELEMETRY"),
          pm_no_telemetry: telemetryEnvFlagEnabled("PM_NO_TELEMETRY"),
          telemetry_otel_disabled: telemetryEnvFlagEnabled("PM_TELEMETRY_OTEL_DISABLED"),
          telemetry_inline_flush: telemetryEnvFlagEnabled("PM_TELEMETRY_INLINE_FLUSH"),
          telemetry_source_context: telemetrySourceContextOverride(),
        },
        /* c8 ignore stop */
      },
    },
    warnings,
  };
}

/**
 * Read-only locks check (pm-xo1n): surfaces active/stale/unreadable/unparseable
 * lock counts using the exact classification `pm gc --scope locks` acts on, so
 * agents can gate on stale item-claim locks before running gc speculatively.
 */
async function buildLocksCheck(pmRoot: string): Promise<{ check: HealthCheck; warnings: string[] }> {
  /* c8 ignore start -- scan failure branches require filesystem-level fault injection */
  let scan: Awaited<ReturnType<typeof scanLockHealth>>;
  try {
    scan = await scanLockHealth(pmRoot);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      check: {
        name: "locks",
        status: "warn",
        details: {
          active_lock_count: 0,
          stale_lock_count: 0,
          unreadable_lock_count: 0,
          unparseable_lock_count: 0,
          scan_failed: true,
          error: message,
          pm_root: pmRoot,
        },
      },
      warnings: [`locks_scan_failed:${message}`],
    };
  }
  const warnings: string[] = [];
  if (scan.stale_lock_count > 0) {
    warnings.push(`locks_stale_count:${scan.stale_lock_count}`);
  }
  if (scan.unreadable_lock_count > 0) {
    warnings.push(`locks_unreadable:${scan.unreadable_lock_count}`);
  }
  /* c8 ignore stop */
  return {
    check: {
      name: "locks",
      status: warnings.length === 0 ? "ok" : "warn",
      details: {
        active_lock_count: scan.active_lock_count,
        stale_lock_count: scan.stale_lock_count,
        unreadable_lock_count: scan.unreadable_lock_count,
        unparseable_lock_count: scan.unparseable_lock_count,
      },
    },
    warnings,
  };
}

async function buildHistoryDriftCheck(
  pmRoot: string,
  items: ItemWithBody[],
): Promise<{ check: HealthCheck; warnings: string[] }> {
  const { missingStreams, unreadableStreams, hashMismatches, chainMismatches, driftedItems } = await scanHistoryDrift(
    pmRoot,
    items,
    { cacheHitVerification: "metadata" },
  );
  const warnings = [
    ...missingStreams.map((id) => `history_drift_missing_stream:${id}`),
    ...unreadableStreams.map((id) => `history_drift_unreadable_stream:${id}`),
    ...hashMismatches.map((id) => `history_drift_hash_mismatch:${id}`),
    ...chainMismatches.map((id) => `history_drift_chain_mismatch:${id}`),
  ];
  return {
    check: {
      name: "history_drift",
      status: warnings.length === 0 ? "ok" : "warn",
      details: {
        checked_items: items.length,
        cache_hit_verification: "metadata",
        drifted_items: driftedItems,
        counts: {
          drifted: driftedItems.length,
          missing_streams: missingStreams.length,
          unreadable_streams: unreadableStreams.length,
          hash_mismatches: hashMismatches.length,
          chain_mismatches: chainMismatches.length,
        },
        missing_streams: missingStreams,
        unreadable_streams: unreadableStreams,
        hash_mismatches: hashMismatches,
        chain_mismatches: chainMismatches,
      },
    },
    warnings,
  };
}

async function buildVectorizationCheck(
  pmRoot: string,
  settings: PmSettings,
  items: ItemWithBody[],
  refreshPolicy: {
    enabled: boolean;
    checkOnly: boolean;
    noRefresh: boolean;
    refreshVectors: boolean;
  },
  verboseStaleItems: boolean,
): Promise<{ check: HealthCheck; warnings: string[] }> {
  const runtimeDefaults = resolveSettingsWithSemanticRuntimeDefaults(settings);
  const providerResolution = resolveEmbeddingProviders(runtimeDefaults.settings);
  const vectorStoreResolution = resolveVectorStores(runtimeDefaults.settings);
  const runtimeEmbeddingIdentity = providerResolution.active
    ? buildVectorizationEmbeddingIdentity(providerResolution.active.name, providerResolution.active.model)
    : null;
  const semanticRuntimeAvailable = Boolean(providerResolution.active && vectorStoreResolution.active);
  const ledgerBefore = await readVectorizationStatusLedger(pmRoot);
  const staleBefore = semanticRuntimeAvailable ? collectStaleVectorizationIds(items, ledgerBefore.entries) : [];
  let refreshResult: Awaited<ReturnType<typeof refreshSemanticEmbeddingsForMutatedItems>> = {
    refreshed: [],
    skipped: [],
    warnings: [],
  };
  if (refreshPolicy.enabled && semanticRuntimeAvailable && staleBefore.length > 0) {
    refreshResult = await refreshSemanticEmbeddingsForMutatedItems(pmRoot, staleBefore, {
      settings: runtimeDefaults.settings,
      apply_runtime_defaults: false,
    });
  }
  const ledgerAfter = await readVectorizationStatusLedger(pmRoot);
  const staleAfter = semanticRuntimeAvailable ? collectStaleVectorizationIds(items, ledgerAfter.entries) : [];
  const strictVectorizationWarnings = !runtimeDefaults.auto_ollama_defaults_applied;
  const embeddingIdentityChanged =
    strictVectorizationWarnings &&
    semanticRuntimeAvailable &&
    Boolean(
      ledgerBefore.embedding &&
        runtimeEmbeddingIdentity &&
        hasVectorizationEmbeddingIdentityChanged(ledgerBefore.embedding, runtimeEmbeddingIdentity),
    );
  /* c8 ignore start -- strict-vectorization warning synthesis branches are integration-only policy permutations */
  const warningSet = new Set<string>([...ledgerBefore.warnings, ...ledgerAfter.warnings]);
  if (strictVectorizationWarnings) {
    for (const warning of refreshResult.warnings) {
      warningSet.add(warning);
    }
  }
  if (embeddingIdentityChanged) {
    warningSet.add("vectorization_embedding_identity_changed");
  }
  if (strictVectorizationWarnings && semanticRuntimeAvailable && staleAfter.length > 0) {
    warningSet.add(`vectorization_stale_items_remaining:${staleAfter.length}`);
  }
  const warnings = [...warningSet].sort((left, right) => left.localeCompare(right));
  const staleBeforeDetail = selectStaleItemDetail(staleBefore, verboseStaleItems);
  const staleAfterDetail = selectStaleItemDetail(staleAfter, verboseStaleItems);

  return {
    check: {
      name: "vectorization",
      status: warnings.length === 0 ? "ok" : "warn",
      details: {
        semantic_runtime_available: semanticRuntimeAvailable,
        compatibility_mode_auto_defaults: runtimeDefaults.auto_ollama_defaults_applied,
        auto_ollama_defaults_applied: runtimeDefaults.auto_ollama_defaults_applied,
        refresh_policy: {
          enabled: refreshPolicy.enabled,
          check_only: refreshPolicy.checkOnly,
          no_refresh: refreshPolicy.noRefresh,
          refresh_vectors: refreshPolicy.refreshVectors,
        },
        provider_active: providerResolution.active?.name ?? null,
        // GH-244: surface the persisted (possibly empty) configured value and
        // how the active resolution was sourced, so a config audit can tell
        // "auto-detected" apart from a genuine misconfiguration when
        // settings.search.provider / vector_store.adapter are empty strings.
        provider_configured: typeof settings.search?.provider === "string" ? settings.search.provider : null,
        provider_source: resolveProviderConfigSource(
          providerResolution.active?.name ?? null,
          settings.search?.provider ?? null,
        ),
        vector_store_active: vectorStoreResolution.active?.name ?? null,
        vector_store_configured: typeof settings.vector_store?.adapter === "string" ? settings.vector_store.adapter : null,
        vector_store_source: resolveProviderConfigSource(
          vectorStoreResolution.active?.name ?? null,
          settings.vector_store?.adapter ?? null,
        ),
        embedding_identity_changed: embeddingIdentityChanged,
        embedding_identity_before: ledgerBefore.embedding ?? null,
        embedding_identity_runtime: runtimeEmbeddingIdentity ?? null,
        items: items.length,
        ledger_entries_before: Object.keys(ledgerBefore.entries).length,
        stale_items_detail_mode: verboseStaleItems ? "full" : "summary",
        stale_items_summary_limit: STALE_VECTORIZATION_SUMMARY_LIMIT,
        stale_items_before_total: staleBeforeDetail.total,
        stale_items_before: staleBeforeDetail.values,
        stale_items_before_truncated: staleBeforeDetail.truncated,
        refresh_attempted: refreshPolicy.enabled && staleBefore.length > 0 && semanticRuntimeAvailable,
        refresh_skipped_reason:
          refreshPolicy.enabled && semanticRuntimeAvailable && staleBefore.length > 0
            ? null
            : !refreshPolicy.enabled
              ? "refresh_disabled"
              : !semanticRuntimeAvailable
                ? "semantic_runtime_unavailable"
                : "no_stale_items",
        refresh_result: refreshResult,
        ledger_entries_after: Object.keys(ledgerAfter.entries).length,
        stale_items_after_total: staleAfterDetail.total,
        stale_items_after: staleAfterDetail.values,
        stale_items_after_truncated: staleAfterDetail.truncated,
      },
    },
    warnings,
  };
  /* c8 ignore stop */
}

function validateSettingsValues(settings: PmSettings): string[] {
  const warnings: string[] = [];
  if (settings.id_prefix.trim().length === 0) {
    warnings.push("settings:id_prefix_empty");
  }
  if (settings.locks.ttl_seconds <= 0) {
    warnings.push("settings:locks_ttl_non_positive");
  }
  return warnings;
}

function resolveVectorRefreshPolicy(options: RunHealthOptions): {
  enabled: boolean;
  checkOnly: boolean;
  noRefresh: boolean;
  refreshVectors: boolean;
} {
  const checkOnly = options.checkOnly === true;
  const noRefresh = options.noRefresh === true || checkOnly;
  const refreshVectors = options.refreshVectors === true;
  if (refreshVectors && checkOnly) {
    throw new PmCliError("--check-only cannot be combined with --refresh-vectors", EXIT_CODE.USAGE);
  }
  if (refreshVectors && options.noRefresh === true) {
    throw new PmCliError("--no-refresh cannot be combined with --refresh-vectors", EXIT_CODE.USAGE);
  }
  return {
    enabled: refreshVectors || !noRefresh,
    checkOnly,
    noRefresh,
    refreshVectors,
  };
}

/**
 * Implements run health for the public runtime surface of this module.
 */
export async function runHealth(global: GlobalOptions, options: RunHealthOptions = {}): Promise<HealthResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settingsPath = getSettingsPath(pmRoot);
  if (!(await pathExists(settingsPath))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const { settings, warnings: settingsReadWarnings } = await readSettingsWithMetadata(pmRoot);
  const normalizedSettingsReadWarnings = [...new Set(settingsReadWarnings)];
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const strictDirectories = options.strictDirectories === true;
  const refreshPolicy = resolveVectorRefreshPolicy(options);
  const optionalBuiltinDirs = new Set<string>(PM_OPTIONAL_TYPE_SUBDIRS.filter((entry) => entry.length > 0));
  const requiredDirSet = new Set<string>(PM_CORE_REQUIRED_SUBDIRS.filter((entry) => entry.length > 0));
  const optionalDirSet = new Set<string>();
  for (const folder of typeRegistry.folders) {
    if (optionalBuiltinDirs.has(folder)) {
      optionalDirSet.add(folder);
      continue;
    }
    requiredDirSet.add(folder);
  }
  const requiredDirs = [...requiredDirSet].sort((left, right) => left.localeCompare(right));
  const optionalDirs = [...optionalDirSet].sort((left, right) => left.localeCompare(right));
  const missingRequiredDirs: string[] = [];
  const missingOptionalDirs: string[] = [];
  const hookWarnings: string[] = [];
  for (const relativeDir of [...requiredDirs, ...optionalDirs]) {
    const directoryPath = path.join(pmRoot, relativeDir);
    hookWarnings.push(
      ...(await runActiveOnReadHooks({
        path: directoryPath,
        scope: "project",
      })),
    );
    if (!(await isDirectory(directoryPath))) {
      if (optionalDirSet.has(relativeDir)) {
        missingOptionalDirs.push(relativeDir);
      } else {
        missingRequiredDirs.push(relativeDir);
      }
    }
  }
  const missingDirs = strictDirectories ? [...missingRequiredDirs, ...missingOptionalDirs] : [...missingRequiredDirs];

  const settingWarnings = validateSettingsValues(settings);
  const telemetryCheck = await buildTelemetryCheck(settings, {
    checkTelemetry: options.checkTelemetry === true,
  });
  const extensionCheck = await buildExtensionCheck(pmRoot, settings, Boolean(global.noExtensions));
  const summaryMode = options.summary === true && options.full !== true;
  const fastProjectionCheckOnly =
    options.checkOnly === true && (options.brief === true || options.summary === true) && options.full !== true;
  const skipIntegrity = (options.skipIntegrity === true || fastProjectionCheckOnly) && options.full !== true;
  const skipDrift = (options.skipDrift === true || fastProjectionCheckOnly) && options.full !== true;
  const skipVectors = (options.skipVectors === true || fastProjectionCheckOnly) && options.full !== true;
  const itemReadWarnings: string[] = [];
  const items = skipDrift && skipVectors
    ? await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder, itemReadWarnings, settings.schema)
    : await listAllFrontMatterWithBody(
        pmRoot,
        settings.item_format,
        typeRegistry.type_to_folder,
        itemReadWarnings,
        settings.schema,
      );
  const itemsWithBody = items as Array<ItemMetadata & { body: string }>;
  const normalizedItemReadWarnings = [...new Set(itemReadWarnings)];
  const historyPolicy = skipDrift
    ? { warnings: [] }
    : await enforceHistoryStreamPolicyForItems({
        pmRoot,
        settings,
        itemIds: items.map((item) => item.id),
        commandLabel: "health",
      });
  const historySummary = await countHistoryStreams(pmRoot, settings.history.compact_policy);
  const locksCheck = await buildLocksCheck(pmRoot);
  const integrityCheck = skipIntegrity
    ? { check: { name: "integrity" as const, status: "ok" as const, details: { skipped: true } }, warnings: [] }
    : await buildIntegrityCheck(pmRoot, typeRegistry.type_to_folder, settings.schema);
  const historyDriftCheck = skipDrift
    ? { check: { name: "history_drift" as const, status: "ok" as const, details: { skipped: true } }, warnings: [] }
    : await buildHistoryDriftCheck(pmRoot, itemsWithBody);
  const vectorizationCheck = skipVectors
    ? { check: { name: "vectorization" as const, status: "ok" as const, details: { skipped: true } }, warnings: [] }
    : await buildVectorizationCheck(pmRoot, settings, itemsWithBody, refreshPolicy, options.verboseStaleItems === true);

  const checks: HealthCheck[] = [
    {
      name: "settings",
      /* c8 ignore next -- settings read-warning status split is covered in broader read-settings integration tests */
      status: normalizedSettingsReadWarnings.length === 0 ? "ok" : "warn",
      details: {
        path: settingsPath,
        version: settings.version,
        id_prefix: settings.id_prefix,
        locks_ttl_seconds: settings.locks.ttl_seconds,
        warnings: normalizedSettingsReadWarnings,
      },
    },
    {
      name: "directories",
      status: missingDirs.length === 0 ? "ok" : "warn",
      details: {
        required: requiredDirs,
        optional: optionalDirs,
        missing_required: missingRequiredDirs,
        missing_optional: missingOptionalDirs,
        missing: missingDirs,
        strict_directories: strictDirectories,
      },
    },
    {
      name: "settings_values",
      status: settingWarnings.length === 0 ? "ok" : "warn",
      details: {
        warnings: settingWarnings,
      },
    },
    telemetryCheck.check,
    extensionCheck.check,
    {
      name: "storage",
      status: historySummary.over_threshold.length === 0 ? "ok" : "warn",
      details: {
        items: items.length,
        history_streams: historySummary.count,
        ...(historySummary.max_entries !== null
          ? {
              compact_policy: {
                enabled: settings.history.compact_policy.enabled,
                max_entries: historySummary.max_entries,
                trigger: settings.history.compact_policy.trigger,
                over_threshold_count: historySummary.over_threshold.length,
                over_threshold: historySummary.over_threshold,
              },
            }
          : {}),
      },
    },
    locksCheck.check,
    integrityCheck.check,
    historyDriftCheck.check,
    vectorizationCheck.check,
  ];

  const warnings = [
    ...missingDirs.map((dir) => `missing_directory:${dir}`),
    ...normalizedSettingsReadWarnings,
    ...settingWarnings,
    ...normalizedItemReadWarnings,
    ...telemetryCheck.warnings,
    ...extensionCheck.warnings,
    ...historyPolicy.warnings,
    ...historySummary.warnings,
    ...locksCheck.warnings,
    ...integrityCheck.warnings,
    ...historyDriftCheck.warnings,
    ...vectorizationCheck.warnings,
    ...hookWarnings,
  ];
  const normalizedWarnings = [...new Set(warnings)];
  // Attach a machine-executable remediation_map (warning-code-prefix -> fix
  // command) to each non-extension check so agents gating on `pm health --json`
  // never have to hardcode the warning-code -> fix mapping. The extensions check
  // keeps its richer, contextual `details.triage.remediation`; brief/summary
  // projections omit remediation_map (it lives only in full check details).
  // Every health check contributes its warning tokens as a remediation source.
  // Most resolve to a registered fix command; the extensions check passes its
  // full warning list because only the system-wide partial-coverage adoption
  // gap is registered — per-extension findings resolve to nothing here and keep
  // their richer `details.triage.remediation`, so buildRemediationMap simply
  // skips every unregistered code (pm-bdvm). The map is total over
  // HealthCheck["name"], so no check is ever silently missing a source.
  const checkRemediationSources: Record<HealthCheck["name"], string[]> = {
    settings: normalizedSettingsReadWarnings,
    directories: missingDirs.map((dir) => `missing_directory:${dir}`),
    settings_values: settingWarnings,
    telemetry: telemetryCheck.warnings,
    extensions: extensionCheck.warnings,
    storage: historySummary.over_threshold.map((id) => `history_stream_over_compact_threshold:${id}`),
    locks: locksCheck.warnings,
    integrity: integrityCheck.warnings,
    history_drift: historyDriftCheck.warnings,
    vectorization: vectorizationCheck.warnings,
  };
  const historyDriftedCount =
    typeof (historyDriftCheck.check.details.counts as { drifted?: unknown } | undefined)?.drifted === "number"
      ? ((historyDriftCheck.check.details.counts as { drifted: number }).drifted)
      : 0;
  for (const check of checks) {
    const remediationMap = buildRemediationMap(checkRemediationSources[check.name]);
    // With multiple drifted streams the per-item `pm history-repair <id>`
    // template would have to be run once per stream; suggest the bulk audited
    // pass instead so agents repair everything in one command.
    if (check.name === "history_drift" && historyDriftedCount > 1) {
      for (const code of Object.keys(remediationMap)) {
        remediationMap[code] = "pm history-repair --all";
      }
    }
    // With multiple over-threshold streams, point at the one-pass bulk sweep
    // rather than a per-stream `pm history-compact <id>` template.
    if (check.name === "storage" && historySummary.over_threshold.length > 1) {
      for (const code of Object.keys(remediationMap)) {
        remediationMap[code] = "pm history-compact --all-streams";
      }
    }
    if (Object.keys(remediationMap).length > 0) {
      check.details = { ...check.details, remediation_map: remediationMap };
    }
  }
  // Telemetry is an opt-out, non-critical observability feature. Its operational
  // state (queue backlog, unreachable endpoint, corrupt local state) is advisory:
  // it must never flip overall project health to not-ok. Such warnings are still
  // surfaced in `warnings` and the telemetry check's own `warn` status.
  const blockingWarnings = normalizedWarnings.filter((warning) => !isAdvisoryHealthWarning(warning));
  const result: HealthResult = {
    ok: blockingWarnings.length === 0,
    checks,
    warnings: normalizedWarnings,
    generated_at: nowIso(),
  };
  if (summaryMode) {
    return applySummaryHealthProjection(result);
  }
  return options.brief === true ? applyBriefHealthProjection(result) : result;
}

export const _testOnlyHealthCommand = {
  buildExtensionHealthTriageSummary,
  buildCapabilityContractMetadata,
  collectUnknownCapabilityGuidance,
  isAdvisoryHealthWarning,
  isDirectory,
  isExpectedUnmanagedExtension,
  listItemDocumentPaths,
  normalizeEndpointForDisplay,
  normalizeExtensionNameForMatch,
  parseTelemetryQueue,
  probeTelemetryEndpointHealth,
  selectStaleItemDetail,
  summarizeHealthCheckDetails,
  summarizeExtensionList,
  summarizeRecordList,
  summarizeStringList,
  telemetryEnvFlagEnabled,
  warningCode,
};
