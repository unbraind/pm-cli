/**
 * @module core/history/history-rewrite
 *
 * Implements append-only history and replay behavior for History Rewrite.
 */
import fs from "node:fs/promises";
import { readFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";
import type { ItemTypeRegistry } from "../item/type-registry.js";
import { acquireLock } from "../lock/lock.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { locateItem, readLocatedItem } from "../store/item-store.js";
import { resolveGovernanceKnobs } from "../store/settings.js";
import type { ItemDocument, PmSettings } from "../../types/index.js";

type LoadedItem = Awaited<ReturnType<typeof readLocatedItem>>;
type HistoryRawWriter = (filePath: string, content: string) => Promise<void>;

/**
 * Documents the history rewrite subject payload exchanged by command, SDK, and package integrations.
 */
export interface HistoryRewriteSubject {
  id: string;
  historyPath: string;
}

/**
 * Documents the history rewrite ownership params payload exchanged by command, SDK, and package integrations.
 */
export interface HistoryRewriteOwnershipParams {
  itemDocument: ItemDocument | null;
  subjectId: string;
  author: string;
  force: boolean | undefined;
  settings: PmSettings;
}

/**
 * Apply ownership_enforcement governance to a history-rewriting operation.
 * Returns the warning(s) the caller should append (empty when no conflict or strict-throws).
 * Throws PmCliError(CONFLICT) in strict mode when the assignee conflicts and --force is not set.
 */
export function checkHistoryRewriteOwnership(params: HistoryRewriteOwnershipParams): string[] {
  if (!params.itemDocument) return [];
  const assigned = params.itemDocument.metadata?.assignee?.trim();
  if (!assigned || assigned === params.author || params.force) return [];

  const governance = resolveGovernanceKnobs(params.settings);
  if (governance.ownership_enforcement === "strict") {
    throw new PmCliError(
      `Item ${params.subjectId} is assigned to ${assigned}. Use --force to override.`,
      EXIT_CODE.CONFLICT,
    );
  }
  if (governance.ownership_enforcement === "warn") {
    return [`ownership_warning:assignee_conflict:${params.subjectId}:${assigned}`];
  }
  return [];
}

/**
 * Documents the verify history rewrite drift params payload exchanged by command, SDK, and package integrations.
 */
export interface VerifyHistoryRewriteDriftParams {
  pmRoot: string;
  subject: HistoryRewriteSubject;
  settings: PmSettings;
  typeRegistry: ItemTypeRegistry;
  historyRawBeforeLock: string | null;
  currentItemRawBeforeLock: string | null;
  /** Short operation name used in the conflict message (e.g. "history-redact"). */
  operation: string;
}

/**
 * Documents the verified history rewrite state payload exchanged by command, SDK, and package integrations.
 */
export interface VerifiedHistoryRewriteState {
  historyRawUnderLock: string | null;
  locatedUnderLock: Awaited<ReturnType<typeof locateItem>>;
  loadedItemUnderLock: LoadedItem | null;
}

/**
 * Re-read the history stream and the located item document under the acquired lock and
 * compare both with the pre-lock raw snapshots. Throws PmCliError(CONFLICT) if either
 * diverged while waiting for the lock so the caller surfaces an actionable retry.
 */
export async function verifyHistoryRewriteNoDrift(
  params: VerifyHistoryRewriteDriftParams,
): Promise<VerifiedHistoryRewriteState> {
  const historyRawUnderLock = await readFileIfExists(params.subject.historyPath);
  if (historyRawUnderLock !== params.historyRawBeforeLock) {
    throw new PmCliError(
      `History for ${params.subject.id} changed while waiting for lock; retry ${params.operation}.`,
      EXIT_CODE.CONFLICT,
    );
  }
  const locatedUnderLock = await locateItem(
    params.pmRoot,
    params.subject.id,
    params.settings.id_prefix,
    params.settings.item_format,
    params.typeRegistry.type_to_folder,
  );
  const loadedItemUnderLock = locatedUnderLock
    ? await readLocatedItem(locatedUnderLock, { schema: params.settings.schema })
    : null;
  if ((loadedItemUnderLock?.raw ?? null) !== (params.currentItemRawBeforeLock ?? null)) {
    throw new PmCliError(
      `Item ${params.subject.id} changed while waiting for lock; retry ${params.operation}.`,
      EXIT_CODE.CONFLICT,
    );
  }
  return { historyRawUnderLock, locatedUnderLock, loadedItemUnderLock };
}

/**
 * Documents the execute history rewrite params payload exchanged by command, SDK, and package integrations.
 */
export interface ExecuteHistoryRewriteParams {
  pmRoot: string;
  subject: HistoryRewriteSubject;
  settings: PmSettings;
  typeRegistry: ItemTypeRegistry;
  historyRawBeforeLock: string | null;
  currentItemRawBeforeLock: string | null;
  /** Short operation name used in conflict guidance (e.g. "history-redact"). */
  operation: string;
  author: string;
  force: boolean | undefined;
  itemDocument: ItemDocument | null;
  applyRewrite: (verified: VerifiedHistoryRewriteState) => Promise<void>;
  applyPostRewrite?: (verified: VerifiedHistoryRewriteState) => Promise<string[]>;
}

/**
 * Writes the rewritten history stream and restores the under-lock snapshot on failure.
 */
export async function writeHistoryRawWithRollback(params: {
  historyPath: string;
  nextHistoryRaw: string;
  historyRawUnderLock: string | null;
  writeHistoryRaw?: HistoryRawWriter;
}): Promise<void> {
  const writeHistoryRaw = params.writeHistoryRaw ?? writeFileAtomic;
  try {
    await writeHistoryRaw(params.historyPath, params.nextHistoryRaw);
  } catch (error) {
    try {
      if (params.historyRawUnderLock === null) {
        await fs.rm(params.historyPath, { force: true });
      } else {
        await writeHistoryRaw(params.historyPath, params.historyRawUnderLock);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `History rewrite failed and rollback also failed: ${String(error)}`,
      );
    }
    throw error;
  }
}

/**
 * Shared lock/verify/ownership orchestration for history-rewrite commands.
 * Callers provide the operation-specific write/rollback logic and optional
 * post-write hook execution while this helper enforces the common governance +
 * lock sequencing contract.
 */
export async function executeHistoryRewrite(params: ExecuteHistoryRewriteParams): Promise<string[]> {
  const warnings = [...checkHistoryRewriteOwnership({
    itemDocument: params.itemDocument,
    subjectId: params.subject.id,
    author: params.author,
    force: params.force,
    settings: params.settings,
  })];
  const releaseLock = await acquireLock(
    params.pmRoot,
    params.subject.id,
    params.settings.locks.ttl_seconds,
    params.author,
    Boolean(params.force),
    params.settings.governance.force_required_for_stale_lock,
    params.settings.locks.wait_ms,
  );
  try {
    const verified = await verifyHistoryRewriteNoDrift({
      pmRoot: params.pmRoot,
      subject: params.subject,
      settings: params.settings,
      typeRegistry: params.typeRegistry,
      historyRawBeforeLock: params.historyRawBeforeLock,
      currentItemRawBeforeLock: params.currentItemRawBeforeLock,
      operation: params.operation,
    });
    await params.applyRewrite(verified);
    if (params.applyPostRewrite) {
      warnings.push(...(await params.applyPostRewrite(verified)));
    }
    return warnings;
  } finally {
    await releaseLock();
  }
}
