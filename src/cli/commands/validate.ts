import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { hashDocument } from "../../core/history/history.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { EXIT_CODE, PM_DIRNAME } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { listAllFrontMatterWithBody } from "../../core/store/item-store.js";
import { getHistoryPath, getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemFrontMatter } from "../../types/index.js";
import { extractReferencedPmItemIdsFromCommand } from "./test.js";

type ValidateCheckName = "metadata" | "resolution" | "files" | "command_references" | "history_drift";
type ValidateStatus = "ok" | "warn";
type ValidateFileScanMode = "default" | "tracked-all" | "tracked-all-strict";
type ItemWithBody = Awaited<ReturnType<typeof listAllFrontMatterWithBody>>[number];
type FileCandidateSource = "default-curated" | "tracked-git" | "tracked-all-fallback-default";

const FILE_SCAN_DIRECTORIES = ["src", "tests", "docs"] as const;
const FILE_SCAN_ROOT_FILES = [
  "README.md",
  "PRD.md",
  "CHANGELOG.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "LICENSE",
] as const;
const DIRECTORY_IGNORE_SET = new Set(["node_modules", ".git", ".cursor", ".agents", "dist", "coverage"]);
const RESOLUTION_FIELD_KEYS = ["resolution", "expected_result", "actual_result"] as const;
const VALIDATE_FILE_SCAN_MODES = ["default", "tracked-all", "tracked-all-strict"] as const;
const GIT_LS_FILES_MAX_BUFFER = 32 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export interface ValidateCommandOptions {
  checkMetadata?: boolean;
  checkResolution?: boolean;
  checkFiles?: boolean;
  includePmInternals?: boolean;
  checkHistoryDrift?: boolean;
  checkCommandReferences?: boolean;
  scanMode?: string;
}

export interface ValidateCheck {
  name: ValidateCheckName;
  status: ValidateStatus;
  details: Record<string, unknown>;
}

export interface ValidateResult {
  ok: boolean;
  checks: ValidateCheck[];
  warnings: string[];
  generated_at: string;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function normalizeRelativeDirectoryPath(value: string): string {
  const normalized = normalizeRelativePath(value);
  return normalized.replace(/\/+$/, "");
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveFileScanMode(scanMode: string | undefined): ValidateFileScanMode {
  if (scanMode === undefined) {
    return "default";
  }
  const normalized = scanMode.trim().toLowerCase();
  if (normalized.length === 0) {
    return "default";
  }
  if (normalized === "default") {
    return "default";
  }
  if (normalized === "tracked-all" || normalized === "tracked_all") {
    return "tracked-all";
  }
  if (normalized === "tracked-all-strict" || normalized === "tracked_all_strict") {
    return "tracked-all-strict";
  }
  throw new PmCliError(
    `Unknown --scan-mode value "${scanMode}". Supported values: ${VALIDATE_FILE_SCAN_MODES.join(", ")}.`,
    EXIT_CODE.USAGE,
  );
}

function resolveWorkspaceRoot(pmRoot: string): string {
  const normalized = pmRoot.replaceAll("\\", "/");
  if (normalized.endsWith("/.agents/pm")) {
    return path.dirname(path.dirname(pmRoot));
  }
  /* c8 ignore next 2 -- non-standard PM root layouts are integration-only edge cases. */
  return process.cwd();
}

async function listFilesRecursive(basePath: string, relativePath: string, output: string[]): Promise<void> {
  const targetDirectory = relativePath.length > 0 ? path.join(basePath, relativePath) : basePath;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(targetDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const childRelative = relativePath.length > 0 ? path.join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (DIRECTORY_IGNORE_SET.has(entry.name)) {
        continue;
      }
      await listFilesRecursive(basePath, childRelative, output);
      continue;
    }
    /* c8 ignore next 3 -- non-file dirent variants (symlink/socket) are filesystem-specific. */
    if (!entry.isFile()) {
      continue;
    }
    output.push(normalizeRelativePath(childRelative));
  }
}

async function collectDefaultProjectFileCandidates(workspaceRoot: string): Promise<string[]> {
  const discovered: string[] = [];
  for (const directory of FILE_SCAN_DIRECTORIES) {
    await listFilesRecursive(workspaceRoot, directory, discovered);
  }
  for (const candidate of FILE_SCAN_ROOT_FILES) {
    const absolute = path.join(workspaceRoot, candidate);
    try {
      const stats = await fs.stat(absolute);
      /* c8 ignore start -- root-candidate presence depends on fixture workspace composition. */
      if (stats.isFile()) {
        discovered.push(normalizeRelativePath(candidate));
      }
      /* c8 ignore stop */
    } catch {
      // Ignore root-file candidates that are not present in this workspace.
    }
  }
  return [...new Set(discovered)].sort((left, right) => left.localeCompare(right));
}

async function collectTrackedGitFileCandidates(workspaceRoot: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: GIT_LS_FILES_MAX_BUFFER,
      windowsHide: true,
    });
    const discovered = stdout
      .split("\0")
      .map((value) => normalizeRelativePath(value))
      .filter((value) => value.length > 0);
    return [...new Set(discovered)].sort((left, right) => left.localeCompare(right));
  } catch {
    /* c8 ignore start -- fallback path exercised only when git metadata is unavailable. */
    return null;
    /* c8 ignore stop */
  }
}

interface FileCandidateCollection {
  requestedMode: ValidateFileScanMode;
  appliedMode: ValidateFileScanMode;
  source: FileCandidateSource;
  candidateFiles: string[];
  candidateTotal: number;
  candidateScanned: number;
}

function resolvePmInternalCandidatePrefixes(pmRoot: string, workspaceRoot: string): string[] {
  const prefixes = new Set<string>();
  const configuredDefault = normalizeRelativeDirectoryPath(PM_DIRNAME);
  if (configuredDefault.length > 0) {
    prefixes.add(configuredDefault);
  }
  const relativePmRoot = normalizeRelativeDirectoryPath(path.relative(workspaceRoot, pmRoot));
  if (relativePmRoot.length > 0 && !relativePmRoot.startsWith("..")) {
    prefixes.add(relativePmRoot);
  }
  return [...prefixes].sort((left, right) => left.localeCompare(right));
}

function hasPathPrefix(candidate: string, prefixes: string[]): boolean {
  for (const prefix of prefixes) {
    if (candidate === prefix || candidate.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

async function collectProjectFileCandidates(
  workspaceRoot: string,
  scanMode: ValidateFileScanMode,
): Promise<FileCandidateCollection> {
  if (scanMode === "tracked-all" || scanMode === "tracked-all-strict") {
    const trackedCandidates = await collectTrackedGitFileCandidates(workspaceRoot);
    if (trackedCandidates) {
      return {
        requestedMode: scanMode,
        appliedMode: scanMode,
        source: "tracked-git",
        candidateFiles: trackedCandidates,
        candidateTotal: trackedCandidates.length,
        candidateScanned: trackedCandidates.length,
      };
    }
    /* c8 ignore start -- deterministic fallback retained for non-git workspaces. */
    const fallbackCandidates = await collectDefaultProjectFileCandidates(workspaceRoot);
    return {
      requestedMode: scanMode,
      appliedMode: "default",
      source: "tracked-all-fallback-default",
      candidateFiles: fallbackCandidates,
      candidateTotal: fallbackCandidates.length,
      candidateScanned: fallbackCandidates.length,
    };
    /* c8 ignore stop */
  }

  const defaultCandidates = await collectDefaultProjectFileCandidates(workspaceRoot);
  return {
    requestedMode: scanMode,
    appliedMode: "default",
    source: "default-curated",
    candidateFiles: defaultCandidates,
    candidateTotal: defaultCandidates.length,
    candidateScanned: defaultCandidates.length,
  };
}

function summarizeList(values: string[], limit = 200): { values: string[]; truncated: boolean } {
  /* c8 ignore start -- truncation behavior only surfaces with very large synthetic datasets. */
  if (values.length <= limit) {
    return { values, truncated: false };
  }
  return {
    values: values.slice(0, limit),
    truncated: true,
  };
  /* c8 ignore stop */
}

function resolveRequestedChecks(options: ValidateCommandOptions): Set<ValidateCheckName> {
  const requested = new Set<ValidateCheckName>();
  if (options.checkMetadata) {
    requested.add("metadata");
  }
  if (options.checkResolution) {
    requested.add("resolution");
  }
  if (options.checkFiles) {
    requested.add("files");
  }
  if (options.checkHistoryDrift) {
    requested.add("history_drift");
  }
  if (options.checkCommandReferences) {
    requested.add("command_references");
  }
  if (requested.size === 0) {
    requested.add("metadata");
    requested.add("resolution");
    requested.add("files");
    requested.add("command_references");
    requested.add("history_drift");
  }
  return requested;
}

function buildMetadataCheck(items: ItemWithBody[]): { check: ValidateCheck; warnings: string[] } {
  const missingAuthor: string[] = [];
  const missingAcceptanceCriteria: string[] = [];
  const missingEstimate: string[] = [];
  const missingCloseReason: string[] = [];

  for (const item of items) {
    if (!toNonEmptyString(item.author)) {
      missingAuthor.push(item.id);
    }
    if (!toNonEmptyString(item.acceptance_criteria)) {
      missingAcceptanceCriteria.push(item.id);
    }
    if (!Number.isFinite(item.estimated_minutes)) {
      missingEstimate.push(item.id);
    }
    if (item.status === "closed" && !toNonEmptyString(item.close_reason)) {
      missingCloseReason.push(item.id);
    }
  }

  const warningTokens: string[] = [];
  if (missingAuthor.length > 0) {
    warningTokens.push(`validate_metadata_missing_author:${missingAuthor.length}`);
  }
  if (missingAcceptanceCriteria.length > 0) {
    warningTokens.push(`validate_metadata_missing_acceptance_criteria:${missingAcceptanceCriteria.length}`);
  }
  if (missingEstimate.length > 0) {
    warningTokens.push(`validate_metadata_missing_estimate:${missingEstimate.length}`);
  }
  if (missingCloseReason.length > 0) {
    warningTokens.push(`validate_metadata_missing_close_reason:${missingCloseReason.length}`);
  }

  const summarizedMissingAuthor = summarizeList(missingAuthor);
  const summarizedMissingAcceptance = summarizeList(missingAcceptanceCriteria);
  const summarizedMissingEstimate = summarizeList(missingEstimate);
  const summarizedMissingCloseReason = summarizeList(missingCloseReason);

  return {
    check: {
      name: "metadata",
      status: warningTokens.length === 0 ? "ok" : "warn",
      details: {
        checked_items: items.length,
        counts: {
          missing_author: missingAuthor.length,
          missing_acceptance_criteria: missingAcceptanceCriteria.length,
          missing_estimated_minutes: missingEstimate.length,
          closed_missing_close_reason: missingCloseReason.length,
        },
        missing_author_item_ids: summarizedMissingAuthor.values,
        missing_author_truncated: summarizedMissingAuthor.truncated,
        missing_acceptance_criteria_item_ids: summarizedMissingAcceptance.values,
        missing_acceptance_criteria_truncated: summarizedMissingAcceptance.truncated,
        missing_estimated_minutes_item_ids: summarizedMissingEstimate.values,
        missing_estimated_minutes_truncated: summarizedMissingEstimate.truncated,
        closed_missing_close_reason_item_ids: summarizedMissingCloseReason.values,
        closed_missing_close_reason_truncated: summarizedMissingCloseReason.truncated,
      },
    },
    warnings: warningTokens,
  };
}

function buildResolutionCheck(items: ItemWithBody[]): { check: ValidateCheck; warnings: string[] } {
  const closedItems = items.filter((item) => item.status === "closed");
  const missingResolutionRows: Array<{ id: string; missing_fields: string[] }> = [];

  for (const item of closedItems) {
    const missingFields = RESOLUTION_FIELD_KEYS.filter((field) => !toNonEmptyString(item[field]));
    if (missingFields.length === 0) {
      continue;
    }
    missingResolutionRows.push({
      id: item.id,
      missing_fields: missingFields,
    });
  }

  const warnings =
    missingResolutionRows.length > 0 ? [`validate_resolution_missing_fields:${missingResolutionRows.length}`] : [];
  const summarizedRows = summarizeList(missingResolutionRows.map((row) => `${row.id}:${row.missing_fields.join(",")}`));
  return {
    check: {
      name: "resolution",
      status: warnings.length === 0 ? "ok" : "warn",
      details: {
        checked_closed_items: closedItems.length,
        missing_resolution_items: missingResolutionRows.length,
        missing_resolution_rows: summarizedRows.values,
        missing_resolution_rows_truncated: summarizedRows.truncated,
      },
    },
    warnings,
  };
}

async function buildFilesCheck(
  items: ItemWithBody[],
  workspaceRoot: string,
  pmRoot: string,
  fileScanMode: ValidateFileScanMode,
  includePmInternals: boolean,
): Promise<{ check: ValidateCheck; warnings: string[] }> {
  const linkedProjectPaths = new Set<string>();
  const missingLinkedPaths: string[] = [];

  for (const item of items) {
    const linkedArtifacts = [...(item.files ?? []), ...(item.docs ?? [])];
    for (const artifact of linkedArtifacts) {
      if (artifact.scope !== "project") {
        continue;
      }
      const normalizedPath = normalizeRelativePath(artifact.path);
      if (normalizedPath.length === 0) {
        continue;
      }
      linkedProjectPaths.add(normalizedPath);
      const absolutePath = path.isAbsolute(artifact.path) ? artifact.path : path.resolve(workspaceRoot, artifact.path);
      try {
        const stats = await fs.stat(absolutePath);
        if (!stats.isFile()) {
          missingLinkedPaths.push(normalizedPath);
        }
      } catch {
        missingLinkedPaths.push(normalizedPath);
      }
    }
  }

  const uniqueMissingLinkedPaths = [...new Set(missingLinkedPaths)].sort((left, right) => left.localeCompare(right));
  const fileCandidates = await collectProjectFileCandidates(workspaceRoot, fileScanMode);
  const strictTrackedAllMode = fileScanMode === "tracked-all-strict";
  const includePmInternalsEffective = includePmInternals || strictTrackedAllMode;
  const pmInternalCandidatePrefixes = includePmInternalsEffective ? [] : resolvePmInternalCandidatePrefixes(pmRoot, workspaceRoot);
  const excludedPmInternalPaths =
    pmInternalCandidatePrefixes.length === 0
      ? []
      : fileCandidates.candidateFiles.filter((candidate) => hasPathPrefix(candidate, pmInternalCandidatePrefixes));
  const candidateFiles =
    pmInternalCandidatePrefixes.length === 0
      ? fileCandidates.candidateFiles
      : fileCandidates.candidateFiles.filter((candidate) => !hasPathPrefix(candidate, pmInternalCandidatePrefixes));
  const excludedPmInternalCount = excludedPmInternalPaths.length;
  const excludedByReason: Record<string, unknown> = {};
  if (excludedPmInternalCount > 0) {
    const summarizedPmInternalPaths = summarizeList(excludedPmInternalPaths);
    excludedByReason.pm_internals = {
      count: excludedPmInternalCount,
      paths: summarizedPmInternalPaths.values,
      paths_truncated: summarizedPmInternalPaths.truncated,
    };
  }
  const orphanedFiles = candidateFiles.filter((candidate) => !linkedProjectPaths.has(candidate));
  const warnings: string[] = [];
  if (uniqueMissingLinkedPaths.length > 0) {
    warnings.push(`validate_files_missing_linked_paths:${uniqueMissingLinkedPaths.length}`);
  }
  if (orphanedFiles.length > 0) {
    warnings.push(`validate_files_orphaned_paths:${orphanedFiles.length}`);
  }
  const summarizedMissing = summarizeList(uniqueMissingLinkedPaths);
  const summarizedOrphaned = summarizeList(orphanedFiles);

  return {
    check: {
      name: "files",
      status: warnings.length === 0 ? "ok" : "warn",
      details: {
        workspace_root: workspaceRoot,
        scan_mode_requested: fileCandidates.requestedMode,
        scan_mode_applied: fileCandidates.appliedMode,
        strict_tracked_all_mode: strictTrackedAllMode,
        candidate_scan_source: fileCandidates.source,
        include_pm_internals: includePmInternalsEffective,
        include_pm_internals_requested: includePmInternals,
        pm_internal_candidate_prefixes: pmInternalCandidatePrefixes,
        pm_internal_excluded_count: excludedPmInternalCount,
        excluded_total: excludedPmInternalCount,
        excluded_by_reason: excludedByReason,
        linked_project_paths: linkedProjectPaths.size,
        candidate_total_raw: fileCandidates.candidateTotal,
        candidate_scanned_raw: fileCandidates.candidateScanned,
        candidate_total: candidateFiles.length,
        candidate_scanned: candidateFiles.length,
        scanned_candidate_files: candidateFiles.length,
        missing_linked_paths_count: uniqueMissingLinkedPaths.length,
        missing_linked_paths: summarizedMissing.values,
        missing_linked_paths_truncated: summarizedMissing.truncated,
        orphaned_paths_count: orphanedFiles.length,
        orphaned_paths: summarizedOrphaned.values,
        orphaned_paths_truncated: summarizedOrphaned.truncated,
      },
    },
    warnings,
  };
}

async function buildHistoryDriftCheck(pmRoot: string, items: ItemWithBody[]): Promise<{ check: ValidateCheck; warnings: string[] }> {
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
      for (const line of raw.split(/\r?\n/)) {
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
    /* c8 ignore start -- defensive guard for future history schema changes. */
    if (!latestAfterHash) {
      missingStreams.push(item.id);
      continue;
    }
    /* c8 ignore stop */
    const { body, ...frontMatter } = item;
    const currentHash = hashDocument({
      front_matter: frontMatter as ItemFrontMatter,
      body,
    });
    if (currentHash !== latestAfterHash) {
      hashMismatches.push(item.id);
    }
  }

  const driftedItems = [...new Set([...missingStreams, ...unreadableStreams, ...hashMismatches])].sort((a, b) =>
    a.localeCompare(b),
  );
  const warnings: string[] = [];
  if (missingStreams.length > 0) {
    warnings.push(`validate_history_drift_missing_streams:${missingStreams.length}`);
  }
  if (unreadableStreams.length > 0) {
    warnings.push(`validate_history_drift_unreadable_streams:${unreadableStreams.length}`);
  }
  if (hashMismatches.length > 0) {
    warnings.push(`validate_history_drift_hash_mismatches:${hashMismatches.length}`);
  }
  const summarizedDrifted = summarizeList(driftedItems);

  return {
    check: {
      name: "history_drift",
      status: warnings.length === 0 ? "ok" : "warn",
      details: {
        checked_items: items.length,
        drifted_items_count: driftedItems.length,
        drifted_items: summarizedDrifted.values,
        drifted_items_truncated: summarizedDrifted.truncated,
        counts: {
          missing_streams: missingStreams.length,
          unreadable_streams: unreadableStreams.length,
          hash_mismatches: hashMismatches.length,
        },
      },
    },
    warnings,
  };
}

function summarizeCommandReferenceRow(ownerId: string, referencedId: string, command: string): string {
  const normalizedCommand = command.trim().replaceAll(/\s+/g, " ");
  const commandPreview = normalizedCommand.length > 120 ? `${normalizedCommand.slice(0, 117)}...` : normalizedCommand;
  return `${ownerId}:${referencedId}:${commandPreview}`;
}

function buildCommandReferencesCheck(
  items: ItemWithBody[],
  idPrefix: string,
): { check: ValidateCheck; warnings: string[] } {
  const knownIds = new Set(items.map((item) => item.id.toLowerCase()));
  let linkedCommandsScanned = 0;
  let referencedPmIdCount = 0;
  const referencedPmIds = new Set<string>();
  const staleReferenceRows: string[] = [];

  for (const item of items) {
    for (const linkedTest of item.tests ?? []) {
      if (typeof linkedTest.command !== "string" || linkedTest.command.trim().length === 0) {
        continue;
      }
      linkedCommandsScanned += 1;
      const referencedIds = extractReferencedPmItemIdsFromCommand(linkedTest.command, idPrefix);
      if (referencedIds.length === 0) {
        continue;
      }
      referencedPmIdCount += referencedIds.length;
      for (const referencedId of referencedIds) {
        referencedPmIds.add(referencedId);
        if (!knownIds.has(referencedId.toLowerCase())) {
          staleReferenceRows.push(summarizeCommandReferenceRow(item.id, referencedId, linkedTest.command));
        }
      }
    }
  }

  const uniqueStaleReferenceRows = [...new Set(staleReferenceRows)].sort((left, right) => left.localeCompare(right));
  const stalePmIds = [...new Set(uniqueStaleReferenceRows.map((row) => row.split(":")[1] ?? ""))]
    .filter((value) => value.length > 0)
    .sort((left, right) => left.localeCompare(right));
  const warnings =
    uniqueStaleReferenceRows.length > 0 ? [`validate_command_references_stale_pm_ids:${uniqueStaleReferenceRows.length}`] : [];
  const summarizedRows = summarizeList(uniqueStaleReferenceRows);
  const summarizedStalePmIds = summarizeList(stalePmIds);
  const summarizedReferencedPmIds = summarizeList([...referencedPmIds].sort((left, right) => left.localeCompare(right)));

  return {
    check: {
      name: "command_references",
      status: warnings.length === 0 ? "ok" : "warn",
      details: {
        checked_items: items.length,
        linked_commands_scanned: linkedCommandsScanned,
        referenced_pm_ids_count: referencedPmIdCount,
        unique_referenced_pm_ids_count: referencedPmIds.size,
        unique_referenced_pm_ids: summarizedReferencedPmIds.values,
        unique_referenced_pm_ids_truncated: summarizedReferencedPmIds.truncated,
        stale_pm_id_references_count: uniqueStaleReferenceRows.length,
        stale_pm_ids_count: stalePmIds.length,
        stale_pm_ids: summarizedStalePmIds.values,
        stale_pm_ids_truncated: summarizedStalePmIds.truncated,
        stale_pm_id_reference_rows: summarizedRows.values,
        stale_pm_id_reference_rows_truncated: summarizedRows.truncated,
      },
    },
    warnings,
  };
}

export async function runValidate(options: ValidateCommandOptions, global: GlobalOptions): Promise<ValidateResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const itemReadWarnings: string[] = [];
  const items = await listAllFrontMatterWithBody(pmRoot, settings.item_format, typeRegistry.type_to_folder, itemReadWarnings);
  const requestedChecks = resolveRequestedChecks(options);
  const fileScanMode = resolveFileScanMode(options.scanMode);
  const workspaceRoot = resolveWorkspaceRoot(pmRoot);
  const checks: ValidateCheck[] = [];
  const warnings = [...new Set(itemReadWarnings)];

  if (requestedChecks.has("metadata")) {
    const metadataCheck = buildMetadataCheck(items);
    checks.push(metadataCheck.check);
    warnings.push(...metadataCheck.warnings);
  }
  if (requestedChecks.has("resolution")) {
    const resolutionCheck = buildResolutionCheck(items);
    checks.push(resolutionCheck.check);
    warnings.push(...resolutionCheck.warnings);
  }
  if (requestedChecks.has("files")) {
    const filesCheck = await buildFilesCheck(items, workspaceRoot, pmRoot, fileScanMode, Boolean(options.includePmInternals));
    checks.push(filesCheck.check);
    warnings.push(...filesCheck.warnings);
  }
  if (requestedChecks.has("command_references")) {
    const commandReferencesCheck = buildCommandReferencesCheck(items, settings.id_prefix);
    checks.push(commandReferencesCheck.check);
    warnings.push(...commandReferencesCheck.warnings);
  }
  if (requestedChecks.has("history_drift")) {
    const historyDriftCheck = await buildHistoryDriftCheck(pmRoot, items);
    checks.push(historyDriftCheck.check);
    warnings.push(...historyDriftCheck.warnings);
  }

  const normalizedWarnings = [...new Set(warnings)].sort((left, right) => left.localeCompare(right));
  return {
    ok: normalizedWarnings.length === 0,
    checks,
    warnings: normalizedWarnings,
    generated_at: nowIso(),
  };
}
