/**
 * @module sdk/query/complete-list
 *
 * Certifies that a list result represents the complete, unfiltered workspace.
 */
import type { PmReadOutputReceipt } from "../read-output-contracts.js";
import type { ListFullResult, ListOptions, ListedItem } from "./list.js";

/** Stable reasons a purported whole-workspace list cannot be trusted. */
export const PM_COMPLETE_LIST_FINDING_CODES = [
  "invalid_envelope",
  "source_incomplete",
  "source_unchecked",
  "filtered_corpus",
  "terminal_items_excluded",
  "strict_read_unproven",
  "page_incomplete",
  "count_mismatch",
  "projection_incomplete",
  "field_omission",
  "omission_receipt_missing",
  "omission_receipt_invalid",
  "read_output_missing",
  "read_output_invalid",
  "read_output_dimensions_incomplete",
  "budget_compaction",
  "budget_omission",
  "session_projection",
  "invalid_item_id",
  "duplicate_item_id",
] as const;

/** Machine-readable reason a complete-list candidate failed certification. */
export type PmCompleteListFindingCode =
  (typeof PM_COMPLETE_LIST_FINDING_CODES)[number];

/** One independently actionable complete-list contract violation. */
export interface PmCompleteListFinding {
  /** Stable finding identifier suitable for automation. */
  code: PmCompleteListFindingCode;
  /** Concise explanation of the evidence that failed. */
  message: string;
}

/** Proof attached only after every whole-corpus invariant passes. */
export interface PmCompleteListCertificate {
  /** Certificate schema version. */
  contract_version: 1;
  /** Number of full item rows certified. */
  item_count: number;
  /** Number of distinct non-empty item identifiers certified. */
  unique_item_id_count: number;
  /** Confirms the request did not exclude closed or canceled work. */
  terminal_items_included: true;
  /** Confirms the underlying tracker scan reported complete. */
  source_complete: true;
  /** Confirms every row used the full metadata projection. */
  full_projection: true;
  /** Confirms neither field nor whole-result omission occurred. */
  no_omissions: true;
  /** Confirms no page, row, or token ceiling reduced the corpus. */
  unbounded: true;
}

/** Full list result augmented with a fail-closed whole-corpus certificate. */
export interface PmCompleteListResult extends ListFullResult {
  /** Exact proof that the returned rows represent the full tracker corpus. */
  complete_list: PmCompleteListCertificate;
  /** Mandatory universal read receipt proving unbounded, uncompacted delivery. */
  read_output: PmReadOutputReceipt;
}

/** Inspection report returned without throwing for policy and UI consumers. */
export interface PmCompleteListInspection {
  /** Whether the candidate is safe to certify as the whole tracker corpus. */
  ok: boolean;
  /** Every independently detected contract violation. */
  findings: PmCompleteListFinding[];
}

/** Failure receipt with both CLI and SDK recovery paths. */
export interface PmCompleteListFailureReceipt {
  /** Stable receipt schema version. */
  contract_version: 1;
  /** Failed contract name. */
  contract: "complete_list";
  /** Every independently detected contract violation. */
  findings: PmCompleteListFinding[];
  /** Executable recovery instructions for both public transports. */
  recovery: {
    /** Exact CLI command that requests the canonical whole corpus. */
    suggested_retry: string;
    /** Equivalent SDK operation. */
    sdk: string;
  };
}

/** Typed fail-closed error raised when whole-corpus proof is absent. */
export class PmCompleteListValidationError extends Error {
  /** Structured failure and executable recovery evidence. */
  readonly receipt: PmCompleteListFailureReceipt;

  /** Construct an immutable complete-list validation failure. */
  constructor(findings: PmCompleteListFinding[]) {
    super(
      `Complete-list certification failed: ${findings.map((finding) => finding.code).join(", ")}.`,
    );
    this.name = "PmCompleteListValidationError";
    this.receipt = {
      contract_version: 1,
      contract: "complete_list",
      findings,
      recovery: {
        suggested_retry:
          "pm list --all --output-include full --strict-read --no-truncate --output-budget unbounded --output-limit unbounded --json",
        sdk: "await client.listAllComplete()",
      },
    };
  }
}

/** Options accepted by the whole-corpus list helper. */
export interface PmCompleteListOptions {
  /** Include item bodies in addition to complete metadata. */
  includeBody?: boolean;
}

/** Build the canonical all-status, full, strict, and unbounded list request. */
export function createCompleteListOptions(
  options: PmCompleteListOptions = {},
): ListOptions & {
  excludeTerminal: false;
  full: true;
  noTruncate: true;
  outputBudget: "unbounded";
  outputLimit: "unbounded";
  strictRead: true;
} {
  return {
    excludeTerminal: false,
    full: true,
    ...(options.includeBody === undefined
      ? {}
      : { includeBody: options.includeBody }),
    noTruncate: true,
    outputBudget: "unbounded",
    outputLimit: "unbounded",
    strictRead: true,
  };
}

/** Narrow an unknown envelope fragment to a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Append one finding only when its invariant failed. */
function addFinding(
  findings: PmCompleteListFinding[],
  condition: boolean,
  code: PmCompleteListFindingCode,
  message: string,
): void {
  if (condition) findings.push({ code, message });
}

/** Append source-scan and filter-scope findings for a list envelope. */
function inspectSourceScope(
  candidate: Record<string, unknown>,
  findings: PmCompleteListFinding[],
): Record<string, unknown> {
  const completeness = isRecord(candidate.completeness)
    ? candidate.completeness
    : {};
  addFinding(
    findings,
    completeness.status === "partial",
    "source_incomplete",
    "The source scan reported unreadable tracker artifacts.",
  );
  addFinding(
    findings,
    completeness.status !== "complete" && completeness.status !== "partial",
    "source_unchecked",
    "The source scan did not prove completeness.",
  );
  const unreadableItemCount = completeness.unreadable_item_count;
  const unreadableDirectoryCount = completeness.unreadable_directory_count;
  addFinding(
    findings,
    completeness.status === "complete" &&
      (unreadableItemCount !== 0 || unreadableDirectoryCount !== 0) &&
      Number.isSafeInteger(unreadableItemCount) &&
      Number.isSafeInteger(unreadableDirectoryCount),
    "source_incomplete",
    "The source scan reports unreadable tracker artifacts despite a complete status.",
  );
  addFinding(
    findings,
    completeness.status === "complete" &&
      (!Number.isSafeInteger(unreadableItemCount) ||
        !Number.isSafeInteger(unreadableDirectoryCount) ||
        Number(unreadableItemCount) < 0 ||
        Number(unreadableDirectoryCount) < 0),
    "source_unchecked",
    "The source scan did not report safe non-negative unreadable counts.",
  );

  const filters = isRecord(candidate.filters) ? candidate.filters : {};
  const runtimeFilters = isRecord(filters.runtime_filters)
    ? filters.runtime_filters
    : {};
  const filterEchoKeys = new Set([
    "exclude_terminal",
    "include_body",
    "no_truncate",
    "runtime_filters",
    "status",
    "strict_read",
  ]);
  addFinding(
    findings,
    filters.status !== "all" ||
      Object.keys(runtimeFilters).length > 0 ||
      Object.keys(filters).some((key) => !filterEchoKeys.has(key)),
    "filtered_corpus",
    "The list did not explicitly select every lifecycle status.",
  );
  addFinding(
    findings,
    filters.exclude_terminal === true,
    "terminal_items_excluded",
    "Terminal lifecycle states were explicitly excluded.",
  );
  addFinding(
    findings,
    filters.strict_read !== true,
    "strict_read_unproven",
    "The result does not echo strict source-read enforcement.",
  );
  return filters;
}

/** Append pagination, count, projection, and field-omission findings. */
function inspectEnvelopeShape(
  candidate: Record<string, unknown> & { items: unknown[] },
  filters: Record<string, unknown>,
  findings: PmCompleteListFinding[],
): void {
  addFinding(
    findings,
    candidate.has_more !== false ||
      candidate.next_cursor !== null ||
      candidate.truncated !== false ||
      candidate.applied_limit !== undefined ||
      filters.no_truncate !== true,
    "page_incomplete",
    "Pagination or a row ceiling may have withheld items.",
  );
  addFinding(
    findings,
    candidate.count !== candidate.items.length ||
      candidate.total !== candidate.items.length,
    "count_mismatch",
    "Envelope counts do not equal the returned item count.",
  );

  const projection = isRecord(candidate.projection) ? candidate.projection : {};
  addFinding(
    findings,
    projection.mode !== "full" || projection.fields !== null,
    "projection_incomplete",
    "The result is not the full metadata projection.",
  );
  const omissionReceipt = isRecord(candidate.omission_receipt)
    ? candidate.omission_receipt
    : undefined;
  addFinding(
    findings,
    omissionReceipt === undefined,
    "omission_receipt_missing",
    "The result carries no field-omission receipt.",
  );
  addFinding(
    findings,
    omissionReceipt !== undefined &&
      (omissionReceipt.has_omissions !== false ||
        omissionReceipt.omitted_field_group_count !== 0 ||
        !Number.isSafeInteger(omissionReceipt.omitted_field_group_count) ||
        !Array.isArray(omissionReceipt.omitted_field_groups) ||
        omissionReceipt.omitted_field_groups.length !== 0),
    "omission_receipt_invalid",
    "The field-omission receipt is malformed or contradicts its no-omission claim.",
  );
  addFinding(
    findings,
    omissionReceipt?.has_omissions === true,
    "field_omission",
    "The omission receipt reports withheld field groups.",
  );
}

/** Return whether a universal read receipt cannot prove an intact list result. */
function isInvalidCompleteListReadOutput(
  readOutput: Record<string, unknown>,
): boolean {
  return (
    readOutput.contract_version !== 1 ||
    readOutput.command !== "list" ||
    readOutput.within_budget !== true ||
    readOutput.strings_compacted !== false ||
    readOutput.rows_compacted !== false ||
    readOutput.result_omitted !== false
  );
}

/** Return whether the receipt proves every dimension required for an unbounded full read. */
function hasCompleteListReadOutputDimensions(
  readOutput: Record<string, unknown>,
): boolean {
  if (!Array.isArray(readOutput.requested_dimensions)) return false;
  const requestedDimensions = new Set(readOutput.requested_dimensions);
  return ["include", "amount", "cost"].every((dimension) =>
    requestedDimensions.has(dimension),
  );
}

/** Append universal-output and cross-call-session findings. */
function inspectOutputScope(
  candidate: Record<string, unknown>,
  findings: PmCompleteListFinding[],
): void {
  const readOutput = isRecord(candidate.read_output)
    ? candidate.read_output
    : undefined;
  addFinding(
    findings,
    readOutput === undefined,
    "read_output_missing",
    "The result carries no universal read-output receipt.",
  );
  addFinding(
    findings,
    readOutput !== undefined && isInvalidCompleteListReadOutput(readOutput),
    "read_output_invalid",
    "The universal read-output receipt does not prove an intact list result.",
  );
  addFinding(
    findings,
    readOutput !== undefined &&
      !hasCompleteListReadOutputDimensions(readOutput),
    "read_output_dimensions_incomplete",
    "The universal read-output receipt does not prove full, unbounded include, amount, and cost dimensions.",
  );
  addFinding(
    findings,
    readOutput?.strings_compacted === true ||
      readOutput?.rows_compacted === true ||
      candidate.output_budget_truncation !== undefined,
    "budget_compaction",
    "Universal output shaping compacted the result.",
  );
  const budgetExceeded = isRecord(candidate.output_budget_exceeded)
    ? candidate.output_budget_exceeded
    : undefined;
  addFinding(
    findings,
    readOutput?.result_omitted === true ||
      budgetExceeded?.omitted_result === true,
    "budget_omission",
    "Universal output shaping omitted the useful result.",
  );
  addFinding(
    findings,
    candidate.read_session !== undefined,
    "session_projection",
    "A cross-call read session can suppress previously served facts.",
  );
}

/** Append row-identity findings that prevent exact set reasoning. */
function inspectItemIds(
  items: unknown[],
  findings: PmCompleteListFinding[],
): void {
  const ids = items.map((item) =>
    isRecord(item) && typeof item.id === "string" ? item.id.trim() : "",
  );
  addFinding(
    findings,
    ids.some((id) => id.length === 0),
    "invalid_item_id",
    "Every full item row must carry a non-empty string id.",
  );
  addFinding(
    findings,
    new Set(ids).size !== ids.length,
    "duplicate_item_id",
    "Every item id must occur exactly once.",
  );
}

/** Inspect an unknown result and report every missing whole-corpus invariant. */
export function inspectCompleteListResult(
  candidate: unknown,
): PmCompleteListInspection {
  if (!isRecord(candidate) || !Array.isArray(candidate.items)) {
    return {
      ok: false,
      findings: [
        {
          code: PM_COMPLETE_LIST_FINDING_CODES[0],
          message: "The result must be an object with an items array.",
        },
      ],
    };
  }

  const envelope = candidate as Record<string, unknown> & { items: unknown[] };
  const findings: PmCompleteListFinding[] = [];
  const filters = inspectSourceScope(envelope, findings);
  inspectEnvelopeShape(envelope, filters, findings);
  inspectOutputScope(envelope, findings);
  inspectItemIds(envelope.items, findings);

  return { ok: findings.length === 0, findings };
}

/** Certify a result as the whole tracker corpus or throw a typed recovery error. */
export function certifyCompleteListResult(
  candidate: unknown,
): PmCompleteListResult {
  const inspection = inspectCompleteListResult(candidate);
  if (!inspection.ok) {
    throw new PmCompleteListValidationError(inspection.findings);
  }
  const result = candidate as ListFullResult & {
    items: ListedItem[];
    read_output: PmReadOutputReceipt;
  };
  return {
    ...result,
    complete_list: {
      contract_version: 1,
      item_count: result.items.length,
      unique_item_id_count: new Set(result.items.map((item) => item.id)).size,
      terminal_items_included: true,
      source_complete: true,
      full_projection: true,
      no_omissions: true,
      unbounded: true,
    },
  };
}

/** Assert whole-corpus completeness while narrowing the candidate type in place. */
export function assertCompleteListResult(
  candidate: unknown,
): asserts candidate is ListFullResult {
  certifyCompleteListResult(candidate);
}
