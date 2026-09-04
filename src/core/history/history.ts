/**
 * @module core/history/history
 *
 * Implements append-only history and replay behavior for History.
 */
import jsonPatch from "fast-json-patch";
import fs from "node:fs/promises";
import path from "node:path";
import { EXIT_CODE, ITEM_METADATA_KEY_ORDER } from "../shared/constants.js";
import { runActiveServiceOverride } from "../extensions/index.js";
import { appendLineAtomic } from "../fs/fs-utils.js";
import { canonicalDocument } from "../item/item-format.js";
import { toItemRecord } from "../item/item-record.js";
import {
  orderObject,
  sha256Hex,
  stableStringify,
} from "../shared/serialization.js";
import {
  isMillisecondPrecisionRfc3339DateTime,
  nowIso,
} from "../shared/time.js";
import {
  diagnoseAgentIdentity,
  resolveHistoryAgentIdentity,
  resolveHistoryAuthorSource,
  type AuthorSource,
} from "../shared/author.js";
import type {
  HistoryEntry,
  HistoryPatchOp,
  HistoryReanchorEvidence,
  ItemDocument,
  LinkedTest,
} from "../../types/index.js";
import {
  appendHistoryEntryWithEventIndex,
  removeHistoryEventIndexForHistoryPath,
} from "./event-index.js";
import { classifyHistoryEvent } from "./event-classification.js";
import { invalidateHistoryDriftCacheForPath } from "./drift-cache.js";
import { PmCliError } from "../shared/errors.js";

const EMPTY_LEGACY_HASH_DOCUMENT = {
  front_matter: {},
  body: "",
};

/** Hash epoch for the current canonical item surface written into immutable history. */
export const CURRENT_HISTORY_ITEM_HASH_VERSION = 3 as const;
/** Hash epochs understood by this runtime. */
export const SUPPORTED_HISTORY_ITEM_HASH_VERSIONS = [1, 2, 3] as const;
/** Record-integrity epoch written beside new immutable history events. */
export const CURRENT_HISTORY_RECORD_HASH_VERSION = 1 as const;
/** Record-integrity epochs understood by this runtime. */
export const SUPPORTED_HISTORY_RECORD_HASH_VERSIONS = [1] as const;
/** Restricts item hash versions accepted by history replay. */
export type HistoryItemHashVersion =
  (typeof SUPPORTED_HISTORY_ITEM_HASH_VERSIONS)[number];
/** Restricts immutable-record hash versions accepted by history replay. */
export type HistoryRecordHashVersion =
  (typeof SUPPORTED_HISTORY_RECORD_HASH_VERSIONS)[number];

/** Canonicalize and hash every immutable record field except the hash value itself. */
export function hashHistoryRecord(
  entry: Omit<HistoryEntry, "record_hash">,
): string {
  return sha256Hex(stableStringify(entry));
}

/** Hash one patch representation without retaining its potentially sensitive values. */
export function hashHistoryPatch(patch: readonly HistoryPatchOp[]): string {
  return sha256Hex(stableStringify(patch));
}

/** Hash an ordered history prefix for compact checkpoint provenance. */
export function hashHistoryStream(entries: readonly HistoryEntry[]): string {
  return sha256Hex(stableStringify(entries));
}

/** Attach the current immutable-record integrity envelope to one history event. */
export function sealHistoryRecord(entry: HistoryEntry): HistoryEntry {
  const sealed = {
    ...entry,
    record_hash_version: CURRENT_HISTORY_RECORD_HASH_VERSION,
  };
  const { record_hash: _recordHash, ...canonical } = sealed;
  return { ...sealed, record_hash: hashHistoryRecord(canonical) };
}

/** Verify record-level attribution coverage while accepting explicit legacy item-state-only entries. */
export function verifyHistoryRecordHash(entry: HistoryEntry):
  | { ok: true; coverage: "record_and_item_state" | "item_state_only" }
  | {
      ok: false;
      error:
        | "incomplete_record_hash_envelope"
        | "record_hash_mismatch"
        | "unsupported_record_hash_version";
    } {
  if (
    entry.record_hash_version === undefined &&
    entry.record_hash === undefined
  ) {
    return { ok: true, coverage: "item_state_only" };
  }
  if (
    entry.record_hash_version === undefined ||
    entry.record_hash === undefined
  ) {
    return { ok: false, error: "incomplete_record_hash_envelope" };
  }
  if (
    !(SUPPORTED_HISTORY_RECORD_HASH_VERSIONS as readonly number[]).includes(
      entry.record_hash_version,
    )
  ) {
    return { ok: false, error: "unsupported_record_hash_version" };
  }
  const { record_hash: _recordHash, ...canonical } = entry;
  return hashHistoryRecord(canonical) === entry.record_hash
    ? { ok: true, coverage: "record_and_item_state" }
    : { ok: false, error: "record_hash_mismatch" };
}

/** Build the retained coordinate and optional exact-record rewrite evidence. */
function createHistoryRewriteEvidence(
  original: HistoryEntry,
  options: Readonly<{
    retainOriginalPatch?: boolean;
    retainPriorRecordHash?: boolean;
  }>,
): HistoryReanchorEvidence {
  const evidence: HistoryReanchorEvidence = {
    before_hash: original.before_hash,
    after_hash: original.after_hash,
    patch_hash: hashHistoryPatch(original.patch),
  };
  if (original.item_hash_version !== undefined) {
    evidence.item_hash_version = original.item_hash_version;
  }
  if (options.retainOriginalPatch) {
    evidence.patch = structuredClone(original.patch);
  }
  if (
    options.retainPriorRecordHash !== false &&
    original.record_hash_version !== undefined &&
    original.record_hash !== undefined
  ) {
    evidence.record_hash_version = original.record_hash_version;
    evidence.record_hash = original.record_hash;
    evidence.record = structuredClone(original);
  }
  return evidence;
}

/** Reseal a maintenance rewrite and retain the anchors and patch digest it replaced. */
export function resealHistoryRewrite(
  original: HistoryEntry,
  rewritten: HistoryEntry,
  options: Readonly<{
    retainOriginalPatch?: boolean;
    retainPriorRecord?: boolean;
    retainPriorRecordHash?: boolean;
  }> = {},
): HistoryEntry {
  const originalRecordVerification = verifyHistoryRecordHash(original);
  if (!originalRecordVerification.ok) {
    throw new TypeError(originalRecordVerification.error);
  }
  const originalPatchHash = hashHistoryPatch(original.patch);
  const retainsRewriteEvidence =
    options.retainPriorRecord === true ||
    original.before_hash !== rewritten.before_hash ||
    original.after_hash !== rewritten.after_hash ||
    original.item_hash_version !== rewritten.item_hash_version ||
    originalPatchHash !== hashHistoryPatch(rewritten.patch);
  const sealed = sealHistoryRecord({
    ...rewritten,
    ...(retainsRewriteEvidence
      ? {
          reanchor_evidence: [
            ...(rewritten.reanchor_evidence ?? []),
            createHistoryRewriteEvidence(original, options),
          ],
        }
      : {}),
  });
  const evidenceVerification = verifyHistoryRewriteEvidence(sealed);
  if (!evidenceVerification.ok) {
    throw new TypeError(evidenceVerification.error);
  }
  return sealed;
}

type PriorHistoryRecordResolution =
  | Readonly<{ kind: "digest_only" }>
  | Readonly<{ kind: "patch_hash_mismatch" }>
  | Readonly<{ kind: "record_hash_mismatch" }>
  | Readonly<{ kind: "legacy"; entry: HistoryEntry }>
  | Readonly<{ kind: "record"; entry: HistoryEntry }>;

/** Return whether runtime data is a dense list of structurally valid patch operations. */
function isHistoryPatch(value: unknown): value is HistoryPatchOp[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) {
    return false;
  }
  return value.every((operation) => {
    if (!isRecord(operation) || typeof operation.path !== "string") {
      return false;
    }
    if (operation.op === "move" || operation.op === "copy") {
      return typeof operation.from === "string";
    }
    if (["add", "replace", "test"].includes(operation.op as string)) {
      return Object.hasOwn(operation, "value");
    }
    return operation.op === "remove";
  });
}

/** Return whether a retained record has the minimum immutable event shape. */
function isRetainedHistoryRecordShape(value: unknown): value is HistoryEntry {
  return (
    isRecord(value) &&
    typeof value.ts === "string" &&
    typeof value.author === "string" &&
    typeof value.op === "string" &&
    typeof value.before_hash === "string" &&
    typeof value.after_hash === "string" &&
    isHistoryPatch(value.patch)
  );
}

/** Return whether optional retained record-hash fields form a complete pair. */
function hasCompleteRetainedRecordHashEnvelope(
  evidence: Record<string, unknown>,
): boolean {
  const hasVersion = evidence.record_hash_version !== undefined;
  const hasHash = evidence.record_hash !== undefined;
  return hasVersion === hasHash;
}

/** Return whether runtime evidence has the bounded shape needed for verification. */
function isHistoryReanchorEvidence(
  evidence: unknown,
): evidence is HistoryReanchorEvidence {
  if (
    !isRecord(evidence) ||
    !hasCompleteRetainedRecordHashEnvelope(evidence) ||
    typeof evidence.before_hash !== "string" ||
    typeof evidence.after_hash !== "string" ||
    typeof evidence.patch_hash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(evidence.patch_hash) ||
    (evidence.patch !== undefined && !isHistoryPatch(evidence.patch)) ||
    (evidence.record_hash_version !== undefined &&
      typeof evidence.record_hash_version !== "number") ||
    (evidence.record_hash !== undefined &&
      (typeof evidence.record_hash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(evidence.record_hash)))
  ) {
    return false;
  }
  return (
    evidence.record === undefined ||
    isRetainedHistoryRecordShape(evidence.record)
  );
}

/** Return whether a retained exact record agrees with its summary coordinates. */
function matchesRetainedHistoryRecord(
  evidence: HistoryReanchorEvidence,
): boolean {
  const record = evidence.record;
  return (
    record !== undefined &&
    record.before_hash === evidence.before_hash &&
    record.after_hash === evidence.after_hash &&
    record.item_hash_version === evidence.item_hash_version &&
    record.record_hash_version === evidence.record_hash_version &&
    record.record_hash === evidence.record_hash &&
    hashHistoryPatch(record.patch) === evidence.patch_hash
  );
}

/** Reconstruct one prior record represented by retained rewrite evidence. */
function reconstructPriorHistoryRecord(
  current: HistoryEntry,
  evidence: HistoryReanchorEvidence,
  priorEvidence: HistoryReanchorEvidence[],
): PriorHistoryRecordResolution {
  if (
    evidence.patch &&
    hashHistoryPatch(evidence.patch) !== evidence.patch_hash
  ) {
    return { kind: "patch_hash_mismatch" };
  }
  if (evidence.record) {
    if (!matchesRetainedHistoryRecord(evidence)) {
      return { kind: "record_hash_mismatch" };
    }
    return { kind: "record", entry: evidence.record };
  }
  const priorPatch = evidence.patch ?? current.patch;
  if (hashHistoryPatch(priorPatch) !== evidence.patch_hash) {
    return { kind: "digest_only" };
  }
  const priorRecord: HistoryEntry = {
    ...current,
    before_hash: evidence.before_hash,
    after_hash: evidence.after_hash,
    patch: priorPatch,
    ...(evidence.item_hash_version === undefined
      ? {}
      : { item_hash_version: evidence.item_hash_version }),
    ...(evidence.record_hash_version === undefined
      ? {}
      : { record_hash_version: evidence.record_hash_version }),
    ...(evidence.record_hash === undefined
      ? {}
      : { record_hash: evidence.record_hash }),
    ...(priorEvidence.length === 0 ? {} : { reanchor_evidence: priorEvidence }),
  };
  if (priorEvidence.length === 0) delete priorRecord.reanchor_evidence;
  if (evidence.item_hash_version === undefined) {
    delete priorRecord.item_hash_version;
  }
  return evidence.record_hash_version === undefined ||
    evidence.record_hash === undefined
    ? { kind: "legacy", entry: priorRecord }
    : { kind: "record", entry: priorRecord };
}

/** Verify that retained rewrite evidence reconstructs every available prior record envelope. */
export function verifyHistoryRewriteEvidence(entry: HistoryEntry):
  | {
      ok: true;
      coverage: "complete" | "digest_only" | "legacy_anchor_only" | "none";
    }
  | {
      ok: false;
      error:
        | "rewrite_evidence_invalid"
        | "rewrite_evidence_patch_hash_mismatch"
        | "rewrite_evidence_record_hash_mismatch";
    } {
  const evidenceEntries = entry.reanchor_evidence;
  if (evidenceEntries === undefined) return { ok: true, coverage: "none" };
  if (!Array.isArray(evidenceEntries)) {
    return { ok: false, error: "rewrite_evidence_invalid" };
  }
  if (evidenceEntries.length === 0) return { ok: true, coverage: "none" };
  let reconstructed = entry;
  for (let index = evidenceEntries.length - 1; index >= 0; index -= 1) {
    const evidence = evidenceEntries[index]!;
    if (!(index in evidenceEntries) || !isHistoryReanchorEvidence(evidence)) {
      return { ok: false, error: "rewrite_evidence_invalid" };
    }
    const prior = reconstructPriorHistoryRecord(
      reconstructed,
      evidence,
      evidenceEntries.slice(0, index),
    );
    if (prior.kind === "patch_hash_mismatch") {
      return { ok: false, error: "rewrite_evidence_patch_hash_mismatch" };
    }
    if (prior.kind === "record_hash_mismatch") {
      return { ok: false, error: "rewrite_evidence_record_hash_mismatch" };
    }
    if (prior.kind === "digest_only") {
      return { ok: true, coverage: "digest_only" };
    }
    if (prior.kind === "legacy") {
      return { ok: true, coverage: "legacy_anchor_only" };
    }
    if (!verifyHistoryRecordHash(prior.entry).ok) {
      return { ok: false, error: "rewrite_evidence_record_hash_mismatch" };
    }
    reconstructed = prior.entry;
  }
  return { ok: true, coverage: "complete" };
}

function compareOptionalStrings(
  left: string | undefined,
  right: string | undefined,
): number {
  return (left ?? "").localeCompare(right ?? "");
}

function compareOptionalNumbers(
  left: number | undefined,
  right: number | undefined,
): number {
  return (left ?? 0) - (right ?? 0);
}

function compareJsonValues(
  left: unknown,
  right: unknown,
  fallback: unknown,
): number {
  // Preserve the original v1 comparator byte-for-byte: replacing JSON.stringify
  // with stableStringify would invalidate immutable hashes from legacy streams.
  return JSON.stringify(left ?? fallback).localeCompare(
    JSON.stringify(right ?? fallback),
  );
}

function compareLegacyLinkedTests(left: LinkedTest, right: LinkedTest): number {
  const comparisons = [
    left.scope.localeCompare(right.scope),
    compareOptionalStrings(left.path, right.path),
    compareOptionalStrings(left.command, right.command),
    compareOptionalNumbers(left.timeout_seconds, right.timeout_seconds),
    compareOptionalStrings(left.pm_context_mode, right.pm_context_mode),
    Number(Boolean(left.shared_host_safe)) -
      Number(Boolean(right.shared_host_safe)),
    compareJsonValues(left.env_clear, right.env_clear, []),
    compareJsonValues(left.env_set, right.env_set, {}),
    compareJsonValues(
      left.assert_stdout_contains,
      right.assert_stdout_contains,
      [],
    ),
    compareJsonValues(left.assert_stdout_regex, right.assert_stdout_regex, []),
    compareJsonValues(
      left.assert_stderr_contains,
      right.assert_stderr_contains,
      [],
    ),
    compareJsonValues(left.assert_stderr_regex, right.assert_stderr_regex, []),
    compareOptionalNumbers(
      left.assert_stdout_min_lines,
      right.assert_stdout_min_lines,
    ),
    compareJsonValues(
      left.assert_json_field_equals,
      right.assert_json_field_equals,
      {},
    ),
    compareJsonValues(
      left.assert_json_field_gte,
      right.assert_json_field_gte,
      {},
    ),
    compareOptionalStrings(left.note, right.note),
  ];
  return comparisons.find((comparison) => comparison !== 0) ?? 0;
}

function decodeJsonPointer(path: string): string[] {
  if (!path || path === "/") {
    return [];
  }
  if (!path.startsWith("/")) {
    return [];
  }
  return path
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function isDefinedPointerPath(document: unknown, path: string): boolean {
  const segments = decodeJsonPointer(path);
  if (segments.length === 0) {
    return true;
  }
  let cursor: unknown = document;
  for (const segment of segments) {
    const arrayIndex = /^(0|[1-9]\d*)$/.test(segment) ? Number(segment) : -1;
    const next = Array.isArray(cursor)
      ? arrayIndex >= 0 && arrayIndex < cursor.length
        ? cursor[arrayIndex]
        : undefined
      : isRecord(cursor) &&
          Object.prototype.hasOwnProperty.call(cursor, segment)
        ? cursor[segment]
        : undefined;
    if (next === undefined) return false;
    cursor = next;
  }
  return true;
}

function normalizeHistoryPatchOps(
  beforeDocument: { metadata: Record<string, unknown>; body: string },
  patch: HistoryPatchOp[],
): HistoryPatchOp[] {
  const normalized: HistoryPatchOp[] = [];
  let replayCursor: unknown = structuredClone(beforeDocument);
  for (const operation of patch) {
    const normalizedOperation =
      operation.op === "replace" &&
      !isDefinedPointerPath(replayCursor, operation.path)
        ? ({ ...operation, op: "add" } as HistoryPatchOp)
        : operation;
    normalized.push(normalizedOperation);
    replayCursor = jsonPatch.applyPatch(
      replayCursor,
      [normalizedOperation as jsonPatch.Operation],
      true,
      true,
    ).newDocument as unknown;
  }
  return normalized;
}

function canonicalHashDocument(
  document: ItemDocument,
  version: HistoryItemHashVersion,
  legacyV2Fields = false,
): {
  front_matter: Record<string, unknown>;
  body: string;
} {
  const hasMetadata =
    document.metadata && Object.keys(document.metadata).length > 0;
  if (!hasMetadata) {
    return {
      front_matter: {},
      body: document.body ?? "",
    };
  }
  const canonical = canonicalDocument(document);
  // Epoch 1 and the earliest epoch-2 writer predate linked-test provenance,
  // workspace isolation, per-execution receipts, and case-preserving
  // dependency ids. Later epoch-2 writers included those fields without
  // advancing the marker, so verification must retain both immutable forms.
  const usesLegacyFields = version === 1 || (version === 2 && legacyV2Fields);
  const epochMetadata = usesLegacyFields
    ? {
        ...canonical.metadata,
        ...(canonical.metadata.dependencies === undefined
          ? {}
          : {
              dependencies: canonical.metadata.dependencies.map(
                (dependency) => ({
                  ...dependency,
                  id: dependency.id.toLowerCase(),
                }),
              ),
            }),
        ...(canonical.metadata.tests === undefined
          ? {}
          : {
              tests: canonical.metadata.tests.map(
                ({
                  workspace_context_mode: _workspaceContextMode,
                  provenance: _provenance,
                  provenance_invalid: _provenanceInvalid,
                  ...test
                }) => test,
              ),
            }),
        ...(canonical.metadata.test_runs === undefined
          ? {}
          : {
              test_runs: canonical.metadata.test_runs.map(
                ({ executions: _executions, ...testRun }) => testRun,
              ),
            }),
      }
    : canonical.metadata;
  const metadata =
    version === 1 && epochMetadata.tests
      ? {
          ...epochMetadata,
          tests: [...epochMetadata.tests].sort(compareLegacyLinkedTests),
        }
      : epochMetadata;
  const orderedMetadata = orderObject(
    toItemRecord(metadata),
    ITEM_METADATA_KEY_ORDER,
  );
  return {
    front_matter: orderedMetadata,
    body: canonical.body,
  };
}

function canonicalPatchDocument(document: ItemDocument): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const hasMetadata =
    document.metadata && Object.keys(document.metadata).length > 0;
  if (!hasMetadata) {
    return {
      metadata: {},
      body: document.body ?? "",
    };
  }
  const canonical = canonicalDocument(document);
  const orderedMetadata = orderObject(
    toItemRecord(canonical.metadata),
    ITEM_METADATA_KEY_ORDER,
  );
  return {
    metadata: orderedMetadata,
    body: canonical.body,
  };
}

/** Implements hash document for the public runtime surface of this module. */
export function hashDocument(document: ItemDocument): string {
  return hashDocumentForVersion(document, CURRENT_HISTORY_ITEM_HASH_VERSION);
}

/** Hash an item with an explicit canonicalization epoch for replay compatibility. */
export function hashDocumentForVersion(
  document: ItemDocument,
  version: HistoryItemHashVersion,
): string {
  if (
    !SUPPORTED_HISTORY_ITEM_HASH_VERSIONS.some(
      (supportedVersion) => supportedVersion === version,
    )
  ) {
    throw new TypeError(`unsupported_item_hash_version:${String(version)}`);
  }
  return sha256Hex(stableStringify(canonicalHashDocument(document, version)));
}

/**
 * Return the ordered hash candidates accepted when verifying one immutable
 * history epoch. Epoch 2 has both its established expanded hash first and the
 * earlier field-frozen writer hash second; the other epochs have one form.
 */
export function hashDocumentVerificationCandidates(
  document: ItemDocument,
  version: HistoryItemHashVersion,
): [string, ...string[]] {
  const canonicalHash = hashDocumentForVersion(document, version);
  return version === 2
    ? [
        canonicalHash,
        sha256Hex(
          stableStringify(canonicalHashDocument(document, version, true)),
        ),
      ]
    : [canonicalHash];
}

/** Implements hash empty document for the public runtime surface of this module. */
export function hashEmptyDocument(): string {
  return sha256Hex(stableStringify(EMPTY_LEGACY_HASH_DOCUMENT));
}

/** Implements create history entry for the public runtime surface of this module. */
export function createHistoryEntry(params: {
  nowIso: string;
  author: string;
  authorSource?: AuthorSource;
  op: string;
  before: ItemDocument;
  after: ItemDocument;
  message?: string;
  context?: Record<string, unknown>;
}): HistoryEntry {
  const beforeHashCanonical = canonicalHashDocument(
    params.before,
    CURRENT_HISTORY_ITEM_HASH_VERSION,
  );
  const afterHashCanonical = canonicalHashDocument(
    params.after,
    CURRENT_HISTORY_ITEM_HASH_VERSION,
  );
  const beforePatchCanonical = canonicalPatchDocument(params.before);
  const afterPatchCanonical = canonicalPatchDocument(params.after);
  const rawPatch = jsonPatch.compare(
    beforePatchCanonical,
    afterPatchCanonical,
  ) as HistoryPatchOp[];
  const patch = normalizeHistoryPatchOps(beforePatchCanonical, rawPatch);
  const agentIdentity = resolveHistoryAgentIdentity(params.author);
  const provenanceOutcomes = agentIdentity.harness
    ? Object.fromEntries(
        Object.entries(diagnoseAgentIdentity().provenance_outcomes).filter(
          ([, outcome]) =>
            outcome.resolver !== undefined && outcome.status !== "resolved",
        ),
      )
    : undefined;
  const context =
    provenanceOutcomes === undefined ||
    Object.keys(provenanceOutcomes).length === 0
      ? params.context
      : {
          ...params.context,
          agent_provenance_outcomes: provenanceOutcomes,
        };

  const entry: HistoryEntry = {
    ts: params.nowIso,
    author: params.author,
    author_source:
      params.authorSource ?? resolveHistoryAuthorSource(params.author),
    ...(agentIdentity.harness ? { agent_harness: agentIdentity.harness } : {}),
    ...(agentIdentity.model ? { agent_model: agentIdentity.model } : {}),
    ...(agentIdentity.model_source
      ? { agent_model_source: agentIdentity.model_source }
      : {}),
    ...(agentIdentity.instance
      ? { agent_instance: agentIdentity.instance }
      : {}),
    ...(agentIdentity.provenance
      ? { agent_provenance: agentIdentity.provenance }
      : {}),
    ...(agentIdentity.episode ? { agent_episode: agentIdentity.episode } : {}),
    op: params.op,
    patch,
    before_hash: sha256Hex(stableStringify(beforeHashCanonical)),
    after_hash: sha256Hex(stableStringify(afterHashCanonical)),
    item_hash_version: CURRENT_HISTORY_ITEM_HASH_VERSION,
    message: params.message === undefined ? undefined : params.message,
    ...(context === undefined ? {} : { context }),
  };
  return sealHistoryRecord({
    ...entry,
    event_class: classifyHistoryEvent(entry),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidHistoryTimestamp(message: string): PmCliError {
  return new PmCliError(message, EXIT_CODE.GENERIC_FAILURE, {
    code: "history_timestamp_invalid",
  });
}

function fallbackHistoryTimestamp(entry: Pick<HistoryEntry, "ts">): string {
  const ts = entry.ts.trim();
  if (ts.length === 0) return nowIso();
  if (!isMillisecondPrecisionRfc3339DateTime(ts)) {
    throw invalidHistoryTimestamp(
      "History timestamp must be a valid RFC 3339 date-time with millisecond precision",
    );
  }
  if (ts !== entry.ts) {
    throw invalidHistoryTimestamp(
      "History timestamp must not contain surrounding whitespace",
    );
  }
  return entry.ts;
}

function withHistoryTimestamp(
  value: Record<string, unknown>,
  fallbackTs: string,
): Record<string, unknown> {
  const ts = value.ts;
  if (typeof ts === "string" && ts.trim().length > 0) {
    if (!isMillisecondPrecisionRfc3339DateTime(ts)) {
      throw invalidHistoryTimestamp(
        "History timestamp must be a valid RFC 3339 date-time with millisecond precision",
      );
    }
    return value;
  }
  return { ...value, ts: fallbackTs };
}

function serializeHistoryLine(
  value: unknown,
  fallbackEntry: Pick<HistoryEntry, "ts">,
): string {
  const fallbackTs = fallbackHistoryTimestamp(fallbackEntry);
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      // Non-JSON extension lines are preserved for compatibility.
      return value;
    }
    if (isRecord(parsed)) {
      return JSON.stringify(withHistoryTimestamp(parsed, fallbackTs));
    }
    return value;
  }
  if (isRecord(value)) {
    return JSON.stringify(withHistoryTimestamp(value, fallbackTs));
  }
  return JSON.stringify(value);
}

/** Apply one extension-provided append decision and report whether it consumed the write. */
async function applyHistoryAppendOverride(
  historyPath: string,
  entry: HistoryEntry,
  result: unknown,
): Promise<boolean> {
  if (result === false) return true;
  if (typeof result === "string") {
    const line = serializeHistoryLine(result, entry);
    await appendHistoryLineWithIdentityReservation(historyPath, line);
    await invalidateHistoryDriftCacheForPath(historyPath);
    await removeHistoryEventIndexForHistoryPath(historyPath);
    return true;
  }
  if (typeof result !== "object" || result === null) return false;
  const record = result as {
    history_path?: unknown;
    entry?: unknown;
    line?: unknown;
    skip?: unknown;
  };
  if (record.skip === true) return true;
  const nextHistoryPath =
    typeof record.history_path === "string" ? record.history_path : historyPath;
  const line = serializeHistoryLine(
    typeof record.line === "string" ? record.line : (record.entry ?? entry),
    entry,
  );
  await appendHistoryLineWithIdentityReservation(nextHistoryPath, line);
  await invalidateHistoryDriftCacheForPath(nextHistoryPath);
  await removeHistoryEventIndexForHistoryPath(nextHistoryPath);
  return true;
}

/** Exclusively create genesis streams at their effective destination; never remove a failed partial reservation. */
async function appendHistoryLineWithIdentityReservation(historyPath: string, line: string): Promise<void> {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    // Legacy service overrides may provide non-JSON lines; verification diagnoses them.
    record = null;
  }
  if (!isRecord(record) || record.op !== "create") {
    await appendLineAtomic(historyPath, line);
    return;
  }
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  try {
    await fs.writeFile(historyPath, `${line}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new PmCliError("This item identity is reserved by an existing history stream.", EXIT_CODE.CONFLICT, {
      code: "item_identity_reserved",
      required: "Choose a new item ID or restore the original item from its history.",
      nextSteps: ["Run pm history <id> --full, then pm restore <id> <version> to recover the original item."],
    });
  }
}

/** Implements append history entry for the public runtime surface of this module. */
export async function appendHistoryEntry(
  historyPath: string,
  entry: HistoryEntry,
): Promise<void> {
  const override = await runActiveServiceOverride("history_append", {
    history_path: historyPath,
    entry,
  });
  if (
    override.handled &&
    (await applyHistoryAppendOverride(historyPath, entry, override.result))
  ) {
    return;
  }
  const timestampedEntry =
    entry.ts.trim().length > 0
      ? entry
      : { ...entry, ts: fallbackHistoryTimestamp(entry) };
  const normalizedEntry = sealHistoryRecord({
    ...timestampedEntry,
    event_class: classifyHistoryEvent(timestampedEntry),
  });
  await appendHistoryEntryWithEventIndex(
    historyPath,
    normalizedEntry,
    async () => {
      await appendHistoryLineWithIdentityReservation(
        historyPath,
        serializeHistoryLine(normalizedEntry, normalizedEntry),
      );
    },
  );
  await invalidateHistoryDriftCacheForPath(historyPath);
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  decodeJsonPointer,
  isDefinedPointerPath,
};
