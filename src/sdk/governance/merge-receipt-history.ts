/**
 * @module sdk/governance/merge-receipt-history
 *
 * Classifies privacy-safe merge receipt references embedded in history.
 */
import { createHash } from "node:crypto";
import path from "node:path";

import {
  compareTimestampStrings,
  isRfc3339DateTime,
} from "../../core/shared/time.js";
import { isSafeReceiptId } from "../merge/receipts.js";

/** First commit timestamp at which merge receipts gained a tracked durable copy. */
export const DURABLE_MERGE_RECEIPT_INTRODUCED_AT = "2026-08-09T16:15:18.000Z";

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
  /** Timestamp of the history event that introduced the reference, when valid. */
  eventTimestamp?: string;
}

/** Audited disposition for one receipt that a pre-durable writer could never publish. */
export interface HistoryMergeReceiptDisposition {
  /** Item whose history contains both the original reference and disposition. */
  itemId: string;
  /** Receipt identity explicitly accepted as unrecoverable. */
  receiptId: string;
  /** One-based coordinate of the original merge event. */
  originalHistoryLine: number;
  /** Timestamp copied from the original merge event for exact matching. */
  originalEventTimestamp: string;
  /** One-based coordinate of the later audit event that records this disposition. */
  auditHistoryLine: number;
  /** Closed reason vocabulary for this exceptional compatibility path. */
  reason: "legacy_clone_local_only";
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
  /** Pre-durable references accepted by a later explicit audited disposition. */
  acceptedDispositionCount: number;
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
      field.includes("\0") ||
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
    !value.field.includes("\0") &&
    typeof value.retained_hash === "string" &&
    /^[a-f0-9]{64}$/u.test(value.retained_hash) &&
    typeof value.discarded_hash === "string" &&
    /^[a-f0-9]{64}$/u.test(value.discarded_hash)
  );
}

/** Return whether a legacy item path is normalized, bounded, and item-scoped. */
function isLegacyItemPath(value: unknown, historyItemId: string): boolean {
  if (typeof value !== "string") return false;
  const normalized = path.posix.normalize(value);
  return (
    value.length <= 4_096 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    normalized === value &&
    !normalized.startsWith("../") &&
    (path.posix.basename(normalized) === `${historyItemId}.toon` ||
      path.posix.basename(normalized) === `${historyItemId}.md`)
  );
}

/** Return whether a preferred-era summary has one safe canonical identity. */
function hasLegacyReceiptIdentity(
  value: Record<string, unknown>,
  historyItemId: string,
): boolean {
  return (
    typeof value.receipt_id === "string" &&
    isSafeReceiptId(value.receipt_id) &&
    (value.preferred === "ours" || value.preferred === "theirs") &&
    value.requested_preference === undefined &&
    value.conflict_resolution === undefined &&
    value.item_id === historyItemId &&
    isLegacyItemPath(value.item_path, historyItemId)
  );
}

/** Return whether preferred-era summary collections are dense and self-consistent. */
function hasLegacyReceiptCollections(value: Record<string, unknown>): boolean {
  const conflictFields = value.conflict_fields;
  const fieldsFromTheirs = value.fields_from_theirs;
  const unionFields = value.union_fields;
  const decisions = value.decisions;
  const decisionFields = Array.isArray(decisions)
    ? new Set(
        decisions.flatMap((decision) =>
          isLegacyDecision(decision) ? [decision.field] : [],
        ),
      )
    : new Set<string>();
  return (
    isFieldArray(conflictFields) &&
    isFieldArray(fieldsFromTheirs) &&
    isFieldArray(unionFields) &&
    Array.isArray(decisions) &&
    decisions.length > 0 &&
    decisions.length <= 256 &&
    Object.keys(decisions).length === decisions.length &&
    decisions.every(isLegacyDecision) &&
    decisionFields.size === decisions.length &&
    conflictFields.length === decisionFields.size &&
    conflictFields.every((field) => decisionFields.has(field))
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
        ...(typeof value.ts === "string" && isRfc3339DateTime(value.ts)
          ? { eventTimestamp: value.ts }
          : {}),
      },
    ];
  });
}

/** Extract validated explicit missing-receipt dispositions from one merge audit event. */
export function extractHistoryMergeReceiptDispositions(
  value: unknown,
  historyItemId: string,
  historyLine: number,
): HistoryMergeReceiptDisposition[] {
  if (!isRecord(value) || value.op !== "merge_reconcile") return [];
  if (!isRecord(value.context) || !isRecord(value.context.merge)) return [];
  const dispositions = value.context.merge.missing_receipt_dispositions;
  if (!Array.isArray(dispositions) || dispositions.length > 256) return [];
  return dispositions.flatMap((disposition) => {
    if (
      !isRecord(disposition) ||
      typeof disposition.receipt_id !== "string" ||
      !isSafeReceiptId(disposition.receipt_id) ||
      typeof disposition.original_history_line !== "number" ||
      !Number.isSafeInteger(disposition.original_history_line) ||
      disposition.original_history_line < 1 ||
      typeof disposition.original_event_ts !== "string" ||
      !isRfc3339DateTime(disposition.original_event_ts) ||
      disposition.reason !== "legacy_clone_local_only"
    ) {
      return [];
    }
    return [
      {
        itemId: historyItemId,
        receiptId: disposition.receipt_id,
        originalHistoryLine: disposition.original_history_line,
        originalEventTimestamp: disposition.original_event_ts,
        auditHistoryLine: historyLine,
        reason: disposition.reason,
      },
    ];
  });
}

/** Classify scanned references without treating complete legacy summaries as absent. */
export function classifyHistoryMergeReceiptReferences(
  references: readonly HistoryMergeReceiptReference[],
  availableReceiptIds: ReadonlySet<string>,
  dispositions: readonly HistoryMergeReceiptDisposition[] = [],
): HistoryMergeReceiptReferenceClassification {
  const dispositionAuditLineByCoordinate = new Map<string, number>();
  for (const disposition of dispositions) {
    const coordinate = `${disposition.itemId}\0${disposition.originalHistoryLine}\0${disposition.receiptId}\0${disposition.originalEventTimestamp}`;
    dispositionAuditLineByCoordinate.set(
      coordinate,
      Math.max(
        dispositionAuditLineByCoordinate.get(coordinate) ?? 0,
        disposition.auditHistoryLine,
      ),
    );
  }
  const dispositionAccepts = (
    reference: HistoryMergeReceiptReference,
  ): boolean =>
    reference.eventTimestamp !== undefined &&
    compareTimestampStrings(
      reference.eventTimestamp,
      DURABLE_MERGE_RECEIPT_INTRODUCED_AT,
    ) < 0 &&
    (dispositionAuditLineByCoordinate.get(
      `${reference.itemId}\0${reference.line}\0${reference.receiptId}\0${reference.eventTimestamp}`,
    ) ?? 0) > reference.line;
  const missing = references
    .filter(
      (reference) =>
        !reference.legacySummaryAccepted &&
        !availableReceiptIds.has(reference.receiptId) &&
        !dispositionAccepts(reference),
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
    acceptedDispositionCount: references.filter(dispositionAccepts).length,
  };
}
