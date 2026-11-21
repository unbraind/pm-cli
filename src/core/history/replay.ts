/**
 * @module core/history/replay
 *
 * Implements append-only history and replay behavior for Replay.
 */
import jsonPatch from "fast-json-patch";
import { historyDigest, resolveHistoryHashAlgorithm, type HistoryHashAlgorithm } from "./digest.js";
import { findHistoryIdentityDiscontinuities } from "./identity.js";
import {
  digestBridgedSegment,
  findNextHistoryBridge,
  locateBridgedSegments,
  matchesHistoryBreak,
  readHistoryBridge,
} from "./bridge.js";
import { ITEM_METADATA_KEY_ORDER } from "../shared/constants.js";
import { canonicalDocument } from "../item/item-format.js";
import { toItemRecord } from "../item/item-record.js";
import {
  orderObject,
  stableStringify,
} from "../shared/serialization.js";
import {
  CURRENT_HISTORY_ITEM_HASH_VERSION,
  SUPPORTED_HISTORY_ITEM_HASH_VERSIONS,
  hashDocumentVerificationCandidates,
  isCompleteHistoryRecord,
  resealHistoryRewrite,
  verifyHistoryRecordHash,
  verifyHistoryRewriteEvidence,
  type HistoryItemHashVersion,
} from "./history.js";
import type {
  HistoryBridge,
  HistoryEntry,
  HistoryPatchOp,
  ItemDocument,
  ItemMetadata,
} from "../../types/index.js";

/**
 * Shared history replay/patch mechanics single-sourced for the history, restore,
 * history-redact, and history-repair commands plus the health/validate drift checks.
 *
 * Each command keeps its own thin error-formatting wrapper so the exact CLI error
 * contracts (restore's rich patch-failure context, redact's op tag, history's
 * generic message) are preserved; only the underlying replay/patch logic is shared.
 */

export interface ReplayDocument {
  /** Value that configures or reports metadata for this contract. */
  metadata: Record<string, unknown>;
  /** Value that configures or reports body for this contract. */
  body: string;
}

/** Public contract for empty replay document, shared by SDK and presentation-layer consumers. */
export const EMPTY_REPLAY_DOCUMENT: ReplayDocument = {
  metadata: {},
  body: "",
};

/** Implements clone empty replay document for the public runtime surface of this module. */
export function cloneEmptyReplayDocument(): ReplayDocument {
  return structuredClone(EMPTY_REPLAY_DOCUMENT);
}

/** Implements replay hash for the public runtime surface of this module. */
export function replayHash(
  document: ReplayDocument,
  version: HistoryItemHashVersion = CURRENT_HISTORY_ITEM_HASH_VERSION,
  algorithm?: HistoryHashAlgorithm,
): string {
  return replayHashVerificationCandidates(document, version, algorithm)[0];
}

/**
 * Return hash candidates that preserve the semantic variant within an epoch.
 * Duplicate values are intentional: before and after candidates use the same
 * index when a patch introduces a field that distinguishes legacy epoch 2.
 */
export function replayHashVerificationCandidates(
  document: ReplayDocument,
  version: HistoryItemHashVersion,
  algorithm?: HistoryHashAlgorithm,
): [string, ...string[]] {
  if (
    Object.keys(document.metadata).length === 0 ||
    Array.isArray(document.metadata.tags)
  ) {
    try {
      return hashDocumentVerificationCandidates(
        replayToItemDocument(document),
        version,
        algorithm,
      );
    } catch {
      // Fall through when another malformed legacy field cannot be canonicalized.
    }
  }
  const fallback = historyDigest(
    stableStringify({
      replay_fallback: true,
      metadata: document.metadata,
      body: document.body,
    }),
    algorithm,
  );
  return version === 2 ? [fallback, fallback] : [fallback];
}

interface ReplayHashCandidateMatch {
  beforeHashes: [string, ...string[]];
  afterHashes: [string, ...string[]];
  pairIndex: number;
  beforeIndex: number;
  afterIndex: number;
}

/**
 * Hash variants already computed for the replay document on each side of one
 * entry, keyed by epoch and digest algorithm. A chain walk hands the `after`
 * map of entry N to entry N+1 as its `before` map because both describe the
 * same document object, so each replayed state is canonicalized and digested
 * once instead of twice.
 */
interface ReplayHashMemo {
  before: Map<string, [string, ...string[]]>;
  after: Map<string, [string, ...string[]]>;
}

/** Match one recorded entry against corresponding before/after hash variants. */
function matchReplayHashCandidates(
  before: ReplayDocument,
  after: ReplayDocument,
  version: HistoryItemHashVersion,
  entry: HistoryEntry,
  memo?: ReplayHashMemo,
): ReplayHashCandidateMatch {
  const algorithm = resolveHistoryHashAlgorithm(entry.hash_algorithm);
  const memoKey = `${version}:${algorithm}`;
  const beforeHashes =
    memo?.before.get(memoKey) ??
    replayHashVerificationCandidates(before, version, algorithm);
  const afterHashes = replayHashVerificationCandidates(after, version, algorithm);
  memo?.after.set(memoKey, afterHashes);
  return {
    beforeHashes,
    afterHashes,
    pairIndex: beforeHashes.findIndex(
      (beforeHash, hashIndex) =>
        beforeHash === entry.before_hash &&
        afterHashes[hashIndex] === entry.after_hash,
    ),
    beforeIndex: beforeHashes.indexOf(entry.before_hash),
    afterIndex: afterHashes.indexOf(entry.after_hash),
  };
}

/** Implements replay to item document for the public runtime surface of this module. */
export function replayToItemDocument(document: ReplayDocument): ItemDocument {
  return {
    metadata: document.metadata as ItemMetadata,
    body: document.body,
  };
}

/** Converts a materialized replay document into a canonical item document. Use this when callers have already rejected the empty/deleted replay state and need restored metadata validated through the normal item-metadata rules. */
export function replayToCanonicalItemDocument(
  document: ReplayDocument,
  options: Parameters<typeof canonicalDocument>[1] = {},
): ItemDocument {
  return canonicalDocument(replayToItemDocument(document), options);
}

/** Canonicalize an item document into the ordered replay form used when comparing a replayed chain against the on-disk item (restore + history-repair reconciliation). */
export function toReplayDocument(document: ItemDocument): ReplayDocument {
  if (!document.metadata || Object.keys(document.metadata).length === 0) {
    return {
      metadata: {},
      body: document.body ?? "",
    };
  }
  const canonical = canonicalDocument(document);
  return {
    metadata: orderObject(
      toItemRecord(canonical.metadata),
      ITEM_METADATA_KEY_ORDER,
    ),
    body: canonical.body,
  };
}

/** Implements normalize replay patch path for the public runtime surface of this module. */
export function normalizeReplayPatchPath(path: string): string {
  if (path === "/front_matter") {
    return "/metadata";
  }
  if (path.startsWith("/front_matter/")) {
    return `/metadata/${path.slice("/front_matter/".length)}`;
  }
  return path;
}

function isHistoryPatchOp(value: unknown): value is HistoryPatchOp {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { op?: unknown }).op === "string" &&
    typeof (value as { path?: unknown }).path === "string"
  );
}

/** Implements normalize replay patch ops for the public runtime surface of this module. */
export function normalizeReplayPatchOps(
  patch: HistoryPatchOp[] | unknown,
): HistoryPatchOp[] {
  if (!Array.isArray(patch)) {
    return [];
  }
  // Values are copied: applying an operation inserts its value into the
  // replay document, and a later operation of the same patch would otherwise
  // mutate the recorded entry itself before its digest or seal is checked.
  return patch.filter(isHistoryPatchOp).map((operation) => ({
    ...operation,
    ...(Object.hasOwn(operation, "value")
      ? { value: structuredClone(operation.value) }
      : {}),
    path: normalizeReplayPatchPath(operation.path),
    from:
      typeof operation.from === "string"
        ? normalizeReplayPatchPath(operation.from)
        : undefined,
  }));
}

function isReplayDocumentShape(
  value: unknown,
): value is { metadata: Record<string, unknown>; body: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "metadata" in value &&
    "body" in value &&
    typeof (value as { body: unknown }).body === "string" &&
    typeof (value as { metadata: unknown }).metadata === "object" &&
    (value as { metadata: unknown }).metadata !== null
  );
}

/** Restricts replay apply result values accepted by command, SDK, and storage contracts. */
export type ReplayApplyResult =
  | { ok: true; document: ReplayDocument }
  | { ok: false; error: unknown };

/** Strictly apply a history patch (front_matter->metadata normalized) to a replay document. Returns a result envelope rather than throwing so each caller can format its own error contract. */
export function tryApplyReplayPatch(
  current: ReplayDocument,
  patch: HistoryPatchOp[],
): ReplayApplyResult {
  try {
    const normalizedPatch = normalizeReplayPatchOps(patch);
    // The structured clone is already private to this call, so the library may
    // mutate it in place; asking it not to would deep-clone the document again.
    const applied = jsonPatch.applyPatch(
      structuredClone(current),
      normalizedPatch as jsonPatch.Operation[],
      true,
      true,
    ).newDocument as unknown;
    if (!isReplayDocumentShape(applied)) {
      return {
        ok: false,
        error: new Error("history_replay_invalid_document_shape"),
      };
    }
    return {
      ok: true,
      document: { metadata: applied.metadata, body: applied.body },
    };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Return the distinct supported hash epochs explicitly declared by a stream. */
function supportedExplicitHistoryItemHashVersions(
  entries: HistoryEntry[],
): HistoryItemHashVersion[] {
  return [
    ...new Set(
      entries
        .map((entry) => entry.item_hash_version)
        .filter(
          (version): version is HistoryItemHashVersion =>
            version !== undefined &&
            (
              SUPPORTED_HISTORY_ITEM_HASH_VERSIONS as readonly number[]
            ).includes(version),
        ),
    ),
  ];
}

/** Return whether an explicit hash epoch cannot be replayed by this build. */
function isUnsupportedExplicitHistoryItemHashVersion(
  version: HistoryEntry["item_hash_version"],
): boolean {
  return (
    version !== undefined &&
    !(SUPPORTED_HISTORY_ITEM_HASH_VERSIONS as readonly number[]).includes(
      version,
    )
  );
}

/** Select the hash epochs allowed for one entry under an authoritative stream marker. */
function historyEntryHashCandidates(
  explicitVersion: HistoryEntry["item_hash_version"],
  authoritativeVersion: HistoryItemHashVersion | undefined,
): HistoryItemHashVersion[] {
  if (explicitVersion !== undefined) {
    return [explicitVersion as HistoryItemHashVersion];
  }
  return authoritativeVersion === undefined
    ? [...SUPPORTED_HISTORY_ITEM_HASH_VERSIONS]
    : [authoritativeVersion];
}

/** Return the first record or retained-rewrite integrity failure for one entry. */
function historyEntryIntegrityError(entry: HistoryEntry): string | undefined {
  const recordVerification = verifyHistoryRecordHash(entry);
  if (!recordVerification.ok) return recordVerification.error;
  const rewriteVerification = verifyHistoryRewriteEvidence(entry);
  return rewriteVerification.ok ? undefined : rewriteVerification.error;
}

/** Validate immutable metadata and apply one patch for chain verification. */
function verifyHistoryEntryInput(
  entry: HistoryEntry,
  replay: ReplayDocument,
): { ok: true; document: ReplayDocument } | { ok: false; error: string } {
  const integrityError = historyEntryIntegrityError(entry);
  if (integrityError) return { ok: false, error: integrityError };
  const applied = tryApplyReplayPatch(replay, entry.patch);
  return applied.ok
    ? { ok: true, document: applied.document }
    : { ok: false, error: "patch_apply_failed" };
}

/** Refuse any entry whose current or retained immutable envelope is invalid. */
function assertHistoryEntryIntegrity(entry: HistoryEntry, index: number): void {
  const integrityError = historyEntryIntegrityError(entry);
  if (integrityError) {
    throw new TypeError(`${integrityError}:entry_${index + 1}`);
  }
}

/**
 * Evaluate hash epochs in preference order and stop at the first epoch whose
 * before/after pair matches. A mismatch evaluates every candidate so the
 * caller can name the failing side.
 */
function matchReplayEpochCandidates(
  before: ReplayDocument,
  after: ReplayDocument,
  candidates: HistoryItemHashVersion[],
  entry: HistoryEntry,
  memo: ReplayHashMemo,
): Array<{ version: HistoryItemHashVersion; match: ReplayHashCandidateMatch }> {
  const matches: Array<{
    version: HistoryItemHashVersion;
    match: ReplayHashCandidateMatch;
  }> = [];
  for (const version of candidates) {
    const match = matchReplayHashCandidates(before, after, version, entry, memo);
    matches.push({ version, match });
    if (match.pairIndex >= 0) break;
  }
  return matches;
}

/**
 * Whether a record can be covered by a bridge: complete, with item anchors
 * that are well-formed digests of its algorithm. A bridged segment checks
 * recorded links instead of replayed states, so a malformed anchor would
 * otherwise be certified.
 */
function isBridgeableRecord(entry: HistoryEntry): boolean {
  if (!isCompleteHistoryRecord(entry)) return false;
  let length: number;
  try {
    length = resolveHistoryHashAlgorithm(entry.hash_algorithm) === "sha512" ? 128 : 64;
  } catch {
    return false;
  }
  const digest = new RegExp(`^[a-f0-9]{${length}}$`, "u");
  if (!digest.test(entry.before_hash) || !digest.test(entry.after_hash)) return false;
  // A record whose patch cannot change state must not claim a state change,
  // even where replay cannot prove its before-state.
  const effectless = normalizeReplayPatchOps(entry.patch).every((operation) => operation.op === "test");
  return !effectless || entry.before_hash === entry.after_hash || Object.hasOwn(entry, "bridge");
}

/** Zero-based inclusive range of entries closed by one verified bridge. */
export interface HistoryBridgedSegment {
  /** First entry after the first named break. */
  start: number;
  /** The bridge record that closes the segment. */
  end: number;
}

/** Bridged segment still open during a chain walk. */
interface OpenBridgedSegment {
  start: number;
  closer: number;
  bridge: HistoryBridge;
  next: number;
}

/**
 * Open a segment when the next bridge names this anchored break, so a stream
 * repaired append-only verifies without rewriting the entries it holds.
 */
function openBridgedSegment(
  entries: HistoryEntry[],
  index: number,
): OpenBridgedSegment | undefined {
  if (index === 0 || !isBridgeableRecord(entries[index])) return undefined;
  const closer = findNextHistoryBridge(entries, index);
  if (closer < 0) return undefined;
  const bridge = readHistoryBridge(entries[closer]);
  if (
    typeof bridge !== "object" ||
    !matchesHistoryBreak(bridge.breaks[0], entries[index - 1], entries[index])
  ) {
    return undefined;
  }
  return { start: index, closer, bridge, next: 1 };
}

/** Result of verifying one entry of a bridged segment. */
type BridgedEntryVerdict =
  | { ok: true; document: ReplayDocument; version?: HistoryItemHashVersion }
  | { ok: false; error: string };

/**
 * Verify one entry inside an open bridged segment, before its bridge. Replay
 * lacks the unrecorded change there, so the walk checks each recorded link:
 * an unlinked entry must be the next named break. Wherever replay does prove
 * the recorded before-state, the entry's recorded effect must match as well.
 */
function verifyBridgedInteriorEntry(
  entries: HistoryEntry[],
  index: number,
  segment: OpenBridgedSegment,
  replay: ReplayDocument,
  candidates: HistoryItemHashVersion[],
): BridgedEntryVerdict {
  const entry = entries[index];
  const previous = entries[index - 1];
  if (!isBridgeableRecord(entry)) return { ok: false, error: "record_incomplete" };
  const input = verifyHistoryEntryInput(entry, replay);
  if (!input.ok) return input;
  const matches = candidates.map((version) =>
    matchReplayHashCandidates(replay, input.document, version, entry),
  );
  if (
    matches.some((match) => match.beforeIndex >= 0) &&
    !matches.some((match) => match.pairIndex >= 0)
  ) {
    return { ok: false, error: "after_hash_mismatch" };
  }
  if (entry.before_hash === previous.after_hash) return input;
  if (!matchesHistoryBreak(segment.bridge.breaks[segment.next], previous, entry)) {
    return { ok: false, error: "bridge_unnamed_break" };
  }
  segment.next += 1;
  return input;
}

/**
 * Verify the bridge that closes a segment: it must name no break that did not
 * occur, link to the last recorded entry, commit to exactly the records it
 * covers, and re-anchor replay on its own after_hash.
 */
function verifyBridgeCloser(
  entries: HistoryEntry[],
  index: number,
  segment: OpenBridgedSegment,
  replay: ReplayDocument,
  candidates: HistoryItemHashVersion[],
): BridgedEntryVerdict {
  const entry = entries[index];
  if (!isBridgeableRecord(entry)) return { ok: false, error: "record_incomplete" };
  const input = verifyHistoryEntryInput(entry, replay);
  if (!input.ok) return input;
  if (segment.next !== segment.bridge.breaks.length) {
    return { ok: false, error: "bridge_names_absent_break" };
  }
  if (entry.before_hash !== entries[index - 1].after_hash) {
    return { ok: false, error: "bridge_link_mismatch" };
  }
  if (
    digestBridgedSegment(entries.slice(segment.start, index), entry) !==
    segment.bridge.segment_digest
  ) {
    return { ok: false, error: "bridge_segment_mismatch" };
  }
  const algorithm = resolveHistoryHashAlgorithm(entry.hash_algorithm);
  const version = candidates.find((candidate) =>
    replayHashVerificationCandidates(input.document, candidate, algorithm).includes(
      entry.after_hash,
    ),
  );
  return version === undefined
    ? { ok: false, error: "bridge_after_hash_mismatch" }
    : { ok: true, document: input.document, version };
}

/** Mutable state of one chain walk, shared by the anchored and bridged steps. */
interface HistoryChainWalk {
  replay: ReplayDocument;
  beforeHashMemo: ReplayHashMemo["before"];
  detectedVersion?: HistoryItemHashVersion;
  authoritativeExplicitVersion?: HistoryItemHashVersion;
  segment?: OpenBridgedSegment;
  bridgedSegments: HistoryBridgedSegment[];
}

/** Advance replay onto an entry whose hashes proved one epoch. */
function acceptHistoryEpoch(
  walk: HistoryChainWalk,
  entry: HistoryEntry,
  version: HistoryItemHashVersion,
  document: ReplayDocument,
  memo: ReplayHashMemo["before"],
): void {
  walk.replay = document;
  walk.beforeHashMemo = memo;
  walk.detectedVersion = version;
  walk.authoritativeExplicitVersion =
    (entry.item_hash_version as HistoryItemHashVersion | undefined) ??
    walk.authoritativeExplicitVersion;
}

/** Verify one entry inside an open bridged segment; returns the failure or undefined. */
function stepBridgedSegment(
  entries: HistoryEntry[],
  index: number,
  walk: HistoryChainWalk,
): string | undefined {
  const segment = walk.segment!;
  const entry = entries[index];
  // The closing repair record keeps the epoch the stream declared; it may not
  // re-anchor on a weaker surface than the records it covers.
  if (
    index === segment.closer &&
    walk.authoritativeExplicitVersion !== undefined &&
    entry.item_hash_version !== walk.authoritativeExplicitVersion
  ) {
    return "bridge_epoch_mismatch";
  }
  const verify =
    index < segment.closer ? verifyBridgedInteriorEntry : verifyBridgeCloser;
  const bridged = verify(
    entries,
    index,
    segment,
    walk.replay,
    historyEntryHashCandidates(entry.item_hash_version, walk.authoritativeExplicitVersion),
  );
  if (!bridged.ok) return bridged.error;
  if (bridged.version === undefined) {
    walk.replay = bridged.document;
    walk.beforeHashMemo = new Map();
    // A declared epoch inside the segment governs later unversioned records.
    walk.authoritativeExplicitVersion =
      (entry.item_hash_version as HistoryItemHashVersion | undefined) ??
      walk.authoritativeExplicitVersion;
    return undefined;
  }
  walk.bridgedSegments.push({ start: segment.start, end: index });
  walk.segment = undefined;
  acceptHistoryEpoch(walk, entry, bridged.version, bridged.document, new Map());
  return undefined;
}

/** Verify one anchored entry, opening a bridged segment at a named break. */
function stepAnchoredEntry(
  entries: HistoryEntry[],
  index: number,
  walk: HistoryChainWalk,
  unsupportedVersion: boolean,
): string | undefined {
  const entry = entries[index];
  if (Object.hasOwn(entry, "bridge")) return "bridge_without_break";
  const input = verifyHistoryEntryInput(entry, walk.replay);
  if (!input.ok) return input.error;
  if (unsupportedVersion) {
    walk.replay = input.document;
    walk.beforeHashMemo = new Map();
    walk.detectedVersion = undefined;
    walk.authoritativeExplicitVersion = undefined;
    return undefined;
  }
  // Prefer legacy epoch 1 when an unversioned entry is valid under both
  // algorithms, but retain compatibility with transitional epoch-2 writers
  // that shipped before item_hash_version became explicit. Candidates are
  // evaluated in preference order and stop at the first matching epoch; a
  // mismatch still evaluates every candidate for its diagnostic.
  const memo: ReplayHashMemo = { before: walk.beforeHashMemo, after: new Map() };
  const candidateMatches = matchReplayEpochCandidates(
    walk.replay,
    input.document,
    historyEntryHashCandidates(entry.item_hash_version, walk.authoritativeExplicitVersion),
    entry,
    memo,
  );
  const matching = candidateMatches.find(({ match }) => match.pairIndex >= 0);
  if (matching !== undefined) {
    acceptHistoryEpoch(walk, entry, matching.version, input.document, memo.after);
    return undefined;
  }
  const beforeMatches = candidateMatches.some(({ match }) => match.beforeIndex >= 0);
  walk.segment = beforeMatches ? undefined : openBridgedSegment(entries, index);
  if (walk.segment === undefined) {
    return `${beforeMatches ? "after" : "before"}_hash_mismatch`;
  }
  walk.replay = input.document;
  walk.beforeHashMemo = new Map();
  walk.authoritativeExplicitVersion =
    (entry.item_hash_version as HistoryItemHashVersion | undefined) ??
    walk.authoritativeExplicitVersion;
  return undefined;
}

/** Verify a chain and report the explicit or auto-detected item hash epoch. */
export function verifyHistoryChainWithVersion(entries: HistoryEntry[]): {
  ok: boolean;
  errors: string[];
  item_hash_version?: HistoryItemHashVersion;
  /** Segments closed by an append-only bridge, in stream order; absent when none. */
  bridged_segments?: HistoryBridgedSegment[];
} {
  const walk: HistoryChainWalk = {
    replay: cloneEmptyReplayDocument(),
    beforeHashMemo: new Map(),
    bridgedSegments: [],
  };
  const errors = findHistoryIdentityDiscontinuities(entries).map(
    (finding) =>
      `verify_failed:duplicate_create:entry_${finding.repeated_create_index}:prior_${finding.prior_genesis_index}`,
  );
  const finish = (ok: boolean, details: { item_hash_version?: HistoryItemHashVersion }) => ({
    ok,
    errors: ok ? [] : errors,
    ...details,
    ...(walk.bridgedSegments.length === 0 ? {} : { bridged_segments: walk.bridgedSegments }),
  });
  const failure = (error: string, index: number) => {
    errors.push(`verify_failed:${error}:entry_${index + 1}`);
    return finish(false, {});
  };
  // A malformed or unsealed bridge is drift wherever it sits, even when an
  // earlier failure would otherwise end the walk before reaching it.
  const invalidBridge = entries.findIndex(
    (entry) => readHistoryBridge(entry) === "invalid",
  );
  if (invalidBridge >= 0) return failure("bridge_invalid", invalidBridge);
  for (let index = 0; index < entries.length; index += 1) {
    const explicitVersion = entries[index].item_hash_version;
    const unsupportedVersion =
      isUnsupportedExplicitHistoryItemHashVersion(explicitVersion);
    if (unsupportedVersion) {
      errors.push(
        `verify_failed:unsupported_item_hash_version:${String(explicitVersion)}:entry_${index + 1}`,
      );
    }
    const error =
      walk.segment === undefined
        ? stepAnchoredEntry(entries, index, walk, unsupportedVersion)
        : stepBridgedSegment(entries, index, walk);
    if (error !== undefined) return failure(error, index);
  }
  return finish(
    errors.length === 0,
    walk.detectedVersion === undefined
      ? {}
      : { item_hash_version: walk.detectedVersion },
  );
}

/** Deterministically verify a history chain while preserving the legacy result shape. */
export function verifyHistoryChain(entries: HistoryEntry[]): {
  ok: boolean;
  errors: string[];
} {
  const result = verifyHistoryChainWithVersion(entries);
  return { ok: result.ok, errors: result.errors };
}

/** Documents the lenient apply result payload exchanged by command, SDK, and package integrations. */
export interface LenientApplyResult {
  /** Value that configures or reports document for this contract. */
  document: ReplayDocument;
  /** Value that configures or reports converted replace to add for this contract. */
  convertedReplaceToAdd: number;
  /** Value that configures or reports skipped ops for this contract. */
  skippedOps: number;
}

function tryApplySingleOp(
  document: unknown,
  op: HistoryPatchOp,
): { ok: true; document: unknown } | { ok: false } {
  try {
    const applied = jsonPatch.applyPatch(
      structuredClone(document),
      [op as jsonPatch.Operation],
      true,
      false,
    ).newDocument as unknown;
    return { ok: true, document: applied };
  } catch {
    return { ok: false };
  }
}

/** Apply a legacy patch op-by-op, recovering from drift that strict replay rejects: a `replace` whose path no longer exists is retried as `add`, and any op that still cannot apply against the current replay state is skipped. The resulting document is what the repaired entry's recomputed patch should target. */
export function lenientApplyReplayPatch(
  current: ReplayDocument,
  patch: HistoryPatchOp[],
): LenientApplyResult {
  let working: unknown = structuredClone(current);
  let convertedReplaceToAdd = 0;
  let skippedOps = 0;

  for (const op of normalizeReplayPatchOps(patch)) {
    const direct = tryApplySingleOp(working, op);
    if (direct.ok) {
      working = direct.document;
      continue;
    }
    if (op.op === "replace") {
      const asAdd = tryApplySingleOp(working, { ...op, op: "add" });
      if (asAdd.ok) {
        working = asAdd.document;
        convertedReplaceToAdd += 1;
        continue;
      }
    }
    skippedOps += 1;
  }

  const candidate = working as { metadata?: unknown; body?: unknown };
  const document: ReplayDocument = {
    metadata:
      typeof candidate.metadata === "object" && candidate.metadata !== null
        ? (candidate.metadata as Record<string, unknown>)
        : {},
    body: typeof candidate.body === "string" ? candidate.body : current.body,
  };
  return { document, convertedReplaceToAdd, skippedOps };
}

/** Documents the reanchor entry detail payload exchanged by command, SDK, and package integrations. */
export interface ReanchorEntryDetail {
  /** Value that configures or reports index for this contract. */
  index: number;
  /** Value that configures or reports rehashed for this contract. */
  rehashed: boolean;
  /** Value that configures or reports patch repaired for this contract. */
  patch_repaired: boolean;
  /** Value that configures or reports converted replace to add for this contract. */
  converted_replace_to_add: number;
  /** Value that configures or reports skipped ops for this contract. */
  skipped_ops: number;
}

/** Documents the reanchor result payload exchanged by command, SDK, and package integrations. */
export interface ReanchorResult {
  /** Value that configures or reports entries for this contract. */
  entries: HistoryEntry[];
  /** Value that configures or reports final document for this contract. */
  finalDocument: ReplayDocument;
  /** Value that configures or reports entries rehashed for this contract. */
  entriesRehashed: number;
  /** Value that configures or reports entries patch repaired for this contract. */
  entriesPatchRepaired: number;
  /** Value that configures or reports converted replace to add for this contract. */
  convertedReplaceToAdd: number;
  /** Value that configures or reports skipped ops for this contract. */
  skippedOps: number;
  /** Entries resealed to dissolve a bridge or to add a replay_inexact marker; an epoch label alone does not count. */
  entriesResealed: number;
  /** Value that configures or reports details for this contract. */
  details: ReanchorEntryDetail[];
  /** Hash epoch retained while rebuilding the stream. */
  itemHashVersion: HistoryItemHashVersion;
  /** Whether rewritten entries explicitly carry the hash epoch field. */
  explicitItemHashVersion: boolean;
}

/** Controls whether re-anchoring preserves historical writer transitions or emits one exact hash surface. */
export interface ReanchorHistoryOptions {
  /** Keep one semantic hash candidate for the complete rewritten stream so adjacent stored endpoints are identical. */
  continuousHashSurface?: boolean;
  /** Rebase an entry's patch onto its new replay position, retaining the original patch as immutable rewrite evidence. */
  projectPatch?: (entry: HistoryEntry, current: ReplayDocument) => HistoryPatchOp[];
  /** The caller already marked every record a dissolved bridge covers (a merge union marks each original branch before it interleaves them), so re-anchoring adds no markers of its own. */
  callerMarksBridgeCoverage?: boolean;
}

/**
 * Resolve the hash epoch a repair must retain.
 *
 * A valid stream is authoritative even when legacy entries omit the version
 * field. For a broken stream, one consistent explicit epoch remains
 * authoritative; fully implicit legacy streams stay on epoch 1. Only an
 * irreconcilably mixed stream falls forward to the current epoch.
 */
export function resolveHistoryRepairItemHashVersion(
  entries: HistoryEntry[],
): HistoryItemHashVersion {
  const explicitVersions = supportedExplicitHistoryItemHashVersions(entries);
  if (explicitVersions.length === 1) {
    return explicitVersions[0];
  }
  const verified = verifyHistoryChainWithVersion(entries);
  if (verified.ok && verified.item_hash_version !== undefined) {
    return verified.item_hash_version;
  }
  if (explicitVersions.length === 0) {
    return 1;
  }
  return CURRENT_HISTORY_ITEM_HASH_VERSION;
}

/** Apply one patch strictly or return its deterministic lenient repair projection. */
function applyReanchorPatch(
  replay: ReplayDocument,
  entry: HistoryEntry,
  projectedPatch: HistoryPatchOp[] = entry.patch,
): {
  next: ReplayDocument;
  patch: HistoryPatchOp[];
  repaired: boolean;
  converted: number;
  skipped: number;
} {
  const strict = tryApplyReplayPatch(replay, projectedPatch);
  if (strict.ok) {
    return {
      next: strict.document,
      patch: projectedPatch,
      repaired: stableStringify(projectedPatch) !== stableStringify(entry.patch),
      converted: 0,
      skipped: 0,
    };
  }
  const lenient = lenientApplyReplayPatch(replay, projectedPatch);
  return {
    next: lenient.document,
    patch: jsonPatch.compare(replay, lenient.document) as HistoryPatchOp[],
    repaired: true,
    converted: lenient.convertedReplaceToAdd,
    skipped: lenient.skippedOps,
  };
}

/** Apply a caller's explicit projection before the canonical reanchor audit. */
function applyProjectedReanchorPatch(replay: ReplayDocument, entry: HistoryEntry, options: ReanchorHistoryOptions): ReturnType<typeof applyReanchorPatch> {
  return applyReanchorPatch(replay, entry, options.projectPatch?.(entry, replay));
}

/**
 * Index the verified bridged segments of a stream. A verified bridge keeps its
 * segment byte-identical while nothing before it changed; projected rewrites
 * (merge unions) rebase every patch, so they dissolve bridges instead. A
 * dissolved segment's entries are re-anchored on replay that lacks the
 * unrecorded change, so each is marked replay_inexact.
 */
function indexBridgedSegments(
  entries: HistoryEntry[],
  options: ReanchorHistoryOptions,
): { preservable: Map<number, number>; inexact: Set<number> } {
  const verified = verifyHistoryChainWithVersion(entries).bridged_segments ?? [];
  return {
    preservable: new Map(
      options.projectPatch === undefined
        ? verified.map((segment) => [segment.start, segment.end])
        : [],
    ),
    // Located, not only verified: a rewrite that repairs a record before the
    // bridge still dissolves it, and must keep its versions refused. A merge
    // union interleaves branches, so it marks each original branch first.
    inexact: collectBridgedInteriorIndexes(
      options.callerMarksBridgeCoverage === true ? [] : locateBridgedSegments(entries).segments,
    ),
  };
}

/**
 * Indexes of the entries a bridged segment covers before its bridge, plus the
 * bridge record itself when no intact commitment proved the segment: its
 * recorded state then rests on records that cannot be trusted either.
 */
export function collectBridgedInteriorIndexes(
  segments: ReadonlyArray<HistoryBridgedSegment & { exact?: boolean }>,
): Set<number> {
  const interior = new Set<number>();
  for (const { start, end, exact } of segments) {
    const last = exact === false ? end : end - 1;
    for (let index = start; index <= last; index += 1) interior.add(index);
  }
  return interior;
}

/**
 * Reseal one record with replay_inexact. The evidence keeps only digests of
 * the prior record, never its values: a following provenance normalization
 * or redaction must not find the removed values preserved in this evidence.
 */
export function markHistoryEntryInexact(entry: HistoryEntry): HistoryEntry {
  return resealHistoryRewrite(
    entry,
    { ...entry, replay_inexact: true },
    { retainPriorRecord: true, retainPriorRecordHash: false },
  );
}

/**
 * Write the unreconstructable knowledge a verified bridge carries onto the
 * records it covers, before any rewrite that may dissolve the bridge: each
 * covered entry is resealed with replay_inexact (its prior record kept as
 * rewrite evidence). Rewrites that reseal, interleave or re-anchor entries
 * before they can see the segment (provenance normalization, merge unions)
 * call this first, so the marker survives whatever they do to the bridge.
 */
export function materializeBridgedSegments(entries: HistoryEntry[]): HistoryEntry[] {
  const interior = collectBridgedInteriorIndexes(locateBridgedSegments(entries).segments);
  return entries.map((entry, index) =>
    interior.has(index) && entry.replay_inexact !== true
      ? markHistoryEntryInexact(entry)
      : entry,
  );
}

/** Keep one verified bridged segment byte-identical while advancing replay through it. */
function keepBridgedSegment(
  entries: HistoryEntry[],
  start: number,
  end: number,
  replay: ReplayDocument,
  rewritten: HistoryEntry[],
  details: ReanchorEntryDetail[],
): ReplayDocument {
  let current = replay;
  for (let index = start; index <= end; index += 1) {
    const kept = entries[index];
    const applied = tryApplyReplayPatch(current, kept.patch);
    /* c8 ignore start -- the verifier already applied this exact patch to this replay. */
    if (!applied.ok) throw new TypeError(`patch_apply_failed:entry_${index + 1}`);
    /* c8 ignore stop */
    current = applied.document;
    rewritten.push(kept);
    details.push({
      index: index + 1,
      rehashed: false,
      patch_repaired: false,
      converted_replace_to_add: 0,
      skipped_ops: 0,
    });
  }
  return current;
}

/**
 * Apply the stream epoch to one re-anchored entry and reseal it when anything
 * changed. A bridge outside a preserved segment names breaks that
 * re-anchoring removes, so it is dissolved and kept only as rewrite evidence.
 */
function finalizeReanchoredEntry(
  entry: HistoryEntry,
  rewrittenEntry: HistoryEntry,
  flags: {
    itemHashVersion: HistoryItemHashVersion | undefined;
    rehashed: boolean;
    patchRepaired: boolean;
    inexact: boolean;
  },
): { entry: HistoryEntry; changed: boolean; unbridged: boolean } {
  if (flags.itemHashVersion === undefined) delete rewrittenEntry.item_hash_version;
  else rewrittenEntry.item_hash_version = flags.itemHashVersion;
  if (flags.inexact) rewrittenEntry.replay_inexact = true;
  const bridgeDissolved = Object.hasOwn(entry, "bridge");
  delete rewrittenEntry.bridge;
  const unbridged = bridgeDissolved || rewrittenEntry.replay_inexact !== entry.replay_inexact;
  const changed =
    flags.rehashed ||
    flags.patchRepaired ||
    unbridged ||
    rewrittenEntry.item_hash_version !== entry.item_hash_version;
  return {
    changed,
    unbridged,
    entry: changed
      ? resealHistoryRewrite(entry, rewrittenEntry, {
          retainOriginalPatch: flags.patchRepaired,
          retainPriorRecord: bridgeDissolved,
        })
      : rewrittenEntry,
  };
}

/** Re-anchor a drifted history chain: replay every entry from empty, recompute the before/after hashes, and only rewrite a patch when the original op set no longer strictly applies (legacy drift). Clean entries keep their patch verbatim so the on-disk diff stays minimal. The returned chain verifies via verifyHistoryChain. */
export function reanchorHistoryEntries(
  entries: HistoryEntry[],
  itemHashVersion: HistoryItemHashVersion = resolveHistoryRepairItemHashVersion(entries),
  options: ReanchorHistoryOptions = {},
): ReanchorResult {
  const unsupportedIndex = entries.findIndex((entry) =>
    isUnsupportedExplicitHistoryItemHashVersion(entry.item_hash_version),
  );
  if (unsupportedIndex >= 0) {
    throw new TypeError(
      `unsupported_item_hash_version:${String(entries[unsupportedIndex]?.item_hash_version)}:entry_${unsupportedIndex + 1}`,
    );
  }
  let replay = cloneEmptyReplayDocument();
  const rewritten: HistoryEntry[] = [];
  const details: ReanchorEntryDetail[] = [];
  let entriesRehashed = 0;
  let entriesPatchRepaired = 0;
  let convertedReplaceToAdd = 0;
  let skippedOps = 0;
  let entriesResealed = 0;
  let semanticIndex: number | undefined;
  const explicitItemHashVersion =
    itemHashVersion !== 1 ||
    entries.some((entry) => entry.item_hash_version !== undefined);
  const bridged = indexBridgedSegments(entries, options);
  let unchangedPrefix = true;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    assertHistoryEntryIntegrity(entry, index);
    const preservedEnd = unchangedPrefix
      ? bridged.preservable.get(index)
      : undefined;
    if (preservedEnd !== undefined) {
      replay = keepBridgedSegment(entries, index, preservedEnd, replay, rewritten, details);
      index = preservedEnd;
      continue;
    }
    const patchApplication = applyProjectedReanchorPatch(replay, entry, options);
    const {
      next,
      patch: outPatch,
      repaired: patchRepaired,
      converted: entryConverted,
      skipped: entrySkipped,
    } = patchApplication;
    convertedReplaceToAdd += entryConverted;
    skippedOps += entrySkipped;
    entriesPatchRepaired += Number(patchRepaired);

    const hashMatch = matchReplayHashCandidates(
      replay,
      next,
      itemHashVersion,
      entry,
    );
    if (semanticIndex === undefined || options.continuousHashSurface !== true) {
      semanticIndex = [
        hashMatch.pairIndex,
        hashMatch.beforeIndex,
        hashMatch.afterIndex,
        Math.min(semanticIndex ?? 0, hashMatch.beforeHashes.length - 1),
      ].find((candidate) => candidate >= 0)!;
    } else {
      semanticIndex = Math.min(
        semanticIndex,
        hashMatch.beforeHashes.length - 1,
      );
    }
    const beforeHash = hashMatch.beforeHashes[semanticIndex]!;
    const afterHash = hashMatch.afterHashes[semanticIndex]!;
    const rehashed =
      beforeHash !== entry.before_hash || afterHash !== entry.after_hash;
    if (rehashed) {
      entriesRehashed += 1;
    }

    const finalized = finalizeReanchoredEntry(
      entry,
      { ...entry, patch: outPatch, before_hash: beforeHash, after_hash: afterHash },
      {
        itemHashVersion: explicitItemHashVersion ? itemHashVersion : undefined,
        rehashed,
        patchRepaired,
        inexact: bridged.inexact.has(index),
      },
    );
    unchangedPrefix &&= !finalized.changed;
    entriesResealed += Number(finalized.unbridged);
    rewritten.push(finalized.entry);
    details.push({
      index: index + 1,
      rehashed,
      patch_repaired: patchRepaired,
      converted_replace_to_add: entryConverted,
      skipped_ops: entrySkipped,
    });
    replay = next;
  }

  return {
    entries: rewritten,
    finalDocument: replay,
    entriesRehashed,
    entriesPatchRepaired,
    convertedReplaceToAdd,
    skippedOps,
    entriesResealed,
    details,
    itemHashVersion,
    explicitItemHashVersion,
  };
}

/** Implements history entries to raw for the public runtime surface of this module. */
export function historyEntriesToRaw(entries: HistoryEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
