import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import type { Dirent } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { scanHistoryDrift } from "../../core/history/drift-scan.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { resolveRuntimeStatusRegistry, type RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import {
  DEFAULT_VALIDATE_CLOSURE_LIKE_METADATA_FIELD_PATTERNS,
  DEFAULT_VALIDATE_STALE_BLOCKER_REASON_PATTERNS,
  EXIT_CODE,
  PM_DIRNAME,
} from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { toNonEmptyStringOrUndefined } from "../../core/shared/primitives.js";
import { nowIso } from "../../core/shared/time.js";
import { listAllFrontMatterWithBody } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ValidateMetadataProfile, ValidateMetadataRequiredField } from "../../types/index.js";
import { extractReferencedPmItemIdsFromCommand } from "./test.js";

type ValidateCheckName = "metadata" | "resolution" | "lifecycle" | "files" | "command_references" | "history_drift";
type ValidateStatus = "ok" | "warn" | "error";
type ValidateDependencyCycleSeverity = "off" | "warn" | "error";
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
type ResolutionFieldKey = (typeof RESOLUTION_FIELD_KEYS)[number];
const VALIDATE_FILE_SCAN_MODES = ["default", "tracked-all", "tracked-all-strict"] as const;
const VALIDATE_METADATA_PROFILE_VALUES = ["core", "strict", "custom"] as const;
const VALIDATE_DEPENDENCY_CYCLE_SEVERITY_VALUES = ["off", "warn", "error"] as const;
const LIFECYCLE_PATTERN_FIELD_KEYS = ["blocked_reason", "resolution", "actual_result"] as const;
type LifecyclePatternFieldKey = (typeof LIFECYCLE_PATTERN_FIELD_KEYS)[number];
const CORE_METADATA_REQUIRED_FIELDS = ["author", "acceptance_criteria", "estimated_minutes", "close_reason"] as const;
const STRICT_METADATA_REQUIRED_FIELDS = [
  ...CORE_METADATA_REQUIRED_FIELDS,
  "reviewer",
  "risk",
  "confidence",
  "sprint",
  "release",
] as const;
const SUPPORTED_METADATA_REQUIRED_FIELDS = [
  ...new Set([...STRICT_METADATA_REQUIRED_FIELDS]),
] as ValidateMetadataRequiredField[];
const METADATA_REQUIRED_FIELD_ALIASES: Record<string, ValidateMetadataRequiredField> = {
  author: "author",
  acceptance_criteria: "acceptance_criteria",
  "acceptance-criteria": "acceptance_criteria",
  estimated_minutes: "estimated_minutes",
  "estimated-minutes": "estimated_minutes",
  estimate: "estimated_minutes",
  close_reason: "close_reason",
  "close-reason": "close_reason",
  reviewer: "reviewer",
  risk: "risk",
  confidence: "confidence",
  sprint: "sprint",
  release: "release",
};
const METADATA_WARNING_TOKEN_BY_FIELD: Record<ValidateMetadataRequiredField, string> = {
  author: "validate_metadata_missing_author",
  acceptance_criteria: "validate_metadata_missing_acceptance_criteria",
  estimated_minutes: "validate_metadata_missing_estimate",
  close_reason: "validate_metadata_missing_close_reason",
  reviewer: "validate_metadata_missing_reviewer",
  risk: "validate_metadata_missing_risk",
  confidence: "validate_metadata_missing_confidence",
  sprint: "validate_metadata_missing_sprint",
  release: "validate_metadata_missing_release",
};
const METADATA_COUNT_KEY_BY_FIELD: Record<ValidateMetadataRequiredField, string> = {
  author: "missing_author",
  acceptance_criteria: "missing_acceptance_criteria",
  estimated_minutes: "missing_estimated_minutes",
  close_reason: "closed_missing_close_reason",
  reviewer: "missing_reviewer",
  risk: "missing_risk",
  confidence: "missing_confidence",
  sprint: "missing_sprint",
  release: "missing_release",
};
const METADATA_ITEM_IDS_KEY_BY_FIELD: Record<ValidateMetadataRequiredField, string> = {
  author: "missing_author_item_ids",
  acceptance_criteria: "missing_acceptance_criteria_item_ids",
  estimated_minutes: "missing_estimated_minutes_item_ids",
  close_reason: "closed_missing_close_reason_item_ids",
  reviewer: "missing_reviewer_item_ids",
  risk: "missing_risk_item_ids",
  confidence: "missing_confidence_item_ids",
  sprint: "missing_sprint_item_ids",
  release: "missing_release_item_ids",
};
const METADATA_TRUNCATED_KEY_BY_FIELD: Record<ValidateMetadataRequiredField, string> = {
  author: "missing_author_truncated",
  acceptance_criteria: "missing_acceptance_criteria_truncated",
  estimated_minutes: "missing_estimated_minutes_truncated",
  close_reason: "closed_missing_close_reason_truncated",
  reviewer: "missing_reviewer_truncated",
  risk: "missing_risk_truncated",
  confidence: "missing_confidence_truncated",
  sprint: "missing_sprint_truncated",
  release: "missing_release_truncated",
};
const GIT_LS_FILES_MAX_BUFFER = 32 * 1024 * 1024;
const FILE_LIST_SUMMARY_LIMIT = 40;
const DIAGNOSTIC_LIST_SUMMARY_LIMIT = 5;
const execFileAsync = promisify(execFile);

export interface ValidateCommandOptions {
  checkMetadata?: boolean;
  checkResolution?: boolean;
  checkLifecycle?: boolean;
  checkStaleBlockers?: boolean;
  dependencyCycleSeverity?: string;
  checkFiles?: boolean;
  includePmInternals?: boolean;
  verboseFileLists?: boolean;
  verboseDiagnostics?: boolean;
  checkHistoryDrift?: boolean;
  checkCommandReferences?: boolean;
  scanMode?: string;
  metadataProfile?: string;
}

export interface ValidateCheck {
  name: ValidateCheckName;
  status: ValidateStatus;
  details: Record<string, unknown>;
}

export interface ValidateResult {
  ok: boolean;
  has_warnings: boolean;
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



function toMeaningfulString(value: unknown): string | undefined {
  const normalized = toNonEmptyStringOrUndefined(value);
  if (!normalized) {
    return undefined;
  }
  const lowered = normalized.toLowerCase();
  if (lowered === "none" || lowered === "null" || lowered === "n/a" || lowered === "na") {
    return undefined;
  }
  return normalized;
}

function normalizeStatusForRegistry(status: string, statusRegistry: RuntimeStatusRegistry): string {
  return normalizeStatusInput(status, statusRegistry) ?? status;
}

function isTerminalStatus(status: string, statusRegistry: RuntimeStatusRegistry): boolean {
  return statusRegistry.terminal_statuses.has(normalizeStatusForRegistry(status, statusRegistry));
}

interface ValidateMetadataPolicy {
  profile: ValidateMetadataProfile;
  profile_source: "default" | "settings" | "option";
  required_fields: ValidateMetadataRequiredField[];
  configured_custom_fields: ValidateMetadataRequiredField[];
  fallback_to_core: boolean;
  warnings: string[];
}

type LifecyclePatternSource = "default" | "settings";

interface LifecyclePatternPolicy {
  stale_blocker_reason_patterns: string[];
  stale_blocker_reason_pattern_source: LifecyclePatternSource;
  closure_like_metadata_field_patterns: Record<LifecyclePatternFieldKey, string[]>;
  closure_like_metadata_field_pattern_sources: Record<LifecyclePatternFieldKey, LifecyclePatternSource>;
}

interface LifecyclePatternSettingsSource {
  validation: {
    lifecycle_stale_blocker_reason_patterns: string[];
    lifecycle_closure_like_blocked_reason_patterns: string[];
    lifecycle_closure_like_resolution_patterns: string[];
    lifecycle_closure_like_actual_result_patterns: string[];
  };
}

function normalizeLifecyclePatternList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function areSortedStringListsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function resolveLifecyclePatternPolicy(settings: LifecyclePatternSettingsSource): LifecyclePatternPolicy {
  const defaultStalePatterns = normalizeLifecyclePatternList(DEFAULT_VALIDATE_STALE_BLOCKER_REASON_PATTERNS);
  const defaultClosureLikePatterns = {
    blocked_reason: normalizeLifecyclePatternList(DEFAULT_VALIDATE_CLOSURE_LIKE_METADATA_FIELD_PATTERNS.blocked_reason),
    resolution: normalizeLifecyclePatternList(DEFAULT_VALIDATE_CLOSURE_LIKE_METADATA_FIELD_PATTERNS.resolution),
    actual_result: normalizeLifecyclePatternList(DEFAULT_VALIDATE_CLOSURE_LIKE_METADATA_FIELD_PATTERNS.actual_result),
  } satisfies Record<LifecyclePatternFieldKey, string[]>;
  const staleBlockerReasonPatterns = normalizeLifecyclePatternList(
    settings.validation.lifecycle_stale_blocker_reason_patterns,
  );
  const closureLikePatterns = {
    blocked_reason: normalizeLifecyclePatternList(settings.validation.lifecycle_closure_like_blocked_reason_patterns),
    resolution: normalizeLifecyclePatternList(settings.validation.lifecycle_closure_like_resolution_patterns),
    actual_result: normalizeLifecyclePatternList(settings.validation.lifecycle_closure_like_actual_result_patterns),
  } satisfies Record<LifecyclePatternFieldKey, string[]>;
  return {
    stale_blocker_reason_patterns: staleBlockerReasonPatterns,
    stale_blocker_reason_pattern_source: areSortedStringListsEqual(staleBlockerReasonPatterns, defaultStalePatterns)
      ? "default"
      : "settings",
    closure_like_metadata_field_patterns: closureLikePatterns,
    closure_like_metadata_field_pattern_sources: {
      blocked_reason: areSortedStringListsEqual(closureLikePatterns.blocked_reason, defaultClosureLikePatterns.blocked_reason)
        ? "default"
        : "settings",
      resolution: areSortedStringListsEqual(closureLikePatterns.resolution, defaultClosureLikePatterns.resolution)
        ? "default"
        : "settings",
      actual_result: areSortedStringListsEqual(closureLikePatterns.actual_result, defaultClosureLikePatterns.actual_result)
        ? "default"
        : "settings",
    },
  };
}

function resolveValidateMetadataProfile(value: string | undefined): ValidateMetadataProfile {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized.length === 0) {
    return "core";
  }
  if ((VALIDATE_METADATA_PROFILE_VALUES as readonly string[]).includes(normalized)) {
    return normalized as ValidateMetadataProfile;
  }
  throw new PmCliError(
    `Unknown --metadata-profile value "${value}". Supported values: ${VALIDATE_METADATA_PROFILE_VALUES.join(", ")}.`,
    EXIT_CODE.USAGE,
  );
}

function resolveDependencyCycleSeverity(value: string | undefined): ValidateDependencyCycleSeverity {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized.length === 0) {
    return "warn";
  }
  if ((VALIDATE_DEPENDENCY_CYCLE_SEVERITY_VALUES as readonly string[]).includes(normalized)) {
    return normalized as ValidateDependencyCycleSeverity;
  }
  throw new PmCliError(
    `Unknown --dependency-cycle-severity value "${value}". Supported values: ${VALIDATE_DEPENDENCY_CYCLE_SEVERITY_VALUES.join(", ")}.`,
    EXIT_CODE.USAGE,
  );
}

function normalizeMetadataRequiredFieldsFromSettings(
  values: readonly ValidateMetadataRequiredField[] | undefined,
): ValidateMetadataRequiredField[] {
  const normalized = [...new Set((values ?? []).map((value) => value.trim().toLowerCase().replaceAll("-", "_")))];
  return normalized
    .map((value) => METADATA_REQUIRED_FIELD_ALIASES[value])
    .filter((value): value is ValidateMetadataRequiredField => value !== undefined)
    .sort((left, right) => left.localeCompare(right));
}

function resolveValidateMetadataPolicy(
  profile: ValidateMetadataProfile,
  profileSource: "default" | "settings" | "option",
  configuredCustomFields: readonly ValidateMetadataRequiredField[],
): ValidateMetadataPolicy {
  const normalizedCustomFields = normalizeMetadataRequiredFieldsFromSettings(configuredCustomFields);
  if (profile === "core") {
    return {
      profile,
      profile_source: profileSource,
      required_fields: [...CORE_METADATA_REQUIRED_FIELDS],
      configured_custom_fields: normalizedCustomFields,
      fallback_to_core: false,
      warnings: [],
    };
  }
  if (profile === "strict") {
    return {
      profile,
      profile_source: profileSource,
      required_fields: [...STRICT_METADATA_REQUIRED_FIELDS],
      configured_custom_fields: normalizedCustomFields,
      fallback_to_core: false,
      warnings: [],
    };
  }
  if (normalizedCustomFields.length > 0) {
    return {
      profile,
      profile_source: profileSource,
      required_fields: normalizedCustomFields,
      configured_custom_fields: normalizedCustomFields,
      fallback_to_core: false,
      warnings: [],
    };
  }
  return {
    profile,
    profile_source: profileSource,
    required_fields: [...CORE_METADATA_REQUIRED_FIELDS],
    configured_custom_fields: normalizedCustomFields,
    fallback_to_core: true,
    warnings: ["validate_metadata_custom_profile_missing_required_fields:0"],
  };
}

function isMetadataFieldMissing(
  item: ItemWithBody,
  field: ValidateMetadataRequiredField,
  statusRegistry: RuntimeStatusRegistry,
): boolean {
  if (field === "author") {
    return !toNonEmptyStringOrUndefined(item.author);
  }
  if (field === "acceptance_criteria") {
    return !toNonEmptyStringOrUndefined(item.acceptance_criteria);
  }
  if (field === "estimated_minutes") {
    return !Number.isFinite(item.estimated_minutes);
  }
  if (field === "close_reason") {
    return normalizeStatusForRegistry(item.status, statusRegistry) === statusRegistry.close_status && !toNonEmptyStringOrUndefined(item.close_reason);
  }
  if (field === "reviewer") {
    return !toNonEmptyStringOrUndefined(item.reviewer);
  }
  if (field === "risk") {
    return !toNonEmptyStringOrUndefined(item.risk);
  }
  if (field === "confidence") {
    if (typeof item.confidence === "number") {
      return !Number.isFinite(item.confidence);
    }
    return !toNonEmptyStringOrUndefined(item.confidence);
  }
  if (field === "sprint") {
    return !toNonEmptyStringOrUndefined(item.sprint);
  }
  return !toNonEmptyStringOrUndefined(item.release);
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
  const resolvedPmRoot = path.resolve(pmRoot);
  const normalizedPmRoot = resolvedPmRoot.replaceAll("\\", "/");
  if (normalizedPmRoot.endsWith("/.agents/pm")) {
    return path.dirname(path.dirname(resolvedPmRoot));
  }
  const resolvedCwd = path.resolve(process.cwd());
  const canonicalPmRoot = realpathForWorkspaceRoot(resolvedPmRoot);
  const canonicalCwd = realpathForWorkspaceRoot(resolvedCwd);
  const relativeFromPmRoot = path.relative(canonicalPmRoot, canonicalCwd);
  const cwdInsidePmRoot =
    relativeFromPmRoot.length === 0 ||
    (!relativeFromPmRoot.startsWith("..") && !path.isAbsolute(relativeFromPmRoot));
  if (cwdInsidePmRoot) {
    return resolvedPmRoot;
  }
  /* c8 ignore next 2 -- non-standard PM root layouts are integration-only edge cases. */
  return resolvedCwd;
}

function realpathForWorkspaceRoot(inputPath: string): string {
  try {
    return realpathSync.native(inputPath);
  } catch {
    return path.resolve(inputPath);
  }
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

function summarizeList(values: string[], limit = DIAGNOSTIC_LIST_SUMMARY_LIMIT): { values: string[]; truncated: boolean } {
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

function summarizeFileList(
  values: string[],
  verboseFileLists: boolean,
): {
  values: string[];
  truncated: boolean;
  total: number;
} {
  if (verboseFileLists) {
    return {
      values,
      truncated: false,
      total: values.length,
    };
  }
  const summary = summarizeList(values, FILE_LIST_SUMMARY_LIMIT);
  return {
    values: summary.values,
    truncated: summary.truncated,
    total: values.length,
  };
}

const RESOLUTION_REMEDIATION_FLAG_BY_FIELD: Record<ResolutionFieldKey, string> = {
  resolution: "--resolution",
  expected_result: "--expected-result",
  actual_result: "--actual-result",
};

const RESOLUTION_REMEDIATION_PLACEHOLDER_BY_FIELD: Record<ResolutionFieldKey, string> = {
  resolution: "Describe how this item was resolved",
  expected_result: "Describe the expected result",
  actual_result: "Describe the actual result",
};

function buildResolutionRemediationCommand(row: { id: string; missing_fields: ResolutionFieldKey[] }): string {
  const fieldArguments = row.missing_fields
    .map((field) => `${RESOLUTION_REMEDIATION_FLAG_BY_FIELD[field]} \"${RESOLUTION_REMEDIATION_PLACEHOLDER_BY_FIELD[field]}\"`)
    .join(" ");
  return `pm update ${row.id} ${fieldArguments} --message \"Backfill resolution metadata\"`;
}

function resolveRequestedChecks(options: ValidateCommandOptions): Set<ValidateCheckName> {
  const requested = new Set<ValidateCheckName>();
  if (options.checkMetadata) {
    requested.add("metadata");
  }
  if (options.checkResolution) {
    requested.add("resolution");
  }
  if (options.checkLifecycle || options.checkStaleBlockers) {
    requested.add("lifecycle");
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
    requested.add("lifecycle");
    requested.add("files");
    requested.add("command_references");
    requested.add("history_drift");
  }
  return requested;
}

function buildMetadataCheck(
  items: ItemWithBody[],
  metadataPolicy: ValidateMetadataPolicy,
  statusRegistry: RuntimeStatusRegistry,
  verboseDiagnostics: boolean,
): { check: ValidateCheck; warnings: string[] } {
  const missingByField = Object.fromEntries(
    SUPPORTED_METADATA_REQUIRED_FIELDS.map((field) => [field, [] as string[]]),
  ) as Record<ValidateMetadataRequiredField, string[]>;

  for (const item of items) {
    for (const field of SUPPORTED_METADATA_REQUIRED_FIELDS) {
      if (!isMetadataFieldMissing(item, field, statusRegistry)) {
        continue;
      }
      missingByField[field].push(item.id);
    }
  }

  const warningTokens = [...metadataPolicy.warnings];
  for (const field of metadataPolicy.required_fields) {
    const missingItems = missingByField[field];
    if (missingItems.length === 0) {
      continue;
    }
    warningTokens.push(`${METADATA_WARNING_TOKEN_BY_FIELD[field]}:${missingItems.length}`);
  }

  // Zero-suppress counts to reduce agent token cost (telemetry pm-tylj).
  // Only emit counts for the ACTIVE required fields of the resolved profile so a
  // looser profile (e.g. core) never reports missing reviewer/risk/sprint/etc.
  // Defensive guards (Gemini high #1, PR #78 follow-up): a future settings
  // shape could include an unsupported field in required_fields — fall back
  // to 0 instead of throwing TypeError, and skip writing when the count-key
  // mapping is undefined.
  const counts: Record<string, number> = {};
  for (const field of metadataPolicy.required_fields) {
    const value = missingByField[field]?.length ?? 0;
    const countKey = METADATA_COUNT_KEY_BY_FIELD[field];
    if (value > 0 && countKey) {
      counts[countKey] = value;
    }
  }
  const details: Record<string, unknown> = {
    checked_items: items.length,
    metadata_profile: metadataPolicy.profile,
    metadata_profile_source: metadataPolicy.profile_source,
    metadata_profile_fallback_to_core: metadataPolicy.fallback_to_core,
    required_fields: [...metadataPolicy.required_fields],
    supported_required_fields: [...SUPPORTED_METADATA_REQUIRED_FIELDS],
    counts,
  };
  if (metadataPolicy.configured_custom_fields.length > 0) {
    details.configured_custom_required_fields = [...metadataPolicy.configured_custom_fields];
  }

  // Only emit per-field item_ids/truncated keys for the ACTIVE required fields of
  // the resolved profile (and only when there are missing items). This stops a
  // looser profile (e.g. core) from emitting the identical full ID array for
  // reviewer/risk/confidence/sprint/release that it does not even require
  // (pm-edge #2 — ~150 redundant lines per validate run on minimal/core).
  // Defensive guard (Gemini high #2, PR #78 follow-up): same optional-chain
  // safety as the counts loop above — never throw if a future settings shape
  // includes an unsupported field.
  for (const field of metadataPolicy.required_fields) {
    const missing = missingByField[field];
    if (!missing || missing.length === 0) {
      continue;
    }
    const idsKey = METADATA_ITEM_IDS_KEY_BY_FIELD[field];
    const truncatedKey = METADATA_TRUNCATED_KEY_BY_FIELD[field];
    if (!idsKey || !truncatedKey) {
      continue;
    }
    const summarized = summarizeList(missing, verboseDiagnostics ? missing.length : DIAGNOSTIC_LIST_SUMMARY_LIMIT);
    details[idsKey] = summarized.values;
    details[truncatedKey] = summarized.truncated;
  }

  return {
    check: {
      name: "metadata",
      status: warningTokens.length === 0 ? "ok" : "warn",
      details,
    },
    warnings: warningTokens,
  };
}

function buildResolutionCheck(
  items: ItemWithBody[],
  statusRegistry: RuntimeStatusRegistry,
  verboseDiagnostics: boolean,
): { check: ValidateCheck; warnings: string[] } {
  const terminalDoneStatuses = new Set<string>(statusRegistry.terminal_done_statuses);
  terminalDoneStatuses.add(statusRegistry.close_status);
  const closedItems = items.filter((item) => terminalDoneStatuses.has(normalizeStatusForRegistry(item.status, statusRegistry)));
  const missingResolutionRows: Array<{ id: string; missing_fields: ResolutionFieldKey[] }> = [];

  for (const item of closedItems) {
    const missingFields = RESOLUTION_FIELD_KEYS.filter((field) => !toNonEmptyStringOrUndefined(item[field]));
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
  const diagnosticLimit = verboseDiagnostics ? Number.POSITIVE_INFINITY : DIAGNOSTIC_LIST_SUMMARY_LIMIT;
  const summarizedRows = summarizeList(
    missingResolutionRows.map((row) => `${row.id}:${row.missing_fields.join(",")}`),
    diagnosticLimit,
  );
  const remediationHints = missingResolutionRows.map((row) => buildResolutionRemediationCommand(row));
  const summarizedHints = summarizeList(remediationHints, diagnosticLimit);
  return {
    check: {
      name: "resolution",
      status: warnings.length === 0 ? "ok" : "warn",
      details: {
        checked_closed_items: closedItems.length,
        missing_resolution_items: missingResolutionRows.length,
        missing_resolution_rows: summarizedRows.values,
        missing_resolution_rows_truncated: summarizedRows.truncated,
        missing_resolution_remediation_hints: summarizedHints.values,
        missing_resolution_remediation_hints_truncated: summarizedHints.truncated,
      },
    },
    warnings,
  };
}

function buildLifecycleDependencyGraph(activeItems: ItemWithBody[]): Map<string, string[]> {
  const activeItemIds = new Set(activeItems.map((item) => item.id));
  const graph = new Map<string, string[]>();
  const sortedItems = [...activeItems].sort((left, right) => left.id.localeCompare(right.id));
  for (const item of sortedItems) {
    const edges = new Set<string>();
    for (const dependency of item.dependencies ?? []) {
      const dependencyId = toMeaningfulString(dependency.id);
      if (!dependencyId || !activeItemIds.has(dependencyId)) {
        continue;
      }
      edges.add(dependencyId);
    }
    graph.set(item.id, [...edges].sort((left, right) => left.localeCompare(right)));
  }
  return graph;
}

function findLifecycleDependencyCycleComponents(graph: Map<string, string[]>): string[][] {
  let nextIndex = 0;
  const indexById = new Map<string, number>();
  const lowLinkById = new Map<string, number>();
  const stack: string[] = [];
  const inStack = new Set<string>();
  const components: string[][] = [];

  const visit = (id: string): void => {
    indexById.set(id, nextIndex);
    lowLinkById.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    inStack.add(id);

    for (const dependencyId of graph.get(id) ?? []) {
      if (!indexById.has(dependencyId)) {
        visit(dependencyId);
        lowLinkById.set(id, Math.min(lowLinkById.get(id)!, lowLinkById.get(dependencyId)!));
      } else if (inStack.has(dependencyId)) {
        lowLinkById.set(id, Math.min(lowLinkById.get(id)!, indexById.get(dependencyId)!));
      }
    }

    if (lowLinkById.get(id) !== indexById.get(id)) {
      return;
    }
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      inStack.delete(member);
      component.push(member);
      if (member === id) {
        break;
      }
    }
    component.sort((left, right) => left.localeCompare(right));
    components.push(component);
  };

  const sortedNodeIds = [...graph.keys()].sort((left, right) => left.localeCompare(right));
  for (const id of sortedNodeIds) {
    if (!indexById.has(id)) {
      visit(id);
    }
  }

  const cycleComponents = components.filter((component) => {
    if (component.length > 1) {
      return true;
    }
    const selfId = component[0];
    return (graph.get(selfId) ?? []).includes(selfId);
  });
  return cycleComponents.sort(
    (left, right) =>
      left[0].localeCompare(right[0]) ||
      left.length - right.length ||
      left.join(",").localeCompare(right.join(",")),
  );
}

function resolveLifecycleDependencyCycleSamplePath(component: string[], graph: Map<string, string[]>): string[] {
  const start = component[0];
  if (component.length === 1) {
    return [start, start];
  }
  const componentSet = new Set(component);
  const path: string[] = [start];
  const visited = new Set<string>([start]);

  const search = (current: string): boolean => {
    const neighbors = (graph.get(current) ?? []).filter((candidate) => componentSet.has(candidate));
    for (const next of neighbors) {
      if (next === start && path.length > 1) {
        path.push(start);
        return true;
      }
      if (visited.has(next)) {
        continue;
      }
      visited.add(next);
      path.push(next);
      if (search(next)) {
        return true;
      }
      path.pop();
      visited.delete(next);
    }
    return false;
  };

  if (search(start)) {
    return [...path];
  }
  return [...component, start];
}

function detectLifecycleDependencyCycles(activeItems: ItemWithBody[]): {
  cycle_count: number;
  cycle_item_ids: string[];
  cycle_sample_paths: string[];
} {
  const graph = buildLifecycleDependencyGraph(activeItems);
  const cycleComponents = findLifecycleDependencyCycleComponents(graph);
  const cycleItemIds = [...new Set(cycleComponents.flat())].sort((left, right) => left.localeCompare(right));
  const cycleSamplePaths = cycleComponents.map((component) =>
    resolveLifecycleDependencyCycleSamplePath(component, graph).join("->"),
  );
  return {
    cycle_count: cycleComponents.length,
    cycle_item_ids: cycleItemIds,
    cycle_sample_paths: cycleSamplePaths,
  };
}

function buildLifecycleCheck(
  items: ItemWithBody[],
  includeStaleBlockers: boolean,
  dependencyCycleSeverity: ValidateDependencyCycleSeverity,
  statusRegistry: RuntimeStatusRegistry,
  lifecyclePatternPolicy: LifecyclePatternPolicy,
): { check: ValidateCheck; warnings: string[] } {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const blockedStatuses =
    statusRegistry.blocked_statuses.size > 0 ? statusRegistry.blocked_statuses : new Set<string>(["blocked"]);
  const activeItems = items.filter((item) => !isTerminalStatus(item.status, statusRegistry));
  const closureLikeRows: Array<{ id: string; fields: string[] }> = [];
  const terminalParentRows: Array<{ id: string; parent_id: string; parent_status: string }> = [];
  const staleBlockerRows: Array<{ id: string; status: string; reasons: string[] }> = [];

  for (const item of activeItems) {
    const closureLikeFields = Object.entries(lifecyclePatternPolicy.closure_like_metadata_field_patterns)
      .filter(([field, patterns]) => {
        const value = toMeaningfulString(item[field as keyof ItemWithBody]);
        if (!value) {
          return false;
        }
        const normalized = value.toLowerCase();
        return patterns.some((pattern) => normalized.includes(pattern));
      })
      .map(([field]) => field)
      .sort((left, right) => left.localeCompare(right));

    if (closureLikeFields.length > 0) {
      closureLikeRows.push({
        id: item.id,
        fields: closureLikeFields,
      });
    }

    const parentId = toMeaningfulString(item.parent);
    if (parentId) {
      const parent = itemsById.get(parentId);
      if (parent && isTerminalStatus(parent.status, statusRegistry)) {
        terminalParentRows.push({
          id: item.id,
          parent_id: parent.id,
          parent_status: parent.status,
        });
      }
    }

    if (includeStaleBlockers) {
      const blockedBy = toMeaningfulString(item.blocked_by);
      const blockedReason = toMeaningfulString(item.blocked_reason);
      const blockedReasonNormalized = blockedReason?.toLowerCase();
      const reasons: string[] = [];
      const normalizedStatus = normalizeStatusForRegistry(item.status, statusRegistry);

      if (!blockedStatuses.has(normalizedStatus)) {
        if (blockedBy) {
          reasons.push("non_blocked_status_has_blocked_by");
        }
        if (blockedReason) {
          reasons.push("non_blocked_status_has_blocked_reason");
        }
      } else {
        if (!blockedBy && !blockedReason) {
          reasons.push("blocked_status_missing_blocker_context");
        }
        if (blockedReasonNormalized?.includes("no active blocker")) {
          reasons.push("blocked_status_reason_reports_no_active_blocker");
        }
        if (
          blockedReasonNormalized &&
          lifecyclePatternPolicy.stale_blocker_reason_patterns.some((pattern) => blockedReasonNormalized.includes(pattern))
        ) {
          reasons.push("blocked_status_reason_matches_stale_pattern");
        }
      }

      if (reasons.length > 0) {
        staleBlockerRows.push({
          id: item.id,
          status: item.status,
          reasons: [...new Set(reasons)].sort((left, right) => left.localeCompare(right)),
        });
      }
    }
  }

  closureLikeRows.sort((left, right) => left.id.localeCompare(right.id));
  terminalParentRows.sort(
    (left, right) => left.id.localeCompare(right.id) || left.parent_id.localeCompare(right.parent_id),
  );
  staleBlockerRows.sort((left, right) => left.id.localeCompare(right.id));
  const dependencyCycleDiagnostics = detectLifecycleDependencyCycles(activeItems);

  const warnings: string[] = [];
  if (closureLikeRows.length > 0) {
    warnings.push(`validate_lifecycle_active_closure_like_metadata:${closureLikeRows.length}`);
  }
  if (terminalParentRows.length > 0) {
    warnings.push(`validate_lifecycle_active_terminal_parent:${terminalParentRows.length}`);
  }
  if (includeStaleBlockers && staleBlockerRows.length > 0) {
    warnings.push(`validate_lifecycle_stale_blockers:${staleBlockerRows.length}`);
  }
  if (dependencyCycleDiagnostics.cycle_count > 0 && dependencyCycleSeverity !== "off") {
    warnings.push(
      `${
        dependencyCycleSeverity === "error"
          ? "validate_lifecycle_dependency_cycles_error"
          : "validate_lifecycle_dependency_cycles"
      }:${dependencyCycleDiagnostics.cycle_count}`,
    );
  }

  const summarizedClosureLikeRows = summarizeList(
    closureLikeRows.map((row) => `${row.id}:${row.fields.join(",")}`),
  );
  const summarizedTerminalParentRows = summarizeList(
    terminalParentRows.map((row) => `${row.id}:${row.parent_id}:${row.parent_status}`),
  );
  const summarizedStaleBlockerRows = summarizeList(
    staleBlockerRows.map((row) => `${row.id}:${row.status}:${row.reasons.join(",")}`),
  );
  const summarizedDependencyCycleItemIds = summarizeList(dependencyCycleDiagnostics.cycle_item_ids);
  const summarizedDependencyCycleSamplePaths = summarizeList(dependencyCycleDiagnostics.cycle_sample_paths);

  return {
    check: {
      name: "lifecycle",
      status: dependencyCycleDiagnostics.cycle_count > 0 && dependencyCycleSeverity === "error"
        ? "error"
        : warnings.length === 0
          ? "ok"
          : "warn",
      details: {
        checked_active_items: activeItems.length,
        active_closure_like_metadata_items: closureLikeRows.length,
        active_closure_like_metadata_rows: summarizedClosureLikeRows.values,
        active_closure_like_metadata_rows_truncated: summarizedClosureLikeRows.truncated,
        active_terminal_parent_items: terminalParentRows.length,
        active_terminal_parent_rows: summarizedTerminalParentRows.values,
        active_terminal_parent_rows_truncated: summarizedTerminalParentRows.truncated,
        stale_blocker_checks_enabled: includeStaleBlockers,
        stale_blocker_items: staleBlockerRows.length,
        stale_blocker_rows: summarizedStaleBlockerRows.values,
        stale_blocker_rows_truncated: summarizedStaleBlockerRows.truncated,
        dependency_cycle_severity_policy: dependencyCycleSeverity,
        dependency_cycle_count: dependencyCycleDiagnostics.cycle_count,
        dependency_cycle_item_count: dependencyCycleDiagnostics.cycle_item_ids.length,
        dependency_cycle_item_ids: summarizedDependencyCycleItemIds.values,
        dependency_cycle_item_ids_truncated: summarizedDependencyCycleItemIds.truncated,
        dependency_cycle_sample_paths: summarizedDependencyCycleSamplePaths.values,
        dependency_cycle_sample_paths_truncated: summarizedDependencyCycleSamplePaths.truncated,
        stale_blocker_reason_patterns: [...lifecyclePatternPolicy.stale_blocker_reason_patterns],
        stale_blocker_reason_pattern_source: lifecyclePatternPolicy.stale_blocker_reason_pattern_source,
        closure_like_blocked_reason_patterns: [
          ...lifecyclePatternPolicy.closure_like_metadata_field_patterns.blocked_reason,
        ],
        closure_like_blocked_reason_pattern_source:
          lifecyclePatternPolicy.closure_like_metadata_field_pattern_sources.blocked_reason,
        closure_like_resolution_patterns: [...lifecyclePatternPolicy.closure_like_metadata_field_patterns.resolution],
        closure_like_resolution_pattern_source:
          lifecyclePatternPolicy.closure_like_metadata_field_pattern_sources.resolution,
        closure_like_actual_result_patterns: [...lifecyclePatternPolicy.closure_like_metadata_field_patterns.actual_result],
        closure_like_actual_result_pattern_source:
          lifecyclePatternPolicy.closure_like_metadata_field_pattern_sources.actual_result,
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
  verboseFileLists: boolean,
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
  const strictModeForcesPmInternals = strictTrackedAllMode && !includePmInternals;
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
    const summarizedPmInternalPaths = summarizeFileList(excludedPmInternalPaths, verboseFileLists);
    excludedByReason.pm_internals = {
      count: excludedPmInternalCount,
      paths: summarizedPmInternalPaths.values,
      paths_truncated: summarizedPmInternalPaths.truncated,
      paths_total: summarizedPmInternalPaths.total,
    };
  }
  const orphanedFiles = candidateFiles.filter((candidate) => !linkedProjectPaths.has(candidate));
  const warnings: string[] = [];
  if (strictModeForcesPmInternals) {
    warnings.push("validate_files_tracked_all_strict_forces_pm_internals");
  }
  if (uniqueMissingLinkedPaths.length > 0) {
    warnings.push(`validate_files_missing_linked_paths:${uniqueMissingLinkedPaths.length}`);
  }
  if (orphanedFiles.length > 0) {
    warnings.push(`validate_files_orphaned_paths:${orphanedFiles.length}`);
  }
  const summarizedMissing = summarizeFileList(uniqueMissingLinkedPaths, verboseFileLists);
  const summarizedOrphaned = summarizeFileList(orphanedFiles, verboseFileLists);

  return {
    check: {
      name: "files",
      status: warnings.length === 0 ? "ok" : "warn",
      details: {
        workspace_root: workspaceRoot,
        scan_mode_requested: fileCandidates.requestedMode,
        scan_mode_applied: fileCandidates.appliedMode,
        strict_tracked_all_mode: strictTrackedAllMode,
        strict_mode_forces_pm_internals: strictModeForcesPmInternals,
        strict_mode_forces_pm_internals_notice: strictModeForcesPmInternals
          ? "tracked-all-strict force-enables PM internals; pass --include-pm-internals to make inclusion explicit."
          : null,
        file_list_detail_mode: verboseFileLists ? "full" : "summary",
        file_list_summary_limit: FILE_LIST_SUMMARY_LIMIT,
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
        missing_linked_paths_total: summarizedMissing.total,
        missing_linked_paths: summarizedMissing.values,
        missing_linked_paths_truncated: summarizedMissing.truncated,
        orphaned_paths_count: orphanedFiles.length,
        orphaned_paths_total: summarizedOrphaned.total,
        orphaned_paths: summarizedOrphaned.values,
        orphaned_paths_truncated: summarizedOrphaned.truncated,
      },
    },
    warnings,
  };
}

async function buildHistoryDriftCheck(pmRoot: string, items: ItemWithBody[]): Promise<{ check: ValidateCheck; warnings: string[] }> {
  const { missingStreams, unreadableStreams, hashMismatches, chainMismatches, driftedItems } = await scanHistoryDrift(
    pmRoot,
    items,
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
  if (chainMismatches.length > 0) {
    warnings.push(`validate_history_drift_chain_mismatches:${chainMismatches.length}`);
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
          chain_mismatches: chainMismatches.length,
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
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const itemReadWarnings: string[] = [];
  const items = await listAllFrontMatterWithBody(
    pmRoot,
    settings.item_format,
    typeRegistry.type_to_folder,
    itemReadWarnings,
    settings.schema,
  );
  const requestedChecks = resolveRequestedChecks(options);
  const metadataProfileSource: "default" | "settings" | "option" =
    typeof options.metadataProfile === "string" ? "option" : "settings";
  const metadataProfile = resolveValidateMetadataProfile(
    typeof options.metadataProfile === "string" ? options.metadataProfile : settings.validation.metadata_profile,
  );
  const metadataPolicy = resolveValidateMetadataPolicy(
    metadataProfile,
    metadataProfileSource,
    settings.validation.metadata_required_fields,
  );
  const lifecyclePatternPolicy = resolveLifecyclePatternPolicy(settings);
  const dependencyCycleSeverity = resolveDependencyCycleSeverity(options.dependencyCycleSeverity);
  const fileScanMode = resolveFileScanMode(options.scanMode);
  const workspaceRoot = resolveWorkspaceRoot(pmRoot);
  const checks: ValidateCheck[] = [];
  const warnings = [...new Set(itemReadWarnings)];

  if (requestedChecks.has("metadata")) {
    const metadataCheck = buildMetadataCheck(items, metadataPolicy, statusRegistry, Boolean(options.verboseDiagnostics));
    checks.push(metadataCheck.check);
    warnings.push(...metadataCheck.warnings);
  }
  if (requestedChecks.has("resolution")) {
    const resolutionCheck = buildResolutionCheck(items, statusRegistry, Boolean(options.verboseDiagnostics));
    checks.push(resolutionCheck.check);
    warnings.push(...resolutionCheck.warnings);
  }
  if (requestedChecks.has("lifecycle")) {
    const lifecycleCheck = buildLifecycleCheck(
      items,
      Boolean(options.checkStaleBlockers),
      dependencyCycleSeverity,
      statusRegistry,
      lifecyclePatternPolicy,
    );
    checks.push(lifecycleCheck.check);
    warnings.push(...lifecycleCheck.warnings);
  }
  if (requestedChecks.has("files")) {
    const filesCheck = await buildFilesCheck(
      items,
      workspaceRoot,
      pmRoot,
      fileScanMode,
      Boolean(options.includePmInternals),
      Boolean(options.verboseFileLists),
    );
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
  const hasErrors = checks.some((check) => check.status === "error");
  return {
    ok: !hasErrors,
    has_warnings: normalizedWarnings.length > 0,
    checks,
    warnings: normalizedWarnings,
    generated_at: nowIso(),
  };
}
