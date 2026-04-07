import fs from "node:fs/promises";
import path from "node:path";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { activateExtensions, getActiveExtensionRegistrations, loadExtensions, runActiveOnReadHooks } from "../../core/extensions/index.js";
import {
  EXTENSION_CAPABILITY_CONTRACT,
  KNOWN_EXTENSION_CAPABILITIES,
  parseLegacyExtensionCapabilityAliasWarning,
  parseUnknownExtensionCapabilityWarning,
  type LoadedExtension,
  type UnknownExtensionCapabilityWarningDetails,
} from "../../core/extensions/loader.js";
import { hashDocument } from "../../core/history/history.js";
import { enforceHistoryStreamPolicyForItems } from "../../core/history/history-stream-policy.js";
import {
  readVectorizationStatusLedger,
  refreshSemanticEmbeddingsForMutatedItems,
} from "../../core/search/cache.js";
import { resolveEmbeddingProviders } from "../../core/search/providers.js";
import { resolveSettingsWithSemanticRuntimeDefaults } from "../../core/search/semantic-defaults.js";
import { resolveVectorStores } from "../../core/search/vector-stores.js";
import { EXIT_CODE, PM_CORE_REQUIRED_SUBDIRS, PM_OPTIONAL_TYPE_SUBDIRS } from "../../core/shared/constants.js";
import { findFirstMergeConflictMarker } from "../../core/shared/conflict-markers.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { parseItemDocument } from "../../core/item/item-format.js";
import { listAllFrontMatterWithBody } from "../../core/store/item-store.js";
import { getHistoryPath, getItemFormatFromPath, getSettingsPath, ITEM_FILE_EXTENSIONS, resolvePmRoot } from "../../core/store/paths.js";
import { readSettingsWithMetadata } from "../../core/store/settings.js";
import type { ItemFormat, PmSettings } from "../../types/index.js";
import { readManagedExtensionState } from "./extension.js";

type HealthStatus = "ok" | "warn";
type MigrationRuntimeStatus = "pending" | "failed" | "applied";

export interface HealthCheck {
  name: "settings" | "directories" | "settings_values" | "extensions" | "storage" | "integrity" | "history_drift" | "vectorization";
  status: HealthStatus;
  details: Record<string, unknown>;
}

export interface HealthResult {
  ok: boolean;
  checks: HealthCheck[];
  warnings: string[];
  generated_at: string;
}

export interface RunHealthOptions {
  strictDirectories?: boolean;
  checkOnly?: boolean;
  noRefresh?: boolean;
  refreshVectors?: boolean;
  verboseStaleItems?: boolean;
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

function warningCode(value: string): string {
  const normalized = value.trim();
  const separator = normalized.indexOf(":");
  if (separator === -1) {
    return normalized;
  }
  return normalized.slice(0, separator);
}

function collectUnknownCapabilityGuidance(warnings: string[]): UnknownExtensionCapabilityWarningDetails[] {
  const seen = new Set<string>();
  const guidance: UnknownExtensionCapabilityWarningDetails[] = [];
  for (const warning of warnings) {
    const parsedDetails = (() => {
      const unknownWarning = parseUnknownExtensionCapabilityWarning(warning);
      if (unknownWarning) {
        return [unknownWarning];
      }
      return parseLegacyExtensionCapabilityAliasWarning(warning);
    })();
    for (const parsed of parsedDetails) {
      const key = `${parsed.layer}:${parsed.name}:${parsed.capability}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      guidance.push(parsed);
    }
  }
  return guidance;
}

function buildCapabilityContractMetadata(): {
  version: number;
  capabilities: string[];
  legacy_aliases: Record<string, string>;
} {
  return {
    version: EXTENSION_CAPABILITY_CONTRACT.version,
    capabilities: [...EXTENSION_CAPABILITY_CONTRACT.capabilities],
    legacy_aliases: { ...EXTENSION_CAPABILITY_CONTRACT.legacy_aliases },
  };
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

async function countHistoryStreams(pmRoot: string): Promise<{ count: number; warnings: string[] }> {
  const historyDir = path.join(pmRoot, "history");
  if (!(await isDirectory(historyDir))) {
    return {
      count: 0,
      warnings: [],
    };
  }
  const historyFiles = (await fs.readdir(historyDir))
    .filter((entry) => entry.endsWith(".jsonl"))
    .sort((left, right) => left.localeCompare(right));

  const warnings: string[] = [];
  for (const fileName of historyFiles) {
    warnings.push(
      ...(await runActiveOnReadHooks({
        path: path.join(historyDir, fileName),
        scope: "project",
      })),
    );
  }

  return {
    count: historyFiles.length,
    warnings,
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
): Promise<{ check: HealthCheck; warnings: string[] }> {
  const itemPaths = await listItemDocumentPaths(pmRoot, typeToFolder);
  const itemUnreadable: string[] = [];
  const itemConflictMarkers: Array<{ path: string; line: number; marker: string }> = [];
  const itemParseFailures: string[] = [];

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
      parseItemDocument(raw, { format: getItemFormatFromPath(itemPath) as ItemFormat });
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
    if (!(typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT")) {
      historyUnreadable.push("history");
    }
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
  if (Array.isArray(extension.capabilities)) {
    summary.capabilities = [...extension.capabilities];
  }
  return summary;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveMigrationId(definition: Record<string, unknown>, fallbackIndex: number): string {
  const explicitId = toNonEmptyString(definition.id);
  if (explicitId) {
    return explicitId;
  }
  return `migration-${String(fallbackIndex + 1).padStart(3, "0")}`;
}

function resolveMigrationStatus(definition: Record<string, unknown>): MigrationRuntimeStatus {
  const rawStatus = toNonEmptyString(definition.status);
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
  return toNonEmptyString(definition.reason) ?? toNonEmptyString(definition.error) ?? toNonEmptyString(definition.message);
}

function compareMigrationEntries(left: MigrationStatusEntry, right: MigrationStatusEntry): number {
  const byLayer = left.layer.localeCompare(right.layer);
  if (byLayer !== 0) {
    return byLayer;
  }
  const byName = left.name.localeCompare(right.name);
  if (byName !== 0) {
    return byName;
  }
  return left.id.localeCompare(right.id);
}

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

function collectStaleVectorizationIds(items: ItemWithBody[], ledgerEntries: Record<string, string>): string[] {
  return items
    .filter((item) => {
      const trackedUpdatedAt = ledgerEntries[item.id];
      return trackedUpdatedAt !== item.updated_at;
    })
    .map((item) => item.id)
    .sort((left, right) => left.localeCompare(right));
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

async function buildHistoryDriftCheck(
  pmRoot: string,
  items: ItemWithBody[],
): Promise<{ check: HealthCheck; warnings: string[] }> {
  const missingStreams: string[] = [];
  const unreadableStreams: string[] = [];
  const hashMismatches: string[] = [];

  for (const item of items) {
    const historyPath = getHistoryPath(pmRoot, item.id);
    let latestAfterHash: string | null = null;
    try {
      const raw = await fs.readFile(historyPath, "utf8");
      if (raw.trim().length === 0) {
        missingStreams.push(item.id);
        continue;
      }
      const lines = raw.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }
        const parsed = JSON.parse(trimmed) as { after_hash?: unknown };
        if (typeof parsed.after_hash !== "string" || parsed.after_hash.trim().length === 0) {
          throw new Error("missing after_hash");
        }
        latestAfterHash = parsed.after_hash;
      }
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") {
        missingStreams.push(item.id);
      } else {
        unreadableStreams.push(item.id);
      }
      continue;
    }
    if (!latestAfterHash) {
      missingStreams.push(item.id);
      continue;
    }
    const { body, ...frontMatter } = item;
    const currentHash = hashDocument({
      front_matter: frontMatter,
      body,
    });
    if (latestAfterHash !== currentHash) {
      hashMismatches.push(item.id);
    }
  }

  const driftedItems = [...new Set([...missingStreams, ...unreadableStreams, ...hashMismatches])].sort((a, b) =>
    a.localeCompare(b),
  );
  const warnings = [
    ...missingStreams.map((id) => `history_drift_missing_stream:${id}`),
    ...unreadableStreams.map((id) => `history_drift_unreadable_stream:${id}`),
    ...hashMismatches.map((id) => `history_drift_hash_mismatch:${id}`),
  ];

  return {
    check: {
      name: "history_drift",
      status: warnings.length === 0 ? "ok" : "warn",
      details: {
        checked_items: items.length,
        drifted_items: driftedItems,
        counts: {
          drifted: driftedItems.length,
          missing_streams: missingStreams.length,
          unreadable_streams: unreadableStreams.length,
          hash_mismatches: hashMismatches.length,
        },
        missing_streams: missingStreams,
        unreadable_streams: unreadableStreams,
        hash_mismatches: hashMismatches,
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
  const warningSet = new Set<string>([...ledgerBefore.warnings, ...ledgerAfter.warnings]);
  if (strictVectorizationWarnings) {
    for (const warning of refreshResult.warnings) {
      warningSet.add(warning);
    }
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
        vector_store_active: vectorStoreResolution.active?.name ?? null,
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
  const extensionCheck = await buildExtensionCheck(pmRoot, settings, Boolean(global.noExtensions));
  const itemReadWarnings: string[] = [];
  const items = await listAllFrontMatterWithBody(pmRoot, settings.item_format, typeRegistry.type_to_folder, itemReadWarnings);
  const normalizedItemReadWarnings = [...new Set(itemReadWarnings)];
  const historyPolicy = await enforceHistoryStreamPolicyForItems({
    pmRoot,
    settings,
    itemIds: items.map((item) => item.id),
    commandLabel: "health",
  });
  const historySummary = await countHistoryStreams(pmRoot);
  const integrityCheck = await buildIntegrityCheck(pmRoot, typeRegistry.type_to_folder);
  const historyDriftCheck = await buildHistoryDriftCheck(pmRoot, items);
  const vectorizationCheck = await buildVectorizationCheck(
    pmRoot,
    settings,
    items,
    refreshPolicy,
    options.verboseStaleItems === true,
  );

  const checks: HealthCheck[] = [
    {
      name: "settings",
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
    extensionCheck.check,
    {
      name: "storage",
      status: "ok",
      details: {
        items: items.length,
        history_streams: historySummary.count,
      },
    },
    integrityCheck.check,
    historyDriftCheck.check,
    vectorizationCheck.check,
  ];

  const warnings = [
    ...missingDirs.map((dir) => `missing_directory:${dir}`),
    ...normalizedSettingsReadWarnings,
    ...settingWarnings,
    ...normalizedItemReadWarnings,
    ...extensionCheck.warnings,
    ...historyPolicy.warnings,
    ...historySummary.warnings,
    ...integrityCheck.warnings,
    ...historyDriftCheck.warnings,
    ...vectorizationCheck.warnings,
    ...hookWarnings,
  ];
  const normalizedWarnings = [...new Set(warnings)];
  return {
    ok: normalizedWarnings.length === 0,
    checks,
    warnings: normalizedWarnings,
    generated_at: nowIso(),
  };
}
