import fs from "node:fs/promises";
import path from "node:path";
import { getEnabledBuiltInExtensions } from "../../core/extensions/builtins.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { activateExtensions, loadExtensions, runActiveOnReadHooks } from "../../core/extensions/index.js";
import type { LoadedExtension } from "../../core/extensions/loader.js";
import { EXIT_CODE, PM_REQUIRED_SUBDIRS } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { listAllFrontMatter } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { PmSettings } from "../../types/index.js";

type HealthStatus = "ok" | "warn";
type MigrationRuntimeStatus = "pending" | "failed" | "applied";

export interface HealthCheck {
  name: "settings" | "directories" | "settings_values" | "extensions" | "storage";
  status: HealthStatus;
  details: Record<string, unknown>;
}

export interface HealthResult {
  ok: boolean;
  checks: HealthCheck[];
  warnings: string[];
  generated_at: string;
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
  const loadedWithBuiltIns = noExtensionsFlag
    ? loadResult.loaded
    : [...getEnabledBuiltInExtensions(settings), ...loadResult.loaded];
  const loadedSummaries = loadedWithBuiltIns.map((extension) => summarizeLoadedExtension(extension));
  const activationResult = await activateExtensions({
    ...loadResult,
    loaded: loadedWithBuiltIns,
  });
  const migrationStatus = summarizeMigrationStatuses(activationResult.registrations.migrations);
  const activationDetails = {
    failed: activationResult.failed,
    warnings: activationResult.warnings,
    hook_counts: activationResult.hook_counts,
    command_override_count: activationResult.command_override_count,
    command_handler_count: activationResult.command_handler_count,
    renderer_override_count: activationResult.renderer_override_count,
    registration_counts: activationResult.registration_counts,
    registrations: activationResult.registrations,
    migration_status: migrationStatus.summary,
  };
  const extensionWarnings = [...loadResult.warnings, ...activationDetails.warnings, ...migrationStatus.warnings];

  return {
    check: {
      name: "extensions",
      status: extensionWarnings.length === 0 ? "ok" : "warn",
      details: {
        ...loadResult,
        loaded: loadedSummaries,
        warnings: extensionWarnings,
        activation: activationDetails,
      } as Record<string, unknown>,
    },
    warnings: extensionWarnings,
  };
}

function validateSettingsValues(settings: Awaited<ReturnType<typeof readSettings>>): string[] {
  const warnings: string[] = [];
  if (settings.id_prefix.trim().length === 0) {
    warnings.push("settings:id_prefix_empty");
  }
  if (settings.locks.ttl_seconds <= 0) {
    warnings.push("settings:locks_ttl_non_positive");
  }
  return warnings;
}

export async function runHealth(global: GlobalOptions): Promise<HealthResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settingsPath = getSettingsPath(pmRoot);
  if (!(await pathExists(settingsPath))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const requiredDirs = PM_REQUIRED_SUBDIRS.filter((entry) => entry.length > 0);
  const missingDirs: string[] = [];
  const hookWarnings: string[] = [];
  for (const relativeDir of requiredDirs) {
    const directoryPath = path.join(pmRoot, relativeDir);
    hookWarnings.push(
      ...(await runActiveOnReadHooks({
        path: directoryPath,
        scope: "project",
      })),
    );
    if (!(await isDirectory(directoryPath))) {
      missingDirs.push(relativeDir);
    }
  }

  const settingWarnings = validateSettingsValues(settings);
  const extensionCheck = await buildExtensionCheck(pmRoot, settings, Boolean(global.noExtensions));
  const items = await listAllFrontMatter(pmRoot);
  const historySummary = await countHistoryStreams(pmRoot);

  const checks: HealthCheck[] = [
    {
      name: "settings",
      status: "ok",
      details: {
        path: settingsPath,
        version: settings.version,
        id_prefix: settings.id_prefix,
        locks_ttl_seconds: settings.locks.ttl_seconds,
      },
    },
    {
      name: "directories",
      status: missingDirs.length === 0 ? "ok" : "warn",
      details: {
        required: requiredDirs,
        missing: missingDirs,
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
  ];

  const warnings = [
    ...missingDirs.map((dir) => `missing_directory:${dir}`),
    ...settingWarnings,
    ...extensionCheck.warnings,
    ...historySummary.warnings,
    ...hookWarnings,
  ];
  return {
    ok: warnings.length === 0,
    checks,
    warnings,
    generated_at: nowIso(),
  };
}
