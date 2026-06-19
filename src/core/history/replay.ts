/**
 * @module core/history/replay
 *
 * Implements append-only history and replay behavior for Replay.
 */
import jsonPatch from "fast-json-patch";
import { FRONT_MATTER_KEY_ORDER } from "../shared/constants.js";
import { canonicalDocument } from "../item/item-format.js";
import { toItemRecord } from "../item/item-record.js";
import { orderObject, sha256Hex, stableStringify } from "../shared/serialization.js";
import { hashDocument } from "./history.js";
import type { HistoryEntry, HistoryPatchOp, ItemDocument, ItemMetadata } from "../../types/index.js";

/**
 * Shared history replay/patch mechanics single-sourced for the history, restore,
 * history-redact, and history-repair commands plus the health/validate drift checks.
 *
 * Each command keeps its own thin error-formatting wrapper so the exact CLI error
 * contracts (restore's rich patch-failure context, redact's op tag, history's
 * generic message) are preserved; only the underlying replay/patch logic is shared.
 */

export interface ReplayDocument {
  metadata: Record<string, unknown>;
  body: string;
}

export const EMPTY_REPLAY_DOCUMENT: ReplayDocument = {
  metadata: {},
  body: "",
};

/**
 * Implements clone empty replay document for the public runtime surface of this module.
 */
export function cloneEmptyReplayDocument(): ReplayDocument {
  return structuredClone(EMPTY_REPLAY_DOCUMENT);
}

/**
 * Implements replay hash for the public runtime surface of this module.
 */
export function replayHash(document: ReplayDocument): string {
  try {
    return hashDocument(replayToItemDocument(document));
  } catch {
    // Legacy/malformed replay states (for example a stream whose first entry never
    // established a full `create` document, so the canonicalizer cannot normalize it)
    // cannot be canonically hashed. Fall back to a deterministic structural hash so
    // re-anchor and verification stay internally consistent for these streams. Fully
    // formed documents always take the canonical path above, so valid streams are
    // unaffected.
    return sha256Hex(stableStringify({ replay_fallback: true, metadata: document.metadata, body: document.body }));
  }
}

/**
 * Implements replay to item document for the public runtime surface of this module.
 */
export function replayToItemDocument(document: ReplayDocument): ItemDocument {
  return {
    metadata: document.metadata as ItemMetadata,
    body: document.body,
  };
}

/**
 * Converts a materialized replay document into a canonical item document. Use
 * this when callers have already rejected the empty/deleted replay state and
 * need restored metadata validated through the normal front-matter rules.
 */
export function replayToCanonicalItemDocument(
  document: ReplayDocument,
  options: Parameters<typeof canonicalDocument>[1] = {},
): ItemDocument {
  return canonicalDocument(replayToItemDocument(document), options);
}

/**
 * Canonicalize an item document into the ordered replay form used when comparing
 * a replayed chain against the on-disk item (restore + history-repair reconciliation).
 */
export function toReplayDocument(document: ItemDocument): ReplayDocument {
  if (!document.metadata || Object.keys(document.metadata).length === 0) {
    return {
      metadata: {},
      body: document.body ?? "",
    };
  }
  const canonical = canonicalDocument(document);
  return {
    metadata: orderObject(toItemRecord(canonical.metadata), FRONT_MATTER_KEY_ORDER),
    body: canonical.body,
  };
}

/**
 * Implements normalize replay patch path for the public runtime surface of this module.
 */
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

/**
 * Implements normalize replay patch ops for the public runtime surface of this module.
 */
export function normalizeReplayPatchOps(patch: HistoryPatchOp[] | unknown): HistoryPatchOp[] {
  if (!Array.isArray(patch)) {
    return [];
  }
  return patch.filter(isHistoryPatchOp).map((operation) => ({
    ...operation,
    path: normalizeReplayPatchPath(operation.path),
    from: typeof operation.from === "string" ? normalizeReplayPatchPath(operation.from) : undefined,
  }));
}

function isReplayDocumentShape(value: unknown): value is { metadata: Record<string, unknown>; body: string } {
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

/**
 * Restricts replay apply result values accepted by command, SDK, and storage contracts.
 */
export type ReplayApplyResult =
  | { ok: true; document: ReplayDocument }
  | { ok: false; error: unknown };

/**
 * Strictly apply a history patch (front_matter->metadata normalized) to a replay
 * document. Returns a result envelope rather than throwing so each caller can
 * format its own error contract.
 */
export function tryApplyReplayPatch(current: ReplayDocument, patch: HistoryPatchOp[]): ReplayApplyResult {
  try {
    const normalizedPatch = normalizeReplayPatchOps(patch);
    const applied = jsonPatch.applyPatch(
      structuredClone(current),
      normalizedPatch as jsonPatch.Operation[],
      true,
      false,
    ).newDocument as unknown;
    if (!isReplayDocumentShape(applied)) {
      return { ok: false, error: new Error("history_replay_invalid_document_shape") };
    }
    return { ok: true, document: { metadata: applied.metadata, body: applied.body } };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Deterministically verify a history chain: each entry's before_hash must equal
 * the prior replayed after_hash, the patch must strictly apply, and the recorded
 * after_hash must equal the replayed result.
 */
export function verifyHistoryChain(entries: HistoryEntry[]): { ok: boolean; errors: string[] } {
  let replay = cloneEmptyReplayDocument();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (replayHash(replay) !== entry.before_hash) {
      return {
        ok: false,
        errors: [`verify_failed:before_hash_mismatch:entry_${index + 1}`],
      };
    }
    const applied = tryApplyReplayPatch(replay, entry.patch);
    if (!applied.ok) {
      return {
        ok: false,
        errors: [`verify_failed:patch_apply_failed:entry_${index + 1}`],
      };
    }
    replay = applied.document;
    if (replayHash(replay) !== entry.after_hash) {
      return {
        ok: false,
        errors: [`verify_failed:after_hash_mismatch:entry_${index + 1}`],
      };
    }
  }
  return { ok: true, errors: [] };
}

/**
 * Documents the lenient apply result payload exchanged by command, SDK, and package integrations.
 */
export interface LenientApplyResult {
  document: ReplayDocument;
  convertedReplaceToAdd: number;
  skippedOps: number;
}

function tryApplySingleOp(document: unknown, op: HistoryPatchOp): { ok: true; document: unknown } | { ok: false } {
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

/**
 * Apply a legacy patch op-by-op, recovering from drift that strict replay rejects:
 * a `replace` whose path no longer exists is retried as `add`, and any op that
 * still cannot apply against the current replay state is skipped. The resulting
 * document is what the repaired entry's recomputed patch should target.
 */
export function lenientApplyReplayPatch(current: ReplayDocument, patch: HistoryPatchOp[]): LenientApplyResult {
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

/**
 * Documents the reanchor entry detail payload exchanged by command, SDK, and package integrations.
 */
export interface ReanchorEntryDetail {
  index: number;
  rehashed: boolean;
  patch_repaired: boolean;
  converted_replace_to_add: number;
  skipped_ops: number;
}

/**
 * Documents the reanchor result payload exchanged by command, SDK, and package integrations.
 */
export interface ReanchorResult {
  entries: HistoryEntry[];
  finalDocument: ReplayDocument;
  entriesRehashed: number;
  entriesPatchRepaired: number;
  convertedReplaceToAdd: number;
  skippedOps: number;
  details: ReanchorEntryDetail[];
}

/**
 * Re-anchor a drifted history chain: replay every entry from empty, recompute the
 * before/after hashes, and only rewrite a patch when the original op set no longer
 * strictly applies (legacy drift). Clean entries keep their patch verbatim so the
 * on-disk diff stays minimal. The returned chain verifies via verifyHistoryChain.
 */
export function reanchorHistoryEntries(entries: HistoryEntry[]): ReanchorResult {
  let replay = cloneEmptyReplayDocument();
  const rewritten: HistoryEntry[] = [];
  const details: ReanchorEntryDetail[] = [];
  let entriesRehashed = 0;
  let entriesPatchRepaired = 0;
  let convertedReplaceToAdd = 0;
  let skippedOps = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const beforeHash = replayHash(replay);
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

    const afterHash = replayHash(next);
    const rehashed = beforeHash !== entry.before_hash || afterHash !== entry.after_hash;
    if (rehashed) {
      entriesRehashed += 1;
    }

    rewritten.push({
      ...entry,
      patch: outPatch,
      before_hash: beforeHash,
      after_hash: afterHash,
    });
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
  };
}

/**
 * Implements history entries to raw for the public runtime surface of this module.
 */
export function historyEntriesToRaw(entries: HistoryEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
