import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import type { Dirent } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { buildRemediationCommands } from "../../core/diagnostics/remediation.js";
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
import {
  partitionFixesByGrant,
  planCloseReasonBackfillFixes,
  planEstimateBackfillFixes,
  planResolutionBackfillFixes,
  planStaleLinkPruneFixes,
  planTerminalParentFixes,
  resolveGrantedFixScopes,
  toFixOutputRow,
  type CloseReasonBackfillRow,
  type EstimateBackfillRow,
  type ResolutionBackfillRow,
  type StaleLinkPruneRow,
  type TerminalParentFixRow,
  type ValidateFixRecord,
} from "../../core/validate/fix-planning.js";
import { findDuplicateIssueCodes, type DuplicateIssueCode } from "../../core/governance/issue-codes.js";
import { buildMissingByTypeCounts, type MissingFieldOccurrence } from "../../core/validate/missing-by-type.js";
import {
  classifyStaleLinkedPaths,
  summarizeStaleLinkedPathClassifications,
} from "../../core/validate/stale-file-classification.js";
import {
  buildMissingLinkedPathRows,
  summarizeMissingLinkedPathRows,
  type StaleLinkOwnerInput,
} from "../../core/validate/missing-link-owners.js";
import type { ValidateMetadataProfile, ValidateMetadataRequiredField } from "../../types/index.js";
import { extractReferencedPmItemIdsFromCommand } from "./test.js";

type ValidateCheckName = "metadata" | "resolution" | "lifecycle" | "files" | "command_references" | "history_drift";
type ValidateStatus = "ok" | "warn" | "error";
type ValidateDependencyCycleSeverity = "off" | "warn" | "error";
type ValidateFileScanMode = "default" | "tracked-all" | "tracked-all-strict";
type ItemWithBody = Awaited<ReturnType<typeof listAllFrontMatterWithBody>>[number];
type FileCandidateSource = "default-curated" | "tracked-git" | "tracked-all-fallback-default";
type OrphanedPathClassification = "docs_unowned" | "tests_unowned" | "source_unowned" | "unlinked_existing";

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
  parentCycleSeverity?: string;
  checkFiles?: boolean;
  includePmInternals?: boolean;
  verboseFileLists?: boolean;
  verboseDiagnostics?: boolean;
  /** Emit complete *_item_ids diagnostic lists (no 5-item cap); implied by --json. */
  allAffectedIds?: boolean;
  checkHistoryDrift?: boolean;
  checkCommandReferences?: boolean;
  scanMode?: string;
  metadataProfile?: string;
  fixHints?: boolean;
  autoFix?: boolean;
  dryRun?: boolean;
  fixScope?: string[];
  pruneMissing?: boolean;
}

export interface ValidateCheck {
  name: ValidateCheckName;
  status: ValidateStatus;
  details: Record<string, unknown>;
}

export interface ValidateFixesSummary {
  mode: "apply" | "dry_run";
  auto_fix: boolean;
  prune_missing: boolean;
  granted_fix_scopes: string[];
  planned_count: number;
  applied_count: number;
  gated_count: number;
  failed_count: number;
  planned_fixes: Array<Record<string, unknown>>;
  applied_fixes: Array<Record<string, unknown>>;
  gated_fixes: Array<Record<string, unknown>>;
  failed_fixes: Array<Record<string, unknown>>;
}

export interface ValidateResult {
  ok: boolean;
  has_warnings: boolean;
  checks: ValidateCheck[];
  warnings: string[];
  /** Present when --auto-fix or --prune-missing was requested; checks always reflect the PRE-fix state. */
  fixes?: ValidateFixesSummary;
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

/* c8 ignore start -- runtime-status alias normalization is covered by status-registry integration tests */
function normalizeStatusForRegistry(status: string, statusRegistry: RuntimeStatusRegistry): string {
  return normalizeStatusInput(status, statusRegistry) ?? status;
}
/* c8 ignore stop */

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

/* c8 ignore start -- lifecycle pattern normalization/default-vs-settings matrix is covered by lifecycle integration tests */
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
/* c8 ignore stop */

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

function resolveParentCycleSeverity(value: string | undefined): ValidateDependencyCycleSeverity {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized.length === 0) {
    return "warn";
  }
  if ((VALIDATE_DEPENDENCY_CYCLE_SEVERITY_VALUES as readonly string[]).includes(normalized)) {
    return normalized as ValidateDependencyCycleSeverity;
  }
  throw new PmCliError(
    `Unknown --parent-cycle-severity value "${value}". Supported values: ${VALIDATE_DEPENDENCY_CYCLE_SEVERITY_VALUES.join(", ")}.`,
    EXIT_CODE.USAGE,
  );
}

/* c8 ignore start -- metadata required-field alias normalization is covered by metadata-policy integration tests */
function normalizeMetadataRequiredFieldsFromSettings(
  values: readonly ValidateMetadataRequiredField[] | undefined,
): ValidateMetadataRequiredField[] {
  const normalized = [...new Set((values ?? []).map((value) => value.trim().toLowerCase().replaceAll("-", "_")))];
  return normalized
    .map((value) => METADATA_REQUIRED_FIELD_ALIASES[value])
    .filter((value): value is ValidateMetadataRequiredField => value !== undefined)
    .sort((left, right) => left.localeCompare(right));
}
/* c8 ignore stop */

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

/**
 * Planning fields whose absence is only actionable on live work (GH-276): an
 * agent backfills an estimate or acceptance criteria to plan/execute an item,
 * so flagging them on a terminal (closed/canceled) historical item is pure
 * noise. Under the `strict` profile these are still enforced everywhere for
 * projects that want full historical coverage.
 */
const TERMINAL_EXEMPT_PLANNING_FIELDS: ReadonlySet<ValidateMetadataRequiredField> = new Set([
  "acceptance_criteria",
  "estimated_minutes",
]);

function isMetadataFieldMissing(
  item: ItemWithBody,
  field: ValidateMetadataRequiredField,
  statusRegistry: RuntimeStatusRegistry,
  enforcePlanningFieldsOnTerminal: boolean,
): boolean {
  // GH-276: skip planning-field gaps on retired (closed/canceled) items unless
  // the resolved profile explicitly demands strict historical coverage.
  if (
    !enforcePlanningFieldsOnTerminal &&
    TERMINAL_EXEMPT_PLANNING_FIELDS.has(field) &&
    isTerminalStatus(item.status, statusRegistry)
  ) {
    return false;
  }
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

/* c8 ignore start -- recursive file-walk dirent/permission edge cases are covered by filesystem integration suites */
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
/* c8 ignore stop */

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

/* c8 ignore start -- PM-internal prefix derivation permutations are covered by file-scan integration tests */
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
/* c8 ignore stop */

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
    /* c8 ignore start -- tracked-git availability fallback is covered by git/non-git integration fixtures */
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
    /* c8 ignore stop */
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

/**
 * Attach a uniform, machine-executable `fix_hints` array to a validate check's
 * details when `--fix-hints` is requested. The resolution check's existing
 * per-row remediation commands (which already carry concrete item ids) are
 * aliased in so agents read one uniform field across every check; all other
 * checks derive one generic command per distinct warning code from the shared
 * remediation registry. Generic hints may contain `<id>`/`<field>`/`<path>`
 * placeholders the caller substitutes before running — they are templates, not
 * always directly executable as-is. Read-only: this only enriches the diagnostic
 * output, never mutates any item.
 */
/* c8 ignore start -- fix-hint projection/truncation combinations are covered by validate output integration tests */
function attachValidateFixHints(check: ValidateCheck, checkWarnings: string[]): void {
  const existingResolutionHints = check.details?.missing_resolution_remediation_hints;
  const aliasedResolution = Array.isArray(existingResolutionHints) && existingResolutionHints.length > 0;
  const fixHints = aliasedResolution
    ? (existingResolutionHints as unknown[]).filter((hint): hint is string => typeof hint === "string")
    : buildRemediationCommands(checkWarnings);
  if (fixHints.length === 0) {
    return;
  }
  // The resolution check truncates its per-row hint list for low-token output;
  // carry that marker onto fix_hints so an agent knows the list is partial and
  // there are more items to repair beyond the ones shown.
  const truncated = aliasedResolution && check.details?.missing_resolution_remediation_hints_truncated === true;
  check.details = {
    ...check.details,
    fix_hints: fixHints,
    ...(truncated ? { fix_hints_truncated: true } : {}),
  };
}
/* c8 ignore stop */

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
    // Remediation flags without explicit --check-* flags scope the run to the
    // checks that can produce fixes: --auto-fix plans metadata/resolution
    // backfills and gated lifecycle fixes; --prune-missing needs the files
    // scan. With neither, the historical run-everything default applies.
    if (options.autoFix) {
      requested.add("metadata");
      requested.add("resolution");
      requested.add("lifecycle");
    }
    if (options.pruneMissing) {
      requested.add("files");
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
  // Explicit check flags are respected as-is, except --prune-missing always
  // needs the files scan it acts on.
  if (options.pruneMissing) {
    requested.add("files");
  }
  return requested;
}

const DUPLICATE_ISSUE_CODE_WARNING_TOKEN = "validate_metadata_duplicate_issue_codes";

/**
 * Project the duplicate logical issue-code findings (GH-235) into the
 * metadata-check `details` shape plus an advisory warning token. Duplicate
 * codes are advisory (warn), never an error — matching every other metadata
 * finding — so an otherwise clean tracker that simply reuses a title prefix is
 * not failed by `pm validate`. Kept outside the c8-ignored builder block so the
 * projection/remediation logic is fully covered by unit tests.
 */
function summarizeDuplicateIssueCodes(
  duplicates: DuplicateIssueCode[],
  verboseDiagnostics: boolean,
): { rows: Array<Record<string, unknown>>; truncated: boolean; warnings: string[] } {
  if (duplicates.length === 0) {
    return { rows: [], truncated: false, warnings: [] };
  }
  const limit = verboseDiagnostics ? duplicates.length : DIAGNOSTIC_LIST_SUMMARY_LIMIT;
  const shown = duplicates.slice(0, limit);
  const rows = shown.map((duplicate) => ({
    code: duplicate.code,
    count: duplicate.count,
    ids: duplicate.ids,
    titles: duplicate.titles,
    remediation_hint: `Items ${duplicate.ids.join(", ")} share issue code "${duplicate.code}"; rename or merge so each logical code maps to one item.`,
  }));
  return {
    rows,
    truncated: shown.length < duplicates.length,
    warnings: [`${DUPLICATE_ISSUE_CODE_WARNING_TOKEN}:${duplicates.length}`],
  };
}

/* c8 ignore start -- metadata diagnostics/backfill planning permutations are covered by validate integration suites */
function buildMetadataCheck(
  items: ItemWithBody[],
  metadataPolicy: ValidateMetadataPolicy,
  statusRegistry: RuntimeStatusRegistry,
  verboseDiagnostics: boolean,
): {
  check: ValidateCheck;
  warnings: string[];
  closeReasonBackfillRows: CloseReasonBackfillRow[];
  estimateBackfillRows: EstimateBackfillRow[];
} {
  const missingByField = Object.fromEntries(
    SUPPORTED_METADATA_REQUIRED_FIELDS.map((field) => [field, [] as string[]]),
  ) as Record<ValidateMetadataRequiredField, string[]>;
  const itemsById = new Map(items.map((item) => [item.id, item]));

  // GH-276: only the `strict` profile enforces planning fields on terminal
  // (closed/canceled) historical items; core/minimal/custom profiles treat a
  // retired item's missing estimate or acceptance criteria as resolved.
  const enforcePlanningFieldsOnTerminal = metadataPolicy.profile === "strict";

  for (const item of items) {
    for (const field of SUPPORTED_METADATA_REQUIRED_FIELDS) {
      if (!isMetadataFieldMissing(item, field, statusRegistry, enforcePlanningFieldsOnTerminal)) {
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

  // Duplicate logical issue-code detection (GH-235): advisory warning when two
  // or more items share a leading title issue code (e.g. `ISSUE-004`).
  const duplicateIssueCodes = findDuplicateIssueCodes(items);
  const duplicateIssueCodeSummary = summarizeDuplicateIssueCodes(duplicateIssueCodes, verboseDiagnostics);
  warningTokens.push(...duplicateIssueCodeSummary.warnings);

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
  // Per-item-type grouping of missing required-field counts (pm-pmyq /
  // GH-172): counts only — never row dumps — and only for the ACTIVE required
  // fields, so the grouping mirrors `counts` at type granularity (e.g.
  // `{ Task: { close_reason: 3 } }`). Zero-suppressed at both levels.
  const missingFieldOccurrences: MissingFieldOccurrence[] = [];
  for (const field of metadataPolicy.required_fields) {
    for (const itemId of missingByField[field] ?? []) {
      const itemType = itemsById.get(itemId)?.type;
      missingFieldOccurrences.push({ item_type: typeof itemType === "string" && itemType.length > 0 ? itemType : "Unknown", field });
    }
  }
  const missingByType = buildMissingByTypeCounts(missingFieldOccurrences);
  const details: Record<string, unknown> = {
    checked_items: items.length,
    metadata_profile: metadataPolicy.profile,
    metadata_profile_source: metadataPolicy.profile_source,
    metadata_profile_fallback_to_core: metadataPolicy.fallback_to_core,
    required_fields: [...metadataPolicy.required_fields],
    supported_required_fields: [...SUPPORTED_METADATA_REQUIRED_FIELDS],
    counts,
    missing_by_type: missingByType,
    duplicate_issue_codes_count: duplicateIssueCodes.length,
    duplicate_issue_codes: duplicateIssueCodeSummary.rows,
    duplicate_issue_codes_truncated: duplicateIssueCodeSummary.truncated,
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

  // Auto-fix planning input (pm-c3sz): closed items flagged for a missing
  // close_reason whose resolution can serve as the derivable source value.
  // Only collected when close_reason is an active required field, so fixes
  // always trace back to an actual finding of this run.
  const closeReasonBackfillRows: CloseReasonBackfillRow[] = metadataPolicy.required_fields.includes("close_reason")
    ? (missingByField.close_reason ?? []).map((itemId) => ({
        id: itemId,
        resolution: toNonEmptyStringOrUndefined(itemsById.get(itemId)?.resolution),
      }))
    : [];

  // Estimate auto-fix planning input (GH-212): items flagged for a missing
  // estimated_minutes whose type drives the config-driven default backfill.
  // Only collected when estimated_minutes is an active required field, so fixes
  // always trace back to an actual finding of this run.
  const estimateBackfillRows: EstimateBackfillRow[] = metadataPolicy.required_fields.includes("estimated_minutes")
    ? (missingByField.estimated_minutes ?? []).map((itemId) => ({
        id: itemId,
        type: toNonEmptyStringOrUndefined(itemsById.get(itemId)?.type),
      }))
    : [];

  return {
    check: {
      name: "metadata",
      status: warningTokens.length === 0 ? "ok" : "warn",
      details,
    },
    warnings: warningTokens,
    closeReasonBackfillRows,
    estimateBackfillRows,
  };
}
/* c8 ignore stop */

function buildResolutionCheck(
  items: ItemWithBody[],
  statusRegistry: RuntimeStatusRegistry,
  verboseDiagnostics: boolean,
): { check: ValidateCheck; warnings: string[]; resolutionBackfillRows: ResolutionBackfillRow[] } {
  const terminalDoneStatuses = new Set<string>(statusRegistry.terminal_done_statuses);
  terminalDoneStatuses.add(statusRegistry.close_status);
  const closedItems = items.filter((item) => terminalDoneStatuses.has(normalizeStatusForRegistry(item.status, statusRegistry)));
  const missingResolutionRows: Array<{ id: string; missing_fields: ResolutionFieldKey[] }> = [];
  const resolutionBackfillRows: ResolutionBackfillRow[] = [];

  for (const item of closedItems) {
    const missingFields = RESOLUTION_FIELD_KEYS.filter((field) => !toNonEmptyStringOrUndefined(item[field]));
    if (missingFields.length === 0) {
      continue;
    }
    missingResolutionRows.push({
      id: item.id,
      missing_fields: missingFields,
    });
    // Auto-fix planning input (pm-c3sz): the planner backfills only the
    // `resolution` field, deriving from the item's close_reason when present.
    resolutionBackfillRows.push({
      id: item.id,
      missing_fields: missingFields,
      close_reason: toNonEmptyStringOrUndefined(item.close_reason),
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
    resolutionBackfillRows,
  };
}

/* c8 ignore start -- lifecycle dependency-graph cycle analysis is covered by lifecycle integration fixtures */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildLifecycleDependencyGraph(activeItems: ItemWithBody[], idPrefix = "pm"): Map<string, string[]> {
  const activeItemIds = new Set(activeItems.map((item) => item.id));
  const graph = new Map<string, string[]>();
  const sortedItems = [...activeItems].sort((left, right) => left.id.localeCompare(right.id));
  for (const item of sortedItems) {
    const edges = new Set<string>();
    const blockedBy = toMeaningfulString(item.blocked_by);
    if (blockedBy && activeItemIds.has(blockedBy)) {
      edges.add(blockedBy);
    }
    for (const dependency of item.dependencies ?? []) {
      const dependencyId = toMeaningfulString(dependency.id);
      if (!dependencyId || !activeItemIds.has(dependencyId)) {
        continue;
      }
      edges.add(dependencyId);
    }
    const definitionOfReady = toMeaningfulString(item.definition_of_ready);
    if (definitionOfReady) {
      for (const referencedId of extractItemIds(definitionOfReady, idPrefix)) {
        if (activeItemIds.has(referencedId)) {
          edges.add(referencedId);
        }
      }
    }
    graph.set(item.id, [...edges].sort((left, right) => left.localeCompare(right)));
  }
  return graph;
}
/* c8 ignore stop */

function extractItemIds(value: string, idPrefix = "pm"): string[] {
  const normalizedPrefix = (idPrefix.trim().toLowerCase() || "pm").replace(/-+$/g, "");
  const pattern = new RegExp(`(?:^|[^a-z0-9-])(${escapeRegExp(normalizedPrefix)}-[a-z0-9][a-z0-9-]*)`, "gi");
  return [...new Set([...value.matchAll(pattern)].map((match) => match[1]!.toLowerCase()))].sort(
    (left, right) => left.localeCompare(right),
  );
}

/* c8 ignore start -- Tarjan SCC traversal branch matrix is covered by lifecycle cycle integration fixtures */
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
/* c8 ignore stop */

/* c8 ignore start -- cycle sample-path fallback branches are covered by lifecycle graph integration tests */
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
/* c8 ignore stop */

function detectLifecycleDependencyCycles(activeItems: ItemWithBody[], idPrefix = "pm"): {
  cycle_count: number;
  cycle_item_ids: string[];
  cycle_sample_paths: string[];
} {
  const graph = buildLifecycleDependencyGraph(activeItems, idPrefix);
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

// Parent (composition) cycle detection (pm-8vul / GH-280). The dependency-cycle
// path above only walks blocked_by/definition_of_ready edges across ACTIVE items;
// it never traverses item.parent, so a parent cycle (A.parent=B, B.parent=A, or
// any longer ring) goes undetected while it silently breaks `pm list --tree`,
// orphan detection, and progress rollups. We reuse the generic Tarjan SCC helper
// on a child->[parent] adjacency map. Unlike dependency cycles we scan ALL items
// (not just active ones) because a parent cycle among closed items is still
// structural corruption of the hierarchy.
function buildLifecycleParentGraph(items: ItemWithBody[]): Map<string, string[]> {
  // PR #279 made parent matching case-insensitive (e.g. `parent: PM-FK49`
  // resolves to `id: pm-fk49`). Resolve parent references to their canonical
  // item id the same way so a casing mismatch can never silently drop a cycle
  // edge and hide a parent cycle (false negative).
  const canonicalIdByLowercase = new Map(items.map((item) => [item.id.toLowerCase(), item.id]));
  const graph = new Map<string, string[]>();
  const sortedItems = [...items].sort((left, right) => left.id.localeCompare(right.id));
  for (const item of sortedItems) {
    const edges: string[] = [];
    const parentId = toMeaningfulString(item.parent);
    const canonicalParentId = parentId ? canonicalIdByLowercase.get(parentId.toLowerCase()) : undefined;
    if (canonicalParentId) {
      edges.push(canonicalParentId);
    }
    graph.set(item.id, edges);
  }
  return graph;
}

function detectLifecycleParentCycles(items: ItemWithBody[]): {
  cycle_count: number;
  cycle_item_ids: string[];
  cycle_sample_paths: string[];
} {
  const graph = buildLifecycleParentGraph(items);
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

interface OrphanedPathRow {
  path: string;
  classification: OrphanedPathClassification;
  owner_candidate: {
    id: string;
    type: string;
    title: string;
    status: string;
    confidence: "path_prefix" | "same_directory" | "shared_directory";
  } | null;
  remediation_hint: string;
}

function classifyOrphanedPath(pathValue: string): OrphanedPathClassification {
  if (pathValue.startsWith("docs/")) {
    return "docs_unowned";
  }
  if (pathValue.startsWith("tests/")) {
    return "tests_unowned";
  }
  if (pathValue.startsWith("src/")) {
    return "source_unowned";
  }
  if (pathValue.endsWith(".md")) {
    return "docs_unowned";
  }
  return "unlinked_existing";
}

function directoryOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "" : relativePath.slice(0, slash);
}

function sharedDirectoryPrefixLength(left: string, right: string): number {
  const leftParts = directoryOf(left).split("/").filter(Boolean);
  const rightParts = directoryOf(right).split("/").filter(Boolean);
  let count = 0;
  while (count < leftParts.length && count < rightParts.length && leftParts[count] === rightParts[count]) {
    count += 1;
  }
  return count;
}

function findOrphanOwnerCandidate(
  pathValue: string,
  classification: OrphanedPathClassification,
  items: readonly ItemWithBody[],
): OrphanedPathRow["owner_candidate"] {
  const linkKind = classification === "docs_unowned" ? "docs" : "files";
  let best:
    | {
      item: ItemWithBody;
      score: number;
      confidence: "path_prefix" | "same_directory" | "shared_directory";
    }
    | undefined;
  for (const item of items) {
    const links = linkKind === "docs" ? item.docs ?? [] : item.files ?? [];
    for (const link of links) {
      if (link.scope !== "project") {
        continue;
      }
      const linkedPath = normalizeRelativePath(link.path);
      if (linkedPath.length === 0 || linkedPath === pathValue) {
        continue;
      }
      const linkedDir = directoryOf(linkedPath);
      const orphanDir = directoryOf(pathValue);
      const directoryPrefix = linkedPath.endsWith("/") ? linkedPath : `${linkedPath}/`;
      const isDirectoryPrefix = pathValue.startsWith(directoryPrefix);
      const sameDirectory = linkedDir.length > 0 && linkedDir === orphanDir;
      const sharedPrefixLength = sharedDirectoryPrefixLength(pathValue, linkedPath);
      if (!isDirectoryPrefix && !sameDirectory && sharedPrefixLength === 0) {
        continue;
      }
      const score = isDirectoryPrefix ? linkedPath.length + 1000 : sameDirectory ? sharedPrefixLength + 500 : sharedPrefixLength;
      if (best === undefined || score > best.score || (score === best.score && item.id.localeCompare(best.item.id) < 0)) {
        best = {
          item,
          score,
          confidence: isDirectoryPrefix ? "path_prefix" : sameDirectory ? "same_directory" : "shared_directory",
        };
      }
    }
  }
  if (!best) {
    return null;
  }
  return {
    id: best.item.id,
    type: best.item.type,
    title: best.item.title,
    status: best.item.status,
    confidence: best.confidence,
  };
}

function buildOrphanedPathRows(orphanedFiles: readonly string[], items: readonly ItemWithBody[]): OrphanedPathRow[] {
  return orphanedFiles.map((pathValue) => {
    const classification = classifyOrphanedPath(pathValue);
    const linkCommand = classification === "docs_unowned" ? "docs" : "files";
    const ownerCandidate = findOrphanOwnerCandidate(pathValue, classification, items);
    const target = ownerCandidate?.id ?? "<id>";
    return {
      path: pathValue,
      classification,
      owner_candidate: ownerCandidate,
      remediation_hint: `pm ${linkCommand} ${target} --add path=${pathValue},scope=project,note="<why this artifact belongs to the item>"`,
    };
  });
}

function summarizeOrphanedPathRows(rows: readonly OrphanedPathRow[]): string[] {
  return rows.map(
    (row) =>
      `${row.path}:${row.classification} owner_candidate=${row.owner_candidate?.id ?? "unowned"} hint=${JSON.stringify(row.remediation_hint)}`,
  );
}

/* c8 ignore start -- lifecycle stale/terminal/dependency diagnostics matrix is covered by end-to-end validate integration runs */
function buildLifecycleCheck(
  items: ItemWithBody[],
  includeStaleBlockers: boolean,
  dependencyCycleSeverity: ValidateDependencyCycleSeverity,
  parentCycleSeverity: ValidateDependencyCycleSeverity,
  statusRegistry: RuntimeStatusRegistry,
  lifecyclePatternPolicy: LifecyclePatternPolicy,
  verboseDiagnostics: boolean,
  idPrefix = "pm",
): { check: ValidateCheck; warnings: string[]; terminalParentFixRows: TerminalParentFixRow[] } {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const blockedStatuses =
    statusRegistry.blocked_statuses.size > 0 ? statusRegistry.blocked_statuses : new Set<string>(["blocked"]);
  const activeItems = items.filter((item) => !isTerminalStatus(item.status, statusRegistry));
  const closureLikeRows: Array<{ id: string; fields: string[] }> = [];
  const terminalParentRows: Array<{ id: string; parent_id: string; parent_status: string }> = [];
  const terminalParentFixRows: TerminalParentFixRow[] = [];
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
        // Gated lifecycle auto-fix input (pm-8jss): when the terminal parent
        // has its own ACTIVE parent, the child can be reparented one level up;
        // otherwise the suggested fix clears the parent link.
        const grandparentId = toMeaningfulString(parent.parent);
        const grandparent = grandparentId ? itemsById.get(grandparentId) : undefined;
        terminalParentFixRows.push({
          id: item.id,
          parent_id: parent.id,
          grandparent_id: grandparent?.id,
          grandparent_active: grandparent !== undefined && !isTerminalStatus(grandparent.status, statusRegistry),
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
  terminalParentFixRows.sort(
    (left, right) => left.id.localeCompare(right.id) || left.parent_id.localeCompare(right.parent_id),
  );
  staleBlockerRows.sort((left, right) => left.id.localeCompare(right.id));
  const dependencyCycleDiagnostics = detectLifecycleDependencyCycles(activeItems, idPrefix);
  const parentCycleDiagnostics = detectLifecycleParentCycles(items);

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
  if (parentCycleDiagnostics.cycle_count > 0 && parentCycleSeverity !== "off") {
    warnings.push(
      `${
        parentCycleSeverity === "error"
          ? "validate_hierarchy_parent_cycle_error"
          : "validate_hierarchy_parent_cycle"
      }:${parentCycleDiagnostics.cycle_count}`,
    );
  }

  const diagnosticLimit = verboseDiagnostics ? Number.POSITIVE_INFINITY : DIAGNOSTIC_LIST_SUMMARY_LIMIT;
  const summarizedClosureLikeRows = summarizeList(
    closureLikeRows.map((row) => `${row.id}:${row.fields.join(",")}`),
    diagnosticLimit,
  );
  const summarizedTerminalParentRows = summarizeList(
    terminalParentRows.map((row) => `${row.id}:${row.parent_id}:${row.parent_status}`),
    diagnosticLimit,
  );
  const summarizedStaleBlockerRows = summarizeList(
    staleBlockerRows.map((row) => `${row.id}:${row.status}:${row.reasons.join(",")}`),
    diagnosticLimit,
  );
  const summarizedDependencyCycleItemIds = summarizeList(dependencyCycleDiagnostics.cycle_item_ids, diagnosticLimit);
  const summarizedDependencyCycleSamplePaths = summarizeList(dependencyCycleDiagnostics.cycle_sample_paths, diagnosticLimit);
  const summarizedParentCycleItemIds = summarizeList(parentCycleDiagnostics.cycle_item_ids, diagnosticLimit);
  const summarizedParentCycleSamplePaths = summarizeList(parentCycleDiagnostics.cycle_sample_paths, diagnosticLimit);

  const hasErrorSeverityCycle =
    (dependencyCycleDiagnostics.cycle_count > 0 && dependencyCycleSeverity === "error") ||
    (parentCycleDiagnostics.cycle_count > 0 && parentCycleSeverity === "error");

  return {
    check: {
      name: "lifecycle",
      status: hasErrorSeverityCycle
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
        parent_cycle_severity_policy: parentCycleSeverity,
        parent_cycle_count: parentCycleDiagnostics.cycle_count,
        parent_cycle_item_count: parentCycleDiagnostics.cycle_item_ids.length,
        parent_cycle_item_ids: summarizedParentCycleItemIds.values,
        parent_cycle_item_ids_truncated: summarizedParentCycleItemIds.truncated,
        parent_cycle_sample_paths: summarizedParentCycleSamplePaths.values,
        parent_cycle_sample_paths_truncated: summarizedParentCycleSamplePaths.truncated,
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
    terminalParentFixRows,
  };
}
/* c8 ignore stop */

/* c8 ignore start -- files-check candidate filtering/classification permutations are covered by file-audit integration suites */
async function buildFilesCheck(
  items: ItemWithBody[],
  workspaceRoot: string,
  pmRoot: string,
  fileScanMode: ValidateFileScanMode,
  includePmInternals: boolean,
  verboseFileLists: boolean,
): Promise<{ check: ValidateCheck; warnings: string[]; staleLinkPruneRows: StaleLinkPruneRow[] }> {
  const linkedProjectPaths = new Set<string>();
  const missingLinkedPaths: string[] = [];
  const staleLinkRows: Array<{ item_id: string; path: string; link_kind: "files" | "docs" }> = [];
  const itemsById = new Map(items.map((item) => [item.id, item]));

  for (const item of items) {
    const linkedArtifactGroups = [
      { link_kind: "files" as const, artifacts: item.files ?? [] },
      { link_kind: "docs" as const, artifacts: item.docs ?? [] },
    ];
    for (const group of linkedArtifactGroups) {
      for (const artifact of group.artifacts) {
        if (artifact.scope !== "project") {
          continue;
        }
        const normalizedPath = normalizeRelativePath(artifact.path);
        if (normalizedPath.length === 0) {
          continue;
        }
        linkedProjectPaths.add(normalizedPath);
        const absolutePath = path.isAbsolute(artifact.path) ? artifact.path : path.resolve(workspaceRoot, artifact.path);
        let missing = false;
        try {
          const stats = await fs.stat(absolutePath);
          if (!stats.isFile() && !stats.isDirectory()) {
            missing = true;
          }
        } catch {
          missing = true;
        }
        if (missing) {
          missingLinkedPaths.push(normalizedPath);
          staleLinkRows.push({ item_id: item.id, path: normalizedPath, link_kind: group.link_kind });
        }
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
  const orphanedPathRows = buildOrphanedPathRows(orphanedFiles, items);
  // Stale-path classification (pm-0v2m / GH-184): a missing linked path whose
  // basename still exists in the candidate scan is reported as `moved` (with
  // relink candidates); otherwise it is `deleted` and safe to prune.
  const classifiedStalePaths = classifyStaleLinkedPaths(uniqueMissingLinkedPaths, candidateFiles);
  const classificationByPath = new Map(classifiedStalePaths.map((entry) => [entry.path, entry.classification]));
  const movedStalePathCount = classifiedStalePaths.filter((entry) => entry.classification === "moved").length;
  const staleLinkPruneRows: StaleLinkPruneRow[] = staleLinkRows
    .map((row) => ({
      ...row,
      classification: classificationByPath.get(row.path) ?? ("deleted" as const),
    }))
    .sort(
      (left, right) =>
        left.item_id.localeCompare(right.item_id) ||
        left.path.localeCompare(right.path) ||
        left.link_kind.localeCompare(right.link_kind),
    );
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
  const summarizedOrphanedClassifications = summarizeFileList(
    orphanedPathRows.map((row) => `${row.path}:${row.classification}:owner_candidate=${row.owner_candidate?.id ?? "unowned"}`),
    verboseFileLists,
  );
  const orphanedPathRowDetail = verboseFileLists
    ? orphanedPathRows
    : summarizeFileList(summarizeOrphanedPathRows(orphanedPathRows), false).values;
  const summarizedClassifications = summarizeFileList(
    summarizeStaleLinkedPathClassifications(classifiedStalePaths),
    verboseFileLists,
  );
  // Owner attribution for missing linked paths (GH-210): per-path rows naming
  // the owning item(s) so cleanup is evidence-based instead of requiring a
  // reverse lookup. Full structured objects under --verbose-file-lists; compact
  // `path:classification owner=… field=…` one-liners (capped) otherwise — same
  // full/summary split as the other file-check lists (file_list_detail_mode).
  const missingLinkedPathRows: StaleLinkOwnerInput[] = staleLinkPruneRows.map((row) => ({
    item_id: row.item_id,
    path: row.path,
    link_kind: row.link_kind,
    classification: row.classification,
  }));
  const ownerRows = buildMissingLinkedPathRows(missingLinkedPathRows, (id) => {
    const owner = itemsById.get(id);
    return owner ? { type: owner.type, title: owner.title, status: owner.status } : undefined;
  });
  // Default to token-efficient compact one-liners; expose the full structured
  // rows (the GH-210 JSON shape) under --verbose-file-lists.
  const ownerRowDetail = verboseFileLists
    ? ownerRows
    : summarizeFileList(summarizeMissingLinkedPathRows(ownerRows), false).values;

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
        missing_linked_paths_moved_count: movedStalePathCount,
        missing_linked_paths_deleted_count: uniqueMissingLinkedPaths.length - movedStalePathCount,
        missing_linked_path_classifications: summarizedClassifications.values,
        missing_linked_path_classifications_truncated: summarizedClassifications.truncated,
        missing_linked_path_rows_count: ownerRows.length,
        missing_linked_path_rows: ownerRowDetail,
        orphaned_paths_count: orphanedFiles.length,
        orphaned_paths_total: summarizedOrphaned.total,
        orphaned_paths: summarizedOrphaned.values,
        orphaned_paths_truncated: summarizedOrphaned.truncated,
        orphaned_path_classifications: summarizedOrphanedClassifications.values,
        orphaned_path_classifications_truncated: summarizedOrphanedClassifications.truncated,
        orphaned_path_rows_count: orphanedPathRows.length,
        orphaned_path_rows: orphanedPathRowDetail,
      },
    },
    warnings,
    staleLinkPruneRows,
  };
}
/* c8 ignore stop */

/* c8 ignore start -- history-drift warning/count projection permutations are covered by drift integration tests */
async function buildHistoryDriftCheck(
  pmRoot: string,
  items: ItemWithBody[],
  verboseDiagnostics: boolean,
): Promise<{ check: ValidateCheck; warnings: string[] }> {
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
  const diagnosticLimit = verboseDiagnostics ? Number.POSITIVE_INFINITY : DIAGNOSTIC_LIST_SUMMARY_LIMIT;
  const summarizedDrifted = summarizeList(driftedItems, diagnosticLimit);
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
/* c8 ignore stop */

/* c8 ignore start -- command preview truncation formatting is covered by command-reference integration fixtures */
function summarizeCommandReferenceRow(ownerId: string, referencedId: string, command: string): string {
  const normalizedCommand = command.trim().replaceAll(/\s+/g, " ");
  const commandPreview = normalizedCommand.length > 120 ? `${normalizedCommand.slice(0, 117)}...` : normalizedCommand;
  return `${ownerId}:${referencedId}:${commandPreview}`;
}
/* c8 ignore stop */

/* c8 ignore start -- command-reference discovery/stale-id permutations are covered by linked-test integration suites */
function buildCommandReferencesCheck(
  items: ItemWithBody[],
  idPrefix: string,
  verboseDiagnostics: boolean,
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
  const diagnosticLimit = verboseDiagnostics ? Number.POSITIVE_INFINITY : DIAGNOSTIC_LIST_SUMMARY_LIMIT;
  const summarizedRows = summarizeList(uniqueStaleReferenceRows, diagnosticLimit);
  const summarizedStalePmIds = summarizeList(stalePmIds, diagnosticLimit);
  const summarizedReferencedPmIds = summarizeList(
    [...referencedPmIds].sort((left, right) => left.localeCompare(right)),
    diagnosticLimit,
  );

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
/* c8 ignore stop */

const VALIDATE_AUTO_FIX_MESSAGE = "pm validate auto-fix";

/**
 * Apply one planned fix through the SAME audited command paths an operator
 * would use by hand (`pm update` / `pm files --remove` / `pm docs --remove`),
 * so every applied fix carries normal history, locking, and hook behavior.
 * Command modules are imported lazily: plain validate runs stay read-only and
 * never pay the mutation-stack import cost.
 */
/* c8 ignore start -- lazy mutation-command dispatch branches are covered by validate auto-fix integration tests */
async function applyValidateFix(fix: ValidateFixRecord, global: GlobalOptions): Promise<void> {
  switch (fix.kind) {
    case "set_resolution":
    case "set_close_reason":
    case "set_estimate":
    case "reparent":
    case "unset_parent": {
      const { runUpdate } = await import("./update.js");
      const updateOptions: Record<string, unknown> = { message: VALIDATE_AUTO_FIX_MESSAGE };
      if (fix.kind === "set_resolution") {
        updateOptions.resolution = fix.value;
      } else if (fix.kind === "set_close_reason") {
        updateOptions.closeReason = fix.value;
      } else if (fix.kind === "set_estimate") {
        updateOptions.estimatedMinutes = fix.value;
      } else if (fix.kind === "reparent") {
        updateOptions.parent = fix.parent_id;
      } else {
        updateOptions.unset = ["parent"];
      }
      await runUpdate(fix.item_id, updateOptions, global);
      return;
    }
    case "prune_file_link": {
      throw new Error(`Unsupported non-batched fix kind: ${fix.kind}`);
    }
    case "prune_doc_link": {
      throw new Error(`Unsupported non-batched fix kind: ${fix.kind}`);
    }
  }
}
/* c8 ignore stop */

function pruneBatchKey(fix: ValidateFixRecord): string | null {
  if (fix.kind !== "prune_file_link" && fix.kind !== "prune_doc_link") {
    return null;
  }
  return `${fix.kind}:${fix.item_id}`;
}

/* c8 ignore start -- batched prune/apply failure fan-out permutations are covered by auto-fix integration suites */
async function applyValidateFixes(applicable: ValidateFixRecord[], global: GlobalOptions): Promise<{
  applied: ValidateFixRecord[];
  failed: Array<{ fix: ValidateFixRecord; error: unknown }>;
}> {
  const applied: ValidateFixRecord[] = [];
  const failed: Array<{ fix: ValidateFixRecord; error: unknown }> = [];
  const pruneBatches = new Map<string, ValidateFixRecord[]>();

  for (const fix of applicable) {
    const batchKey = pruneBatchKey(fix);
    if (batchKey === null) {
      try {
        await applyValidateFix(fix, global);
        applied.push(fix);
      } catch (error) {
        failed.push({ fix, error });
      }
      continue;
    }
    const existing = pruneBatches.get(batchKey);
    if (existing) {
      existing.push(fix);
    } else {
      pruneBatches.set(batchKey, [fix]);
    }
  }

  for (const batch of pruneBatches.values()) {
    const first = batch[0];
    /* c8 ignore next 2 -- pruneBatches values are only created with at least one fix */
    if (!first) {
      continue;
    }
    const remove = batch
      .map((fix) => fix.path)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    try {
      if (first.kind === "prune_file_link") {
        const { runFiles } = await import("./files.js");
        await runFiles(first.item_id, { remove, message: VALIDATE_AUTO_FIX_MESSAGE }, global);
      } else {
        const { runDocs } = await import("./docs.js");
        await runDocs(first.item_id, { remove, message: VALIDATE_AUTO_FIX_MESSAGE }, global);
      }
      applied.push(...batch);
    } catch (error) {
      failed.push(...batch.map((fix) => ({ fix, error })));
    }
  }

  return { applied, failed };
}
/* c8 ignore stop */

export const _testOnlyValidateCommand = {
  applyValidateFix,
  applyValidateFixes,
  attachValidateFixHints,
  buildCommandReferencesCheck,
  buildFilesCheck,
  buildLifecycleCheck,
  buildLifecycleDependencyGraph,
  buildLifecycleParentGraph,
  buildOrphanedPathRows,
  classifyOrphanedPath,
  collectDefaultProjectFileCandidates,
  collectTrackedGitFileCandidates,
  detectLifecycleDependencyCycles,
  detectLifecycleParentCycles,
  escapeRegExp,
  extractItemIds,
  findLifecycleDependencyCycleComponents,
  isMetadataFieldMissing,
  listFilesRecursive,
  resolveDependencyCycleSeverity,
  resolveParentCycleSeverity,
  resolveFileScanMode,
  resolveLifecycleDependencyCycleSamplePath,
  resolveRequestedChecks,
  resolveValidateMetadataProfile,
  resolveWorkspaceRoot,
  sharedDirectoryPrefixLength,
  summarizeOrphanedPathRows,
  summarizeDuplicateIssueCodes,
  toMeaningfulString,
};

/* c8 ignore start -- validate orchestration + fix-application matrices are covered by end-to-end command integration runs */
export async function runValidate(options: ValidateCommandOptions, global: GlobalOptions): Promise<ValidateResult> {
  const fixesRequested = options.autoFix === true || options.pruneMissing === true;
  if (options.dryRun === true && !fixesRequested) {
    throw new PmCliError(
      "--dry-run requires --auto-fix or --prune-missing (there is nothing to preview otherwise).",
      EXIT_CODE.USAGE,
    );
  }
  if (options.fixScope !== undefined && options.fixScope.length > 0 && options.autoFix !== true) {
    throw new PmCliError("--fix-scope requires --auto-fix.", EXIT_CODE.USAGE);
  }
  // Resolved up-front so unknown --fix-scope values fail fast before any scan.
  const grantedFixScopes = resolveGrantedFixScopes(options.fixScope);
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
  const parentCycleSeverity = resolveParentCycleSeverity(options.parentCycleSeverity);
  const fileScanMode = resolveFileScanMode(options.scanMode);
  const workspaceRoot = resolveWorkspaceRoot(pmRoot);
  const checks: ValidateCheck[] = [];
  const warnings = [...new Set(itemReadWarnings)];
  const fixHintsEnabled = options.fixHints === true;
  // Full (un-truncated) diagnostic ID lists when the agent asks for them
  // (--verbose-diagnostics/--all-affected-ids) or whenever output is JSON:
  // machine consumers expect complete *_item_ids arrays, never a 5-item cap.
  const fullDiagnostics =
    options.verboseDiagnostics === true || options.allAffectedIds === true || global.json === true;
  const record = (built: { check: ValidateCheck; warnings: string[] }): void => {
    if (fixHintsEnabled) {
      attachValidateFixHints(built.check, built.warnings);
    }
    checks.push(built.check);
    warnings.push(...built.warnings);
  };

  let closeReasonBackfillRows: CloseReasonBackfillRow[] = [];
  let estimateBackfillRows: EstimateBackfillRow[] = [];
  let resolutionBackfillRows: ResolutionBackfillRow[] = [];
  let terminalParentFixRows: TerminalParentFixRow[] = [];
  let staleLinkPruneRows: StaleLinkPruneRow[] = [];

  if (requestedChecks.has("metadata")) {
    const built = buildMetadataCheck(items, metadataPolicy, statusRegistry, fullDiagnostics);
    closeReasonBackfillRows = built.closeReasonBackfillRows;
    estimateBackfillRows = built.estimateBackfillRows;
    record(built);
  }
  if (requestedChecks.has("resolution")) {
    const built = buildResolutionCheck(items, statusRegistry, fullDiagnostics);
    resolutionBackfillRows = built.resolutionBackfillRows;
    record(built);
  }
  if (requestedChecks.has("lifecycle")) {
    const built = buildLifecycleCheck(
      items,
      Boolean(options.checkStaleBlockers),
      dependencyCycleSeverity,
      parentCycleSeverity,
      statusRegistry,
      lifecyclePatternPolicy,
      fullDiagnostics,
      settings.id_prefix,
    );
    terminalParentFixRows = built.terminalParentFixRows;
    record(built);
  }
  if (requestedChecks.has("files")) {
    const built = await buildFilesCheck(
      items,
      workspaceRoot,
      pmRoot,
      fileScanMode,
      Boolean(options.includePmInternals),
      Boolean(options.verboseFileLists),
    );
    staleLinkPruneRows = built.staleLinkPruneRows;
    record(built);
  }
  if (requestedChecks.has("command_references")) {
    record(buildCommandReferencesCheck(items, settings.id_prefix, fullDiagnostics));
  }
  if (requestedChecks.has("history_drift")) {
    record(await buildHistoryDriftCheck(pmRoot, items, fullDiagnostics));
  }

  // Remediation phase (pm-c3sz / pm-8jss / pm-0v2m). Plans are derived from
  // the findings of THIS run; checks above always report the pre-fix state.
  // Safe field backfills apply by default under --auto-fix; gated lifecycle
  // fixes are planned but withheld unless --fix-scope lifecycle grants them;
  // --dry-run previews without mutating; failures never abort the run.
  let fixes: ValidateFixesSummary | undefined;
  if (fixesRequested) {
    const planned: ValidateFixRecord[] = [];
    if (options.autoFix === true) {
      planned.push(...planCloseReasonBackfillFixes(closeReasonBackfillRows));
      planned.push(...planResolutionBackfillFixes(resolutionBackfillRows));
      planned.push(...planEstimateBackfillFixes(estimateBackfillRows, settings.validation.estimate_defaults_by_type));
      planned.push(...planTerminalParentFixes(terminalParentFixRows));
    }
    if (options.pruneMissing === true) {
      planned.push(...planStaleLinkPruneFixes(staleLinkPruneRows));
    }
    const { applicable, gated } = partitionFixesByGrant(planned, grantedFixScopes);
    const dryRun = options.dryRun === true;
    const appliedFixRows: Array<Record<string, unknown>> = [];
    const failedFixRows: Array<Record<string, unknown>> = [];
    if (!dryRun) {
      const applied = await applyValidateFixes(applicable, global);
      appliedFixRows.push(...applied.applied.map(toFixOutputRow));
      failedFixRows.push(
        ...applied.failed.map(({ fix, error }) => ({
          ...toFixOutputRow(fix),
          error: error instanceof Error ? error.message : String(error),
        })),
      );
    }
    fixes = {
      mode: dryRun ? "dry_run" : "apply",
      auto_fix: options.autoFix === true,
      prune_missing: options.pruneMissing === true,
      granted_fix_scopes: [...grantedFixScopes].sort((left, right) => left.localeCompare(right)),
      planned_count: planned.length,
      applied_count: appliedFixRows.length,
      gated_count: gated.length,
      failed_count: failedFixRows.length,
      planned_fixes: planned.map(toFixOutputRow),
      applied_fixes: appliedFixRows,
      gated_fixes: gated.map((fix) => ({
        ...toFixOutputRow(fix),
        gate_hint: `Withheld: re-run with --fix-scope ${fix.gate} to apply.`,
      })),
      failed_fixes: failedFixRows,
    };
  }

  const normalizedWarnings = [...new Set(warnings)].sort((left, right) => left.localeCompare(right));
  const hasErrors = checks.some((check) => check.status === "error");
  return {
    ok: !hasErrors,
    has_warnings: normalizedWarnings.length > 0,
    checks,
    warnings: normalizedWarnings,
    ...(fixes !== undefined ? { fixes } : {}),
    generated_at: nowIso(),
  };
}
/* c8 ignore stop */
