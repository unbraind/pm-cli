/**
 * @module sdk/governance/merge-receipt-history
 *
 * Classifies privacy-safe merge receipt references embedded in history.
 */
import { createHash } from "node:crypto";

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

/** Return whether every member of an unknown value is a string. */
function isStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

/** Return whether an unknown value is one complete legacy field decision. */
function isLegacyDecision(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.field === "string" &&
    typeof value.retained_hash === "string" &&
    /^[a-f0-9]{64}$/u.test(value.retained_hash) &&
    typeof value.discarded_hash === "string" &&
    /^[a-f0-9]{64}$/u.test(value.discarded_hash)
  );
}

/** Return whether one summary is a complete, self-contained preferred-era receipt. */
export function isLegacyMergeReceiptSummary(
  value: Record<string, unknown>,
  historyItemId: string,
): boolean {
  const itemPath = value.item_path;
  return (
    typeof value.receipt_id === "string" &&
    isSafeReceiptId(value.receipt_id) &&
    (value.preferred === "ours" || value.preferred === "theirs") &&
    value.requested_preference === undefined &&
    value.conflict_resolution === undefined &&
    value.item_id === historyItemId &&
    typeof itemPath === "string" &&
    (itemPath.endsWith(`/${historyItemId}.toon`) ||
      itemPath.endsWith(`/${historyItemId}.md`)) &&
    isStringArray(value.conflict_fields) &&
    isStringArray(value.fields_from_theirs) &&
    isStringArray(value.union_fields) &&
    Array.isArray(value.decisions) &&
    value.decisions.every(isLegacyDecision)
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
