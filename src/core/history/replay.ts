/**
 * @module core/history/replay
 *
 * Implements append-only history and replay behavior for Replay.
 */
import jsonPatch from "fast-json-patch";
import { ITEM_METADATA_KEY_ORDER } from "../shared/constants.js";
import { canonicalDocument } from "../item/item-format.js";
import { toItemRecord } from "../item/item-record.js";
import {
  orderObject,
  sha256Hex,
  stableStringify,
} from "../shared/serialization.js";
import {
  CURRENT_HISTORY_ITEM_HASH_VERSION,
  SUPPORTED_HISTORY_ITEM_HASH_VERSIONS,
  hashDocumentForVersion,
  type HistoryItemHashVersion,
} from "./history.js";
import type {
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
): string {
  if (
    Object.keys(document.metadata).length === 0 ||
    Array.isArray(document.metadata.tags)
  ) {
    try {
      return hashDocumentForVersion(replayToItemDocument(document), version);
    } catch {
      // Fall through when another malformed legacy field cannot be canonicalized.
    }
  }
  // Preserve the structural hashes recorded before missing tags became safe to
  // normalize. Pre-create/legacy replay states and other malformed metadata cannot
  // switch hash algorithms without invalidating immutable history chains.
  return sha256Hex(
    stableStringify({
      replay_fallback: true,
      metadata: document.metadata,
      body: document.body,
    }),
  );
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
  return patch.filter(isHistoryPatchOp).map((operation) => ({
    ...operation,
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
    const applied = jsonPatch.applyPatch(
      structuredClone(current),
      normalizedPatch as jsonPatch.Operation[],
      true,
      false,
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

/** Deterministically verify a history chain: each entry's before_hash must equal the prior replayed after_hash, the patch must strictly apply, and the recorded after_hash must equal the replayed result. */
/** Verify a chain and report the explicit or auto-detected item hash epoch. */
export function verifyHistoryChainWithVersion(entries: HistoryEntry[]): {
  ok: boolean;
  errors: string[];
  item_hash_version?: HistoryItemHashVersion;
} {
  let replay = cloneEmptyReplayDocument();
  let detectedVersion: HistoryItemHashVersion | undefined;
  let authoritativeExplicitVersion: HistoryItemHashVersion | undefined;
  const errors: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const explicitVersion = entry.item_hash_version;
    if (isUnsupportedExplicitHistoryItemHashVersion(explicitVersion)) {
      errors.push(
        `verify_failed:unsupported_item_hash_version:${String(explicitVersion)}:entry_${index + 1}`,
      );
      const applied = tryApplyReplayPatch(replay, entry.patch);
      if (!applied.ok) {
        return {
          ok: false,
          errors: [
            ...errors,
            `verify_failed:patch_apply_failed:entry_${index + 1}`,
          ],
        };
      }
      replay = applied.document;
      detectedVersion = undefined;
      authoritativeExplicitVersion = undefined;
      continue;
    }
    const applied = tryApplyReplayPatch(replay, entry.patch);
    if (!applied.ok) {
      return {
        ok: false,
        errors: [
          ...errors,
          `verify_failed:patch_apply_failed:entry_${index + 1}`,
        ],
      };
    }
    // Prefer legacy epoch 1 when an unversioned entry is valid under both
    // algorithms, but retain compatibility with transitional epoch-2 writers
    // that shipped before item_hash_version became explicit.
    const candidates = historyEntryHashCandidates(
      explicitVersion,
      authoritativeExplicitVersion,
    );
    const beforeMatches = candidates.filter(
      (version) => replayHash(replay, version) === entry.before_hash,
    );
    if (beforeMatches.length === 0) {
      return {
        ok: false,
        errors: [
          ...errors,
          `verify_failed:before_hash_mismatch:entry_${index + 1}`,
        ],
      };
    }
    const version = beforeMatches.find(
      (candidate) =>
        replayHash(applied.document, candidate) === entry.after_hash,
    );
    if (version === undefined) {
      return {
        ok: false,
        errors: [
          ...errors,
          `verify_failed:after_hash_mismatch:entry_${index + 1}`,
        ],
      };
    }
    replay = applied.document;
    detectedVersion = version;
    authoritativeExplicitVersion =
      (explicitVersion as HistoryItemHashVersion | undefined) ??
      authoritativeExplicitVersion;
  }
  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      ...(detectedVersion === undefined
        ? {}
        : { item_hash_version: detectedVersion }),
    };
  }
  return {
    ok: true,
    errors: [],
    ...(detectedVersion === undefined
      ? {}
      : { item_hash_version: detectedVersion }),
  };
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
  /** Value that configures or reports details for this contract. */
  details: ReanchorEntryDetail[];
  /** Hash epoch retained while rebuilding the stream. */
  itemHashVersion: HistoryItemHashVersion;
  /** Whether rewritten entries explicitly carry the hash epoch field. */
  explicitItemHashVersion: boolean;
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

/** Re-anchor a drifted history chain: replay every entry from empty, recompute the before/after hashes, and only rewrite a patch when the original op set no longer strictly applies (legacy drift). Clean entries keep their patch verbatim so the on-disk diff stays minimal. The returned chain verifies via verifyHistoryChain. */
export function reanchorHistoryEntries(
  entries: HistoryEntry[],
  itemHashVersion = resolveHistoryRepairItemHashVersion(entries),
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
  const explicitItemHashVersion =
    itemHashVersion !== 1 ||
    entries.some((entry) => entry.item_hash_version !== undefined);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const beforeHash = replayHash(replay, itemHashVersion);
    const strict = tryApplyReplayPatch(replay, entry.patch);

    let next: ReplayDocument;
    let outPatch: HistoryPatchOp[];
    let patchRepaired = false;
    let entryConverted = 0;
    let entrySkipped = 0;

    if (strict.ok) {
      next = strict.document;
      outPatch = entry.patch;
    } else {
      const lenient = lenientApplyReplayPatch(replay, entry.patch);
      next = lenient.document;
      outPatch = jsonPatch.compare(replay, next) as HistoryPatchOp[];
      patchRepaired = true;
      entryConverted = lenient.convertedReplaceToAdd;
      entrySkipped = lenient.skippedOps;
      convertedReplaceToAdd += entryConverted;
      skippedOps += entrySkipped;
      entriesPatchRepaired += 1;
    }

    const afterHash = replayHash(next, itemHashVersion);
    const rehashed =
      beforeHash !== entry.before_hash || afterHash !== entry.after_hash;
    if (rehashed) {
      entriesRehashed += 1;
    }

    const rewrittenEntry: HistoryEntry = {
      ...entry,
      patch: outPatch,
      before_hash: beforeHash,
      after_hash: afterHash,
    };
    if (explicitItemHashVersion) {
      rewrittenEntry.item_hash_version = itemHashVersion;
    } else {
      delete rewrittenEntry.item_hash_version;
    }
    rewritten.push(rewrittenEntry);
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
