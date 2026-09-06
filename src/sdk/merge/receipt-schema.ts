/**
 * @module sdk/merge/receipt-schema
 * Validates historical and current receipt encodings and enforces durable-value privacy policy.
 */
import path from "node:path";
import { stableStringify } from "../../core/shared/serialization.js";
import { isRfc3339DateTime } from "../../core/shared/time.js";
import {
  encodeItemScalarDecisionValue,
  hashItemScalarDecisionValue,
  isItemScalarMissingValue,
  type ItemMergeConflictDecision,
} from "./three-way.js";
import { isMergeReceiptOperation } from "./receipt-operation.js";
import type {
  MergeDecisionReceipt,
  MergeReceiptInvalidEvidence,
} from "./receipts.js";

const RECEIPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const RECEIPT_ITEM_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const RECEIPT_FIELD_MAX = 2_048;
const RECEIPT_VALUE_MAX_DEPTH = 64;
const RECEIPT_VALUE_MAX_NODES = 100_000;
const RECEIPT_KEYS = new Set([
  "version",
  "id",
  "item_path",
  "item_id",
  "requested_preference",
  "requested_preference_applied",
  "preferred",
  "conflict_resolution",
  "fields_from_theirs",
  "union_fields",
  "merged_field_hashes",
  "decisions",
  "state",
  "created_at",
  "reconciled_at",
  "value_availability",
  "value_policy",
  "evidence_source",
  "operation",
  "settlement",
]);

/** Return whether a receipt id is safe to expose in cleartext diagnostics. */
export function isSafeReceiptId(value: string): boolean {
  return RECEIPT_ID_PATTERN.test(value);
}
const RECEIPT_DECISION_KEYS = new Set([
  "field",
  "base",
  "ours",
  "theirs",
  "retained",
  "discarded",
  "retained_side",
  "resolution_basis",
]);

/** Versioned allowlist controlling which scalar evidence may enter tracked receipt sidecars. */
export const DURABLE_VALUE_POLICY = "bounded_non_sensitive_scalars_v1" as const;
const REVIEWABLE_BUILTIN_STATUSES = new Set([
  "open",
  "in_progress",
  "blocked",
  "closed",
  "canceled",
]);
const REVIEWABLE_ORDINAL_FIELDS = new Set(["risk", "confidence", "severity"]);
const REVIEWABLE_ORDINAL_VALUES = new Set([
  "low",
  "medium",
  "high",
  "critical",
]);
const REVIEWABLE_DURABLE_VALUES_BY_FIELD = new Map<string, ReadonlySet<string>>(
  [
    ["priority", new Set([0, 1, 2, 3, 4].map(stableStringify))],
    ["status", new Set([...REVIEWABLE_BUILTIN_STATUSES].map(stableStringify))],
    ...[...REVIEWABLE_ORDINAL_FIELDS].map(
      (field): [string, ReadonlySet<string>] => [
        field,
        new Set([...REVIEWABLE_ORDINAL_VALUES].map(stableStringify)),
      ],
    ),
  ],
);

/** Narrow untrusted JSON to a non-array object before schema inspection. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Refuse receipt extensions outside the versioned schema key set. */
function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/** Validate bounded dense string collections used in receipt coordinates. */
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= RECEIPT_FIELD_MAX &&
    value.every(
      (entry) =>
        typeof entry === "string" && entry.length > 0 && entry.length <= 256,
    )
  );
}

/** Bound JSON depth and node count before retaining untrusted decision values. */
function hasBoundedJsonStructure(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (
      nodes > RECEIPT_VALUE_MAX_NODES ||
      current.depth > RECEIPT_VALUE_MAX_DEPTH
    ) {
      return false;
    }
    if (Array.isArray(current.value)) {
      for (const entry of current.value) {
        pending.push({ value: entry, depth: current.depth + 1 });
      }
    } else if (isRecord(current.value)) {
      for (const entry of Object.values(current.value)) {
        pending.push({ value: entry, depth: current.depth + 1 });
      }
    }
  }
  return true;
}

/** Validate one clone-local scalar decision and its optional resolution evidence. */
function isMergeDecision(value: unknown): value is ItemMergeConflictDecision {
  if (!isRecord(value)) return false;
  const retainedSides = [undefined, "ours", "theirs"];
  const resolutionBases = [
    undefined,
    "requested_preference",
    "document_updated_at",
    "stable_value_tiebreak",
  ];
  return [
    hasOnlyKeys(value, RECEIPT_DECISION_KEYS),
    typeof value.field === "string",
    typeof value.field === "string" && value.field.length > 0,
    typeof value.field === "string" && value.field.length <= 256,
    Object.hasOwn(value, "base"),
    Object.hasOwn(value, "ours"),
    Object.hasOwn(value, "theirs"),
    Object.hasOwn(value, "retained"),
    Object.hasOwn(value, "discarded"),
    hasBoundedJsonStructure(value.base),
    hasBoundedJsonStructure(value.ours),
    hasBoundedJsonStructure(value.theirs),
    hasBoundedJsonStructure(value.retained),
    hasBoundedJsonStructure(value.discarded),
    retainedSides.includes(value.retained_side as string | undefined),
    resolutionBases.includes(value.resolution_basis as string | undefined),
  ].every(Boolean);
}

/** Validate the complete field-to-SHA-256 proof map used during repair. */
function isMergedFieldHashes(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= RECEIPT_FIELD_MAX &&
    entries.every(
      ([field, hash]) =>
        field.length > 0 &&
        field.length <= 256 &&
        typeof hash === "string" &&
        /^[a-f0-9]{64}$/u.test(hash),
    )
  );
}

/** Require a normalized tracker item path whose basename matches the receipt item. */
function isSafeReceiptItemPath(value: unknown, itemId: string): boolean {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value)
  ) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return (
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    path.posix.basename(normalized, path.posix.extname(normalized)) === itemId
  );
}

/** Validate receipt arrays and optional merged-field proof coverage. */
function hasValidReceiptCollections(value: Record<string, unknown>): boolean {
  return !isStringArray(value.fields_from_theirs) ||
    !isStringArray(value.union_fields) ||
    !Array.isArray(value.decisions) ||
    value.decisions.length > RECEIPT_FIELD_MAX ||
    !value.decisions.every(isMergeDecision)
    ? false
    : value.merged_field_hashes === undefined ||
        isMergedFieldHashes(value.merged_field_hashes);
}

/** Validate every closed-domain lifecycle and merge-policy field. */
function hasValidReceiptEnums(value: Record<string, unknown>): boolean {
  const preferences = [undefined, "ours", "theirs"];
  const resolutions = [
    undefined,
    "preferred_side",
    "stable_value_order",
    "latest_document_update",
  ];
  const availabilities = [
    undefined,
    "clone_local",
    "hash_only",
    "bounded_inline",
    "mixed",
  ];
  const sources = [undefined, "clone_local", "durable"];
  return (
    preferences.includes(value.requested_preference as string | undefined) &&
    preferences.includes(value.preferred as string | undefined) &&
    (value.requested_preference_applied === undefined ||
      typeof value.requested_preference_applied === "boolean") &&
    resolutions.includes(value.conflict_resolution as string | undefined) &&
    (value.state === "pending" || value.state === "reconciled") &&
    availabilities.includes(value.value_availability as string | undefined) &&
    (value.value_policy === undefined ||
      value.value_policy === DURABLE_VALUE_POLICY) &&
    sources.includes(value.evidence_source as string | undefined)
  );
}

/** Validate creation and optional settlement timestamps as RFC 3339 values. */
function hasValidReceiptTimestamps(value: Record<string, unknown>): boolean {
  return (
    typeof value.created_at === "string" &&
    isRfc3339DateTime(value.created_at) &&
    (value.reconciled_at === undefined ||
      (typeof value.reconciled_at === "string" &&
        isRfc3339DateTime(value.reconciled_at)))
  );
}

/** Validate one hash-only or policy-bounded durable decision value. */
function hasDurableDecisionValue(field: string, value: unknown): boolean {
  if (!isRecord(value) || isPrehashedValue(value) === undefined) return false;
  const keys = Object.keys(value);
  if (!keys.every((key) => key === "pm_value_hash" || key === "pm_value")) {
    return false;
  }
  if (!Object.hasOwn(value, "pm_value")) return keys.length === 1;
  const preview = value.pm_value;
  const allowed =
    preview === null ||
    REVIEWABLE_DURABLE_VALUES_BY_FIELD.get(field)?.has(
      stableStringify(preview),
    ) === true;
  return (
    allowed && hashItemScalarDecisionValue(preview) === value.pm_value_hash
  );
}

/** Validate durable decision redaction and the declared availability summary. */
function hasValidDurableDecisions(receipt: MergeDecisionReceipt): boolean {
  if (
    !receipt.decisions.every(
      (decision) =>
        decision.base === null &&
        decision.ours === null &&
        decision.theirs === null &&
        hasDurableDecisionValue(decision.field, decision.retained) &&
        hasDurableDecisionValue(decision.field, decision.discarded),
    )
  ) {
    return false;
  }
  const inlineValueCount = receipt.decisions.reduce(
    (count, decision) =>
      count +
      (isRecord(decision.retained) &&
      Object.hasOwn(decision.retained, "pm_value")
        ? 1
        : 0) +
      (isRecord(decision.discarded) &&
      Object.hasOwn(decision.discarded, "pm_value")
        ? 1
        : 0),
    0,
  );
  const expectedAvailability =
    inlineValueCount === 0
      ? "hash_only"
      : inlineValueCount === receipt.decisions.length * 2
        ? "bounded_inline"
        : "mixed";
  return (
    receipt.value_availability === expectedAvailability &&
    (inlineValueCount === 0 || receipt.value_policy === DURABLE_VALUE_POLICY)
  );
}

/** Require restored-origin settlements to retain the immutable operation they disposition. */
function hasValidReceiptOperation(value: Record<string, unknown>): boolean {
  if (
    value.operation !== undefined &&
    !isMergeReceiptOperation(value.operation)
  )
    return false;
  return (
    value.settlement === undefined ||
    (value.settlement === "original_git_state_restored" &&
      value.state === "reconciled" &&
      value.operation !== undefined)
  );
}

/** Validate schema identity before inspecting values or lifecycle policy. */
function receiptIdentityValidationError(
  value: Record<string, unknown>,
): MergeReceiptInvalidEvidence["validation_error"] | null {
  for (const key of [
    "version",
    "id",
    "item_path",
    "item_id",
    "fields_from_theirs",
    "union_fields",
    "decisions",
    "state",
    "created_at",
  ]) {
    if (!Object.hasOwn(value, key)) return "required_fields";
  }
  if (value.version !== 1 || !hasOnlyKeys(value, RECEIPT_KEYS)) {
    return "required_fields";
  }
  if (typeof value.id !== "string" || !isSafeReceiptId(value.id)) {
    return "receipt_id";
  }
  if (
    typeof value.item_id !== "string" ||
    !RECEIPT_ITEM_ID_PATTERN.test(value.item_id)
  ) {
    return "item_id";
  }
  if (!isSafeReceiptItemPath(value.item_path, value.item_id)) {
    return "item_path";
  }
  return null;
}

/** Return the narrowest validation class for untrusted receipt evidence. */
export function receiptValidationError(
  value: unknown,
  evidenceSource: "clone_local" | "durable",
): MergeReceiptInvalidEvidence["validation_error"] | null {
  if (!isRecord(value)) return "required_fields";
  const identityError = receiptIdentityValidationError(value);
  if (identityError !== null) return identityError;
  if (!hasValidReceiptOperation(value)) return "operation";
  if (!hasValidReceiptCollections(value)) return "collections";
  if (!hasValidReceiptEnums(value)) return "enums";
  if (!hasValidReceiptTimestamps(value)) return "timestamps";
  if (
    evidenceSource === "durable" &&
    !hasValidDurableDecisions(value as unknown as MergeDecisionReceipt)
  ) {
    return "durable_decisions";
  }
  return null;
}

/** Restore omitted non-selected slots from identified v1 clone-local writer contracts; never infer a missing retained or discarded value. */
export function normalizeLegacyReceipt(value: unknown): unknown {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.value_policy !== undefined ||
    !Array.isArray(value.decisions)
  )
    return value;
  const preferredEra =
    (value.preferred === "ours" || value.preferred === "theirs") &&
    value.requested_preference === undefined;
  const requestedPreferenceEra =
    (value.requested_preference === "ours" ||
      value.requested_preference === "theirs") &&
    value.value_availability === "clone_local";
  if (!preferredEra && !requestedPreferenceEra) return value;
  return {
    ...value,
    decisions: value.decisions.map((decision: unknown) => {
      if (
        !isRecord(decision) ||
        !Object.hasOwn(decision, "retained") ||
        !Object.hasOwn(decision, "discarded")
      )
        return decision;
      return {
        base: encodeItemScalarDecisionValue(undefined),
        ours: encodeItemScalarDecisionValue(undefined),
        theirs: encodeItemScalarDecisionValue(undefined),
        ...decision,
      };
    }),
  };
}

/** Identify the rejected collection without exposing its values. */
export function receiptCollectionValidationPath(
  value: unknown,
): string | undefined {
  if (!isRecord(value)) return undefined;
  if (!isStringArray(value.fields_from_theirs)) return "fields_from_theirs";
  if (!isStringArray(value.union_fields)) return "union_fields";
  if (
    !Array.isArray(value.decisions) ||
    value.decisions.length > RECEIPT_FIELD_MAX
  )
    return "decisions";
  const index = value.decisions.findIndex(
    (decision: unknown) => !isMergeDecision(decision),
  );
  if (index >= 0) return `decisions[${index}]`;
  return "merged_field_hashes";
}

/** Validate a complete receipt against its clone-local or durable evidence policy. */
export function isMergeDecisionReceipt(
  value: unknown,
  evidenceSource: "clone_local" | "durable",
): value is MergeDecisionReceipt {
  return receiptValidationError(value, evidenceSource) === null;
}

/** Extract a structurally valid precomputed SHA-256 decision hash. */
export function isPrehashedValue(value: unknown): string | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("pm_value_hash" in value)
  ) {
    return undefined;
  }
  const hash = value.pm_value_hash;
  return typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash)
    ? hash
    : undefined;
}

/** Convert a raw scalar into hashed evidence with an allowlisted preview. */
export function durableValueEvidence(
  field: string,
  value: unknown,
): { pm_value_hash: string; pm_value?: unknown } {
  const missing = isItemScalarMissingValue(value);
  const pmValueHash = hashItemScalarDecisionValue(missing ? undefined : value);
  const reviewable =
    !missing &&
    (value === null ||
      REVIEWABLE_DURABLE_VALUES_BY_FIELD.get(field)?.has(
        stableStringify(value),
      ) === true);
  return reviewable
    ? { pm_value_hash: pmValueHash, pm_value: value }
    : { pm_value_hash: pmValueHash };
}
