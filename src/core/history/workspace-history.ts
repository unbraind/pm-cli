/**
 * @module core/history/workspace-history
 *
 * Records singleton workspace documents in the same append-only, hash-chained
 * HistoryEntry format used by item mutations.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  readFileIfExists,
  writeFileAtomic,
} from "../fs/fs-utils.js";
import { acquireLock } from "../lock/lock.js";
import { EMPTY_CANONICAL_DOCUMENT } from "../shared/constants.js";
import { stableStringify } from "../shared/serialization.js";
import type { HistoryEntry, ItemDocument, ItemMetadata } from "../../types.js";
import { appendHistoryEntry, createHistoryEntry } from "./history.js";
import { readHistoryEntries } from "./read.js";
import {
  cloneEmptyReplayDocument,
  replayToItemDocument,
  tryApplyReplayPatch,
  verifyHistoryChain,
  type ReplayDocument,
} from "./replay.js";

/** Synthetic item id used to expose the singleton workspace audit stream. */
export const WORKSPACE_HISTORY_ID = "_workspace";

/** Return the canonical workspace history stream path. */
export function getWorkspaceHistoryPath(pmRoot: string): string {
  return path.join(pmRoot, "history", `${WORKSPACE_HISTORY_ID}.jsonl`);
}

/** One singleton-document mutation appended to workspace history. */
export interface WorkspaceHistoryChange {
  /** Tracker root containing the workspace history stream. */
  pmRoot: string;
  /** Repository-relative or tracker-relative document identity. */
  documentPath: string;
  /** Document value observed before the mutation. */
  before: unknown;
  /** Document value persisted by the mutation. */
  after: unknown;
  /** Stable operation name. */
  op: string;
  /** Optional operation key that makes retries return the original entry. */
  idempotencyKey?: string;
  /** Attributable mutation actor. */
  author: string;
  /** Optional human-readable rationale. */
  message?: string;
  /** Lock time-to-live in seconds. */
  lockTtlSeconds: number;
  /** Maximum lock wait in milliseconds. */
  lockWaitMs: number;
}

/** Options for one lock-scoped audited workspace singleton write. */
export interface WorkspaceJsonWriteOptions {
  /** Tracker root containing the singleton. */
  pmRoot: string;
  /** Absolute singleton path. */
  filePath: string;
  /** Fully serialized JSON value to persist. */
  raw: string;
  /** Stable operation name. */
  op: string;
  /** Attributable mutation actor. */
  author: string;
  /** Lock time-to-live in seconds. */
  lockTtlSeconds: number;
  /** Maximum lock wait in milliseconds. */
  lockWaitMs: number;
  /** Optional human-readable rationale. */
  message?: string;
  /** Whether creating a previously absent singleton produces a history entry. */
  recordCreation?: boolean;
}

interface WorkspaceAuditMetadata extends ItemMetadata {
  documents: Record<string, unknown>;
}

function workspaceDocument(
  documents: Record<string, unknown>,
  timestamp: string,
): ItemDocument {
  const metadata: WorkspaceAuditMetadata = {
    id: WORKSPACE_HISTORY_ID,
    title: "Workspace state",
    description: "Audited singleton workspace document state.",
    type: "Chore",
    status: "open",
    priority: 2,
    tags: ["workspace-history"],
    created_at: timestamp,
    updated_at: timestamp,
    documents,
  };
  return { metadata, body: "" };
}

function replayWorkspaceEntries(entries: readonly HistoryEntry[]): ItemDocument {
  let replay = cloneEmptyReplayDocument();
  for (const entry of entries) {
    const applied = tryApplyReplayPatch(replay, entry.patch) as {
      ok: true;
      document: ReplayDocument;
    };
    replay = applied.document;
  }
  return replayToItemDocument(replay);
}

/**
 * Append one workspace document mutation while the caller holds the dedicated
 * workspace-history lock.
 */
async function appendWorkspaceHistoryChangeLocked(
  change: WorkspaceHistoryChange,
): Promise<{ entry: HistoryEntry; historyPath: string }> {
  const historyPath = getWorkspaceHistoryPath(change.pmRoot);
  const entries = await readHistoryEntries(
    historyPath,
    WORKSPACE_HISTORY_ID,
  );
  const verification = verifyHistoryChain(entries);
  if (!verification.ok) {
    throw new TypeError(
      `Workspace history verification failed: ${verification.errors.join(", ")}`,
    );
  }
  const idempotentEntry =
    change.idempotencyKey === undefined
      ? undefined
      : entries.find(
          (entry) => entry.op === `${change.op}:${change.idempotencyKey}`,
        );
  if (idempotentEntry) {
    return { entry: idempotentEntry, historyPath };
  }
  const timestamp = new Date().toISOString();
  const beforeDocument: ItemDocument =
    entries.length === 0
      ? (EMPTY_CANONICAL_DOCUMENT as unknown as ItemDocument)
      : replayWorkspaceEntries(entries);
  const priorDocuments =
    "documents" in beforeDocument.metadata &&
    typeof beforeDocument.metadata.documents === "object" &&
    beforeDocument.metadata.documents !== null &&
    !Array.isArray(beforeDocument.metadata.documents)
      ? (beforeDocument.metadata.documents as Record<string, unknown>)
      : {};
  const recordedBefore = priorDocuments[change.documentPath];
  if (
    recordedBefore !== undefined &&
    stableStringify(recordedBefore) !== stableStringify(change.before)
  ) {
    throw new TypeError(
      `Workspace history state for "${change.documentPath}" changed outside the audited mutation path.`,
    );
  }
  const afterDocument = workspaceDocument(
    { ...priorDocuments, [change.documentPath]: change.after },
    entries.length === 0
      ? timestamp
      : beforeDocument.metadata.created_at!,
  );
  const entry = createHistoryEntry({
    nowIso: timestamp,
    author: change.author,
    op:
      change.idempotencyKey === undefined
        ? change.op
        : `${change.op}:${change.idempotencyKey}`,
    before: beforeDocument,
    after: afterDocument,
    message: change.message,
  });
  await appendHistoryEntry(historyPath, entry);
  return { entry, historyPath };
}

/**
 * Append one workspace document mutation under the dedicated workspace-history
 * lock. Existing history is verified and replayed before the new entry is
 * derived, so concurrent writers cannot fork the chain.
 */
export async function appendWorkspaceHistoryChange(
  change: WorkspaceHistoryChange,
): Promise<{ entry: HistoryEntry; historyPath: string }> {
  const release = await acquireLock(
    change.pmRoot,
    "workspace-history",
    change.lockTtlSeconds,
    change.author,
    false,
    false,
    change.lockWaitMs,
  );
  try {
    return await appendWorkspaceHistoryChangeLocked(change);
  } finally {
    await release();
  }
}

/**
 * Atomically serialize a JSON singleton snapshot, write, history append, and
 * compensation under the workspace-history lock.
 */
export async function writeWorkspaceJsonWithHistory(
  params: WorkspaceJsonWriteOptions,
): Promise<boolean> {
  const release = await acquireLock(
    params.pmRoot,
    "workspace-history",
    params.lockTtlSeconds,
    params.author,
    false,
    false,
    params.lockWaitMs,
  );
  try {
    const beforeRaw = await readFileIfExists(params.filePath);
    if (beforeRaw === params.raw) return false;
    const before = beforeRaw === null ? null : JSON.parse(beforeRaw);
    const after = JSON.parse(params.raw);
    await writeFileAtomic(params.filePath, params.raw);
    try {
      if (beforeRaw !== null || params.recordCreation !== false) {
        await appendWorkspaceHistoryChangeLocked({
          pmRoot: params.pmRoot,
          documentPath: path
            .relative(params.pmRoot, params.filePath)
            .replaceAll("\\", "/"),
          before,
          after,
          op: params.op,
          author: params.author,
          lockTtlSeconds: params.lockTtlSeconds,
          lockWaitMs: params.lockWaitMs,
          message: params.message,
        });
      }
    } catch (error: unknown) {
      if (beforeRaw === null) {
        await fs.rm(params.filePath, { force: true });
      } else {
        await writeFileAtomic(params.filePath, beforeRaw);
      }
      throw error;
    }
    return true;
  } finally {
    await release();
  }
}
