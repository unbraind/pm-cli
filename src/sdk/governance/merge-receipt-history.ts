/**
 * @module sdk/governance/merge-receipt-history
 *
 * Classifies privacy-safe merge receipt references embedded in history.
 */
import { createHash } from "node:crypto";
import path from "node:path";

import { isSafeReceiptId } from "../merge/receipts.js";

/** One receipt reference discovered at an immutable history coordinate. */
export interface HistoryMergeReceiptReference {
  /** Item whose history contains the summary. */
  itemId: string;
  /** One-based history line containing the summary. */
  line: number;
  /** Privacy-safe receipt identifier. */
  receiptId: string;
  /** Whether the summary is a complete supported preferred-era record. */
  legacySummaryAccepted: boolean;
}

/** Missing-reference coordinate returned to bounded integrity diagnostics. */
export interface MissingHistoryMergeReceiptReference {
  /** Item whose history contains the unresolved reference. */
  item_id: string;
  /** One-based history line containing the unresolved reference. */
  history_line: number;
  /** Safe identifier when the source value is suitable for diagnostics. */
  receipt_id?: string;
  /** Digest used instead of an unsafe identifier. */
  receipt_reference_hash?: string;
}

/** Partitioned compatibility outcome for all scanned history references. */
export interface HistoryMergeReceiptReferenceClassification {
  /** References requiring authoritative external evidence. */
  missing: MissingHistoryMergeReceiptReference[];
  /** Complete preferred-era summaries accepted without impossible migration. */
  acceptedLegacyCount: number;
}

/** Return whether an unknown value is a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return a bounded dense list of unique, non-empty field names. */
function isFieldArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 256) return false;
  const fields = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const field = value[index];
    if (
      !(index in value) ||
      typeof field !== "string" ||
      field.length === 0 ||
      field.length > 256 ||
      fields.has(field)
    ) {
      return false;
    }
    fields.add(field);
  }
  return true;
}

/** Return whether an unknown value is one complete legacy field decision. */
function isLegacyDecision(value: unknown): value is {
  discarded_hash: string;
  field: string;
  retained_hash: string;
} {
  if (!isRecord(value)) return false;
  return (
    typeof value.field === "string" &&
    value.field.length > 0 &&
    value.field.length <= 256 &&
    typeof value.retained_hash === "string" &&
    /^[a-f0-9]{64}$/u.test(value.retained_hash) &&
    typeof value.discarded_hash === "string" &&
    /^[a-f0-9]{64}$/u.test(value.discarded_hash)
  );
}

/** Return whether a preferred-era summary has one safe canonical identity. */
function hasLegacyReceiptIdentity(
  value: Record<string, unknown>,
  historyItemId: string,
): boolean {
  const itemPath = value.item_path;
  const normalizedItemPath =
    typeof itemPath === "string" ? path.posix.normalize(itemPath) : "";
  return (
    typeof value.receipt_id === "string" &&
    isSafeReceiptId(value.receipt_id) &&
    (value.preferred === "ours" || value.preferred === "theirs") &&
    value.requested_preference === undefined &&
    value.conflict_resolution === undefined &&
    value.item_id === historyItemId &&
    typeof itemPath === "string" &&
    itemPath.length <= 4_096 &&
    !itemPath.includes("\\") &&
    !path.posix.isAbsolute(itemPath) &&
    normalizedItemPath === itemPath &&
    !normalizedItemPath.startsWith("../") &&
    (path.posix.basename(normalizedItemPath) === `${historyItemId}.toon` ||
      path.posix.basename(normalizedItemPath) === `${historyItemId}.md`)
  );
}

/** Return whether preferred-era summary collections are dense and self-consistent. */
function hasLegacyReceiptCollections(value: Record<string, unknown>): boolean {
  const conflictFields = value.conflict_fields;
  const fieldsFromTheirs = value.fields_from_theirs;
  const unionFields = value.union_fields;
  const decisions = value.decisions;
  return (
    isFieldArray(conflictFields) &&
    isFieldArray(fieldsFromTheirs) &&
    isFieldArray(unionFields) &&
    Array.isArray(decisions) &&
    decisions.length > 0 &&
    decisions.length <= 256 &&
    Object.keys(decisions).length === decisions.length &&
    decisions.every(isLegacyDecision) &&
    new Set(decisions.map((decision) => decision.field)).size ===
      decisions.length &&
    [...conflictFields].sort().join("\0") ===
      decisions
        .map((decision) => decision.field)
        .sort()
        .join("\0")
  );
}

/** Return whether one summary is a complete, self-contained preferred-era receipt. */
export function isLegacyMergeReceiptSummary(
  value: Record<string, unknown>,
  historyItemId: string,
): boolean {
  return (
    hasLegacyReceiptIdentity(value, historyItemId) &&
    hasLegacyReceiptCollections(value)
  );
}

/** Extract receipt ids and legacy compatibility disposition from one history entry. */
export function extractHistoryMergeReceiptReferences(
  value: unknown,
  historyItemId: string,
): Array<Omit<HistoryMergeReceiptReference, "itemId" | "line">> {
  if (!isRecord(value) || !isRecord(value.context)) return [];
  const merge = value.context.merge;
  if (!isRecord(merge) || !Array.isArray(merge.receipts)) return [];
  return merge.receipts.flatMap((receipt) => {
    if (
      !isRecord(receipt) ||
      typeof receipt.receipt_id !== "string" ||
      receipt.receipt_id.trim().length === 0
    ) {
      return [];
    }
    return [
      {
        receiptId: receipt.receipt_id,
        legacySummaryAccepted: isLegacyMergeReceiptSummary(
          receipt,
          historyItemId,
        ),
      },
    ];
  });
}

/** Classify scanned references without treating complete legacy summaries as absent. */
export function classifyHistoryMergeReceiptReferences(
  references: readonly HistoryMergeReceiptReference[],
  availableReceiptIds: ReadonlySet<string>,
): HistoryMergeReceiptReferenceClassification {
  const missing = references
    .filter(
      (reference) =>
        !reference.legacySummaryAccepted &&
        !availableReceiptIds.has(reference.receiptId),
    )
    .map((reference) => ({
      item_id: reference.itemId,
      history_line: reference.line,
      ...(isSafeReceiptId(reference.receiptId)
        ? { receipt_id: reference.receiptId }
        : {
            receipt_reference_hash: createHash("sha256")
              .update(reference.receiptId)
              .digest("hex"),
          }),
    }));
  return {
    missing,
    acceptedLegacyCount: references.filter(
      (reference) => reference.legacySummaryAccepted,
    ).length,
  };
}
