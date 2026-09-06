/**
 * @module sdk/merge/receipts
 *
 * Stores recoverable merge decisions below the clone-local Git directory.
 * Raw losing values deliberately never enter the public tracker history; the
 * history entry records hashes and provenance while this receipt preserves the
 * value for the coordinator that performed the merge.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  ensureDir,
  isFileAbsentError,
  isFileMissingError,
  pathExists,
  writeFileAtomic,
} from "../../core/fs/fs-utils.js";
import { sha256Hex, stableStringify } from "../../core/shared/serialization.js";
import { nowIso } from "../../core/shared/time.js";
import {
  encodeItemScalarDecisionValue,
  hashItemScalarDecisionValue,
  isItemScalarMissingValue,
  type ItemMergeConflictDecision,
  type ItemScalarConflictResolution,
  type MergePreferredSide,
} from "./three-way.js";
import type { MergeReceiptOperation } from "./receipt-operation.js";
import { readBoundedRegularFile } from "./receipt-file-boundary.js";

import { DURABLE_VALUE_POLICY, durableValueEvidence, isSafeReceiptId, isMergeDecisionReceipt, isPrehashedValue, normalizeLegacyReceipt, receiptCollectionValidationPath, receiptValidationError } from "./receipt-schema.js";
export { isSafeReceiptId } from "./receipt-schema.js";

const execFileAsync = promisify(execFile);
const RECEIPT_FILE_MAX_BYTES = 16 * 1024 * 1024;
const RECEIPT_INVALID_EVIDENCE_DETAIL_LIMIT = 100;

/** One clone-local merge receipt with recoverable branch values. */
export interface MergeDecisionReceipt {
  /** Receipt schema version. */
  version: 1;
  /** Opaque receipt identity referenced from public history. */
  id: string;
  /** Repository-relative item path supplied by Git as `%P`. */
  item_path: string;
  /** Item id derived from the merged document path. */
  item_id: string;
  /** Side requested by the caller; stable-value decisions can retain either side. */
  requested_preference?: MergePreferredSide;
  /** Whether requested preference participates in item scalar selection. */
  requested_preference_applied?: boolean;
  /** Legacy schema-v1 key accepted while reading older clone-local receipts. */
  preferred?: MergePreferredSide;
  /** Scalar-conflict selection contract used by the item driver. */
  conflict_resolution: ItemScalarConflictResolution;
  /** Fields selected cleanly from the other branch. */
  fields_from_theirs: string[];
  /** Collections combined from both branches. */
  union_fields: string[];
  /** SHA-256 hashes of the merged values for every field represented by this receipt. Absent on legacy receipts, which cannot prove drift attribution. */
  merged_field_hashes?: Record<string, string>;
  /** Full recoverable scalar decisions, retained only in the clone. */
  decisions: ItemMergeConflictDecision[];
  /** Immutable original Git coordinates captured while the driver runs during a rebase. */
  operation?: MergeReceiptOperation;
  /** Explicit audited disposition when the original Git state was restored instead of merging. */
  settlement?: "original_git_state_restored";
  /** Whether a reconciliation history event settled this receipt. */
  state: "pending" | "reconciled";
  /** Receipt creation timestamp. */
  created_at: string;
  /** Reconciliation timestamp, when consumed. */
  reconciled_at?: string;
  /** Whether decision values are recoverable locally or represented by hashes only. */
  value_availability?: "clone_local" | "hash_only" | "bounded_inline" | "mixed";
  /** Versioned rule governing which durable scalar previews may be committed. */
  value_policy?: typeof DURABLE_VALUE_POLICY;
  /** Runtime-only provenance assigned by the reader; serialized values are ignored. */
  evidence_source?: "clone_local" | "durable";
}

/** Privacy-safe receipt summary suitable for committed history context. */
export interface MergeDecisionReceiptSummary {
  /** Opaque clone-local receipt identity. */
  receipt_id: string;
  /** Item whose merge produced the receipt. */
  item_id: string;
  /** Repository-relative item path. */
  item_path: string;
  /** Scalar fields that required a preferred-side decision. */
  conflict_fields: string[];
  /** Fields selected cleanly from the other branch. */
  fields_from_theirs: string[];
  /** Collections combined from both branches. */
  union_fields: string[];
  /** Side requested by the caller; decision hashes prove the actual retained values. */
  requested_preference: MergePreferredSide;
  /** Whether requested preference participated in item scalar selection. */
  requested_preference_applied: boolean;
  /** Scalar-conflict selection contract used by the item driver. */
  conflict_resolution: ItemScalarConflictResolution;
  /** Hashes proving the retained and discarded values without publishing them. */
  decisions: Array<{
    field: string;
    retained_hash: string;
    discarded_hash: string;
  }>;
}

/** Structured result for the explicit clone-local merge report command. */
export interface MergeReceiptReport {
  /** Whether the report was read successfully. */
  ok: true;
  /** Number of receipts returned. */
  count: number;
  /** Receipts including recoverable values from the local clone only. */
  receipts: MergeDecisionReceipt[];
  /** ISO timestamp for the report. */
  generated_at: string;
}

/** Loss-aware merge receipt report for integrity gates and diagnostic adapters. */
export interface MergeReceiptEvidenceReport {
  /** Whether clone-local evidence resolved and every candidate was read and validated successfully. */
  ok: boolean;
  /** Whether clone-local evidence resolved and every discovered JSON candidate was read and validated successfully. */
  complete: boolean;
  /** Number of valid receipts returned. */
  count: number;
  /** Number of candidates rejected by bounded-file, schema, identity, or copy-consistency validation. */
  invalid_evidence_count: number;
  /** Bounded privacy-safe identities and reason codes for rejected evidence. */
  invalid_evidence: MergeReceiptInvalidEvidence[];
  /** Whether additional rejected evidence was omitted from the bounded detail list. */
  invalid_evidence_truncated: boolean;
  /** Whether the clone-local Git receipt directory was resolved successfully; always emitted by current implementations and optional for structural compatibility. */
  clone_local_evidence_resolved?: boolean;
  /** Receipts including recoverable values from the local clone only. */
  receipts: MergeDecisionReceipt[];
  /** ISO timestamp for the report. */
  generated_at: string;
}

/** Loss-aware receipt inspection result that never exposes malformed file contents. */
export interface MergeReceiptEvidenceScan {
  /** Valid receipts that passed bounded-file, schema, and identity validation. */
  receipts: MergeDecisionReceipt[];
  /** Number of JSON receipt candidates that could not be validated safely. */
  invalid_evidence_count: number;
  /** Bounded privacy-safe identities and reason codes for rejected evidence. */
  invalid_evidence: MergeReceiptInvalidEvidence[];
  /** Whether additional rejected evidence was omitted from the bounded detail list. */
  invalid_evidence_truncated: boolean;
  /** Whether the clone-local Git receipt directory was resolved successfully; always emitted by current implementations and optional for structural compatibility. */
  clone_local_evidence_resolved?: boolean;
}

/** Stable privacy-safe classification for one rejected receipt candidate or source. */
export interface MergeReceiptInvalidEvidence {
  /** Evidence store that produced the rejected candidate. */
  evidence_source: "clone_local" | "durable" | "clone_local_and_durable";
  /** Stable failure class suitable for remediation routing and graph analytics. */
  reason:
    | "directory_unreadable"
    | "candidate_not_bounded_regular_file"
    | "candidate_unreadable"
    | "candidate_invalid_json"
    | "schema_or_identity_invalid"
    | "schema_invalid"
    | "identity_invalid"
    | "copy_provenance_mismatch";
  /** Exact validation boundary when schema or identity evidence is rejected. */
  validation_error?:
    | "required_fields"
    | "receipt_id"
    | "item_id"
    | "item_path"
    | "filename"
    | "collections"
    | "enums"
    | "timestamps"
    | "durable_decisions"
    | "operation";
  /** Exact schema coordinate, excluding rejected values and user-controlled field names. */
  validation_path?: string;
  /** Receipt identity when the bounded filename itself is a valid receipt id. */
  receipt_id?: string;
  /** SHA-256 locator for an unsafe or malformed candidate filename. */
  candidate_name_hash?: string;
}

/** Resolve the clone-local receipt store without crossing a Git worktree boundary. */
async function resolveReceiptDirectory(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "pm-merge-receipts",
      ],
      { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 },
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Derive the tracker root only when the merged item belongs to this workspace. */
async function resolveTrackerRootFromItemPath(
  cwd: string,
  itemPath: string,
): Promise<string | null> {
  let directory = path.dirname(path.resolve(cwd, itemPath));
  for (let depth = 0; depth < 12; depth += 1) {
    if (await pathExists(path.join(directory, "settings.json")))
      return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/** Locate the tracked durable receipt sidecar directory. */
function durableReceiptDirectory(pmRoot: string): string {
  return path.join(pmRoot, "merge-receipts");
}

/** Map a validated opaque receipt identifier to its canonical filename. */
function receiptFileName(id: string): string {
  return `${id}.json`;
}

/** Revalidate one receipt and stage its atomic reconciled-state replacement. */
async function prepareReceiptSettlement(params: {
  receiptPath: string;
  receiptId: string;
  evidenceSource: "clone_local" | "durable";
  reconciledAt: string;
  settlement?: "original_git_state_restored";
  readReceipt?: (receiptPath: string) => Promise<string | null>;
}): Promise<{ path: string; content: string; fingerprints: string[]; modern: boolean } | null> {
  let raw: string | null;
  try {
    raw = params.readReceipt
      ? await params.readReceipt(params.receiptPath)
      : await readBoundedRegularFile(params.receiptPath, RECEIPT_FILE_MAX_BYTES);
  } catch (error) {
    if (isFileAbsentError(error)) return null;
    throw error;
  }
  if (raw === null) {
    throw new Error(
      `Receipt ${params.receiptId} settlement source is not a bounded regular file.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = normalizeLegacyReceipt(JSON.parse(raw) as unknown);
  } catch {
    throw new Error(
      `Receipt ${params.receiptId} settlement source is not valid JSON.`,
    );
  }
  if (
    !isMergeDecisionReceipt(parsed, params.evidenceSource) ||
    parsed.id !== params.receiptId ||
    (params.settlement !== undefined && parsed.operation === undefined) ||
    path.basename(params.receiptPath) !== receiptFileName(parsed.id)
  ) {
    throw new Error(
      `Receipt ${params.receiptId} settlement source failed schema or identity validation.`,
    );
  }
  const { evidence_source: _evidenceSource, ...persistedReceipt } = parsed;
  return {
    path: params.receiptPath,
    fingerprints: receiptProvenanceFingerprints(parsed),
    modern: parsed.value_policy !== undefined,
    content: `${JSON.stringify(
      {
        ...persistedReceipt,
        state: "reconciled",
        reconciled_at: params.reconciledAt,
        ...(params.settlement ? { settlement: params.settlement } : {}),
      },
      null,
      2,
    )}\n`,
  };
}

/** Fingerprint immutable receipt provenance while excluding lifecycle state. */
function receiptProvenanceFingerprint(receipt: MergeDecisionReceipt, legacy = false): string {
  return sha256Hex(
    stableStringify({
      id: receipt.id,
      item_id: receipt.item_id,
      item_path: receipt.item_path,
      created_at: receipt.created_at,
      requested_preference:
        receipt.requested_preference ?? receipt.preferred ?? "ours",
      conflict_resolution: receipt.conflict_resolution ?? "preferred_side",
      fields_from_theirs: receipt.fields_from_theirs,
      union_fields: receipt.union_fields,
      merged_field_hashes: receipt.merged_field_hashes ?? null,
      operation: receipt.operation ?? null,
      decisions: legacy
        ? receipt.decisions.map((decision) => ({
            field: decision.field,
            retained_hash: sha256Hex(stableStringify(encodeItemScalarDecisionValue(decision.retained))),
            discarded_hash: sha256Hex(stableStringify(encodeItemScalarDecisionValue(decision.discarded))),
          }))
        : summarizeMergeReceipt(receipt).decisions,
    }),
  );
}

/** Compare historical plain-scalar and current presence-domain hashes without changing stored evidence. */
function receiptProvenanceFingerprints(receipt: MergeDecisionReceipt): string[] {
  const fingerprints = [receiptProvenanceFingerprint(receipt)];
  if (receipt.value_policy === undefined &&
      (receipt.value_availability === undefined || receipt.value_availability === "clone_local")) {
    fingerprints.push(receiptProvenanceFingerprint(receipt, true));
  }
  return fingerprints;
}

/** Merge clone-local and durable lifecycle state without losing pending work. */
function mergeReceiptCopyLifecycle(
  local: MergeDecisionReceipt,
  durable: MergeDecisionReceipt,
): MergeDecisionReceipt {
  if (local.state === "reconciled" && durable.state === "reconciled" && local.settlement === durable.settlement) {
    return local;
  }
  const { reconciled_at: _reconciledAt, settlement: _settlement, ...pendingLocal } = local;
  return { ...pendingLocal, state: "pending" };
}

/** Convert a raw receipt into privacy-safe history context. */
export function summarizeMergeReceipt(
  receipt: MergeDecisionReceipt,
): MergeDecisionReceiptSummary {
  return {
    receipt_id: receipt.id,
    item_id: receipt.item_id,
    item_path: receipt.item_path,
    conflict_fields: receipt.decisions.map((decision) => decision.field),
    fields_from_theirs: receipt.fields_from_theirs,
    union_fields: receipt.union_fields,
    requested_preference:
      receipt.requested_preference ?? receipt.preferred ?? "ours",
    requested_preference_applied:
      receipt.requested_preference_applied ??
      (receipt.conflict_resolution ?? "preferred_side") === "preferred_side",
    conflict_resolution: receipt.conflict_resolution,
    decisions: receipt.decisions.map((decision) => ({
      field: decision.field,
      retained_hash:
        isPrehashedValue(decision.retained) ??
        hashItemScalarDecisionValue(
          isItemScalarMissingValue(decision.retained)
            ? undefined
            : decision.retained,
        ),
      discarded_hash:
        isPrehashedValue(decision.discarded) ??
        hashItemScalarDecisionValue(
          isItemScalarMissingValue(decision.discarded)
            ? undefined
            : decision.discarded,
        ),
    })),
  };
}

/** Persist one item-driver outcome in the clone-local Git directory. */
export async function writeMergeReceipt(params: {
  cwd: string;
  itemPath: string;
  preferred: MergePreferredSide;
  conflictResolution?: ItemScalarConflictResolution;
  fieldsFromTheirs: string[];
  unionFields: string[];
  mergedFieldHashes?: Record<string, string>;
  decisions: ItemMergeConflictDecision[];
  operation?: MergeReceiptOperation;
}): Promise<MergeDecisionReceipt | null> {
  const directory = await resolveReceiptDirectory(params.cwd);
  if (directory === null) {
    return null;
  }
  const trimmedItemPath = params.itemPath.trim();
  const itemPath =
    /^(['"])(.*)\1$/su.exec(trimmedItemPath)?.[2] ?? trimmedItemPath;
  const itemId = path.basename(itemPath, path.extname(itemPath));
  const receipt: MergeDecisionReceipt = {
    version: 1,
    id: randomUUID(),
    item_path: itemPath.replaceAll("\\", "/"),
    item_id: itemId,
    requested_preference: params.preferred,
    requested_preference_applied:
      (params.conflictResolution ?? "preferred_side") === "preferred_side",
    conflict_resolution: params.conflictResolution ?? "preferred_side",
    fields_from_theirs: [...params.fieldsFromTheirs],
    union_fields: [...params.unionFields],
    ...(params.mergedFieldHashes
      ? { merged_field_hashes: { ...params.mergedFieldHashes } }
      : {}),
    decisions: structuredClone(params.decisions).map((decision) => ({
      ...decision,
      base: encodeItemScalarDecisionValue(decision.base),
      ours: encodeItemScalarDecisionValue(decision.ours),
      theirs: encodeItemScalarDecisionValue(decision.theirs),
      retained: encodeItemScalarDecisionValue(decision.retained),
      discarded: encodeItemScalarDecisionValue(decision.discarded),
    })),
    ...(params.operation ? { operation: params.operation } : {}),
    state: "pending",
    created_at: nowIso(),
    value_availability: "clone_local",
  };
  await ensureDir(directory);
  await writeFileAtomic(
    path.join(directory, receiptFileName(receipt.id)),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  const trackerRoot = await resolveTrackerRootFromItemPath(
    params.cwd,
    receipt.item_path,
  );
  if (trackerRoot !== null) {
    const durableDirectory = durableReceiptDirectory(trackerRoot);
    const durableDecisions = receipt.decisions.map((decision) => ({
      field: decision.field,
      base: null,
      ours: null,
      theirs: null,
      retained: durableValueEvidence(decision.field, decision.retained),
      discarded: durableValueEvidence(decision.field, decision.discarded),
      retained_side: decision.retained_side,
      resolution_basis: decision.resolution_basis,
    }));
    const inlineValueCount = durableDecisions.reduce(
      (count, decision) =>
        count +
        (Object.hasOwn(decision.retained, "pm_value") ? 1 : 0) +
        (Object.hasOwn(decision.discarded, "pm_value") ? 1 : 0),
      0,
    );
    const durableReceipt: MergeDecisionReceipt = {
      ...receipt,
      decisions: durableDecisions,
      value_availability:
        inlineValueCount === 0
          ? "hash_only"
          : inlineValueCount === durableDecisions.length * 2
            ? "bounded_inline"
            : "mixed",
      value_policy: DURABLE_VALUE_POLICY,
    };
    await ensureDir(durableDirectory);
    await writeFileAtomic(
      path.join(durableDirectory, receiptFileName(receipt.id)),
      `${JSON.stringify(durableReceipt, null, 2)}\n`,
    );
  }
  return receipt;
}

/** Scan one receipt directory with bounded per-candidate failure evidence. */
async function readReceiptsFromDirectory(
  directory: string,
  evidenceSource: "clone_local" | "durable",
): Promise<
  Pick<
    MergeReceiptEvidenceScan,
    | "receipts"
    | "invalid_evidence_count"
    | "invalid_evidence"
    | "invalid_evidence_truncated"
  >
> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error: unknown) {
    const absent = await receiptDirectoryFailureMeansAbsent(directory, error);
    return {
      receipts: [],
      invalid_evidence_count: absent ? 0 : 1,
      invalid_evidence: absent
        ? []
        : [{ evidence_source: evidenceSource, reason: "directory_unreadable" }],
      invalid_evidence_truncated: false,
    };
  }
  const receipts: MergeDecisionReceipt[] = [];
  let invalidEvidenceCount = 0;
  const invalidEvidence: MergeReceiptInvalidEvidence[] = [];
  const recordInvalidEvidence = (
    name: string,
    candidate: Pick<MergeReceiptInvalidEvidence, "reason" | "validation_error" | "validation_path">,
  ): void => {
    invalidEvidenceCount += 1;
    if (invalidEvidence.length >= RECEIPT_INVALID_EVIDENCE_DETAIL_LIMIT) return;
    const receiptId = name.slice(0, -".json".length);
    invalidEvidence.push({
      evidence_source: evidenceSource,
      reason: candidate.reason,
      ...(candidate.validation_path ? { validation_path: candidate.validation_path } : {}),
      ...(candidate.validation_error === undefined
        ? {}
        : { validation_error: candidate.validation_error }),
      ...(isSafeReceiptId(receiptId)
        ? { receipt_id: receiptId }
        : { candidate_name_hash: sha256Hex(name) }),
    });
  };
  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    if (!name.endsWith(".json")) continue;
    const candidate = await inspectReceiptCandidate(
      directory,
      name,
      evidenceSource,
    );
    if (candidate.receipt !== undefined) {
      receipts.push(candidate.receipt);
    } else {
      recordInvalidEvidence(name, candidate);
    }
  }
  return {
    receipts,
    invalid_evidence_count: invalidEvidenceCount,
    invalid_evidence: invalidEvidence,
    invalid_evidence_truncated: invalidEvidenceCount > invalidEvidence.length,
  };
}

/** Distinguish a missing optional receipt store from an unreadable one. */
async function receiptDirectoryFailureMeansAbsent(
  directory: string,
  error: unknown,
  inspectAncestor: (
    ancestor: string,
  ) => Promise<Pick<Stats, "isDirectory">> = stat,
): Promise<boolean> {
  if (!isFileMissingError(error)) return false;
  let ancestor = directory;
  while (true) {
    try {
      return (await inspectAncestor(ancestor)).isDirectory();
    } catch (ancestorError: unknown) {
      if (!isFileMissingError(ancestorError)) return false;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return true;
      ancestor = parent;
    }
  }
}

/** Inspect one candidate without exposing rejected file contents. */
async function inspectReceiptCandidate(
  directory: string,
  name: string,
  evidenceSource: "clone_local" | "durable",
): Promise<
  | { receipt: MergeDecisionReceipt; reason?: never }
  | {
      receipt?: never;
      reason: MergeReceiptInvalidEvidence["reason"];
      validation_error?: MergeReceiptInvalidEvidence["validation_error"];
      validation_path?: string;
    }
> {
  let raw: string | null;
  try {
    raw = await readBoundedRegularFile(path.join(directory, name), RECEIPT_FILE_MAX_BYTES);
  } catch {
    return { reason: "candidate_unreadable" };
  }
  if (raw === null) return { reason: "candidate_not_bounded_regular_file" };
  let parsed: unknown;
  try {
    parsed = normalizeLegacyReceipt(JSON.parse(raw) as unknown);
  } catch {
    return { reason: "candidate_invalid_json" };
  }
  const validationError = receiptValidationError(parsed, evidenceSource);
  if (validationError !== null) {
    const identityErrors: ReadonlySet<
      MergeReceiptInvalidEvidence["validation_error"]
    > = new Set(["receipt_id", "item_id", "item_path"]);
    return {
      reason: identityErrors.has(validationError)
        ? "identity_invalid"
        : "schema_invalid",
      validation_error: validationError,
      ...(validationError === "collections" ? { validation_path: receiptCollectionValidationPath(parsed) } : {}),
    };
  }
  const receipt = parsed as MergeDecisionReceipt;
  if (name !== receiptFileName(receipt.id)) {
    return { reason: "identity_invalid", validation_error: "filename" };
  }
  const {
    preferred: legacyPreference,
    evidence_source: _serializedEvidenceSource,
    ...receiptWithoutRuntimeKeys
  } = receipt;
  return {
    receipt: {
      ...receiptWithoutRuntimeKeys,
      requested_preference:
        receipt.requested_preference ?? legacyPreference ?? "ours",
      requested_preference_applied:
        receipt.requested_preference_applied ??
        (receipt.conflict_resolution ?? "preferred_side") === "preferred_side",
      conflict_resolution: receipt.conflict_resolution ?? "preferred_side",
      evidence_source: evidenceSource,
    },
  };
}

/** Inspect valid receipts and count invalid evidence without returning untrusted file contents. */
export async function inspectMergeReceiptEvidence(
  cwd: string,
  options: {
    /** Include receipts whose reconciliation state is already settled. */
    includeReconciled?: boolean;
    /** Include receipts that contain no discarded scalar values. */
    includeLossless?: boolean;
    /** Explicit tracker root used to locate durable receipt evidence. */
    pmRoot?: string;
  } = {},
): Promise<MergeReceiptEvidenceScan> {
  const directory = await resolveReceiptDirectory(cwd);
  const local =
    directory === null
      ? {
          receipts: [],
          invalid_evidence_count: 0,
          invalid_evidence: [],
          invalid_evidence_truncated: false,
        }
      : await readReceiptsFromDirectory(directory, "clone_local");
  const trackerRoot = options.pmRoot ?? path.join(cwd, ".agents", "pm");
  const durable = await readReceiptsFromDirectory(
    durableReceiptDirectory(trackerRoot),
    "durable",
  );
  const receipts = new Map(
    durable.receipts.map((receipt) => [receipt.id, receipt]),
  );
  let divergentCopyCount = 0;
  const divergentCopyEvidence: MergeReceiptInvalidEvidence[] = [];
  for (const receipt of local.receipts) {
    const durableCopy = receipts.get(receipt.id);
    if (
      durableCopy !== undefined &&
      !(durableCopy.value_policy === undefined ? receiptProvenanceFingerprints(receipt)
        : [receiptProvenanceFingerprint(receipt)]).includes(receiptProvenanceFingerprint(durableCopy))
    ) {
      receipts.delete(receipt.id);
      divergentCopyCount += 1;
      if (
        local.invalid_evidence.length +
          durable.invalid_evidence.length +
          divergentCopyEvidence.length <
        RECEIPT_INVALID_EVIDENCE_DETAIL_LIMIT
      ) {
        divergentCopyEvidence.push({
          evidence_source: "clone_local_and_durable",
          reason: "copy_provenance_mismatch",
          receipt_id: receipt.id,
        });
      }
      continue;
    }
    receipts.set(
      receipt.id,
      durableCopy === undefined
        ? receipt
        : mergeReceiptCopyLifecycle(receipt, durableCopy),
    );
  }
  return {
    receipts: [...receipts.values()]
      .filter(
        (receipt) =>
          (options.includeReconciled || receipt.state === "pending") &&
          (options.includeLossless !== false || receipt.decisions.length > 0),
      )
      .sort((left, right) => left.created_at.localeCompare(right.created_at)),
    invalid_evidence_count:
      local.invalid_evidence_count +
      durable.invalid_evidence_count +
      divergentCopyCount,
    invalid_evidence: [
      ...local.invalid_evidence,
      ...durable.invalid_evidence,
      ...divergentCopyEvidence,
    ].slice(0, RECEIPT_INVALID_EVIDENCE_DETAIL_LIMIT),
    invalid_evidence_truncated:
      local.invalid_evidence_truncated ||
      durable.invalid_evidence_truncated ||
      local.invalid_evidence_count +
        durable.invalid_evidence_count +
        divergentCopyCount >
        RECEIPT_INVALID_EVIDENCE_DETAIL_LIMIT,
    clone_local_evidence_resolved: directory !== null,
  };
}

/** Read clone-local receipts with explicit reconciled/lossless classification controls. */
export async function listMergeReceipts(
  cwd: string,
  options: {
    includeReconciled?: boolean;
    includeLossless?: boolean;
    pmRoot?: string;
  } = {},
): Promise<MergeDecisionReceipt[]> {
  return (await inspectMergeReceiptEvidence(cwd, options)).receipts;
}

/** Split merge provenance into receipts with discarded values and receipts whose composition was lossless. */
export function partitionMergeReceipts(receipts: MergeDecisionReceipt[]): {
  /** Receipts that require an explicit decision because at least one competing scalar value was discarded. */
  pendingDecisions: MergeDecisionReceipt[];
  /** Receipts that record provenance without a discarded competing scalar value. */
  lossless: MergeDecisionReceipt[];
} {
  const pendingDecisions: MergeDecisionReceipt[] = [];
  const lossless: MergeDecisionReceipt[] = [];
  for (const receipt of receipts) {
    (Array.isArray(receipt.decisions) && receipt.decisions.length > 0
      ? pendingDecisions
      : lossless
    ).push(receipt);
  }
  return { pendingDecisions, lossless };
}

/** Mark a receipt as represented by a committed merge history event. */
export async function markMergeReceiptReconciled(
  cwd: string,
  receipt: MergeDecisionReceipt,
  options: { requireExisting?: boolean; settlement?: "original_git_state_restored" } = {},
): Promise<void> {
  const directory = await resolveReceiptDirectory(cwd);
  if (directory === null) {
    if (options.requireExisting === true) {
      throw new Error(`Receipt ${receipt.id} disappeared before settlement.`);
    }
    return;
  }
  const receiptEvidenceSource = receipt.evidence_source ?? "clone_local";
  if (!isMergeDecisionReceipt(receipt, receiptEvidenceSource)) {
    throw new Error(
      "Merge receipt trusted settlement input failed schema validation.",
    );
  }
  const reconciledAt = nowIso();
  const localPath = path.join(directory, receiptFileName(receipt.id));
  const trackerRoot = await resolveTrackerRootFromItemPath(
    cwd,
    receipt.item_path,
  );
  const durablePath =
    trackerRoot === null
      ? null
      : path.join(
          durableReceiptDirectory(trackerRoot),
          receiptFileName(receipt.id),
        );
  const prepared = await Promise.all([
    prepareReceiptSettlement({
      receiptPath: localPath,
      receiptId: receipt.id,
      evidenceSource: "clone_local",
      reconciledAt,
      settlement: options.settlement,
    }),
    ...(durablePath === null
      ? []
      : [
          prepareReceiptSettlement({
            receiptPath: durablePath,
            receiptId: receipt.id,
            evidenceSource: "durable" as const,
            reconciledAt,
            settlement: options.settlement,
          }),
        ]),
  ]);
  const writes = prepared.filter(
    (entry): entry is { path: string; content: string; fingerprints: string[]; modern: boolean } =>
      entry !== null,
  );
  if (writes.length === 0) {
    if (options.requireExisting === true) {
      throw new Error(`Receipt ${receipt.id} disappeared before settlement.`);
    }
    return;
  }
  const expectedFingerprints = writes.some((write) => write.modern)
    ? [receiptProvenanceFingerprint(receipt)] : receiptProvenanceFingerprints(receipt);
  if (!expectedFingerprints.some((fingerprint) =>
    writes.every((write) => write.fingerprints.includes(fingerprint)),
  )) {
    throw new Error(
      `Receipt ${receipt.id} settlement copies disagree on immutable merge provenance.`,
    );
  }
  for (const write of writes) {
    await writeFileAtomic(write.path, write.content);
  }
}

/** Report pending or historical clone-local merge decisions. */
export async function runMergeReceiptReport(options: {
  /** Include receipts already represented by merge history events. */
  includeReconciled?: boolean;
  /** Repository directory to inspect; defaults to the process working directory. */
  cwd?: string;
}): Promise<MergeReceiptReport> {
  const receipts = await listMergeReceipts(options.cwd ?? process.cwd(), {
    ...options,
    includeLossless: true,
  });
  return {
    ok: true,
    count: receipts.length,
    receipts,
    generated_at: nowIso(),
  };
}

/** Inspect every receipt candidate and retain completeness diagnostics without exposing rejected file contents. */
export async function runMergeReceiptEvidenceReport(options: {
  /** Include receipts already represented by merge history events. */
  includeReconciled?: boolean;
  /** Repository directory to inspect; defaults to the process working directory. */
  cwd?: string;
}): Promise<MergeReceiptEvidenceReport> {
  const evidence = await inspectMergeReceiptEvidence(
    options.cwd ?? process.cwd(),
    {
      ...options,
      includeLossless: true,
    },
  );
  const complete =
    evidence.clone_local_evidence_resolved === true &&
    evidence.invalid_evidence_count === 0;
  return {
    ok: complete,
    complete,
    count: evidence.receipts.length,
    invalid_evidence_count: evidence.invalid_evidence_count,
    invalid_evidence: evidence.invalid_evidence,
    invalid_evidence_truncated: evidence.invalid_evidence_truncated,
    clone_local_evidence_resolved: evidence.clone_local_evidence_resolved,
    receipts: evidence.receipts,
    generated_at: nowIso(),
  };
}

/** Test-only seams for deterministic receipt-boundary fault coverage. */
export const _testOnlyMergeReceipts = {
  prepareReceiptSettlement,
  receiptDirectoryFailureMeansAbsent,
};
