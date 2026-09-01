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
import { isRfc3339DateTime, nowIso } from "../../core/shared/time.js";
import type {
  ItemMergeConflictDecision,
  MergePreferredSide,
} from "./three-way.js";
import { readBoundedRegularFile } from "./receipt-file-boundary.js";

const execFileAsync = promisify(execFile);
const RECEIPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const RECEIPT_ITEM_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const RECEIPT_FIELD_MAX = 2_048;
const RECEIPT_FILE_MAX_BYTES = 16 * 1024 * 1024;
const RECEIPT_VALUE_MAX_DEPTH = 64;
const RECEIPT_VALUE_MAX_NODES = 100_000;
const RECEIPT_INVALID_EVIDENCE_DETAIL_LIMIT = 100;
const RECEIPT_KEYS = new Set([
  "version",
  "id",
  "item_path",
  "item_id",
  "requested_preference",
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
  "evidence_source",
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
]);

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
  /** Legacy schema-v1 key accepted while reading older clone-local receipts. */
  preferred?: MergePreferredSide;
  /** Scalar-conflict selection contract used by the item driver. */
  conflict_resolution: "preferred_side" | "stable_value_order";
  /** Fields selected cleanly from the other branch. */
  fields_from_theirs: string[];
  /** Collections combined from both branches. */
  union_fields: string[];
  /** SHA-256 hashes of the merged values for every field represented by this receipt. Absent on legacy receipts, which cannot prove drift attribution. */
  merged_field_hashes?: Record<string, string>;
  /** Full recoverable scalar decisions, retained only in the clone. */
  decisions: ItemMergeConflictDecision[];
  /** Whether a merge reconciliation history event consumed this receipt. */
  state: "pending" | "reconciled";
  /** Receipt creation timestamp. */
  created_at: string;
  /** Reconciliation timestamp, when consumed. */
  reconciled_at?: string;
  /** Whether decision values are recoverable locally or represented by hashes only. */
  value_availability?: "clone_local" | "hash_only";
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
  /** Scalar-conflict selection contract used by the item driver. */
  conflict_resolution: "preferred_side" | "stable_value_order";
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
    | "copy_provenance_mismatch";
  /** Receipt identity when the bounded filename itself is a valid receipt id. */
  receipt_id?: string;
  /** SHA-256 locator for an unsafe or malformed candidate filename. */
  candidate_name_hash?: string;
}

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

function durableReceiptDirectory(pmRoot: string): string {
  return path.join(pmRoot, "merge-receipts");
}

function receiptFileName(id: string): string {
  return `${id}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

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

function isMergeDecision(value: unknown): value is ItemMergeConflictDecision {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, RECEIPT_DECISION_KEYS) &&
    typeof value.field === "string" &&
    value.field.length > 0 &&
    value.field.length <= 256 &&
    Object.hasOwn(value, "base") &&
    Object.hasOwn(value, "ours") &&
    Object.hasOwn(value, "theirs") &&
    Object.hasOwn(value, "retained") &&
    Object.hasOwn(value, "discarded") &&
    hasBoundedJsonStructure(value.base) &&
    hasBoundedJsonStructure(value.ours) &&
    hasBoundedJsonStructure(value.theirs) &&
    hasBoundedJsonStructure(value.retained) &&
    hasBoundedJsonStructure(value.discarded)
  );
}

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

function hasValidReceiptIdentity(value: Record<string, unknown>): boolean {
  return !hasOnlyKeys(value, RECEIPT_KEYS) || value.version !== 1
    ? false
    : typeof value.id === "string" &&
        isSafeReceiptId(value.id) &&
        typeof value.item_id === "string" &&
        RECEIPT_ITEM_ID_PATTERN.test(value.item_id) &&
        isSafeReceiptItemPath(value.item_path, value.item_id);
}

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

function hasValidReceiptEnums(value: Record<string, unknown>): boolean {
  const preferences = [undefined, "ours", "theirs"];
  const resolutions = [undefined, "preferred_side", "stable_value_order"];
  const availabilities = [undefined, "clone_local", "hash_only"];
  const sources = [undefined, "clone_local", "durable"];
  return (
    preferences.includes(value.requested_preference as string | undefined) &&
    preferences.includes(value.preferred as string | undefined) &&
    resolutions.includes(value.conflict_resolution as string | undefined) &&
    (value.state === "pending" || value.state === "reconciled") &&
    availabilities.includes(value.value_availability as string | undefined) &&
    sources.includes(value.evidence_source as string | undefined)
  );
}

function hasValidReceiptTimestamps(value: Record<string, unknown>): boolean {
  return (
    typeof value.created_at === "string" &&
    isRfc3339DateTime(value.created_at) &&
    (value.reconciled_at === undefined ||
      (typeof value.reconciled_at === "string" &&
        isRfc3339DateTime(value.reconciled_at)))
  );
}

function hasHashOnlyDurableDecisions(receipt: MergeDecisionReceipt): boolean {
  return (
    receipt.value_availability === "hash_only" &&
    receipt.decisions.every(
      (decision) =>
        decision.base === null &&
        decision.ours === null &&
        decision.theirs === null &&
        isExactPrehashedValue(decision.retained) &&
        isExactPrehashedValue(decision.discarded),
    )
  );
}

function isMergeDecisionReceipt(
  value: unknown,
  evidenceSource: "clone_local" | "durable",
): value is MergeDecisionReceipt {
  if (
    !isRecord(value) ||
    !hasValidReceiptIdentity(value) ||
    !hasValidReceiptCollections(value) ||
    !hasValidReceiptEnums(value) ||
    !hasValidReceiptTimestamps(value)
  ) {
    return false;
  }
  const receipt = value as unknown as MergeDecisionReceipt;
  return evidenceSource !== "durable" || hasHashOnlyDurableDecisions(receipt);
}

async function readBoundedRegularReceiptFile(
  receiptPath: string,
): Promise<string | null> {
  return readBoundedRegularFile(receiptPath, RECEIPT_FILE_MAX_BYTES);
}

async function prepareReceiptSettlement(params: {
  receiptPath: string;
  receiptId: string;
  evidenceSource: "clone_local" | "durable";
  reconciledAt: string;
  readReceipt?: (receiptPath: string) => Promise<string | null>;
}): Promise<{ path: string; content: string; fingerprint: string } | null> {
  let raw: string | null;
  try {
    raw = await (params.readReceipt ?? readBoundedRegularReceiptFile)(
      params.receiptPath,
    );
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
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(
      `Receipt ${params.receiptId} settlement source is not valid JSON.`,
    );
  }
  if (
    !isMergeDecisionReceipt(parsed, params.evidenceSource) ||
    parsed.id !== params.receiptId ||
    path.basename(params.receiptPath) !== receiptFileName(parsed.id)
  ) {
    throw new Error(
      `Receipt ${params.receiptId} settlement source failed schema or identity validation.`,
    );
  }
  const { evidence_source: _evidenceSource, ...persistedReceipt } = parsed;
  return {
    path: params.receiptPath,
    fingerprint: receiptProvenanceFingerprint(parsed),
    content: `${JSON.stringify(
      {
        ...persistedReceipt,
        state: "reconciled",
        reconciled_at: params.reconciledAt,
      },
      null,
      2,
    )}\n`,
  };
}

function receiptProvenanceFingerprint(receipt: MergeDecisionReceipt): string {
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
      decisions: summarizeMergeReceipt(receipt).decisions,
    }),
  );
}

function mergeReceiptCopyLifecycle(
  local: MergeDecisionReceipt,
  durable: MergeDecisionReceipt,
): MergeDecisionReceipt {
  if (local.state === "reconciled" && durable.state === "reconciled") {
    return local;
  }
  const { reconciled_at: _reconciledAt, ...pendingLocal } = local;
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
    conflict_resolution: receipt.conflict_resolution,
    decisions: receipt.decisions.map((decision) => ({
      field: decision.field,
      retained_hash:
        isPrehashedValue(decision.retained) ??
        sha256Hex(stableStringify(decision.retained)),
      discarded_hash:
        isPrehashedValue(decision.discarded) ??
        sha256Hex(stableStringify(decision.discarded)),
    })),
  };
}

function isPrehashedValue(value: unknown): string | undefined {
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

function isExactPrehashedValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    isPrehashedValue(value) !== undefined
  );
}

/** Persist one item-driver outcome in the clone-local Git directory. */
export async function writeMergeReceipt(params: {
  cwd: string;
  itemPath: string;
  preferred: MergePreferredSide;
  conflictResolution?: "preferred_side" | "stable_value_order";
  fieldsFromTheirs: string[];
  unionFields: string[];
  mergedFieldHashes?: Record<string, string>;
  decisions: ItemMergeConflictDecision[];
}): Promise<MergeDecisionReceipt | null> {
  const directory = await resolveReceiptDirectory(params.cwd);
  if (directory === null) {
    return null;
  }
  const trimmedItemPath = params.itemPath.trim();
  const itemPath =
    trimmedItemPath.length >= 2 &&
    ((trimmedItemPath.startsWith("'") && trimmedItemPath.endsWith("'")) ||
      (trimmedItemPath.startsWith('"') && trimmedItemPath.endsWith('"')))
      ? trimmedItemPath.slice(1, -1)
      : trimmedItemPath;
  const itemId = path.basename(itemPath, path.extname(itemPath));
  const receipt: MergeDecisionReceipt = {
    version: 1,
    id: randomUUID(),
    item_path: itemPath.replaceAll("\\", "/"),
    item_id: itemId,
    requested_preference: params.preferred,
    conflict_resolution: params.conflictResolution ?? "preferred_side",
    fields_from_theirs: [...params.fieldsFromTheirs],
    union_fields: [...params.unionFields],
    ...(params.mergedFieldHashes
      ? { merged_field_hashes: { ...params.mergedFieldHashes } }
      : {}),
    decisions: structuredClone(params.decisions),
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
    const summary = summarizeMergeReceipt(receipt);
    const durableReceipt: MergeDecisionReceipt = {
      ...receipt,
      decisions: summary.decisions.map((decision) => ({
        field: decision.field,
        base: null,
        ours: null,
        theirs: null,
        retained: { pm_value_hash: decision.retained_hash },
        discarded: { pm_value_hash: decision.discarded_hash },
      })),
      value_availability: "hash_only",
    };
    await ensureDir(durableDirectory);
    await writeFileAtomic(
      path.join(durableDirectory, receiptFileName(receipt.id)),
      `${JSON.stringify(durableReceipt, null, 2)}\n`,
    );
  }
  return receipt;
}

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
    reason: MergeReceiptInvalidEvidence["reason"],
  ): void => {
    invalidEvidenceCount += 1;
    if (invalidEvidence.length >= RECEIPT_INVALID_EVIDENCE_DETAIL_LIMIT) return;
    const receiptId = name.slice(0, -".json".length);
    invalidEvidence.push({
      evidence_source: evidenceSource,
      reason,
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
      recordInvalidEvidence(name, candidate.reason);
    }
  }
  return {
    receipts,
    invalid_evidence_count: invalidEvidenceCount,
    invalid_evidence: invalidEvidence,
    invalid_evidence_truncated: invalidEvidenceCount > invalidEvidence.length,
  };
}

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

async function inspectReceiptCandidate(
  directory: string,
  name: string,
  evidenceSource: "clone_local" | "durable",
): Promise<
  | { receipt: MergeDecisionReceipt; reason?: never }
  | { receipt?: never; reason: MergeReceiptInvalidEvidence["reason"] }
> {
  let raw: string | null;
  try {
    raw = await readBoundedRegularReceiptFile(path.join(directory, name));
  } catch {
    return { reason: "candidate_unreadable" };
  }
  if (raw === null) return { reason: "candidate_not_bounded_regular_file" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { reason: "candidate_invalid_json" };
  }
  if (
    !isMergeDecisionReceipt(parsed, evidenceSource) ||
    name !== receiptFileName(parsed.id)
  ) {
    return { reason: "schema_or_identity_invalid" };
  }
  const {
    preferred: legacyPreference,
    evidence_source: _serializedEvidenceSource,
    ...receiptWithoutRuntimeKeys
  } = parsed;
  return {
    receipt: {
      ...receiptWithoutRuntimeKeys,
      requested_preference:
        parsed.requested_preference ?? legacyPreference ?? "ours",
      conflict_resolution: parsed.conflict_resolution ?? "preferred_side",
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
      receiptProvenanceFingerprint(durableCopy) !==
        receiptProvenanceFingerprint(receipt)
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
  options: { requireExisting?: boolean } = {},
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
    }),
    ...(durablePath === null
      ? []
      : [
          prepareReceiptSettlement({
            receiptPath: durablePath,
            receiptId: receipt.id,
            evidenceSource: "durable" as const,
            reconciledAt,
          }),
        ]),
  ]);
  const writes = prepared.filter(
    (entry): entry is { path: string; content: string; fingerprint: string } =>
      entry !== null,
  );
  if (writes.length === 0) {
    if (options.requireExisting === true) {
      throw new Error(`Receipt ${receipt.id} disappeared before settlement.`);
    }
    return;
  }
  const expectedFingerprint = receiptProvenanceFingerprint(receipt);
  if (
    new Set([expectedFingerprint, ...writes.map((write) => write.fingerprint)])
      .size !== 1
  ) {
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
