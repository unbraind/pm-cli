/**
 * @module sdk/defect-recurrence
 *
 * Compiles versioned defect-recurrence policy into an incremental index and
 * explains which local and hosted checks a proposed change must run.
 */
import { createHash } from "node:crypto";

import { stableStringify } from "../../core/shared/serialization.js";
import type { AssuranceItemRecord } from "./assurance.js";

/** Stable defect escape taxonomy used by project policy and PM metadata. */
export const DEFECT_ESCAPE_CLASSES = [
  "production_defect",
  "nightly_regression",
  "scanner_finding",
  "review_caught_late",
] as const;

/** Evidence dispositions accepted by the fail-closed defect gate. */
export const DEFECT_GATE_EVIDENCE_DISPOSITIONS = [
  "gate_added",
  "gate_strengthened",
  "explicit_waiver",
] as const;

/** Defect escape classification. */
export type DefectEscapeClass = (typeof DEFECT_ESCAPE_CLASSES)[number];

/** Distinguishes a concrete assurance improvement from a reviewed exception. */
export type DefectGateEvidenceDisposition =
  (typeof DEFECT_GATE_EVIDENCE_DISPOSITIONS)[number];

/** Structured proof attached to a terminal defect item. */
export interface DefectGateEvidence {
  /** Whether a gate was added, strengthened, or explicitly waived. */
  disposition: DefectGateEvidenceDisposition;
  /** Stable gate identifier, except for an explicit waiver. */
  gate_id?: string;
  /** Runnable negative-control command that proves the gate can fail. */
  negative_control?: string;
  /** Local checks selected by the same recurrence policy as hosted checks. */
  local_checks?: string[];
  /** Hosted checks selected by the same recurrence policy as local checks. */
  hosted_checks?: string[];
  /** Accountable owner of the gate or waiver. */
  owner: string;
  /** Concrete reason for an explicit waiver. */
  waiver_reason?: string;
  /** ISO timestamp after which an explicit waiver is invalid. */
  waiver_expires_at?: string;
}

/** Signals that associate a family with source changes or PM context. */
export interface DefectRecurrenceTriggers {
  /** Repository-relative glob patterns. */
  file_patterns?: string[];
  /** Package names or workspace package paths. */
  package_names?: string[];
  /** Canonical PM item ids. */
  item_ids?: string[];
  /** PM tags. */
  tags?: string[];
  /** Stable error-code contracts. */
  error_codes?: string[];
}

/** Local and hosted checks selected together for one recurrence family. */
export interface DefectRecurrenceChecks {
  /** Fast checks suitable for local development. */
  local: string[];
  /** Hosted checks that add independent or environment-specific evidence. */
  hosted: string[];
}

/** Budget that makes an assurance family measurable over time. */
export interface DefectRecurrenceBudget {
  /** Maximum accepted escaped-defect rate. */
  max_escape_rate: number;
  /** Maximum accepted false-positive rate. */
  max_false_positive_rate: number;
}

/** Versioned recurrence policy for one historically observed defect family. */
export interface DefectRecurrenceFamily {
  /** Stable family identifier. */
  id: string;
  /** Monotonic family contract version. */
  version: number;
  /** Concise human-readable title. */
  title: string;
  /** PM item accountable for maintaining this family. */
  owner_item_id: string;
  /** Escape class represented by the historical examples. */
  escape_class: DefectEscapeClass;
  /** Signals that select this family. */
  triggers: DefectRecurrenceTriggers;
  /** Shared local and hosted assurance policy. */
  checks: DefectRecurrenceChecks;
  /** Input that must select this family during policy validation. */
  negative_control: DefectChangeRiskInput;
  /** Historical items that justify the family. */
  historical_item_ids: string[];
  /** Quantitative escape and false-positive budgets. */
  budget: DefectRecurrenceBudget;
}

/** Repository recurrence policy serialized by a project or extension. */
export interface DefectRecurrencePolicy {
  /** Serialized policy format version. */
  version: 1;
  /** ISO instant after which terminal defects require structured evidence. */
  evidence_epoch: string;
  /** Versioned recurrence families. */
  families: DefectRecurrenceFamily[];
}

/** Input used to explain assurance requirements for a proposed change. */
export interface DefectChangeRiskInput {
  /** Changed repository-relative files. */
  files?: string[];
  /** Changed package names or workspace package paths. */
  package_names?: string[];
  /** PM items in the change lineage. */
  item_ids?: string[];
  /** PM tags in the change lineage. */
  tags?: string[];
  /** Error-code contracts touched by the change. */
  error_codes?: string[];
}

/** Options for a full or incremental recurrence-index build. */
export interface BuildDefectRecurrenceIndexOptions {
  /** Previous index whose unaffected item mappings can be reused. */
  previous_index?: DefectRecurrenceIndex;
  /** Item ids replaced by the supplied item projection. */
  changed_item_ids?: string[];
}

/** Deterministic recurrence index shared by CLI, SDK, MCP, and CI. */
export interface DefectRecurrenceIndex {
  /** Index format version. */
  version: 1;
  /** Hash of the policy used to build the index. */
  policy_fingerprint: string;
  /** Hash of policy plus deterministic item-to-family contributions. */
  index_fingerprint: string;
  /** Stable family definitions. */
  families: DefectRecurrenceFamily[];
  /** Sparse PM item-to-family index. */
  item_families: Record<string, string[]>;
  /** Build-cost receipt. */
  build: {
    /** Items inspected during this build. */
    items_scanned: number;
    /** Unchanged item mappings reused from a previous index. */
    items_reused: number;
    /** Items with at least one recurrence family. */
    items_indexed: number;
  };
}

/** One explainable reason that selected an assurance family. */
export interface DefectChangeRiskReason {
  /** Signal category that matched. */
  signal: "file" | "package" | "item" | "tag" | "error_code";
  /** Submitted signal value. */
  value: string;
  /** Policy trigger or indexed item that matched. */
  matched: string;
}

/** One selected recurrence family and its evidence requirements. */
export interface DefectChangeRiskMatch {
  /** Stable family identifier. */
  family_id: string;
  /** Family contract version. */
  family_version: number;
  /** Accountable PM item. */
  owner_item_id: string;
  /** Historical escape class. */
  escape_class: DefectEscapeClass;
  /** Exact selection reasons. */
  reasons: DefectChangeRiskReason[];
  /** Required local checks. */
  local_checks: string[];
  /** Required hosted checks. */
  hosted_checks: string[];
  /** Quantitative policy budget. */
  budget: DefectRecurrenceBudget;
}

/** Pagination controls for bounded change-risk output. */
export interface AnalyzeDefectChangeRiskOptions {
  /** Opaque cursor returned by a previous report. */
  cursor?: string;
  /** Maximum family rows returned, from 1 through 100. */
  limit?: number;
}

/** Serialized assurance-risk request shared by CLI, SDK, and MCP transports. */
export interface DefectChangeRiskRequest {
  /** Project- or package-owned recurrence policy. */
  policy: DefectRecurrencePolicy;
  /** Proposed source and PM-context changes. */
  change: DefectChangeRiskInput;
  /** Opaque cursor returned by a previous report. */
  cursor?: string;
  /** Maximum family rows returned, from 1 through 100. */
  limit?: number;
}

/** Bounded and explainable change-risk report. */
export interface DefectChangeRiskReport {
  /** Whether at least one historical family was selected. */
  risk_detected: boolean;
  /** Stable recurrence-index identity. */
  index_fingerprint: string;
  /** Current page of selected families. */
  items: DefectChangeRiskMatch[];
  /** Total selected families before pagination. */
  total: number;
  /** Opaque continuation cursor when rows remain. */
  next_cursor?: string;
  /** Deduplicated local checks across every selected family. */
  required_local_checks: string[];
  /** Deduplicated hosted checks across every selected family. */
  required_hosted_checks: string[];
  /** Deterministic analysis-cost receipt. */
  cost: {
    /** Families evaluated. */
    families_evaluated: number;
    /** Submitted signals evaluated against the policy. */
    signals_evaluated: number;
    /** Selected families before pagination. */
    families_selected: number;
    /** Approximate JSON-token cost of the bounded response. */
    estimated_output_tokens: number;
  };
  /** Stable collection selector for agent consumers. */
  row_contract: { row_keys: ["items"]; jq_selector: ".items[]" };
}

/** One fail-closed defect-evidence finding. */
export interface DefectGateEvidenceFinding {
  /** PM item missing or carrying invalid evidence. */
  item_id: string;
  /** Stable machine-readable finding kind. */
  kind:
    | "missing_escape_class"
    | "invalid_escape_class"
    | "invalid_completion_timestamp"
    | "missing_gate_evidence"
    | "invalid_gate_evidence"
    | "expired_waiver";
  /** Actionable explanation. */
  detail: string;
}

/** Fail-closed governance report for terminal defects after the policy epoch. */
export interface DefectGateEvidenceReport {
  /** Whether every governed defect carried valid evidence. */
  ok: boolean;
  /** Terminal defect items governed by the epoch. */
  governed_item_count: number;
  /** Terminal defects carrying a recognized historical escape classification. */
  classified_item_count: number;
  /** Historical and epoch-governed counts by required escape class. */
  class_counts: Record<DefectEscapeClass, number>;
  /** Historical and epoch-governed counts by evidence disposition. */
  evidence_disposition_counts: Record<DefectGateEvidenceDisposition, number>;
  /** Stable sorted findings. */
  findings: DefectGateEvidenceFinding[];
}

const MAX_FILE_PATTERN_LENGTH = 256;
const MAX_COMPILED_PATH_PATTERNS = 1_024;
const compiledPathPatterns = new Map<string, RegExp>();
const CHANGE_INPUT_FIELDS = [
  "files",
  "package_names",
  "item_ids",
  "tags",
  "error_codes",
] as const;

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => (left < right ? -1 : 1),
  );
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function assertNonEmpty(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function assertChangeInput(
  value: unknown,
  field: string,
): DefectChangeRiskInput {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  for (const key of CHANGE_INPUT_FIELDS) {
    if (value[key] !== undefined && !isStringArray(value[key])) {
      throw new TypeError(`${field}.${key} must be an array of strings`);
    }
  }
  return value as DefectChangeRiskInput;
}

function assertTriggers(
  value: unknown,
  familyId: string,
): asserts value is DefectRecurrenceTriggers {
  if (!isRecord(value)) {
    throw new TypeError(
      `defect recurrence family ${familyId} triggers must be an object`,
    );
  }
  for (const key of [
    "package_names",
    "item_ids",
    "tags",
    "error_codes",
  ] as const) {
    if (value[key] !== undefined && !isStringArray(value[key])) {
      throw new TypeError(
        `defect recurrence family ${familyId} triggers.${key} must be an array of strings`,
      );
    }
  }
  const filePatterns = value.file_patterns;
  if (filePatterns !== undefined && !isStringArray(filePatterns)) {
    throw new TypeError(
      `defect recurrence family ${familyId} triggers.file_patterns must be an array of strings`,
    );
  }
  for (const pattern of filePatterns ?? []) {
    if (pattern.length > MAX_FILE_PATTERN_LENGTH) {
      throw new TypeError(
        `defect recurrence family ${familyId} file pattern exceeds ${MAX_FILE_PATTERN_LENGTH} characters`,
      );
    }
  }
}

/** Validate stable identity fields and reject duplicate family ids. */
function assertFamilyIdentity(
  family: DefectRecurrenceFamily,
  ids: Set<string>,
): void {
  assertNonEmpty(family.id, "defect recurrence family id");
  if (ids.has(family.id)) {
    throw new TypeError(`Duplicate defect recurrence family ${family.id}`);
  }
  ids.add(family.id);
  if (!Number.isInteger(family.version) || family.version < 1) {
    throw new TypeError(
      `defect recurrence family ${family.id} version must be a positive integer`,
    );
  }
  if (!DEFECT_ESCAPE_CLASSES.includes(family.escape_class)) {
    throw new TypeError(
      `defect recurrence family ${family.id} has an invalid escape class`,
    );
  }
  assertNonEmpty(family.title, `defect recurrence family ${family.id} title`);
  assertNonEmpty(
    family.owner_item_id,
    `defect recurrence family ${family.id} owner_item_id`,
  );
}

/** Validate historical lineage and executable local and hosted check references. */
function assertFamilyEvidenceContracts(family: DefectRecurrenceFamily): void {
  if (
    !isStringArray(family.historical_item_ids) ||
    family.historical_item_ids.length === 0 ||
    family.historical_item_ids.some((itemId) => !itemId.trim())
  ) {
    throw new TypeError(
      `defect recurrence family ${family.id} requires historical_item_ids`,
    );
  }
  assertTriggers(family.triggers, family.id);
  if (
    !isRecord(family.checks) ||
    !isStringArray(family.checks.local) ||
    !isStringArray(family.checks.hosted) ||
    family.checks.local.some((check) => !check.trim()) ||
    family.checks.hosted.some((check) => !check.trim())
  ) {
    throw new TypeError(
      `defect recurrence family ${family.id} checks must contain local and hosted string arrays`,
    );
  }
}

/** Validate finite normalized escape and false-positive budgets. */
function assertFamilyBudget(family: DefectRecurrenceFamily): void {
  if (
    !isRecord(family.budget) ||
    typeof family.budget.max_escape_rate !== "number" ||
    !Number.isFinite(family.budget.max_escape_rate) ||
    typeof family.budget.max_false_positive_rate !== "number" ||
    !Number.isFinite(family.budget.max_false_positive_rate)
  ) {
    throw new TypeError(
      `defect recurrence family ${family.id} requires numeric budgets`,
    );
  }
  if (
    family.budget.max_escape_rate < 0 ||
    family.budget.max_escape_rate > 1 ||
    family.budget.max_false_positive_rate < 0 ||
    family.budget.max_false_positive_rate > 1
  ) {
    throw new TypeError(
      `defect recurrence family ${family.id} budgets must be between 0 and 1`,
    );
  }
}

/** Validate that a structurally safe negative control selects its own family. */
function assertFamilyNegativeControl(family: DefectRecurrenceFamily): void {
  const negativeControl = assertChangeInput(
    family.negative_control,
    `defect recurrence family ${family.id} negative_control`,
  );
  if (familyReasons(family, negativeControl, {}).length === 0) {
    throw new TypeError(
      `defect recurrence family ${family.id} negative_control must select its own family`,
    );
  }
}

/** Validate the complete recurrence policy before indexing or analysis. */
function validatePolicy(policy: DefectRecurrencePolicy): void {
  if (policy.version !== 1) {
    throw new TypeError(
      `Unsupported defect recurrence policy version ${policy.version}`,
    );
  }
  if (
    typeof policy.evidence_epoch !== "string" ||
    !Number.isFinite(Date.parse(policy.evidence_epoch))
  ) {
    throw new TypeError(
      "defect recurrence evidence_epoch must be an ISO timestamp",
    );
  }
  const ids = new Set<string>();
  for (const family of policy.families) {
    if (!isRecord(family))
      throw new TypeError("defect recurrence family must be an object");
    assertFamilyIdentity(family, ids);
    assertFamilyEvidenceContracts(family);
    assertFamilyBudget(family);
    assertFamilyNegativeControl(family);
  }
}

function pathMatches(pattern: string, value: string): boolean {
  let compiled = compiledPathPatterns.get(pattern);
  if (compiled === undefined) {
    if (compiledPathPatterns.size >= MAX_COMPILED_PATH_PATTERNS) {
      const oldest = compiledPathPatterns.keys().next().value;
      compiledPathPatterns.delete(oldest!);
    }
    const escaped = pattern
      .replaceAll("**", "\u0000")
      .replaceAll(/[|\\{}()[\]^$+?./]/gu, "\\$&")
      .replaceAll("*", "[^/]*")
      .replaceAll("\u0000", ".*");
    compiled = new RegExp(`^${escaped}$`, "u");
    compiledPathPatterns.set(pattern, compiled);
  }
  return compiled.test(value);
}

function itemSignals(item: AssuranceItemRecord): DefectChangeRiskInput {
  const files = (item.files ?? []).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return [];
    const value = (entry as { path?: unknown }).path;
    return typeof value === "string" ? [value] : [];
  });
  const packageNames = Array.isArray(item.package_names)
    ? item.package_names.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const errorCodes = Array.isArray(item.error_codes)
    ? item.error_codes.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  return {
    files,
    package_names: packageNames,
    item_ids: [item.id],
    tags: Array.isArray(item.tags)
      ? item.tags.filter((value): value is string => typeof value === "string")
      : [],
    error_codes: errorCodes,
  };
}

function fileReasons(
  family: DefectRecurrenceFamily,
  input: DefectChangeRiskInput,
): DefectChangeRiskReason[] {
  const reasons: DefectChangeRiskReason[] = [];
  const patterns = uniqueSorted(family.triggers.file_patterns ?? []);
  for (const file of uniqueSorted(input.files ?? [])) {
    for (const pattern of patterns) {
      if (pathMatches(pattern, file))
        reasons.push({ signal: "file", value: file, matched: pattern });
    }
  }
  return reasons;
}

function exactReasons(
  family: DefectRecurrenceFamily,
  input: DefectChangeRiskInput,
): DefectChangeRiskReason[] {
  const exactSignals: Array<{
    signal: "package" | "tag" | "error_code";
    values: string[];
    triggers: string[];
  }> = [
    {
      signal: "package",
      values: uniqueSorted(input.package_names ?? []),
      triggers: uniqueSorted(family.triggers.package_names ?? []),
    },
    {
      signal: "tag",
      values: uniqueSorted(input.tags ?? []),
      triggers: uniqueSorted(family.triggers.tags ?? []),
    },
    {
      signal: "error_code",
      values: uniqueSorted(input.error_codes ?? []),
      triggers: uniqueSorted(family.triggers.error_codes ?? []),
    },
  ];
  const reasons: DefectChangeRiskReason[] = [];
  for (const exact of exactSignals) {
    const triggerSet = new Set(exact.triggers);
    for (const value of exact.values) {
      if (triggerSet.has(value))
        reasons.push({ signal: exact.signal, value, matched: value });
    }
  }
  return reasons;
}

function itemReasons(
  family: DefectRecurrenceFamily,
  input: DefectChangeRiskInput,
  itemFamilies: Readonly<Record<string, string[]>>,
): DefectChangeRiskReason[] {
  const directItemIds = new Set(family.triggers.item_ids ?? []);
  return uniqueSorted(input.item_ids ?? []).flatMap((itemId) =>
    directItemIds.has(itemId) || itemFamilies[itemId]?.includes(family.id)
      ? [{ signal: "item" as const, value: itemId, matched: family.id }]
      : [],
  );
}

function familyReasons(
  family: DefectRecurrenceFamily,
  input: DefectChangeRiskInput,
  itemFamilies: Readonly<Record<string, string[]>>,
): DefectChangeRiskReason[] {
  const reasons = [
    ...fileReasons(family, input),
    ...exactReasons(family, input),
    ...itemReasons(family, input, itemFamilies),
  ];
  return reasons.sort((left, right) =>
    left.signal !== right.signal
      ? left.signal.localeCompare(right.signal)
      : left.value !== right.value
        ? left.value.localeCompare(right.value)
        : left.matched.localeCompare(right.matched),
  );
}

function readRiskCursorOffset(
  cursor: string | undefined,
  indexFingerprint: string,
): number {
  if (!cursor) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("defect change-risk cursor is invalid");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { index_fingerprint?: unknown }).index_fingerprint !==
      indexFingerprint ||
    !Number.isInteger((parsed as { offset?: unknown }).offset) ||
    (parsed as { offset: number }).offset < 0
  ) {
    throw new TypeError("defect change-risk cursor does not match this index");
  }
  return (parsed as { offset: number }).offset;
}

function changeSignalCount(input: DefectChangeRiskInput): number {
  return [
    input.files,
    input.package_names,
    input.item_ids,
    input.tags,
    input.error_codes,
  ].reduce((total, values) => total + (values?.length ?? 0), 0);
}

/** Compile deterministic policy and PM metadata into a sparse incremental index. */
export function buildDefectRecurrenceIndex(
  policy: DefectRecurrencePolicy,
  items: readonly AssuranceItemRecord[],
  options: BuildDefectRecurrenceIndexOptions = {},
): DefectRecurrenceIndex {
  validatePolicy(policy);
  const families = [...policy.families].sort((left, right) =>
    left.id < right.id ? -1 : 1,
  );
  const policyFingerprint = fingerprint({ ...policy, families });
  const changed = new Set(options.changed_item_ids ?? []);
  const canReuse =
    options.previous_index?.policy_fingerprint === policyFingerprint;
  const itemFamilies: Record<string, string[]> = canReuse
    ? Object.fromEntries(
        Object.entries(options.previous_index?.item_families ?? {}).filter(
          ([itemId]) => !changed.has(itemId),
        ),
      )
    : {};
  const itemsReused = canReuse ? Object.keys(itemFamilies).length : 0;
  for (const item of items) {
    const signals = itemSignals(item);
    const matched = families
      .filter(
        (family) =>
          family.historical_item_ids.includes(item.id) ||
          familyReasons(family, signals, {}).length > 0,
      )
      .map((family) => family.id);
    if (matched.length > 0) itemFamilies[item.id] = matched;
    else delete itemFamilies[item.id];
  }
  const sortedItemFamilies = Object.fromEntries(
    Object.entries(itemFamilies)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([itemId, familyIds]) => [itemId, uniqueSorted(familyIds)]),
  );
  return {
    version: 1,
    policy_fingerprint: policyFingerprint,
    index_fingerprint: fingerprint({
      policy_fingerprint: policyFingerprint,
      item_families: sortedItemFamilies,
    }),
    families,
    item_families: sortedItemFamilies,
    build: {
      items_scanned: items.length,
      items_reused: itemsReused,
      items_indexed: Object.keys(sortedItemFamilies).length,
    },
  };
}

/** Explain recurrence families and shared local/hosted checks for one change. */
export function analyzeDefectChangeRisk(
  index: DefectRecurrenceIndex,
  input: DefectChangeRiskInput,
  options: AnalyzeDefectChangeRiskOptions = {},
): DefectChangeRiskReport {
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError(
      "defect change-risk limit must be an integer from 1 through 100",
    );
  }
  const offset = readRiskCursorOffset(options.cursor, index.index_fingerprint);
  const matches = index.families.flatMap((family) => {
    const reasons = familyReasons(family, input, index.item_families);
    return reasons.length === 0
      ? []
      : [
          {
            family_id: family.id,
            family_version: family.version,
            owner_item_id: family.owner_item_id,
            escape_class: family.escape_class,
            reasons,
            local_checks: uniqueSorted(family.checks.local),
            hosted_checks: uniqueSorted(family.checks.hosted),
            budget: family.budget,
          },
        ];
  });
  const page = matches.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const nextCursor =
    nextOffset < matches.length
      ? Buffer.from(
          JSON.stringify({
            index_fingerprint: index.index_fingerprint,
            offset: nextOffset,
          }),
        ).toString("base64url")
      : undefined;
  const reportWithoutCost = {
    risk_detected: matches.length > 0,
    index_fingerprint: index.index_fingerprint,
    items: page,
    total: matches.length,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    required_local_checks: uniqueSorted(
      matches.flatMap((match) => match.local_checks),
    ),
    required_hosted_checks: uniqueSorted(
      matches.flatMap((match) => match.hosted_checks),
    ),
    row_contract: {
      row_keys: ["items"] as ["items"],
      jq_selector: ".items[]" as const,
    },
  };
  return {
    ...reportWithoutCost,
    cost: {
      families_evaluated: index.families.length,
      signals_evaluated: changeSignalCount(input),
      families_selected: matches.length,
      estimated_output_tokens: Math.ceil(
        JSON.stringify(reportWithoutCost).length / 4,
      ),
    },
  };
}

function isDefectItem(item: AssuranceItemRecord): boolean {
  return (
    item.type.toLowerCase() === "issue" ||
    (Array.isArray(item.tags) ? item.tags : []).some(
      (tag) =>
        typeof tag === "string" &&
        ["bug", "defect", "security"].includes(tag.toLowerCase()),
    )
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every(nonEmptyString)
  );
}

function validEvidence(
  value: unknown,
  nowMs: number,
): { valid: boolean; expired: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, expired: false };
  }
  const evidence = value as Partial<DefectGateEvidence>;
  if (
    !DEFECT_GATE_EVIDENCE_DISPOSITIONS.includes(
      evidence.disposition as DefectGateEvidenceDisposition,
    ) ||
    typeof evidence.owner !== "string" ||
    !evidence.owner.trim()
  ) {
    return { valid: false, expired: false };
  }
  if (evidence.disposition === "explicit_waiver") {
    const expiry = Date.parse(evidence.waiver_expires_at ?? "");
    return {
      valid:
        nonEmptyString(evidence.waiver_reason) &&
        Number.isFinite(expiry) &&
        expiry >= nowMs,
      expired: Number.isFinite(expiry) && expiry < nowMs,
    };
  }
  return {
    valid:
      nonEmptyString(evidence.gate_id) &&
      nonEmptyString(evidence.negative_control) &&
      nonEmptyStringArray(evidence.local_checks) &&
      nonEmptyStringArray(evidence.hosted_checks),
    expired: false,
  };
}

function evidenceFindings(
  item: AssuranceItemRecord,
  nowMs: number,
): DefectGateEvidenceFinding[] {
  const findings: DefectGateEvidenceFinding[] = [];
  if (
    !Number.isFinite(
      Date.parse(
        typeof item.completed_at === "string" ? item.completed_at : "",
      ),
    ) &&
    !Number.isFinite(
      Date.parse(typeof item.closed_at === "string" ? item.closed_at : ""),
    )
  ) {
    findings.push({
      item_id: item.id,
      kind: "invalid_completion_timestamp",
      detail: `${item.id} requires a valid completed_at or closed_at timestamp after the defect-evidence epoch.`,
    });
  }
  if (typeof item.escape_class !== "string") {
    findings.push({
      item_id: item.id,
      kind: "missing_escape_class",
      detail: `${item.id} requires escape_class after the defect-evidence epoch.`,
    });
  } else if (
    !DEFECT_ESCAPE_CLASSES.includes(item.escape_class as DefectEscapeClass)
  ) {
    findings.push({
      item_id: item.id,
      kind: "invalid_escape_class",
      detail: `${item.id} has unsupported escape_class ${item.escape_class}.`,
    });
  }
  if (item.gate_evidence === undefined) {
    findings.push({
      item_id: item.id,
      kind: "missing_gate_evidence",
      detail: `${item.id} requires structured gate_evidence after the defect-evidence epoch.`,
    });
    return findings;
  }
  const result = validEvidence(item.gate_evidence, nowMs);
  if (!result.valid) {
    findings.push({
      item_id: item.id,
      kind: result.expired ? "expired_waiver" : "invalid_gate_evidence",
      detail: result.expired
        ? `${item.id} carries an expired gate-evidence waiver.`
        : `${item.id} gate_evidence does not prove a gate or explicit waiver.`,
    });
  }
  return findings;
}

/** Enforce structured escape classification and gate evidence on new terminal defects. */
export function evaluateDefectGateEvidence(
  items: readonly AssuranceItemRecord[],
  policy: DefectRecurrencePolicy,
  terminalStatuses: readonly string[],
  now = new Date(),
): DefectGateEvidenceReport {
  validatePolicy(policy);
  const epochMs = Date.parse(policy.evidence_epoch);
  const terminal = new Set(terminalStatuses);
  const governed = items.filter((item) => {
    if (!terminal.has(item.status) || !isDefectItem(item)) return false;
    const completedAt = Date.parse(
      typeof item.completed_at === "string" ? item.completed_at : "",
    );
    if (Number.isFinite(completedAt)) return completedAt >= epochMs;
    const closedAt = Date.parse(
      typeof item.closed_at === "string" ? item.closed_at : "",
    );
    if (Number.isFinite(closedAt)) return closedAt >= epochMs;
    const createdAt = Date.parse(
      typeof item.created_at === "string" ? item.created_at : "",
    );
    return Number.isFinite(createdAt) && createdAt >= epochMs;
  });
  const classCounts = Object.fromEntries(
    DEFECT_ESCAPE_CLASSES.map((escapeClass) => [escapeClass, 0]),
  ) as Record<DefectEscapeClass, number>;
  const evidenceDispositionCounts = Object.fromEntries(
    DEFECT_GATE_EVIDENCE_DISPOSITIONS.map((disposition) => [disposition, 0]),
  ) as Record<DefectGateEvidenceDisposition, number>;
  const classified = items.filter(
    (item) =>
      terminal.has(item.status) &&
      isDefectItem(item) &&
      typeof item.escape_class === "string" &&
      DEFECT_ESCAPE_CLASSES.includes(item.escape_class as DefectEscapeClass),
  );
  for (const item of classified) {
    classCounts[item.escape_class as DefectEscapeClass] += 1;
    if (
      typeof item.gate_evidence === "object" &&
      item.gate_evidence !== null &&
      !Array.isArray(item.gate_evidence)
    ) {
      const disposition = (item.gate_evidence as { disposition?: unknown })
        .disposition;
      if (
        typeof disposition === "string" &&
        DEFECT_GATE_EVIDENCE_DISPOSITIONS.includes(
          disposition as DefectGateEvidenceDisposition,
        )
      ) {
        evidenceDispositionCounts[
          disposition as DefectGateEvidenceDisposition
        ] += 1;
      }
    }
  }
  const findings = governed.flatMap((item) =>
    evidenceFindings(item, now.getTime()),
  );
  findings.sort((left, right) =>
    left.item_id !== right.item_id
      ? left.item_id.localeCompare(right.item_id)
      : left.kind.localeCompare(right.kind),
  );
  return {
    ok: findings.length === 0,
    governed_item_count: governed.length,
    classified_item_count: classified.length,
    class_counts: classCounts,
    evidence_disposition_counts: evidenceDispositionCounts,
    findings,
  };
}

/** Parse an untrusted serialized policy without weakening runtime validation. */
export function parseDefectRecurrencePolicy(
  value: unknown,
): DefectRecurrencePolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("defect recurrence policy must be an object");
  }
  const policy = value as DefectRecurrencePolicy;
  if (!Array.isArray(policy.families)) {
    throw new TypeError("defect recurrence policy families must be an array");
  }
  validatePolicy(policy);
  return policy;
}

/** Parse an untrusted cross-transport change-risk request. */
export function parseDefectChangeRiskRequest(
  value: unknown,
): DefectChangeRiskRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("defect change-risk request must be an object");
  }
  const request = value as Partial<DefectChangeRiskRequest>;
  const change = assertChangeInput(
    request.change,
    "defect change-risk request.change",
  );
  if (request.cursor !== undefined && typeof request.cursor !== "string") {
    throw new TypeError("defect change-risk request.cursor must be a string");
  }
  if (request.limit !== undefined && !Number.isInteger(request.limit)) {
    throw new TypeError("defect change-risk request.limit must be an integer");
  }
  return {
    policy: parseDefectRecurrencePolicy(request.policy),
    change,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.limit === undefined ? {} : { limit: request.limit }),
  };
}
