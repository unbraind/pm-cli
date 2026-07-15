/**
 * @module sdk/governance/validate
 *
 * Implements the pm validate command surface and its agent-facing runtime behavior.
 */
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
import {
  resolveRuntimeStatusRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
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
import {
  CURRENT_ITEM_FORMAT_VERSION,
  effectiveItemFormatVersion,
  scanItemFormatVersions,
} from "../../core/item/item-format-version.js";
import { listAllItemMetadataWithBody } from "../../core/store/item-store.js";
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
  type ValidateFixScope,
  type ValidateFixRecord,
} from "../../core/validate/fix-planning.js";
import {
  findDuplicateIssueCodes,
  type DuplicateIssueCode,
} from "../../core/governance/issue-codes.js";
import {
  buildMissingByTypeCounts,
  type MissingFieldOccurrence,
} from "../../core/validate/missing-by-type.js";
import {
  classifyStaleLinkedPaths,
  summarizeStaleLinkedPathClassifications,
} from "../../core/validate/stale-file-classification.js";
import { isRemoteLinkedArtifactReference } from "../../core/validate/linked-artifact-reference.js";
import {
  buildMissingLinkedPathRows,
  summarizeMissingLinkedPathRows,
  type StaleLinkOwnerInput,
} from "../../core/validate/missing-link-owners.js";
import type {
  ValidateMetadataProfile,
  ValidateMetadataRequiredField,
} from "../../types/index.js";
import { collectDanglingDependencyReferences } from "../dependencies.js";
import { scanHistoryAuthorAttribution } from "../author-attribution.js";
import {
  createRelationshipKindRegistry,
  type RelationshipKindRegistry,
} from "../relationships.js";
import { runDocs } from "../docs.js";
import { runFiles } from "../files.js";
import { extractReferencedPmItemIdsFromCommand } from "../test/linked-command-detection.js";

type ValidateCheckName =
  | "metadata"
  | "resolution"
  | "lifecycle"
  | "dependency_references"
  | "files"
  | "command_references"
  | "history_drift"
  | "format_version";
type ValidateStatus = "ok" | "warn" | "error";
type ValidateDependencyCycleSeverity = "off" | "warn" | "error";
type ValidateFileScanMode = "default" | "tracked-all" | "tracked-all-strict";
type ItemWithBody = Awaited<
  ReturnType<typeof listAllItemMetadataWithBody>
>[number];
type FileCandidateSource =
  | "default-curated"
  | "tracked-git"
  | "tracked-all-fallback-default";
type OrphanedPathClassification =
  | "docs_unowned"
  | "tests_unowned"
  | "source_unowned"
  | "unlinked_existing";

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
const DIRECTORY_IGNORE_SET = new Set([
  "node_modules",
  ".git",
  ".cursor",
  ".agents",
  "dist",
  "coverage",
]);
const RESOLUTION_FIELD_KEYS = [
  "resolution",
  "expected_result",
  "actual_result",
] as const;
type ResolutionFieldKey = (typeof RESOLUTION_FIELD_KEYS)[number];
const VALIDATE_FILE_SCAN_MODES = [
  "default",
  "tracked-all",
  "tracked-all-strict",
] as const;
const VALIDATE_METADATA_PROFILE_VALUES = ["core", "strict", "custom"] as const;
const VALIDATE_DEPENDENCY_CYCLE_SEVERITY_VALUES = [
  "off",
  "warn",
  "error",
] as const;
const LIFECYCLE_PATTERN_FIELD_KEYS = [
  "blocked_reason",
  "resolution",
  "actual_result",
] as const;
type LifecyclePatternFieldKey = (typeof LIFECYCLE_PATTERN_FIELD_KEYS)[number];
const CORE_METADATA_REQUIRED_FIELDS = [
  "author",
  "acceptance_criteria",
  "estimated_minutes",
  "close_reason",
] as const;
const STRICT_METADATA_REQUIRED_FIELDS = [
  ...CORE_METADATA_REQUIRED_FIELDS,
  "reviewer",
  "risk",
  "confidence",
  "sprint",
  "release",
] as const;
// Keep this deduplicated so future list edits cannot double-count metadata diagnostics.
const SUPPORTED_METADATA_REQUIRED_FIELDS: readonly ValidateMetadataRequiredField[] =
  Array.from(
    new Set<ValidateMetadataRequiredField>(STRICT_METADATA_REQUIRED_FIELDS),
  );
const METADATA_REQUIRED_FIELD_ALIASES: Record<
  string,
  ValidateMetadataRequiredField
> = {
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
const METADATA_WARNING_TOKEN_BY_FIELD: Record<
  ValidateMetadataRequiredField,
  string
> = {
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
const METADATA_COUNT_KEY_BY_FIELD: Record<
  ValidateMetadataRequiredField,
  string
> = {
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
const METADATA_ITEM_IDS_KEY_BY_FIELD: Record<
  ValidateMetadataRequiredField,
  string
> = {
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
const METADATA_TRUNCATED_KEY_BY_FIELD: Record<
  ValidateMetadataRequiredField,
  string
> = {
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
const GIT_LS_FILES_TIMEOUT_MS = 10_000;
const FILE_LIST_SUMMARY_LIMIT = 40;
const DIAGNOSTIC_LIST_SUMMARY_LIMIT = 5;
// Conservative pre-stat guard for common filesystem limits; over-limit links are unreadable, not prune-safe.
const LINKED_ARTIFACT_MAX_PATH_LENGTH = 4096;
const LINKED_ARTIFACT_MAX_SEGMENT_LENGTH = 255;
const execFileAsync = promisify(execFile);

/** Documents the validate command options payload exchanged by command, SDK, and package integrations. */
export interface ValidateCommandOptions {
  /** Value that configures or reports check metadata for this contract. */
  checkMetadata?: boolean;
  /** Value that configures or reports check resolution for this contract. */
  checkResolution?: boolean;
  /** Value that configures or reports check lifecycle for this contract. */
  checkLifecycle?: boolean;
  /** Value that configures or reports check stale blockers for this contract. */
  checkStaleBlockers?: boolean;
  /** Value that configures or reports dependency cycle severity for this contract. */
  dependencyCycleSeverity?: string;
  /** Value that configures or reports parent cycle severity for this contract. */
  parentCycleSeverity?: string;
  /** Value that configures or reports check files for this contract. */
  checkFiles?: boolean;
  /** Value that configures or reports include pm internals for this contract. */
  includePmInternals?: boolean;
  /** Value that configures or reports verbose file lists for this contract. */
  verboseFileLists?: boolean;
  /** Value that configures or reports verbose diagnostics for this contract. */
  verboseDiagnostics?: boolean;
  /** Emit complete *_item_ids diagnostic lists (no 5-item cap); implied by --json. */
  allAffectedIds?: boolean;
  /** Value that configures or reports check history drift for this contract. */
  checkHistoryDrift?: boolean;
  /** Value that configures or reports check command references for this contract. */
  checkCommandReferences?: boolean;
  /** Strategy used to control scan behavior. */
  scanMode?: string;
  /** Value that configures or reports metadata profile for this contract. */
  metadataProfile?: string;
  /** Value that configures or reports fix hints for this contract. */
  fixHints?: boolean;
  /** Value that configures or reports auto fix for this contract. */
  autoFix?: boolean;
  /** Value that configures or reports dry run for this contract. */
  dryRun?: boolean;
  /** Value that configures or reports fix scope for this contract. */
  fixScope?: string[];
  /** Value that configures or reports prune missing for this contract. */
  pruneMissing?: boolean;
}

/** Mutation operations injected when validation is allowed to apply audited fixes. */
export interface ValidateMutationServices {
  /** Apply one update through the host's canonical audited mutation path. */
  runUpdate?: (
    id: string,
    options: Record<string, unknown>,
    global: GlobalOptions,
  ) => Promise<unknown>;
}

/** Documents the validate check payload exchanged by command, SDK, and package integrations. */
export interface ValidateCheck {
  /** Value that configures or reports name for this contract. */
  name: ValidateCheckName;
  /** Lifecycle state reported for status. */
  status: ValidateStatus;
  /** Value that configures or reports details for this contract. */
  details: Record<string, unknown>;
}

/** Documents the validate fixes summary payload exchanged by command, SDK, and package integrations. */
export interface ValidateFixesSummary {
  /** Value that configures or reports mode for this contract. */
  mode: "apply" | "dry_run";
  /** Value that configures or reports auto fix for this contract. */
  auto_fix: boolean;
  /** Value that configures or reports prune missing for this contract. */
  prune_missing: boolean;
  /** Value that configures or reports granted fix scopes for this contract. */
  granted_fix_scopes: string[];
  /** Number of planned entries represented by this result. */
  planned_count: number;
  /** Number of applied entries represented by this result. */
  applied_count: number;
  /** Number of gated entries represented by this result. */
  gated_count: number;
  /** Number of failed entries represented by this result. */
  failed_count: number;
  /** Value that configures or reports planned fixes for this contract. */
  planned_fixes: Array<Record<string, unknown>>;
  /** Value that configures or reports applied fixes for this contract. */
  applied_fixes: Array<Record<string, unknown>>;
  /** Value that configures or reports gated fixes for this contract. */
  gated_fixes: Array<Record<string, unknown>>;
  /** Value that configures or reports failed fixes for this contract. */
  failed_fixes: Array<Record<string, unknown>>;
}

/** Documents the validate result payload exchanged by command, SDK, and package integrations. */
export interface ValidateResult {
  /** Whether the operation completed without a blocking failure. */
  ok: boolean;
  /** Whether warnings applies to this operation. */
  has_warnings: boolean;
  /** Value that configures or reports checks for this contract. */
  checks: ValidateCheck[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Present when --auto-fix or --prune-missing was requested; checks always reflect the PRE-fix state. */
  fixes?: ValidateFixesSummary;
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

function normalizeRelativePath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
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
  if (
    lowered === "none" ||
    lowered === "null" ||
    lowered === "n/a" ||
    lowered === "na"
  ) {
    return undefined;
  }
  return normalized;
}

/* c8 ignore start -- runtime-status alias normalization is covered by status-registry integration tests */
function normalizeStatusForRegistry(
  status: string,
  statusRegistry: RuntimeStatusRegistry,
): string {
  return normalizeStatusInput(status, statusRegistry) ?? status;
}
/* c8 ignore stop */

function isTerminalStatus(
  status: string,
  statusRegistry: RuntimeStatusRegistry,
): boolean {
  return statusRegistry.terminal_statuses.has(
    normalizeStatusForRegistry(status, statusRegistry),
  );
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
  closure_like_metadata_field_patterns: Record<
    LifecyclePatternFieldKey,
    string[]
  >;
  closure_like_metadata_field_pattern_sources: Record<
    LifecyclePatternFieldKey,
    LifecyclePatternSource
  >;
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
function normalizeLifecyclePatternList(
  values: readonly string[] | undefined,
): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function areSortedStringListsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function resolveLifecyclePatternPolicy(
  settings: LifecyclePatternSettingsSource,
): LifecyclePatternPolicy {
  const defaultStalePatterns = normalizeLifecyclePatternList(
    DEFAULT_VALIDATE_STALE_BLOCKER_REASON_PATTERNS,
  );
  const defaultClosureLikePatterns = {
    blocked_reason: normalizeLifecyclePatternList(
      DEFAULT_VALIDATE_CLOSURE_LIKE_METADATA_FIELD_PATTERNS.blocked_reason,
    ),
    resolution: normalizeLifecyclePatternList(
      DEFAULT_VALIDATE_CLOSURE_LIKE_METADATA_FIELD_PATTERNS.resolution,
    ),
    actual_result: normalizeLifecyclePatternList(
      DEFAULT_VALIDATE_CLOSURE_LIKE_METADATA_FIELD_PATTERNS.actual_result,
    ),
  } satisfies Record<LifecyclePatternFieldKey, string[]>;
  const staleBlockerReasonPatterns = normalizeLifecyclePatternList(
    settings.validation.lifecycle_stale_blocker_reason_patterns,
  );
  const closureLikePatterns = {
    blocked_reason: normalizeLifecyclePatternList(
      settings.validation.lifecycle_closure_like_blocked_reason_patterns,
    ),
    resolution: normalizeLifecyclePatternList(
      settings.validation.lifecycle_closure_like_resolution_patterns,
    ),
    actual_result: normalizeLifecyclePatternList(
      settings.validation.lifecycle_closure_like_actual_result_patterns,
    ),
  } satisfies Record<LifecyclePatternFieldKey, string[]>;
  return {
    stale_blocker_reason_patterns: staleBlockerReasonPatterns,
    stale_blocker_reason_pattern_source: areSortedStringListsEqual(
      staleBlockerReasonPatterns,
      defaultStalePatterns,
    )
      ? "default"
      : "settings",
    closure_like_metadata_field_patterns: closureLikePatterns,
    closure_like_metadata_field_pattern_sources: {
      blocked_reason: areSortedStringListsEqual(
        closureLikePatterns.blocked_reason,
        defaultClosureLikePatterns.blocked_reason,
      )
        ? "default"
        : "settings",
      resolution: areSortedStringListsEqual(
        closureLikePatterns.resolution,
        defaultClosureLikePatterns.resolution,
      )
        ? "default"
        : "settings",
      actual_result: areSortedStringListsEqual(
        closureLikePatterns.actual_result,
        defaultClosureLikePatterns.actual_result,
      )
        ? "default"
        : "settings",
    },
  };
}
/* c8 ignore stop */

function resolveValidateMetadataProfile(
  value: string | undefined,
): ValidateMetadataProfile {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized.length === 0) {
    return "core";
  }
  if (
    (VALIDATE_METADATA_PROFILE_VALUES as readonly string[]).includes(normalized)
  ) {
    return normalized as ValidateMetadataProfile;
  }
  throw new PmCliError(
    `Unknown --metadata-profile value "${value}". Supported values: ${VALIDATE_METADATA_PROFILE_VALUES.join(", ")}.`,
    EXIT_CODE.USAGE,
  );
}

function resolveDependencyCycleSeverity(
  value: string | undefined,
): ValidateDependencyCycleSeverity {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized.length === 0) {
    return "warn";
  }
  if (
    (VALIDATE_DEPENDENCY_CYCLE_SEVERITY_VALUES as readonly string[]).includes(
      normalized,
    )
  ) {
    return normalized as ValidateDependencyCycleSeverity;
  }
  throw new PmCliError(
    `Unknown --dependency-cycle-severity value "${value}". Supported values: ${VALIDATE_DEPENDENCY_CYCLE_SEVERITY_VALUES.join(", ")}.`,
    EXIT_CODE.USAGE,
  );
}

function resolveParentCycleSeverity(
  value: string | undefined,
): ValidateDependencyCycleSeverity {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized.length === 0) {
    return "warn";
  }
  if (
    (VALIDATE_DEPENDENCY_CYCLE_SEVERITY_VALUES as readonly string[]).includes(
      normalized,
    )
  ) {
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
  const normalized = [
    ...new Set(
      (values ?? []).map((value) =>
        value.trim().toLowerCase().replaceAll("-", "_"),
      ),
    ),
  ];
  return normalized
    .map((value) => METADATA_REQUIRED_FIELD_ALIASES[value])
    .filter(
      (value): value is ValidateMetadataRequiredField => value !== undefined,
    )
    .sort((left, right) => left.localeCompare(right));
}
/* c8 ignore stop */

function resolveValidateMetadataPolicy(
  profile: ValidateMetadataProfile,
  profileSource: "default" | "settings" | "option",
  configuredCustomFields: readonly ValidateMetadataRequiredField[],
): ValidateMetadataPolicy {
  const normalizedCustomFields = normalizeMetadataRequiredFieldsFromSettings(
    configuredCustomFields,
  );
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

/** Planning fields whose absence is only actionable on live work (GH-276): an agent backfills an estimate or acceptance criteria to plan/execute an item, so flagging them on a terminal (closed/canceled) historical item is pure noise. Under the `strict` profile these are still enforced everywhere for projects that want full historical coverage. */
const TERMINAL_EXEMPT_PLANNING_FIELDS: ReadonlySet<ValidateMetadataRequiredField> =
  new Set(["acceptance_criteria", "estimated_minutes"]);

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
    return (
      normalizeStatusForRegistry(item.status, statusRegistry) ===
        statusRegistry.close_status &&
      !toNonEmptyStringOrUndefined(item.close_reason)
    );
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

function resolveFileScanMode(
  scanMode: string | undefined,
): ValidateFileScanMode {
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
  if (
    normalized === "tracked-all-strict" ||
    normalized === "tracked_all_strict"
  ) {
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
    (!relativeFromPmRoot.startsWith("..") &&
      !path.isAbsolute(relativeFromPmRoot));
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
async function listFilesRecursive(
  basePath: string,
  relativePath: string,
  output: string[],
): Promise<void> {
  const targetDirectory =
    relativePath.length > 0 ? path.join(basePath, relativePath) : basePath;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(targetDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const childRelative =
      relativePath.length > 0
        ? path.join(relativePath, entry.name)
        : entry.name;
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

async function collectDefaultProjectFileCandidates(
  workspaceRoot: string,
): Promise<string[]> {
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
  return [...new Set(discovered)].sort((left, right) =>
    left.localeCompare(right),
  );
}

async function collectTrackedGitFileCandidates(
  workspaceRoot: string,
): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: GIT_LS_FILES_MAX_BUFFER,
      windowsHide: true,
      timeout: GIT_LS_FILES_TIMEOUT_MS,
    });
    const discovered = stdout
      .split("\0")
      .map((value) => normalizeRelativePath(value))
      .filter((value) => value.length > 0);
    return [...new Set(discovered)].sort((left, right) =>
      left.localeCompare(right),
    );
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
function resolvePmInternalCandidatePrefixes(
  pmRoot: string,
  workspaceRoot: string,
): string[] {
  const prefixes = new Set<string>();
  const configuredDefault = normalizeRelativeDirectoryPath(PM_DIRNAME);
  if (configuredDefault.length > 0) {
    prefixes.add(configuredDefault);
  }
  const relativePmRoot = normalizeRelativeDirectoryPath(
    path.relative(workspaceRoot, pmRoot),
  );
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
    const trackedCandidates =
      await collectTrackedGitFileCandidates(workspaceRoot);
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
    const fallbackCandidates =
      await collectDefaultProjectFileCandidates(workspaceRoot);
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

  const defaultCandidates =
    await collectDefaultProjectFileCandidates(workspaceRoot);
  return {
    requestedMode: scanMode,
    appliedMode: "default",
    source: "default-curated",
    candidateFiles: defaultCandidates,
    candidateTotal: defaultCandidates.length,
    candidateScanned: defaultCandidates.length,
  };
}

function summarizeList(
  values: string[],
  limit = DIAGNOSTIC_LIST_SUMMARY_LIMIT,
): { values: string[]; truncated: boolean } {
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

const RESOLUTION_REMEDIATION_FLAG_BY_FIELD: Record<ResolutionFieldKey, string> =
  {
    resolution: "--resolution",
    expected_result: "--expected-result",
    actual_result: "--actual-result",
  };

const RESOLUTION_REMEDIATION_PLACEHOLDER_BY_FIELD: Record<
  ResolutionFieldKey,
  string
> = {
  resolution: "Describe how this item was resolved",
  expected_result: "Describe the expected result",
  actual_result: "Describe the actual result",
};

function buildResolutionRemediationCommand(row: {
  id: string;
  missing_fields: ResolutionFieldKey[];
}): string {
  const fieldArguments = row.missing_fields
    .map(
      (field) =>
        `${RESOLUTION_REMEDIATION_FLAG_BY_FIELD[field]} "${RESOLUTION_REMEDIATION_PLACEHOLDER_BY_FIELD[field]}"`,
    )
    .join(" ");
  return `pm update ${row.id} ${fieldArguments} --message "Backfill resolution metadata"`;
}

/** Attach a uniform, machine-executable `fix_hints` array to a validate check's details when `--fix-hints` is requested. The resolution check's existing per-row remediation commands (which already carry concrete item ids) are aliased in so agents read one uniform field across every check; all other checks derive one generic command per distinct warning code from the shared remediation registry. Generic hints may contain `<id>`/`<field>`/`<path>` placeholders the caller substitutes before running — they are templates, not always directly executable as-is. Read-only: this only enriches the diagnostic output, never mutates any item. */
/* c8 ignore start -- fix-hint projection/truncation combinations are covered by validate output integration tests */
function attachValidateFixHints(
  check: ValidateCheck,
  checkWarnings: string[],
): void {
  const existingResolutionHints =
    check.details?.missing_resolution_remediation_hints;
  const aliasedResolution =
    Array.isArray(existingResolutionHints) &&
    existingResolutionHints.length > 0;
  const fixHints = aliasedResolution
    ? (existingResolutionHints as unknown[]).filter(
        (hint): hint is string => typeof hint === "string",
      )
    : buildRemediationCommands(checkWarnings);
  if (fixHints.length === 0) {
    return;
  }
  // The resolution check truncates its per-row hint list for low-token output;
  // carry that marker onto fix_hints so an agent knows the list is partial and
  // there are more items to repair beyond the ones shown.
  const truncated =
    aliasedResolution &&
    check.details?.missing_resolution_remediation_hints_truncated === true;
  check.details = {
    ...check.details,
    fix_hints: fixHints,
    ...(truncated ? { fix_hints_truncated: true } : {}),
  };
}
/* c8 ignore stop */

function resolveRequestedChecks(
  options: ValidateCommandOptions,
): Set<ValidateCheckName> {
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
      requested.add("format_version");
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

const DUPLICATE_ISSUE_CODE_WARNING_TOKEN =
  "validate_metadata_duplicate_issue_codes";

/** Project the duplicate logical issue-code findings (GH-235) into the metadata-check `details` shape plus an advisory warning token. Duplicate codes are advisory (warn), never an error — matching every other metadata finding — so an otherwise clean tracker that simply reuses a title prefix is not failed by `pm validate`. Kept outside the c8-ignored builder block so the projection/remediation logic is fully covered by unit tests. */
function summarizeDuplicateIssueCodes(
  duplicates: DuplicateIssueCode[],
  verboseDiagnostics: boolean,
): {
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  warnings: string[];
} {
  if (duplicates.length === 0) {
    return { rows: [], truncated: false, warnings: [] };
  }
  const limit = verboseDiagnostics
    ? duplicates.length
    : DIAGNOSTIC_LIST_SUMMARY_LIMIT;
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

function initializeMissingMetadataByField(): Record<
  ValidateMetadataRequiredField,
  string[]
> {
  return Object.fromEntries(
    SUPPORTED_METADATA_REQUIRED_FIELDS.map((field) => [field, [] as string[]]),
  ) as Record<ValidateMetadataRequiredField, string[]>;
}

function collectMissingMetadataByField(
  items: ItemWithBody[],
  statusRegistry: RuntimeStatusRegistry,
  enforcePlanningFieldsOnTerminal: boolean,
): Record<ValidateMetadataRequiredField, string[]> {
  const missingByField = initializeMissingMetadataByField();
  for (const item of items) {
    for (const field of SUPPORTED_METADATA_REQUIRED_FIELDS) {
      if (
        isMetadataFieldMissing(
          item,
          field,
          statusRegistry,
          enforcePlanningFieldsOnTerminal,
        )
      ) {
        missingByField[field].push(item.id);
      }
    }
  }
  return missingByField;
}

function buildMetadataWarningTokens(
  metadataPolicy: ValidateMetadataPolicy,
  missingByField: Record<ValidateMetadataRequiredField, string[]>,
  duplicateWarnings: string[],
): string[] {
  const warningTokens = [...metadataPolicy.warnings];
  for (const field of metadataPolicy.required_fields) {
    const missingItems = missingByField[field];
    if (missingItems.length > 0) {
      warningTokens.push(
        `${METADATA_WARNING_TOKEN_BY_FIELD[field]}:${missingItems.length}`,
      );
    }
  }
  warningTokens.push(...duplicateWarnings);
  return warningTokens;
}

function buildMetadataCounts(
  metadataPolicy: ValidateMetadataPolicy,
  missingByField: Record<ValidateMetadataRequiredField, string[]>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const field of metadataPolicy.required_fields) {
    const missing = missingByField[field];
    const value = missing ? missing.length : 0;
    const countKey = METADATA_COUNT_KEY_BY_FIELD[field];
    if (value > 0 && countKey) {
      counts[countKey] = value;
    }
  }
  return counts;
}

function buildMissingFieldOccurrences(
  metadataPolicy: ValidateMetadataPolicy,
  missingByField: Record<ValidateMetadataRequiredField, string[]>,
  itemsById: Map<string, ItemWithBody>,
): MissingFieldOccurrence[] {
  const occurrences: MissingFieldOccurrence[] = [];
  for (const field of metadataPolicy.required_fields) {
    const missing = missingByField[field];
    if (!missing) {
      continue;
    }
    for (const itemId of missing) {
      const itemType = itemsById.get(itemId)?.type;
      const normalizedItemType =
        typeof itemType === "string" && itemType.length > 0
          ? itemType
          : "Unknown";
      occurrences.push({ item_type: normalizedItemType, field });
    }
  }
  return occurrences;
}

/* v8 ignore start -- metadata policy keys are validated before this summarizer; fallback branches are defensive */
function attachMissingMetadataItemIds(
  details: Record<string, unknown>,
  metadataPolicy: ValidateMetadataPolicy,
  missingByField: Record<ValidateMetadataRequiredField, string[]>,
  verboseDiagnostics: boolean,
): void {
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
    const summarized = summarizeList(
      missing,
      verboseDiagnostics ? missing.length : DIAGNOSTIC_LIST_SUMMARY_LIMIT,
    );
    details[idsKey] = summarized.values;
    details[truncatedKey] = summarized.truncated;
  }
}
/* v8 ignore stop */

function buildCloseReasonBackfillRows(
  metadataPolicy: ValidateMetadataPolicy,
  missingByField: Record<ValidateMetadataRequiredField, string[]>,
  itemsById: Map<string, ItemWithBody>,
): CloseReasonBackfillRow[] {
  if (!metadataPolicy.required_fields.includes("close_reason")) {
    return [];
  }
  const missing = missingByField.close_reason;
  if (!missing) {
    return [];
  }
  return missing.map((itemId) => ({
    id: itemId,
    resolution: toNonEmptyStringOrUndefined(itemsById.get(itemId)?.resolution),
  }));
}

function buildEstimateBackfillRows(
  metadataPolicy: ValidateMetadataPolicy,
  missingByField: Record<ValidateMetadataRequiredField, string[]>,
  itemsById: Map<string, ItemWithBody>,
): EstimateBackfillRow[] {
  if (!metadataPolicy.required_fields.includes("estimated_minutes")) {
    return [];
  }
  const missing = missingByField.estimated_minutes;
  if (!missing) {
    return [];
  }
  return missing.map((itemId) => ({
    id: itemId,
    type: toNonEmptyStringOrUndefined(itemsById.get(itemId)?.type),
  }));
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
  const itemsById = new Map(items.map((item) => [item.id, item]));

  // GH-276: only the `strict` profile enforces planning fields on terminal
  // (closed/canceled) historical items; core/minimal/custom profiles treat a
  // retired item's missing estimate or acceptance criteria as resolved.
  const enforcePlanningFieldsOnTerminal = metadataPolicy.profile === "strict";
  const missingByField = collectMissingMetadataByField(
    items,
    statusRegistry,
    enforcePlanningFieldsOnTerminal,
  );

  // Duplicate logical issue-code detection (GH-235): advisory warning when two
  // or more items share a leading title issue code (e.g. `ISSUE-004`).
  const duplicateIssueCodes = findDuplicateIssueCodes(items);
  const duplicateIssueCodeSummary = summarizeDuplicateIssueCodes(
    duplicateIssueCodes,
    verboseDiagnostics,
  );
  const warningTokens = buildMetadataWarningTokens(
    metadataPolicy,
    missingByField,
    duplicateIssueCodeSummary.warnings,
  );

  // Zero-suppress counts to reduce agent token cost (telemetry pm-tylj).
  // Only emit counts for the ACTIVE required fields of the resolved profile so a
  // looser profile (e.g. core) never reports missing reviewer/risk/sprint/etc.
  // Defensive guards (Gemini high #1, PR #78 follow-up): a future settings
  // shape could include an unsupported field in required_fields — fall back
  // to 0 instead of throwing TypeError, and skip writing when the count-key
  // mapping is undefined.
  const counts = buildMetadataCounts(metadataPolicy, missingByField);
  // Per-item-type grouping of missing required-field counts (pm-pmyq /
  // GH-172): counts only — never row dumps — and only for the ACTIVE required
  // fields, so the grouping mirrors `counts` at type granularity (e.g.
  // `{ Task: { close_reason: 3 } }`). Zero-suppressed at both levels.
  const missingFieldOccurrences = buildMissingFieldOccurrences(
    metadataPolicy,
    missingByField,
    itemsById,
  );
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
    details.configured_custom_required_fields = [
      ...metadataPolicy.configured_custom_fields,
    ];
  }

  // Only emit per-field item_ids/truncated keys for the ACTIVE required fields of
  // the resolved profile (and only when there are missing items). This stops a
  // looser profile (e.g. core) from emitting the identical full ID array for
  // reviewer/risk/confidence/sprint/release that it does not even require
  // (pm-edge #2 — ~150 redundant lines per validate run on minimal/core).
  // Defensive guard (Gemini high #2, PR #78 follow-up): same optional-chain
  // safety as the counts loop above — never throw if a future settings shape
  // includes an unsupported field.
  attachMissingMetadataItemIds(
    details,
    metadataPolicy,
    missingByField,
    verboseDiagnostics,
  );

  // Auto-fix planning input (pm-c3sz): closed items flagged for a missing
  // close_reason whose resolution can serve as the derivable source value.
  // Only collected when close_reason is an active required field, so fixes
  // always trace back to an actual finding of this run.
  const closeReasonBackfillRows = buildCloseReasonBackfillRows(
    metadataPolicy,
    missingByField,
    itemsById,
  );

  // Estimate auto-fix planning input (GH-212): items flagged for a missing
  // estimated_minutes whose type drives the config-driven default backfill.
  // Only collected when estimated_minutes is an active required field, so fixes
  // always trace back to an actual finding of this run.
  const estimateBackfillRows = buildEstimateBackfillRows(
    metadataPolicy,
    missingByField,
    itemsById,
  );

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
): {
  check: ValidateCheck;
  warnings: string[];
  resolutionBackfillRows: ResolutionBackfillRow[];
} {
  const terminalDoneStatuses = new Set<string>(
    statusRegistry.terminal_done_statuses,
  );
  terminalDoneStatuses.add(statusRegistry.close_status);
  const closedItems = items.filter((item) =>
    terminalDoneStatuses.has(
      normalizeStatusForRegistry(item.status, statusRegistry),
    ),
  );
  const missingResolutionRows: Array<{
    id: string;
    missing_fields: ResolutionFieldKey[];
  }> = [];
  const resolutionBackfillRows: ResolutionBackfillRow[] = [];

  for (const item of closedItems) {
    const missingFields = RESOLUTION_FIELD_KEYS.filter(
      (field) => !toNonEmptyStringOrUndefined(item[field]),
    );
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
    missingResolutionRows.length > 0
      ? [`validate_resolution_missing_fields:${missingResolutionRows.length}`]
      : [];
  const diagnosticLimit = verboseDiagnostics
    ? Number.POSITIVE_INFINITY
    : DIAGNOSTIC_LIST_SUMMARY_LIMIT;
  const summarizedRows = summarizeList(
    missingResolutionRows.map(
      (row) => `${row.id}:${row.missing_fields.join(",")}`,
    ),
    diagnosticLimit,
  );
  const remediationHints = missingResolutionRows.map((row) =>
    buildResolutionRemediationCommand(row),
  );
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
        missing_resolution_remediation_hints_truncated:
          summarizedHints.truncated,
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

function buildLifecycleDependencyGraph(
  activeItems: ItemWithBody[],
  idPrefix = "pm",
  relationshipRegistry: RelationshipKindRegistry = createRelationshipKindRegistry(),
): Map<string, string[]> {
  const activeItemIds = new Set(activeItems.map((item) => item.id));
  const graph = new Map<string, string[]>();
  const sortedItems = [...activeItems].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  for (const item of sortedItems) {
    const edges = new Set<string>();
    const blockedBy = toMeaningfulString(item.blocked_by);
    if (blockedBy && activeItemIds.has(blockedBy)) {
      edges.add(blockedBy);
    }
    for (const dependency of item.dependencies ?? []) {
      const dependencyKind = toMeaningfulString(dependency.kind);
      if (!dependencyKind) continue;
      const relationshipDefinition =
        relationshipRegistry.resolve(dependencyKind);
      if (!relationshipDefinition?.ordering) continue;
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
    graph.set(
      item.id,
      [...edges].sort((left, right) => left.localeCompare(right)),
    );
  }
  return graph;
}
/* c8 ignore stop */

function buildDependencyReferencesCheck(
  items: ItemWithBody[],
  verboseDiagnostics: boolean,
  statusRegistry?: RuntimeStatusRegistry,
): { check: ValidateCheck; warnings: string[] } {
  const classified = collectDanglingDependencyReferences(
    items,
    statusRegistry
      ? (status) => isTerminalStatus(status, statusRegistry)
      : undefined,
  );
  const activeRows = classified.active.map(
    (row) => `${row.holder_id}:${row.target_id}:${row.kind}`,
  );
  const legacyRows = classified.legacy_terminal.map(
    (row) =>
      `${row.holder_id}:${row.target_id}:${row.kind}:${row.holder_status}`,
  );
  const diagnosticLimit = verboseDiagnostics
    ? Number.POSITIVE_INFINITY
    : DIAGNOSTIC_LIST_SUMMARY_LIMIT;
  const summarizedRows = summarizeList(activeRows, diagnosticLimit);
  const summarizedLegacyRows = summarizeList(legacyRows, diagnosticLimit);
  const hints = summarizeList(
    classified.active.map((row) => {
      if (row.source === "parent") {
        return `pm update ${row.holder_id} --unset parent`;
      }
      return row.source === "blocked_by"
        ? `pm update ${row.holder_id} --unset blocked_by`
        : `pm update ${row.holder_id} --replace-deps '<correct dependency edges>'`;
    }),
    diagnosticLimit,
  );
  return {
    check: {
      name: "dependency_references",
      status: activeRows.length === 0 ? "ok" : "warn",
      details: {
        checked_items: items.length,
        dangling_reference_count: activeRows.length + legacyRows.length,
        active_dangling_reference_count: activeRows.length,
        dangling_reference_rows: summarizedRows.values,
        dangling_reference_rows_truncated: summarizedRows.truncated,
        legacy_terminal_dangling_reference_count: legacyRows.length,
        legacy_closed_dangling_reference_count:
          classified.legacy_terminal.filter(
            (row) => row.holder_status === "closed",
          ).length,
        legacy_terminal_dangling_reference_rows: summarizedLegacyRows.values,
        legacy_terminal_dangling_reference_rows_truncated:
          summarizedLegacyRows.truncated,
        no_active_blocker_sentinel_count:
          classified.no_active_blocker_sentinels.length,
        remediation_hints: hints.values,
        remediation_hints_truncated: hints.truncated,
      },
    },
    warnings:
      activeRows.length > 0
        ? [`validate_dangling_dependency_references:${activeRows.length}`]
        : [],
  };
}

function extractItemIds(value: string, idPrefix = "pm"): string[] {
  const normalizedPrefix = (idPrefix.trim().toLowerCase() || "pm").replace(
    /-+$/g,
    "",
  );
  const pattern = new RegExp(
    `(?:^|[^a-z0-9-])(${escapeRegExp(normalizedPrefix)}-[a-z0-9][a-z0-9-]*)`,
    "gi",
  );
  return [
    ...new Set(
      [...value.matchAll(pattern)].map((match) => match[1]!.toLowerCase()),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

/* c8 ignore start -- Tarjan SCC traversal branch matrix is covered by lifecycle cycle integration fixtures */
function findLifecycleDependencyCycleComponents(
  graph: Map<string, string[]>,
): string[][] {
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
        lowLinkById.set(
          id,
          Math.min(lowLinkById.get(id)!, lowLinkById.get(dependencyId)!),
        );
      } else if (inStack.has(dependencyId)) {
        lowLinkById.set(
          id,
          Math.min(lowLinkById.get(id)!, indexById.get(dependencyId)!),
        );
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

  const sortedNodeIds = [...graph.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
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
function resolveLifecycleDependencyCycleSamplePath(
  component: string[],
  graph: Map<string, string[]>,
): string[] {
  const start = component[0];
  if (component.length === 1) {
    return [start, start];
  }
  const componentSet = new Set(component);
  const path: string[] = [start];
  const visited = new Set<string>([start]);

  const search = (current: string): boolean => {
    const neighbors = (graph.get(current) ?? []).filter((candidate) =>
      componentSet.has(candidate),
    );
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

function detectLifecycleDependencyCycles(
  activeItems: ItemWithBody[],
  idPrefix = "pm",
): {
  cycle_count: number;
  cycle_item_ids: string[];
  cycle_sample_paths: string[];
} {
  const graph = buildLifecycleDependencyGraph(activeItems, idPrefix);
  const cycleComponents = findLifecycleDependencyCycleComponents(graph);
  const cycleItemIds = [...new Set(cycleComponents.flat())].sort(
    (left, right) => left.localeCompare(right),
  );
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
function buildLifecycleParentGraph(
  items: ItemWithBody[],
): Map<string, string[]> {
  // PR #279 made parent matching case-insensitive (e.g. `parent: PM-FK49`
  // resolves to `id: pm-fk49`). Resolve parent references to their canonical
  // item id the same way so a casing mismatch can never silently drop a cycle
  // edge and hide a parent cycle (false negative).
  const canonicalIdByLowercase = new Map(
    items.map((item) => [item.id.toLowerCase(), item.id]),
  );
  const graph = new Map<string, string[]>();
  const sortedItems = [...items].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  for (const item of sortedItems) {
    const edges: string[] = [];
    const parentId = toMeaningfulString(item.parent);
    const canonicalParentId = parentId
      ? canonicalIdByLowercase.get(parentId.toLowerCase())
      : undefined;
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
  const cycleItemIds = [...new Set(cycleComponents.flat())].sort(
    (left, right) => left.localeCompare(right),
  );
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
  while (
    count < leftParts.length &&
    count < rightParts.length &&
    leftParts[count] === rightParts[count]
  ) {
    count += 1;
  }
  return count;
}

interface OrphanOwnerCandidateScore {
  score: number;
  confidence: "path_prefix" | "same_directory" | "shared_directory";
}

function scoreOrphanOwnerCandidate(
  pathValue: string,
  linkedPath: string,
): OrphanOwnerCandidateScore | null {
  const linkedDir = directoryOf(linkedPath);
  const orphanDir = directoryOf(pathValue);
  const directoryPrefix = linkedPath.endsWith("/")
    ? linkedPath
    : `${linkedPath}/`;
  const isDirectoryPrefix = pathValue.startsWith(directoryPrefix);
  const sameDirectory = linkedDir.length > 0 && linkedDir === orphanDir;
  const sharedPrefixLength = sharedDirectoryPrefixLength(pathValue, linkedPath);
  if (!isDirectoryPrefix && !sameDirectory && sharedPrefixLength === 0) {
    return null;
  }
  if (isDirectoryPrefix) {
    return { score: linkedPath.length + 1000, confidence: "path_prefix" };
  }
  return sameDirectory
    ? { score: sharedPrefixLength + 500, confidence: "same_directory" }
    : { score: sharedPrefixLength, confidence: "shared_directory" };
}

function shouldReplaceOrphanOwnerCandidate(
  best: { item: ItemWithBody; score: number } | undefined,
  item: ItemWithBody,
  score: number,
): boolean {
  return (
    best === undefined ||
    score > best.score ||
    (score === best.score && item.id.localeCompare(best.item.id) < 0)
  );
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
    const links = linkKind === "docs" ? (item.docs ?? []) : (item.files ?? []);
    for (const link of links) {
      if (link.scope !== "project") {
        continue;
      }
      const linkedPath = normalizeRelativePath(link.path);
      if (linkedPath.length === 0 || linkedPath === pathValue) {
        continue;
      }
      const scored = scoreOrphanOwnerCandidate(pathValue, linkedPath);
      if (scored === null) {
        continue;
      }
      if (shouldReplaceOrphanOwnerCandidate(best, item, scored.score)) {
        best = {
          item,
          score: scored.score,
          confidence: scored.confidence,
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

function buildOrphanedPathRows(
  orphanedFiles: readonly string[],
  items: readonly ItemWithBody[],
): OrphanedPathRow[] {
  return orphanedFiles.map((pathValue) => {
    const classification = classifyOrphanedPath(pathValue);
    const linkCommand = classification === "docs_unowned" ? "docs" : "files";
    const ownerCandidate = findOrphanOwnerCandidate(
      pathValue,
      classification,
      items,
    );
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

interface LifecycleScanRows {
  activeItems: ItemWithBody[];
  closureLikeRows: Array<{ id: string; fields: string[] }>;
  terminalParentRows: Array<{
    id: string;
    parent_id: string;
    parent_status: string;
  }>;
  terminalParentFixRows: TerminalParentFixRow[];
  staleBlockerRows: Array<{ id: string; status: string; reasons: string[] }>;
}

function closureLikeFieldsForItem(
  item: ItemWithBody,
  lifecyclePatternPolicy: LifecyclePatternPolicy,
): string[] {
  return Object.entries(
    lifecyclePatternPolicy.closure_like_metadata_field_patterns,
  )
    .filter(([field, patterns]) => {
      const value = toMeaningfulString(item[field as keyof ItemWithBody]);
      return value
        ? patterns.some((pattern) => value.toLowerCase().includes(pattern))
        : false;
    })
    .map(([field]) => field)
    .sort((left, right) => left.localeCompare(right));
}

function buildTerminalParentFixRow(
  item: ItemWithBody,
  parent: ItemWithBody,
  itemsById: Map<string, ItemWithBody>,
  canonicalIdByLowercase: Map<string, string>,
  statusRegistry: RuntimeStatusRegistry,
): TerminalParentFixRow {
  const grandparentId = toMeaningfulString(parent.parent);
  const grandparent = grandparentId
    ? itemsById.get(
        canonicalIdByLowercase.get(grandparentId.toLowerCase()) ??
          grandparentId,
      )
    : undefined;
  return {
    id: item.id,
    parent_id: parent.id,
    grandparent_id: grandparent?.id,
    grandparent_active:
      grandparent !== undefined &&
      !isTerminalStatus(grandparent.status, statusRegistry),
  };
}

/* v8 ignore start -- stale-blocker reason variants are covered through command-level diagnostics; helper branch counters are defensive */
function staleBlockerReasonsForItem(
  item: ItemWithBody,
  blockedStatuses: Set<string>,
  statusRegistry: RuntimeStatusRegistry,
  lifecyclePatternPolicy: LifecyclePatternPolicy,
): string[] {
  const blockedBy = toMeaningfulString(item.blocked_by);
  const blockedReason = toMeaningfulString(item.blocked_reason);
  const blockedReasonNormalized = blockedReason?.toLowerCase();
  const normalizedStatus = normalizeStatusForRegistry(
    item.status,
    statusRegistry,
  );
  const reasons: string[] = [];
  if (!blockedStatuses.has(normalizedStatus)) {
    if (blockedBy) {
      reasons.push("non_blocked_status_has_blocked_by");
    }
    if (blockedReason) {
      reasons.push("non_blocked_status_has_blocked_reason");
    }
    return reasons;
  }
  if (!blockedBy && !blockedReason) {
    /* v8 ignore start -- blocked-status creation paths seed either blocked_by or blocked_reason before lifecycle validation */
    reasons.push("blocked_status_missing_blocker_context");
    /* v8 ignore stop */
  }
  if (blockedReasonNormalized?.includes("no active blocker")) {
    reasons.push("blocked_status_reason_reports_no_active_blocker");
  }
  if (
    blockedReasonNormalized &&
    lifecyclePatternPolicy.stale_blocker_reason_patterns.some((pattern) =>
      blockedReasonNormalized.includes(pattern),
    )
  ) {
    reasons.push("blocked_status_reason_matches_stale_pattern");
  }
  return reasons;
}
/* v8 ignore stop */

function collectLifecycleScanRows(
  items: ItemWithBody[],
  includeStaleBlockers: boolean,
  statusRegistry: RuntimeStatusRegistry,
  lifecyclePatternPolicy: LifecyclePatternPolicy,
): LifecycleScanRows {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const canonicalIdByLowercase = new Map(
    items.map((item) => [item.id.toLowerCase(), item.id]),
  );
  /* v8 ignore start -- runtime status registry normally supplies blocked statuses; fallback preserves legacy settings safety */
  const blockedStatuses =
    statusRegistry.blocked_statuses.size > 0
      ? statusRegistry.blocked_statuses
      : new Set<string>(["blocked"]);
  /* v8 ignore stop */
  const rows: LifecycleScanRows = {
    activeItems: items.filter(
      (item) => !isTerminalStatus(item.status, statusRegistry),
    ),
    closureLikeRows: [],
    terminalParentRows: [],
    terminalParentFixRows: [],
    staleBlockerRows: [],
  };
  for (const item of rows.activeItems) {
    const closureLikeFields = closureLikeFieldsForItem(
      item,
      lifecyclePatternPolicy,
    );
    if (closureLikeFields.length > 0) {
      rows.closureLikeRows.push({ id: item.id, fields: closureLikeFields });
    }
    const parentId = toMeaningfulString(item.parent);
    const parent = parentId
      ? itemsById.get(
          canonicalIdByLowercase.get(parentId.toLowerCase()) ?? parentId,
        )
      : undefined;
    if (parent && isTerminalStatus(parent.status, statusRegistry)) {
      rows.terminalParentRows.push({
        id: item.id,
        parent_id: parent.id,
        parent_status: parent.status,
      });
      rows.terminalParentFixRows.push(
        buildTerminalParentFixRow(
          item,
          parent,
          itemsById,
          canonicalIdByLowercase,
          statusRegistry,
        ),
      );
    }
    /* v8 ignore start -- stale-blocker reason presence is covered by command diagnostics; branch accounting here is defensive */
    if (includeStaleBlockers) {
      const reasons = staleBlockerReasonsForItem(
        item,
        blockedStatuses,
        statusRegistry,
        lifecyclePatternPolicy,
      );
      if (reasons.length > 0) {
        rows.staleBlockerRows.push({
          id: item.id,
          status: item.status,
          reasons: [...new Set(reasons)].sort((left, right) =>
            left.localeCompare(right),
          ),
        });
      }
    }
    /* v8 ignore stop */
  }
  return rows;
}

function sortLifecycleScanRows(rows: LifecycleScanRows): void {
  rows.closureLikeRows.sort((left, right) => left.id.localeCompare(right.id));
  /* v8 ignore start -- parent-id tie breakers only matter for duplicate legacy ids, which the tracker writer prevents */
  rows.terminalParentRows.sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.parent_id.localeCompare(right.parent_id),
  );
  rows.terminalParentFixRows.sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.parent_id.localeCompare(right.parent_id),
  );
  /* v8 ignore stop */
  rows.staleBlockerRows.sort((left, right) => left.id.localeCompare(right.id));
}

function lifecycleCycleWarningToken(
  prefix:
    | "validate_lifecycle_dependency_cycles"
    | "validate_hierarchy_parent_cycle",
  severity: ValidateDependencyCycleSeverity,
  count: number,
): string | null {
  if (count <= 0 || severity === "off") {
    return null;
  }
  return `${severity === "error" ? `${prefix}_error` : prefix}:${count}`;
}

function buildLifecycleWarnings(
  rows: LifecycleScanRows,
  includeStaleBlockers: boolean,
  dependencyCycleSeverity: ValidateDependencyCycleSeverity,
  parentCycleSeverity: ValidateDependencyCycleSeverity,
  dependencyCycleCount: number,
  parentCycleCount: number,
): string[] {
  const warnings: string[] = [];
  if (rows.closureLikeRows.length > 0) {
    warnings.push(
      `validate_lifecycle_active_closure_like_metadata:${rows.closureLikeRows.length}`,
    );
  }
  if (rows.terminalParentRows.length > 0) {
    warnings.push(
      `validate_lifecycle_active_terminal_parent:${rows.terminalParentRows.length}`,
    );
  }
  if (includeStaleBlockers && rows.staleBlockerRows.length > 0) {
    warnings.push(
      `validate_lifecycle_stale_blockers:${rows.staleBlockerRows.length}`,
    );
  }
  const dependencyWarning = lifecycleCycleWarningToken(
    "validate_lifecycle_dependency_cycles",
    dependencyCycleSeverity,
    dependencyCycleCount,
  );
  const parentWarning = lifecycleCycleWarningToken(
    "validate_hierarchy_parent_cycle",
    parentCycleSeverity,
    parentCycleCount,
  );
  return [
    ...warnings,
    ...(dependencyWarning ? [dependencyWarning] : []),
    ...(parentWarning ? [parentWarning] : []),
  ];
}

interface LinkedPathScanState {
  linkedProjectPaths: Set<string>;
  remoteLinkedPaths: Set<string>;
  missingLinkedPaths: string[];
  staleLinkRows: Array<{
    item_id: string;
    path: string;
    link_kind: "files" | "docs";
  }>;
}

function linkedArtifactPathExceedsFilesystemLimits(
  artifactPath: string,
): boolean {
  const normalized = normalizeRelativePath(artifactPath);
  return (
    normalized.length > LINKED_ARTIFACT_MAX_PATH_LENGTH ||
    normalized
      .split(/[\\/]/)
      .some((segment) => segment.length > LINKED_ARTIFACT_MAX_SEGMENT_LENGTH)
  );
}

async function linkedArtifactIsMissing(
  workspaceRoot: string,
  artifactPath: string,
): Promise<boolean> {
  const absolutePath = path.isAbsolute(artifactPath)
    ? artifactPath
    : path.resolve(workspaceRoot, artifactPath);
  if (linkedArtifactPathExceedsFilesystemLimits(absolutePath)) {
    return false;
  }
  try {
    const stats = await fs.stat(absolutePath);
    return !stats.isFile() && !stats.isDirectory();
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

async function collectLinkedPathScanState(
  items: ItemWithBody[],
  workspaceRoot: string,
): Promise<LinkedPathScanState> {
  const state: LinkedPathScanState = {
    linkedProjectPaths: new Set<string>(),
    remoteLinkedPaths: new Set<string>(),
    missingLinkedPaths: [],
    staleLinkRows: [],
  };
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
        if (isRemoteLinkedArtifactReference(artifact.path)) {
          state.remoteLinkedPaths.add(artifact.path.trim());
          continue;
        }
        const normalizedPath = normalizeRelativePath(artifact.path);
        if (normalizedPath.length === 0) {
          continue;
        }
        state.linkedProjectPaths.add(normalizedPath);
        if (await linkedArtifactIsMissing(workspaceRoot, artifact.path)) {
          state.missingLinkedPaths.push(normalizedPath);
          state.staleLinkRows.push({
            item_id: item.id,
            path: normalizedPath,
            link_kind: group.link_kind,
          });
        }
      }
    }
  }
  return state;
}

interface FileCandidatePartition {
  strictTrackedAllMode: boolean;
  strictModeForcesPmInternals: boolean;
  includePmInternalsEffective: boolean;
  pmInternalCandidatePrefixes: string[];
  excludedPmInternalPaths: string[];
  candidateFiles: string[];
  excludedByReason: Record<string, unknown>;
}

function partitionFileCandidates(
  fileCandidates: FileCandidateCollection,
  pmRoot: string,
  workspaceRoot: string,
  fileScanMode: ValidateFileScanMode,
  includePmInternals: boolean,
  verboseFileLists: boolean,
): FileCandidatePartition {
  const strictTrackedAllMode = fileScanMode === "tracked-all-strict";
  const strictModeForcesPmInternals =
    strictTrackedAllMode && !includePmInternals;
  const includePmInternalsEffective =
    includePmInternals || strictTrackedAllMode;
  const pmInternalCandidatePrefixes = includePmInternalsEffective
    ? []
    : resolvePmInternalCandidatePrefixes(pmRoot, workspaceRoot);
  const excludedPmInternalPaths =
    pmInternalCandidatePrefixes.length === 0
      ? []
      : fileCandidates.candidateFiles.filter((candidate) =>
          hasPathPrefix(candidate, pmInternalCandidatePrefixes),
        );
  const candidateFiles =
    pmInternalCandidatePrefixes.length === 0
      ? fileCandidates.candidateFiles
      : fileCandidates.candidateFiles.filter(
          (candidate) => !hasPathPrefix(candidate, pmInternalCandidatePrefixes),
        );
  const excludedByReason: Record<string, unknown> = {};
  if (excludedPmInternalPaths.length > 0) {
    const summarizedPmInternalPaths = summarizeFileList(
      excludedPmInternalPaths,
      verboseFileLists,
    );
    excludedByReason.pm_internals = {
      count: excludedPmInternalPaths.length,
      paths: summarizedPmInternalPaths.values,
      paths_truncated: summarizedPmInternalPaths.truncated,
      paths_total: summarizedPmInternalPaths.total,
    };
  }
  return {
    strictTrackedAllMode,
    strictModeForcesPmInternals,
    includePmInternalsEffective,
    pmInternalCandidatePrefixes,
    excludedPmInternalPaths,
    candidateFiles,
    excludedByReason,
  };
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
): {
  check: ValidateCheck;
  warnings: string[];
  terminalParentFixRows: TerminalParentFixRow[];
} {
  const rows = collectLifecycleScanRows(
    items,
    includeStaleBlockers,
    statusRegistry,
    lifecyclePatternPolicy,
  );
  sortLifecycleScanRows(rows);
  const dependencyCycleDiagnostics = detectLifecycleDependencyCycles(
    rows.activeItems,
    idPrefix,
  );
  const parentCycleDiagnostics = detectLifecycleParentCycles(items);
  const warnings = buildLifecycleWarnings(
    rows,
    includeStaleBlockers,
    dependencyCycleSeverity,
    parentCycleSeverity,
    dependencyCycleDiagnostics.cycle_count,
    parentCycleDiagnostics.cycle_count,
  );

  const diagnosticLimit = verboseDiagnostics
    ? Number.POSITIVE_INFINITY
    : DIAGNOSTIC_LIST_SUMMARY_LIMIT;
  const summarizedClosureLikeRows = summarizeList(
    rows.closureLikeRows.map((row) => `${row.id}:${row.fields.join(",")}`),
    diagnosticLimit,
  );
  const summarizedTerminalParentRows = summarizeList(
    rows.terminalParentRows.map(
      (row) => `${row.id}:${row.parent_id}:${row.parent_status}`,
    ),
    diagnosticLimit,
  );
  const summarizedStaleBlockerRows = summarizeList(
    rows.staleBlockerRows.map(
      (row) => `${row.id}:${row.status}:${row.reasons.join(",")}`,
    ),
    diagnosticLimit,
  );
  const summarizedDependencyCycleItemIds = summarizeList(
    dependencyCycleDiagnostics.cycle_item_ids,
    diagnosticLimit,
  );
  const summarizedDependencyCycleSamplePaths = summarizeList(
    dependencyCycleDiagnostics.cycle_sample_paths,
    diagnosticLimit,
  );
  const summarizedParentCycleItemIds = summarizeList(
    parentCycleDiagnostics.cycle_item_ids,
    diagnosticLimit,
  );
  const summarizedParentCycleSamplePaths = summarizeList(
    parentCycleDiagnostics.cycle_sample_paths,
    diagnosticLimit,
  );

  const hasErrorSeverityCycle =
    (dependencyCycleDiagnostics.cycle_count > 0 &&
      dependencyCycleSeverity === "error") ||
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
        checked_active_items: rows.activeItems.length,
        active_closure_like_metadata_items: rows.closureLikeRows.length,
        active_closure_like_metadata_rows: summarizedClosureLikeRows.values,
        active_closure_like_metadata_rows_truncated:
          summarizedClosureLikeRows.truncated,
        active_terminal_parent_items: rows.terminalParentRows.length,
        active_terminal_parent_rows: summarizedTerminalParentRows.values,
        active_terminal_parent_rows_truncated:
          summarizedTerminalParentRows.truncated,
        stale_blocker_checks_enabled: includeStaleBlockers,
        stale_blocker_items: rows.staleBlockerRows.length,
        stale_blocker_rows: summarizedStaleBlockerRows.values,
        stale_blocker_rows_truncated: summarizedStaleBlockerRows.truncated,
        dependency_cycle_severity_policy: dependencyCycleSeverity,
        dependency_cycle_count: dependencyCycleDiagnostics.cycle_count,
        dependency_cycle_item_count:
          dependencyCycleDiagnostics.cycle_item_ids.length,
        dependency_cycle_item_ids: summarizedDependencyCycleItemIds.values,
        dependency_cycle_item_ids_truncated:
          summarizedDependencyCycleItemIds.truncated,
        dependency_cycle_sample_paths:
          summarizedDependencyCycleSamplePaths.values,
        dependency_cycle_sample_paths_truncated:
          summarizedDependencyCycleSamplePaths.truncated,
        parent_cycle_severity_policy: parentCycleSeverity,
        parent_cycle_count: parentCycleDiagnostics.cycle_count,
        parent_cycle_item_count: parentCycleDiagnostics.cycle_item_ids.length,
        parent_cycle_item_ids: summarizedParentCycleItemIds.values,
        parent_cycle_item_ids_truncated: summarizedParentCycleItemIds.truncated,
        parent_cycle_sample_paths: summarizedParentCycleSamplePaths.values,
        parent_cycle_sample_paths_truncated:
          summarizedParentCycleSamplePaths.truncated,
        stale_blocker_reason_patterns: [
          ...lifecyclePatternPolicy.stale_blocker_reason_patterns,
        ],
        stale_blocker_reason_pattern_source:
          lifecyclePatternPolicy.stale_blocker_reason_pattern_source,
        closure_like_blocked_reason_patterns: [
          ...lifecyclePatternPolicy.closure_like_metadata_field_patterns
            .blocked_reason,
        ],
        closure_like_blocked_reason_pattern_source:
          lifecyclePatternPolicy.closure_like_metadata_field_pattern_sources
            .blocked_reason,
        closure_like_resolution_patterns: [
          ...lifecyclePatternPolicy.closure_like_metadata_field_patterns
            .resolution,
        ],
        closure_like_resolution_pattern_source:
          lifecyclePatternPolicy.closure_like_metadata_field_pattern_sources
            .resolution,
        closure_like_actual_result_patterns: [
          ...lifecyclePatternPolicy.closure_like_metadata_field_patterns
            .actual_result,
        ],
        closure_like_actual_result_pattern_source:
          lifecyclePatternPolicy.closure_like_metadata_field_pattern_sources
            .actual_result,
      },
    },
    warnings,
    terminalParentFixRows: rows.terminalParentFixRows,
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
): Promise<{
  check: ValidateCheck;
  warnings: string[];
  staleLinkPruneRows: StaleLinkPruneRow[];
}> {
  const linkedPathState = await collectLinkedPathScanState(
    items,
    workspaceRoot,
  );
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const uniqueMissingLinkedPaths = [
    ...new Set(linkedPathState.missingLinkedPaths),
  ].sort((left, right) => left.localeCompare(right));
  const fileCandidates = await collectProjectFileCandidates(
    workspaceRoot,
    fileScanMode,
  );
  const partition = partitionFileCandidates(
    fileCandidates,
    pmRoot,
    workspaceRoot,
    fileScanMode,
    includePmInternals,
    verboseFileLists,
  );
  const orphanedFiles = partition.candidateFiles.filter(
    (candidate) => !linkedPathState.linkedProjectPaths.has(candidate),
  );
  const orphanedPathRows = buildOrphanedPathRows(orphanedFiles, items);
  // Stale-path classification (pm-0v2m / GH-184): a missing linked path whose
  // basename still exists in the candidate scan is reported as `moved` (with
  // relink candidates); otherwise it is `deleted` and safe to prune.
  const classifiedStalePaths = classifyStaleLinkedPaths(
    uniqueMissingLinkedPaths,
    partition.candidateFiles,
  );
  const classificationByPath = new Map(
    classifiedStalePaths.map((entry) => [entry.path, entry.classification]),
  );
  const movedStalePathCount = classifiedStalePaths.filter(
    (entry) => entry.classification === "moved",
  ).length;
  const staleLinkPruneRows: StaleLinkPruneRow[] = linkedPathState.staleLinkRows
    .map((row) => ({
      ...row,
      classification:
        classificationByPath.get(row.path) ?? ("deleted" as const),
    }))
    .sort(
      (left, right) =>
        left.item_id.localeCompare(right.item_id) ||
        left.path.localeCompare(right.path) ||
        left.link_kind.localeCompare(right.link_kind),
    );
  const warnings: string[] = [];
  if (partition.strictModeForcesPmInternals) {
    warnings.push("validate_files_tracked_all_strict_forces_pm_internals");
  }
  if (uniqueMissingLinkedPaths.length > 0) {
    warnings.push(
      `validate_files_missing_linked_paths:${uniqueMissingLinkedPaths.length}`,
    );
  }
  if (orphanedFiles.length > 0) {
    warnings.push(`validate_files_orphaned_paths:${orphanedFiles.length}`);
  }
  const uniqueRemoteLinkedPaths = [...linkedPathState.remoteLinkedPaths].sort(
    (left, right) => left.localeCompare(right),
  );
  const summarizedRemote = summarizeFileList(
    uniqueRemoteLinkedPaths,
    verboseFileLists,
  );
  const summarizedMissing = summarizeFileList(
    uniqueMissingLinkedPaths,
    verboseFileLists,
  );
  const summarizedOrphaned = summarizeFileList(orphanedFiles, verboseFileLists);
  const summarizedOrphanedClassifications = summarizeFileList(
    orphanedPathRows.map(
      (row) =>
        `${row.path}:${row.classification}:owner_candidate=${row.owner_candidate?.id ?? "unowned"}`,
    ),
    verboseFileLists,
  );
  const orphanedPathRowDetail = verboseFileLists
    ? orphanedPathRows
    : summarizeFileList(summarizeOrphanedPathRows(orphanedPathRows), false)
        .values;
  const summarizedClassifications = summarizeFileList(
    summarizeStaleLinkedPathClassifications(classifiedStalePaths),
    verboseFileLists,
  );
  // Owner attribution for missing linked paths (GH-210): per-path rows naming
  // the owning item(s) so cleanup is evidence-based instead of requiring a
  // reverse lookup. Full structured objects under --verbose-file-lists; compact
  // `path:classification owner=… field=…` one-liners (capped) otherwise — same
  // full/summary split as the other file-check lists (file_list_detail_mode).
  const missingLinkedPathRows: StaleLinkOwnerInput[] = staleLinkPruneRows.map(
    (row) => ({
      item_id: row.item_id,
      path: row.path,
      link_kind: row.link_kind,
      classification: row.classification,
    }),
  );
  const ownerRows = buildMissingLinkedPathRows(missingLinkedPathRows, (id) => {
    const owner = itemsById.get(id);
    return owner
      ? { type: owner.type, title: owner.title, status: owner.status }
      : undefined;
  });
  // Default to token-efficient compact one-liners; expose the full structured
  // rows (the GH-210 JSON shape) under --verbose-file-lists.
  const ownerRowDetail = verboseFileLists
    ? ownerRows
    : summarizeFileList(summarizeMissingLinkedPathRows(ownerRows), false)
        .values;

  return {
    check: {
      name: "files",
      status: warnings.length === 0 ? "ok" : "warn",
      details: {
        workspace_root: workspaceRoot,
        scan_mode_requested: fileCandidates.requestedMode,
        scan_mode_applied: fileCandidates.appliedMode,
        strict_tracked_all_mode: partition.strictTrackedAllMode,
        strict_mode_forces_pm_internals: partition.strictModeForcesPmInternals,
        strict_mode_forces_pm_internals_notice:
          partition.strictModeForcesPmInternals
            ? "tracked-all-strict force-enables PM internals; pass --include-pm-internals to make inclusion explicit."
            : null,
        file_list_detail_mode: verboseFileLists ? "full" : "summary",
        file_list_summary_limit: FILE_LIST_SUMMARY_LIMIT,
        candidate_scan_source: fileCandidates.source,
        include_pm_internals: partition.includePmInternalsEffective,
        include_pm_internals_requested: includePmInternals,
        pm_internal_candidate_prefixes: partition.pmInternalCandidatePrefixes,
        pm_internal_excluded_count: partition.excludedPmInternalPaths.length,
        excluded_total: partition.excludedPmInternalPaths.length,
        excluded_by_reason: partition.excludedByReason,
        linked_project_paths: linkedPathState.linkedProjectPaths.size,
        remote_linked_paths_count: uniqueRemoteLinkedPaths.length,
        remote_linked_paths_total: summarizedRemote.total,
        remote_linked_paths: summarizedRemote.values,
        remote_linked_paths_truncated: summarizedRemote.truncated,
        candidate_total_raw: fileCandidates.candidateTotal,
        candidate_scanned_raw: fileCandidates.candidateScanned,
        candidate_total: partition.candidateFiles.length,
        candidate_scanned: partition.candidateFiles.length,
        scanned_candidate_files: partition.candidateFiles.length,
        missing_linked_paths_count: uniqueMissingLinkedPaths.length,
        missing_linked_paths_total: summarizedMissing.total,
        missing_linked_paths: summarizedMissing.values,
        missing_linked_paths_truncated: summarizedMissing.truncated,
        missing_linked_paths_moved_count: movedStalePathCount,
        missing_linked_paths_deleted_count:
          uniqueMissingLinkedPaths.length - movedStalePathCount,
        missing_linked_path_classifications: summarizedClassifications.values,
        missing_linked_path_classifications_truncated:
          summarizedClassifications.truncated,
        missing_linked_path_rows_count: ownerRows.length,
        missing_linked_path_rows: ownerRowDetail,
        orphaned_paths_count: orphanedFiles.length,
        orphaned_paths_total: summarizedOrphaned.total,
        orphaned_paths: summarizedOrphaned.values,
        orphaned_paths_truncated: summarizedOrphaned.truncated,
        orphaned_path_classifications: summarizedOrphanedClassifications.values,
        orphaned_path_classifications_truncated:
          summarizedOrphanedClassifications.truncated,
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
  const {
    missingStreams,
    unreadableStreams,
    hashMismatches,
    chainMismatches,
    driftedItems,
  } = await scanHistoryDrift(pmRoot, items);
  const warnings: string[] = [];
  if (missingStreams.length > 0) {
    warnings.push(
      `validate_history_drift_missing_streams:${missingStreams.length}`,
    );
  }
  if (unreadableStreams.length > 0) {
    warnings.push(
      `validate_history_drift_unreadable_streams:${unreadableStreams.length}`,
    );
  }
  if (hashMismatches.length > 0) {
    warnings.push(
      `validate_history_drift_hash_mismatches:${hashMismatches.length}`,
    );
  }
  if (chainMismatches.length > 0) {
    warnings.push(
      `validate_history_drift_chain_mismatches:${chainMismatches.length}`,
    );
  }
  const diagnosticLimit = verboseDiagnostics
    ? Number.POSITIVE_INFINITY
    : DIAGNOSTIC_LIST_SUMMARY_LIMIT;
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
function summarizeCommandReferenceRow(
  ownerId: string,
  referencedId: string,
  command: string,
): string {
  const normalizedCommand = command.trim().replaceAll(/\s+/g, " ");
  const commandPreview =
    normalizedCommand.length > 120
      ? `${normalizedCommand.slice(0, 117)}...`
      : normalizedCommand;
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
      if (
        typeof linkedTest.command !== "string" ||
        linkedTest.command.trim().length === 0
      ) {
        continue;
      }
      linkedCommandsScanned += 1;
      const referencedIds = extractReferencedPmItemIdsFromCommand(
        linkedTest.command,
        idPrefix,
      );
      if (referencedIds.length === 0) {
        continue;
      }
      referencedPmIdCount += referencedIds.length;
      for (const referencedId of referencedIds) {
        referencedPmIds.add(referencedId);
        if (!knownIds.has(referencedId.toLowerCase())) {
          staleReferenceRows.push(
            summarizeCommandReferenceRow(
              item.id,
              referencedId,
              linkedTest.command,
            ),
          );
        }
      }
    }
  }

  const uniqueStaleReferenceRows = [...new Set(staleReferenceRows)].sort(
    (left, right) => left.localeCompare(right),
  );
  const stalePmIds = [
    ...new Set(uniqueStaleReferenceRows.map((row) => row.split(":")[1] ?? "")),
  ]
    .filter((value) => value.length > 0)
    .sort((left, right) => left.localeCompare(right));
  const warnings =
    uniqueStaleReferenceRows.length > 0
      ? [
          `validate_command_references_stale_pm_ids:${uniqueStaleReferenceRows.length}`,
        ]
      : [];
  const diagnosticLimit = verboseDiagnostics
    ? Number.POSITIVE_INFINITY
    : DIAGNOSTIC_LIST_SUMMARY_LIMIT;
  const summarizedRows = summarizeList(
    uniqueStaleReferenceRows,
    diagnosticLimit,
  );
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

/* c8 ignore start -- format-version diagnostics projection is covered by validate format-version integration fixtures */
function buildFormatVersionCheck(
  items: ItemWithBody[],
  verboseDiagnostics: boolean,
): { check: ValidateCheck; warnings: string[] } {
  const scan = scanItemFormatVersions(
    items.map((item) => ({
      ref: item.id,
      version: effectiveItemFormatVersion(item),
    })),
  );
  const warnings: string[] = [];
  if (scan.outdated.length > 0) {
    warnings.push(
      `validate_format_version_outdated_items:${scan.outdated.length}`,
    );
  }
  if (scan.ahead.length > 0) {
    warnings.push(`validate_format_version_ahead_items:${scan.ahead.length}`);
  }
  const diagnosticLimit = verboseDiagnostics
    ? Number.POSITIVE_INFINITY
    : DIAGNOSTIC_LIST_SUMMARY_LIMIT;
  const summarizedOutdated = summarizeList(scan.outdated, diagnosticLimit);
  const summarizedAhead = summarizeList(scan.ahead, diagnosticLimit);
  // `ahead` items were written by a newer pm than this runtime: validation
  // cannot vouch for fields it does not understand, so it is an error (upgrade
  // pm). `outdated` items are a non-fatal warning (a migration would rewrite
  // them). At the current baseline version neither list is populated.
  const status: ValidateStatus =
    scan.ahead.length > 0 ? "error" : scan.outdated.length > 0 ? "warn" : "ok";
  return {
    check: {
      name: "format_version",
      status,
      details: {
        checked_items: items.length,
        current_format_version: CURRENT_ITEM_FORMAT_VERSION,
        outdated_items_count: scan.outdated.length,
        outdated_items: summarizedOutdated.values,
        outdated_items_truncated: summarizedOutdated.truncated,
        ahead_items_count: scan.ahead.length,
        ahead_items: summarizedAhead.values,
        ahead_items_truncated: summarizedAhead.truncated,
      },
    },
    warnings,
  };
}
/* c8 ignore stop */

const VALIDATE_AUTO_FIX_MESSAGE = "pm validate auto-fix";

/** Apply one planned fix through the SAME audited command paths an operator would use by hand (`pm update` / `pm files --remove` / `pm docs --remove`), so every applied fix carries normal history, locking, and hook behavior. Command modules are imported lazily: plain validate runs stay read-only and never pay the mutation-stack import cost. */
/* c8 ignore start -- lazy mutation-command dispatch branches are covered by validate auto-fix integration tests */
async function applyValidateFix(
  fix: ValidateFixRecord,
  global: GlobalOptions,
  services: ValidateMutationServices,
): Promise<void> {
  switch (fix.kind) {
    case "set_resolution":
    case "set_close_reason":
    case "set_estimate":
    case "reparent":
    case "unset_parent": {
      const updateOptions: Record<string, unknown> = {
        message: VALIDATE_AUTO_FIX_MESSAGE,
      };
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
      if (!services.runUpdate) {
        throw new PmCliError(
          "Applying validate metadata/lifecycle fixes requires a runUpdate mutation service.",
          EXIT_CODE.USAGE,
        );
      }
      await services.runUpdate(fix.item_id, updateOptions, global);
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
async function applyValidateFixes(
  applicable: ValidateFixRecord[],
  global: GlobalOptions,
  services: ValidateMutationServices,
): Promise<{
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
        await applyValidateFix(fix, global, services);
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
      .filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      );
    try {
      if (first.kind === "prune_file_link") {
        await runFiles(
          first.item_id,
          { remove, message: VALIDATE_AUTO_FIX_MESSAGE },
          global,
        );
      } else {
        await runDocs(
          first.item_id,
          { remove, message: VALIDATE_AUTO_FIX_MESSAGE },
          global,
        );
      }
      applied.push(...batch);
    } catch (error) {
      failed.push(...batch.map((fix) => ({ fix, error })));
    }
  }

  return { applied, failed };
}
/* c8 ignore stop */

/** Public contract for test only validate command, shared by SDK and presentation-layer consumers. */
export const _testOnlyValidateCommand = {
  applyValidateFix,
  applyValidateFixes,
  attachValidateFixHints,
  buildCommandReferencesCheck,
  buildDependencyReferencesCheck,
  buildCloseReasonBackfillRows,
  buildFilesCheck,
  buildLifecycleCheck,
  buildLifecycleDependencyGraph,
  buildLifecycleParentGraph,
  buildEstimateBackfillRows,
  buildMetadataCounts,
  buildMissingFieldOccurrences,
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
  linkedArtifactPathExceedsFilesystemLimits,
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

type LoadedValidateSettings = Awaited<ReturnType<typeof readSettings>>;

interface ValidateCheckExecutionState {
  checks: ValidateCheck[];
  warnings: string[];
  closeReasonBackfillRows: CloseReasonBackfillRow[];
  estimateBackfillRows: EstimateBackfillRow[];
  resolutionBackfillRows: ResolutionBackfillRow[];
  terminalParentFixRows: TerminalParentFixRow[];
  staleLinkPruneRows: StaleLinkPruneRow[];
}

function recordValidateCheck(
  state: ValidateCheckExecutionState,
  built: { check: ValidateCheck; warnings: string[] },
  fixHintsEnabled: boolean,
): void {
  if (fixHintsEnabled) {
    attachValidateFixHints(built.check, built.warnings);
  }
  state.checks.push(built.check);
  state.warnings.push(...built.warnings);
}

async function executeRequestedValidateChecks(params: {
  requestedChecks: Set<ValidateCheckName>;
  options: ValidateCommandOptions;
  global: GlobalOptions;
  pmRoot: string;
  workspaceRoot: string;
  settings: LoadedValidateSettings;
  items: ItemWithBody[];
  statusRegistry: RuntimeStatusRegistry;
  metadataPolicy: ValidateMetadataPolicy;
  lifecyclePatternPolicy: LifecyclePatternPolicy;
  dependencyCycleSeverity: ValidateDependencyCycleSeverity;
  parentCycleSeverity: ValidateDependencyCycleSeverity;
  fileScanMode: ValidateFileScanMode;
  initialWarnings: string[];
}): Promise<ValidateCheckExecutionState> {
  const state: ValidateCheckExecutionState = {
    checks: [],
    warnings: [...params.initialWarnings],
    closeReasonBackfillRows: [],
    estimateBackfillRows: [],
    resolutionBackfillRows: [],
    terminalParentFixRows: [],
    staleLinkPruneRows: [],
  };
  const fixHintsEnabled = params.options.fixHints === true;
  const fullDiagnostics =
    params.options.verboseDiagnostics === true ||
    params.options.allAffectedIds === true ||
    params.global.json === true;
  if (params.requestedChecks.has("metadata")) {
    const built = buildMetadataCheck(
      params.items,
      params.metadataPolicy,
      params.statusRegistry,
      fullDiagnostics,
    );
    state.closeReasonBackfillRows = built.closeReasonBackfillRows;
    state.estimateBackfillRows = built.estimateBackfillRows;
    recordValidateCheck(state, built, fixHintsEnabled);
  }
  if (params.requestedChecks.has("resolution")) {
    const built = buildResolutionCheck(
      params.items,
      params.statusRegistry,
      fullDiagnostics,
    );
    state.resolutionBackfillRows = built.resolutionBackfillRows;
    recordValidateCheck(state, built, fixHintsEnabled);
  }
  if (params.requestedChecks.has("lifecycle")) {
    const built = buildLifecycleCheck(
      params.items,
      Boolean(params.options.checkStaleBlockers),
      params.dependencyCycleSeverity,
      params.parentCycleSeverity,
      params.statusRegistry,
      params.lifecyclePatternPolicy,
      fullDiagnostics,
      params.settings.id_prefix,
    );
    state.terminalParentFixRows = built.terminalParentFixRows;
    recordValidateCheck(state, built, fixHintsEnabled);
    recordValidateCheck(
      state,
      buildDependencyReferencesCheck(
        params.items,
        fullDiagnostics,
        params.statusRegistry,
      ),
      fixHintsEnabled,
    );
  }
  if (params.requestedChecks.has("files")) {
    const built = await buildFilesCheck(
      params.items,
      params.workspaceRoot,
      params.pmRoot,
      params.fileScanMode,
      Boolean(params.options.includePmInternals),
      Boolean(params.options.verboseFileLists),
    );
    state.staleLinkPruneRows = built.staleLinkPruneRows;
    recordValidateCheck(state, built, fixHintsEnabled);
  }
  if (params.requestedChecks.has("command_references")) {
    recordValidateCheck(
      state,
      buildCommandReferencesCheck(
        params.items,
        params.settings.id_prefix,
        fullDiagnostics,
      ),
      fixHintsEnabled,
    );
  }
  if (params.requestedChecks.has("history_drift")) {
    recordValidateCheck(
      state,
      await buildHistoryDriftCheck(
        params.pmRoot,
        params.items,
        fullDiagnostics,
      ),
      fixHintsEnabled,
    );
  }
  if (params.requestedChecks.has("format_version")) {
    recordValidateCheck(
      state,
      buildFormatVersionCheck(params.items, fullDiagnostics),
      fixHintsEnabled,
    );
  }
  return state;
}

function planValidateFixes(
  options: ValidateCommandOptions,
  state: ValidateCheckExecutionState,
  settings: LoadedValidateSettings,
): ValidateFixRecord[] {
  const planned: ValidateFixRecord[] = [];
  if (options.autoFix === true) {
    planned.push(
      ...planCloseReasonBackfillFixes(state.closeReasonBackfillRows),
    );
    planned.push(...planResolutionBackfillFixes(state.resolutionBackfillRows));
    planned.push(
      ...planEstimateBackfillFixes(
        state.estimateBackfillRows,
        settings.validation.estimate_defaults_by_type,
      ),
    );
    planned.push(...planTerminalParentFixes(state.terminalParentFixRows));
  }
  if (options.pruneMissing === true) {
    planned.push(...planStaleLinkPruneFixes(state.staleLinkPruneRows));
  }
  return planned;
}

/* v8 ignore start -- validate fix-summary matrix is covered end-to-end; direct helper fallback branches are defensive */
async function buildValidateFixesSummary(
  options: ValidateCommandOptions,
  state: ValidateCheckExecutionState,
  settings: LoadedValidateSettings,
  grantedFixScopes: Set<ValidateFixScope>,
  global: GlobalOptions,
  services: ValidateMutationServices,
): Promise<ValidateFixesSummary | undefined> {
  if (options.autoFix !== true && options.pruneMissing !== true) {
    return undefined;
  }
  const planned = planValidateFixes(options, state, settings);
  const { applicable, gated } = partitionFixesByGrant(
    planned,
    grantedFixScopes,
  );
  const dryRun = options.dryRun === true;
  const appliedFixRows: Array<Record<string, unknown>> = [];
  const failedFixRows: Array<Record<string, unknown>> = [];
  if (!dryRun) {
    const applied = await applyValidateFixes(applicable, global, services);
    appliedFixRows.push(...applied.applied.map(toFixOutputRow));
    failedFixRows.push(
      ...applied.failed.map(({ fix, error }) => ({
        ...toFixOutputRow(fix),
        error: error instanceof Error ? error.message : String(error),
      })),
    );
  }
  return {
    mode: dryRun ? "dry_run" : "apply",
    auto_fix: options.autoFix === true,
    prune_missing: options.pruneMissing === true,
    granted_fix_scopes: [...grantedFixScopes].sort((left, right) =>
      left.localeCompare(right),
    ),
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
/* v8 ignore stop */

/* c8 ignore start -- validate orchestration + fix-application matrices are covered by end-to-end command integration runs */
/** Implements run validate for the public runtime surface of this module. */
export async function runValidate(
  options: ValidateCommandOptions,
  global: GlobalOptions,
  services: ValidateMutationServices = {},
): Promise<ValidateResult> {
  const fixesRequested =
    options.autoFix === true || options.pruneMissing === true;
  if (options.dryRun === true && !fixesRequested) {
    throw new PmCliError(
      "--dry-run requires --auto-fix or --prune-missing (there is nothing to preview otherwise).",
      EXIT_CODE.USAGE,
    );
  }
  if (
    options.fixScope !== undefined &&
    options.fixScope.length > 0 &&
    options.autoFix !== true
  ) {
    throw new PmCliError("--fix-scope requires --auto-fix.", EXIT_CODE.USAGE);
  }
  // Resolved up-front so unknown --fix-scope values fail fast before any scan.
  const grantedFixScopes = resolveGrantedFixScopes(options.fixScope);
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }

  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const itemReadWarnings: string[] = [];
  const items = await listAllItemMetadataWithBody(
    pmRoot,
    settings.item_format,
    typeRegistry.type_to_folder,
    itemReadWarnings,
    settings.schema,
  );
  const requestedChecks = resolveRequestedChecks(options);
  if (requestedChecks.has("history_drift")) {
    const authorAttribution = await scanHistoryAuthorAttribution(pmRoot);
    if (authorAttribution.actionable_unknown_event_count > 0) {
      itemReadWarnings.push(
        `validate_history_unknown_author_events:${authorAttribution.actionable_unknown_event_count}`,
      );
    }
  }
  const metadataProfileSource: "default" | "settings" | "option" =
    typeof options.metadataProfile === "string" ? "option" : "settings";
  const metadataProfile = resolveValidateMetadataProfile(
    typeof options.metadataProfile === "string"
      ? options.metadataProfile
      : settings.validation.metadata_profile,
  );
  const metadataPolicy = resolveValidateMetadataPolicy(
    metadataProfile,
    metadataProfileSource,
    settings.validation.metadata_required_fields,
  );
  const lifecyclePatternPolicy = resolveLifecyclePatternPolicy(settings);
  const dependencyCycleSeverity = resolveDependencyCycleSeverity(
    options.dependencyCycleSeverity,
  );
  const parentCycleSeverity = resolveParentCycleSeverity(
    options.parentCycleSeverity,
  );
  const fileScanMode = resolveFileScanMode(options.scanMode);
  const workspaceRoot = resolveWorkspaceRoot(pmRoot);
  const state = await executeRequestedValidateChecks({
    requestedChecks,
    options,
    global,
    pmRoot,
    workspaceRoot,
    settings,
    items,
    statusRegistry,
    metadataPolicy,
    lifecyclePatternPolicy,
    dependencyCycleSeverity,
    parentCycleSeverity,
    fileScanMode,
    initialWarnings: [...new Set(itemReadWarnings)],
  });

  // Remediation phase (pm-c3sz / pm-8jss / pm-0v2m). Plans are derived from
  // the findings of THIS run; checks above always report the pre-fix state.
  // Safe field backfills apply by default under --auto-fix; gated lifecycle
  // fixes are planned but withheld unless --fix-scope lifecycle grants them;
  // --dry-run previews without mutating; failures never abort the run.
  const fixes = fixesRequested
    ? await buildValidateFixesSummary(
        options,
        state,
        settings,
        grantedFixScopes,
        global,
        services,
      )
    : undefined;

  const normalizedWarnings = [...new Set(state.warnings)].sort((left, right) =>
    left.localeCompare(right),
  );
  const hasErrors = state.checks.some((check) => check.status === "error");
  return {
    ok: !hasErrors,
    has_warnings: normalizedWarnings.length > 0,
    checks: state.checks,
    warnings: normalizedWarnings,
    ...(fixes !== undefined ? { fixes } : {}),
    generated_at: nowIso(),
  };
}
/* c8 ignore stop */
