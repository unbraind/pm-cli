/**
 * @module core/history/workspace-history
 *
 * Records singleton workspace documents in the same append-only, hash-chained
 * HistoryEntry format used by item mutations.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { readFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";
import { acquireLock } from "../lock/lock.js";
import { EMPTY_CANONICAL_DOCUMENT, EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { stableStringify } from "../shared/serialization.js";
import { nowIso } from "../shared/time.js";
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

/** Result of deriving one audited singleton snapshot while its lock is held. */
export interface WorkspaceJsonMutation<Result> {
  /** Fully serialized JSON value to persist. */
  raw: string;
  /** Caller-defined result derived from the same locked before-state. */
  result: Result;
}

/** Options for deriving and writing one audited singleton under one lock. */
export interface WorkspaceJsonMutationOptions<Result> extends Omit<
  WorkspaceJsonWriteOptions,
  "raw"
> {
  /** Derive the next snapshot and receipt from the locked serialized state. */
  mutate: (
    beforeRaw: string | null,
  ) => WorkspaceJsonMutation<Result> | Promise<WorkspaceJsonMutation<Result>>;
}

/** Options for one append-only workspace audit event that leaves state unchanged. */
export interface WorkspaceAuditEventOptions {
  /** Tracker root containing the workspace history stream. */
  pmRoot: string;
  /** Stable operation name. */
  op: string;
  /** Attributable reviewer or operator. */
  author: string;
  /** Structured, non-secret audit metadata. */
  context: Record<string, unknown>;
  /** Human-readable rationale. */
  message: string;
  /** Lock time-to-live in seconds. */
  lockTtlSeconds: number;
  /** Maximum lock wait in milliseconds. */
  lockWaitMs: number;
}

/** Agreement between the replayed workspace stream and governed singleton files. */
export interface WorkspaceHistoryStateAgreement {
  /** Whether every governed singleton is readable and equals its replayed value. */
  ok: boolean;
  /** Number of singleton documents represented by the latest replayed state. */
  document_count: number;
  /** Governed documents whose on-disk JSON equals the replayed value. */
  matching_documents: string[];
  /** Governed documents whose on-disk JSON differs from the replayed value. */
  mismatched_documents: string[];
  /** Governed documents absent from disk. */
  missing_documents: string[];
  /** Governed documents that cannot be read as safe workspace-local JSON. */
  unreadable_documents: string[];
}

/** Authorized append-only reconciliation of one out-of-band singleton state. */
export interface WorkspaceJsonReconciliationOptions extends Omit<
  WorkspaceJsonWriteOptions,
  "raw" | "recordCreation"
> {
  /** Closed Decision item authorizing acceptance of the on-disk state. */
  authorizationDecision: string;
}

/** Restore one governed singleton from a recorded workspace history version. */
export interface WorkspaceJsonRestoreOptions extends Omit<
  WorkspaceJsonWriteOptions,
  "raw" | "recordCreation"
> {
  /** One-based workspace history version whose document value is restored. */
  targetVersion: number;
}

/** Receipt returned after a singleton is restored from workspace history. */
export interface WorkspaceJsonRestoreResult {
  /** Tracker-relative singleton identity. */
  document_path: string;
  /** One-based workspace history version used as the restore source. */
  restored_from_version: number;
  /** Whether the on-disk singleton and latest history state changed. */
  changed: boolean;
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

function replayWorkspaceEntries(
  entries: readonly HistoryEntry[],
  count = entries.length,
): ItemDocument {
  let replay = cloneEmptyReplayDocument();
  for (const entry of entries.slice(0, count)) {
    const applied = tryApplyReplayPatch(replay, entry.patch) as {
      ok: true;
      document: ReplayDocument;
    };
    replay = applied.document;
  }
  return replayToItemDocument(replay);
}

/** Read the governed document map from one replayed workspace document. */
function workspaceDocuments(document: ItemDocument): Record<string, unknown> {
  return "documents" in document.metadata &&
    typeof document.metadata.documents === "object" &&
    document.metadata.documents !== null &&
    !Array.isArray(document.metadata.documents)
    ? (document.metadata.documents as Record<string, unknown>)
    : {};
}

/** Refuse a workspace mutation or replay whose append-only chain is invalid. */
function throwWorkspaceHistoryVerificationFailure(
  errors: readonly string[],
): never {
  throw new PmCliError(
    `Workspace history verification failed: ${errors.join(", ")}`,
    EXIT_CODE.CONFLICT,
    {
      code: "workspace_history_chain_invalid",
      reason: "workspace_history_chain_verification_failed",
      verification_errors: [...errors],
      required:
        "Repair the _workspace history chain before reading, reconciling, restoring, or appending audited singleton state.",
      why: "Continuing against an unverifiable append-only stream could hide or compound workspace state corruption.",
      examples: [
        "pm history _workspace --verify --json",
        "pm validate --check-history-drift --fix-hints --json",
      ],
      nextSteps: [
        "Inspect the exact verification_errors and preserve the corrupt stream as evidence.",
        "Use the history-drift remediation returned by validate before retrying the refused operation.",
      ],
      recovery: {
        recovery_mode: "compact",
        next_best_command: "pm history _workspace --verify --json",
      },
    },
  );
}

/** Resolve a governed singleton path and reject paths outside the tracker root. */
function resolveGovernedDocumentPath(
  pmRoot: string,
  filePath: string,
): { documentPath: string; absolutePath: string } {
  const absolutePath = path.resolve(filePath);
  const documentPath = path.relative(pmRoot, absolutePath).replaceAll("\\", "/");
  if (
    documentPath.length === 0 ||
    documentPath === ".." ||
    documentPath.startsWith("../") ||
    path.isAbsolute(documentPath)
  ) {
    throw new TypeError("Workspace history document path must stay inside the tracker root");
  }
  return { documentPath, absolutePath };
}

/**
 * Compare every singleton represented by the verified workspace stream with
 * its current on-disk JSON. Hash-chain verification proves recorded ordering;
 * this state-agreement check separately proves that every current singleton
 * mutation is represented by that chain.
 */
export async function inspectWorkspaceHistoryState(
  pmRoot: string,
): Promise<WorkspaceHistoryStateAgreement> {
  const entries = await readHistoryEntries(
    getWorkspaceHistoryPath(pmRoot),
    WORKSPACE_HISTORY_ID,
  );
  const verification = verifyHistoryChain(entries);
  if (!verification.ok) {
    throwWorkspaceHistoryVerificationFailure(verification.errors);
  }
  const documents = workspaceDocuments(
    entries.length === 0
      ? (EMPTY_CANONICAL_DOCUMENT as unknown as ItemDocument)
      : replayWorkspaceEntries(entries),
  );
  const matching: string[] = [];
  const mismatched: string[] = [];
  const missing: string[] = [];
  const unreadable: string[] = [];
  for (const documentPath of Object.keys(documents).sort()) {
    let raw: string | null;
    try {
      const resolved = resolveGovernedDocumentPath(
        pmRoot,
        path.resolve(pmRoot, documentPath),
      );
      raw = await readFileIfExists(resolved.absolutePath);
      if (raw === null) {
        missing.push(documentPath);
        continue;
      }
      const current = JSON.parse(raw) as unknown;
      (stableStringify(current) === stableStringify(documents[documentPath])
        ? matching
        : mismatched
      ).push(documentPath);
    } catch {
      unreadable.push(documentPath);
    }
  }
  return {
    ok:
      mismatched.length === 0 &&
      missing.length === 0 &&
      unreadable.length === 0,
    document_count: Object.keys(documents).length,
    matching_documents: matching,
    mismatched_documents: mismatched,
    missing_documents: missing,
    unreadable_documents: unreadable,
  };
}

/**
 * Append one workspace document mutation while the caller holds the dedicated
 * workspace-history lock.
 */
async function appendWorkspaceHistoryChangeLocked(
  change: WorkspaceHistoryChange,
): Promise<{ entry: HistoryEntry; historyPath: string }> {
  const historyPath = getWorkspaceHistoryPath(change.pmRoot);
  const entries = await readHistoryEntries(historyPath, WORKSPACE_HISTORY_ID);
  const verification = verifyHistoryChain(entries);
  if (!verification.ok) {
    throwWorkspaceHistoryVerificationFailure(verification.errors);
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
  const timestamp = nowIso();
  const beforeDocument: ItemDocument =
    entries.length === 0
      ? (EMPTY_CANONICAL_DOCUMENT as unknown as ItemDocument)
      : replayWorkspaceEntries(entries);
  const priorDocuments = workspaceDocuments(beforeDocument);
  const recordedBefore = priorDocuments[change.documentPath];
  if (
    recordedBefore !== undefined &&
    stableStringify(recordedBefore) !== stableStringify(change.before)
  ) {
    throw new PmCliError(
      `Workspace history state for "${change.documentPath}" changed outside the audited mutation path.`,
      EXIT_CODE.CONFLICT,
      {
        code: "workspace_history_state_conflict",
        reason: "out_of_band_workspace_state",
        required:
          "Reconcile the singleton document with its matching _workspace history state before retrying the mutation.",
        why: "Accepting the write would make the append-only audit stream describe a state that was not actually observed.",
        examples: [
          "pm history _workspace --verify",
          "pm validate --check-history-drift --fix-hints",
        ],
        nextSteps: [
          "Review the version-control change that altered the singleton and preserve the intended document plus its matching workspace history.",
          "Rerun the original mutation only after the on-disk singleton agrees with the latest audited workspace state.",
        ],
        recovery: {
          recovery_mode: "compact",
          next_best_command: "pm history _workspace --verify",
        },
      },
    );
  }
  const afterDocument = workspaceDocument(
    { ...priorDocuments, [change.documentPath]: change.after },
    entries.length === 0 ? timestamp : beforeDocument.metadata.created_at!,
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

/** Append a verified no-state-change event to the workspace audit stream. */
export async function appendWorkspaceAuditEvent(
  options: WorkspaceAuditEventOptions,
): Promise<{ entry: HistoryEntry; historyPath: string }> {
  const release = await acquireLock(
    options.pmRoot,
    "workspace-history",
    options.lockTtlSeconds,
    options.author,
    false,
    false,
    options.lockWaitMs,
  );
  try {
    const historyPath = getWorkspaceHistoryPath(options.pmRoot);
    const entries = await readHistoryEntries(historyPath, WORKSPACE_HISTORY_ID);
    const verification = verifyHistoryChain(entries);
    if (!verification.ok) {
      throwWorkspaceHistoryVerificationFailure(verification.errors);
    }
    const beforeDocument: ItemDocument =
      entries.length === 0
        ? (EMPTY_CANONICAL_DOCUMENT as unknown as ItemDocument)
        : replayWorkspaceEntries(entries);
    const entry = createHistoryEntry({
      nowIso: nowIso(),
      author: options.author,
      op: options.op,
      before: beforeDocument,
      after: beforeDocument,
      message: options.message,
      context: options.context,
    });
    await appendHistoryEntry(historyPath, entry);
    return { entry, historyPath };
  } finally {
    await release();
  }
}

/**
 * Atomically serialize a JSON singleton snapshot, write, history append, and
 * compensation under the workspace-history lock.
 */
async function writeWorkspaceJsonWithHistoryLocked(
  params: WorkspaceJsonWriteOptions,
  beforeRaw: string | null,
): Promise<boolean> {
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
}

/**
 * Derive and persist an audited singleton mutation from one lock-protected
 * before-state, preventing read-modify-write callers from losing updates.
 */
export async function mutateWorkspaceJsonWithHistory<Result>(
  params: WorkspaceJsonMutationOptions<Result>,
): Promise<{ changed: boolean; result: Result }> {
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
    const mutation = await params.mutate(beforeRaw);
    return {
      changed: await writeWorkspaceJsonWithHistoryLocked(
        { ...params, raw: mutation.raw },
        beforeRaw,
      ),
      result: mutation.result,
    };
  } finally {
    await release();
  }
}

/**
 * Atomically persist one caller-serialized JSON singleton and its audit entry
 * under the workspace-history lock, with compensation if history append fails.
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
    return await writeWorkspaceJsonWithHistoryLocked(
      params,
      await readFileIfExists(params.filePath),
    );
  } finally {
    await release();
  }
}

/**
 * Append an authorized reconciliation event that adopts a reviewed on-disk
 * singleton after an out-of-band change. The existing stream is never edited:
 * its latest replayed state becomes the event before-state and the reviewed
 * singleton becomes the after-state, with the authorizing Decision recorded in
 * structured context.
 */
export async function reconcileWorkspaceJsonHistory(
  options: WorkspaceJsonReconciliationOptions,
): Promise<{ changed: boolean; entry?: HistoryEntry; historyPath: string }> {
  const authorizationDecision = options.authorizationDecision.trim();
  if (!authorizationDecision) {
    throw new TypeError("Workspace history reconciliation requires an authorization decision");
  }
  const release = await acquireLock(
    options.pmRoot,
    "workspace-history",
    options.lockTtlSeconds,
    options.author,
    false,
    false,
    options.lockWaitMs,
  );
  try {
    const { documentPath, absolutePath } = resolveGovernedDocumentPath(
      options.pmRoot,
      options.filePath,
    );
    const historyPath = getWorkspaceHistoryPath(options.pmRoot);
    const entries = await readHistoryEntries(historyPath, WORKSPACE_HISTORY_ID);
    const verification = verifyHistoryChain(entries);
    if (!verification.ok) {
      throwWorkspaceHistoryVerificationFailure(verification.errors);
    }
    const beforeDocument = replayWorkspaceEntries(entries);
    const priorDocuments = workspaceDocuments(beforeDocument);
    if (!Object.hasOwn(priorDocuments, documentPath)) {
      throw new TypeError(
        `Workspace history does not govern document ${documentPath}`,
      );
    }
    const raw = await readFileIfExists(absolutePath);
    if (raw === null) {
      throw new TypeError(`Workspace history document is missing: ${documentPath}`);
    }
    const current = JSON.parse(raw) as unknown;
    if (stableStringify(priorDocuments[documentPath]) === stableStringify(current)) {
      return { changed: false, historyPath };
    }
    const timestamp = nowIso();
    const entry = createHistoryEntry({
      nowIso: timestamp,
      author: options.author,
      op: options.op,
      before: beforeDocument,
      after: workspaceDocument(
        { ...priorDocuments, [documentPath]: current },
        beforeDocument.metadata.created_at!,
      ),
      message: options.message,
      context: {
        reason: "out_of_band_workspace_state_reconciliation",
        document_path: documentPath,
        authorization_decision: authorizationDecision,
      },
    });
    await appendHistoryEntry(historyPath, entry);
    return { changed: true, entry, historyPath };
  } finally {
    await release();
  }
}

/**
 * Restore one governed JSON singleton to the value recorded at a one-based
 * workspace history version, then append the restore as a new history state so
 * replay remains forward-only and independently verifiable.
 */
export async function restoreWorkspaceJsonFromHistory(
  options: WorkspaceJsonRestoreOptions,
): Promise<WorkspaceJsonRestoreResult> {
  const release = await acquireLock(
    options.pmRoot,
    "workspace-history",
    options.lockTtlSeconds,
    options.author,
    false,
    false,
    options.lockWaitMs,
  );
  try {
    const { documentPath, absolutePath } = resolveGovernedDocumentPath(
      options.pmRoot,
      options.filePath,
    );
    const entries = await readHistoryEntries(
      getWorkspaceHistoryPath(options.pmRoot),
      WORKSPACE_HISTORY_ID,
    );
    const verification = verifyHistoryChain(entries);
    if (!verification.ok) {
      throwWorkspaceHistoryVerificationFailure(verification.errors);
    }
    if (
      !Number.isInteger(options.targetVersion) ||
      options.targetVersion < 1 ||
      options.targetVersion > entries.length
    ) {
      throw new TypeError(
        `Invalid workspace history target version: ${String(options.targetVersion)}`,
      );
    }
    const target = workspaceDocuments(
      replayWorkspaceEntries(entries, options.targetVersion),
    )[documentPath];
    if (target === undefined) {
      throw new TypeError(
        `Workspace history version ${options.targetVersion} does not contain ${documentPath}`,
      );
    }
    const beforeRaw = await readFileIfExists(absolutePath);
    const targetRaw = `${JSON.stringify(target, null, 2)}\n`;
    if (beforeRaw === targetRaw)
      return {
        document_path: documentPath,
        restored_from_version: options.targetVersion,
        changed: false,
      };
    const beforeDocument = replayWorkspaceEntries(entries);
    const timestamp = nowIso();
    const entry = createHistoryEntry({
      nowIso: timestamp,
      author: options.author,
      op: options.op,
      before: beforeDocument,
      after: workspaceDocument(
        { ...workspaceDocuments(beforeDocument), [documentPath]: target },
        beforeDocument.metadata.created_at!,
      ),
      message: options.message,
      context: {
        reason: "workspace_state_restore",
        document_path: documentPath,
        restored_from_version: options.targetVersion,
        replaced_out_of_band_state: true,
      },
    });
    await writeFileAtomic(absolutePath, targetRaw);
    try {
      await appendHistoryEntry(
        getWorkspaceHistoryPath(options.pmRoot),
        entry,
      );
    } catch (error: unknown) {
      if (beforeRaw === null) await fs.rm(absolutePath, { force: true });
      else await writeFileAtomic(absolutePath, beforeRaw);
      throw error;
    }
    return {
      document_path: documentPath,
      restored_from_version: options.targetVersion,
      changed: true,
    };
  } finally {
    await release();
  }
}
