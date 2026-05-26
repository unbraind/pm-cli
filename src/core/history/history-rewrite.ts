import { readFileIfExists } from "../fs/fs-utils.js";
import type { ItemTypeRegistry } from "../item/type-registry.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { locateItem, readLocatedItem } from "../store/item-store.js";
import { resolveGovernanceKnobs } from "../store/settings.js";
import type { ItemDocument, PmSettings } from "../../types/index.js";

type LoadedItem = Awaited<ReturnType<typeof readLocatedItem>>;

export interface HistoryRewriteSubject {
  id: string;
  historyPath: string;
}

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
  const assigned = params.itemDocument.metadata.assignee?.trim();
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
