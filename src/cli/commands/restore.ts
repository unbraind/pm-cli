/**
 * @module cli/commands/restore
 *
 * Implements the pm restore command surface and its agent-facing runtime behavior.
 */
import jsonPatch from "fast-json-patch";
import fs from "node:fs/promises";
import {
  pathExists,
  readFileIfExists,
  writeFileAtomic,
} from "../../core/fs/fs-utils.js";
import {
  appendHistoryEntry,
  createHistoryEntry,
} from "../../core/history/history.js";
import {
  replayToCanonicalItemDocument,
  replayToItemDocument,
  toReplayDocument,
} from "../../core/history/replay.js";
import {
  applyHistoryPatch,
  ensureMaterializedHistoryTarget as ensureMaterializedRestoreTarget,
  extractPatchFailureContext,
  readHistoryEntries,
  replayHistoryToTarget as replayToTarget,
  resolveHistoryTarget,
} from "../../sdk/history-read.js";
import { enforceHistoryStreamPolicyForItem } from "../../core/history/history-stream-policy.js";
import { normalizeItemId, normalizeRawItemId } from "../../core/item/id.js";
import {
  canonicalDocument,
  serializeItemDocument,
} from "../../core/item/item-format.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { acquireLock } from "../../core/lock/lock.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import {
  getActiveExtensionRegistrations,
  projectAfterCommandItemSnapshot,
  recordAfterCommandAffectedItem,
  runActiveOnWriteHooks,
} from "../../core/extensions/index.js";
import { locateItem, readLocatedItem } from "../../core/store/item-store.js";
import {
  acquireItemMetadataDerivedIndexLock,
  refreshItemMetadataDerivedIndex,
} from "../../sdk/item-metadata-index.js";
import {
  getHistoryPath,
  getItemPath,
  getSettingsPath,
  resolvePmRoot,
} from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { resolveAuthor } from "../../core/shared/author.js";
import type {
  HistoryEntry,
  HistoryPatchOp,
  ItemDocument,
  ItemMetadata,
} from "../../types/index.js";

interface ResolvedRestoreSubject {
  id: string;
  historyPath: string;
  located: Awaited<ReturnType<typeof locateItem>>;
  historyPolicyWarnings: string[];
}

interface RestoreCurrentState {
  document: ItemDocument;
  originalRaw: string | null;
}

/** Documents the restore command options payload exchanged by command, SDK, and package integrations. */
export interface RestoreCommandOptions {
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the restore result payload exchanged by command, SDK, and package integrations. */
export interface RestoreResult {
  /** Value that configures or reports item for this contract. */
  item: ItemMetadata;
  /** Value that configures or reports restored from for this contract. */
  restored_from: {
    kind: "version" | "timestamp";
    target: string;
    history_index: number;
    entry_ts: string;
    entry_op: string;
  };
  /** Value that configures or reports changed fields for this contract. */
  changed_fields: string[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
}

/** Resolve restore targets with the command's established wording and at-or-before timestamp semantics. */
function ensureReplayTarget(target: string, history: readonly HistoryEntry[]) {
  return resolveHistoryTarget(target, history, {
    errorSubject: "restore",
    allowFutureTimestamp: true,
  });
}

function replayCurrentDocument(history: HistoryEntry[]): ItemDocument {
  const currentReplay = replayToTarget(history, history.length - 1);
  if (Object.keys(currentReplay.metadata).length === 0) {
    return {
      metadata: {} as ItemMetadata,
      body: currentReplay.body,
    };
  }
  return canonicalDocument(replayToItemDocument(currentReplay));
}

async function resolveRestoreSubject(
  pmRoot: string,
  id: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  typeToFolder: Record<string, string>,
): Promise<ResolvedRestoreSubject> {
  const located = await locateItem(
    pmRoot,
    id,
    settings.id_prefix,
    settings.item_format,
    typeToFolder,
  );
  if (located) {
    const historyPath = getHistoryPath(pmRoot, located.id);
    const historyPolicy = await enforceHistoryStreamPolicyForItem({
      pmRoot,
      settings,
      itemId: located.id,
      commandLabel: "restore",
    });
    return {
      id: located.id,
      historyPath,
      located,
      historyPolicyWarnings: historyPolicy.warnings,
    };
  }

  const normalizedId = normalizeItemId(id, settings.id_prefix);
  const rawNormalizedId = normalizeRawItemId(id);
  /* c8 ignore start -- raw-id fallback is covered by normalize-item-id utility tests. */
  const candidateIds =
    normalizedId === rawNormalizedId
      ? [normalizedId]
      : [normalizedId, rawNormalizedId];
  /* c8 ignore stop */
  for (const candidateId of candidateIds) {
    const historyPath = getHistoryPath(pmRoot, candidateId);
    if (await pathExists(historyPath)) {
      return {
        id: candidateId,
        historyPath,
        located: null,
        historyPolicyWarnings: [],
      };
    }
  }

  throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
}

function changedFields(
  beforeDocument: ItemDocument,
  afterDocument: ItemDocument,
): string[] {
  const beforeReplay = toReplayDocument(beforeDocument);
  const afterReplay = toReplayDocument(afterDocument);
  const patch = jsonPatch.compare(
    beforeReplay,
    afterReplay,
  ) as HistoryPatchOp[];
  const fields = new Set<string>();

  for (const op of patch) {
    if (op.path === "/body" || op.path.startsWith("/body/")) {
      fields.add("body");
      continue;
    }
    const segment = op.path
      .replace(/^\/(?:metadata|front_matter)\/?/, "")
      .split("/")[0];
    fields.add(segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  }

  return Array.from(fields).sort((a, b) => a.localeCompare(b));
}

async function loadRestoreStateUnderLock(params: {
  pmRoot: string;
  resolvedId: string;
  subject: ResolvedRestoreSubject;
  settings: Awaited<ReturnType<typeof readSettings>>;
  typeToFolder: Record<string, string>;
  historyRawBeforeLock: string | null;
  currentItemRawBeforeLock: string | null;
}): Promise<{
  loadedItemUnderLock: Awaited<ReturnType<typeof readLocatedItem>> | null;
  existingItemPath: string | null;
}> {
  const historyRawUnderLock = await readFileIfExists(
    params.subject.historyPath,
  );
  if (historyRawUnderLock !== params.historyRawBeforeLock) {
    throw new PmCliError(
      `History for ${params.resolvedId} changed while waiting for lock; retry restore.`,
      EXIT_CODE.CONFLICT,
    );
  }
  const locatedUnderLock = await locateItem(
    params.pmRoot,
    params.resolvedId,
    params.settings.id_prefix,
    params.settings.item_format,
    params.typeToFolder,
  );
  const loadedItemUnderLock = locatedUnderLock
    ? await readLocatedItem(locatedUnderLock, {
        schema: params.settings.schema,
      })
    : null;
  if ((loadedItemUnderLock?.raw ?? null) !== params.currentItemRawBeforeLock) {
    throw new PmCliError(
      `Item ${params.resolvedId} changed while waiting for lock; retry restore.`,
      EXIT_CODE.CONFLICT,
    );
  }
  return {
    loadedItemUnderLock,
    existingItemPath: locatedUnderLock?.itemPath ?? null,
  };
}

function resolveRestoreCurrentState(
  loadedItemUnderLock: Awaited<ReturnType<typeof readLocatedItem>> | null,
  history: HistoryEntry[],
): RestoreCurrentState {
  if (loadedItemUnderLock) {
    return {
      document: loadedItemUnderLock.document,
      originalRaw: loadedItemUnderLock.raw,
    };
  }
  return { document: replayCurrentDocument(history), originalRaw: null };
}

function collectRestoreOwnershipWarnings(params: {
  document: ItemDocument;
  author: string;
  force: boolean | undefined;
  enforcement: "strict" | "warn" | "none";
  resolvedId: string;
}): string[] {
  const assigned = params.document.metadata.assignee?.trim();
  const hasOwnershipConflict =
    assigned && assigned !== params.author && !params.force;
  if (!hasOwnershipConflict) {
    return [];
  }
  if (params.enforcement === "strict") {
    throw new PmCliError(
      `Item ${params.resolvedId} is assigned to ${assigned}. Use --force to override.`,
      EXIT_CODE.CONFLICT,
    );
  }
  return params.enforcement === "warn"
    ? [`ownership_warning:assignee_conflict:${params.resolvedId}:${assigned}`]
    : [];
}

async function restorePreviousItemAfterHistoryFailure(params: {
  existingItemPath: string | null;
  resolvedOriginalRaw: string | null;
  restoredItemPath: string;
}): Promise<void> {
  if (
    params.existingItemPath &&
    params.resolvedOriginalRaw !== null &&
    params.restoredItemPath !== params.existingItemPath
  ) {
    await writeFileAtomic(params.existingItemPath, params.resolvedOriginalRaw);
    await fs.rm(params.restoredItemPath, { force: true });
    return;
  }
  if (params.existingItemPath && params.resolvedOriginalRaw !== null) {
    await writeFileAtomic(params.existingItemPath, params.resolvedOriginalRaw);
    return;
  }
  await fs.rm(params.restoredItemPath, { force: true });
}

async function runRestoreWriteHooks(params: {
  restoredItemPath: string;
  historyPath: string;
  before: ItemDocument;
  after: ItemDocument;
}): Promise<string[]> {
  return [
    ...(await runActiveOnWriteHooks({
      path: params.restoredItemPath,
      scope: "project",
      op: "restore",
      item_id: params.after.metadata.id,
      item_type: params.after.metadata.type,
      before: params.before,
      after: params.after,
      changed_fields: ["restored"],
    })),
    ...(await runActiveOnWriteHooks({
      path: params.historyPath,
      scope: "project",
      op: "restore:history",
      item_id: params.after.metadata.id,
      item_type: params.after.metadata.type,
      before: params.before,
      after: params.after,
      changed_fields: ["restored"],
    })),
  ];
}

/** Implements run restore for the public runtime surface of this module. */
export async function runRestore(
  id: string,
  target: string,
  options: RestoreCommandOptions,
  global: GlobalOptions,
): Promise<RestoreResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const subject = await resolveRestoreSubject(
    pmRoot,
    id,
    settings,
    typeRegistry.type_to_folder,
  );
  const resolvedId = subject.id;
  const historyRawBeforeLock = await readFileIfExists(subject.historyPath);
  const history = await readHistoryEntries(subject.historyPath, resolvedId);
  if (history.length === 0) {
    throw new PmCliError(
      `No history exists for ${resolvedId}; restore is unavailable.`,
      EXIT_CODE.NOT_FOUND,
    );
  }

  const resolvedTarget = ensureReplayTarget(target, history);
  const replayDocument = ensureMaterializedRestoreTarget(
    replayToTarget(history, resolvedTarget.historyIndex),
    resolvedTarget,
  );
  const restoredDocument = replayToCanonicalItemDocument(replayDocument, {
    schema: settings.schema,
  });

  if (restoredDocument.metadata.id !== resolvedId) {
    throw new PmCliError(
      `Restore target resolved to item ${restoredDocument.metadata.id}, expected ${resolvedId}.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  const loadedItemBeforeLock = subject.located
    ? await readLocatedItem(subject.located, { schema: settings.schema })
    : null;
  const currentItemRawBeforeLock = loadedItemBeforeLock?.raw ?? null;

  const author = resolveAuthor(options.author, settings.author_default);
  const releaseLock = await acquireLock(
    pmRoot,
    resolvedId,
    settings.locks.ttl_seconds,
    author,
    Boolean(options.force),
    settings.governance.force_required_for_stale_lock,
    settings.locks.wait_ms,
  );

  try {
    const { loadedItemUnderLock, existingItemPath } =
      await loadRestoreStateUnderLock({
        pmRoot,
        resolvedId,
        subject,
        settings,
        typeToFolder: typeRegistry.type_to_folder,
        historyRawBeforeLock,
        currentItemRawBeforeLock,
      });
    const itemFormat = "toon";
    const currentState = resolveRestoreCurrentState(
      loadedItemUnderLock,
      history,
    );
    const ownershipWarnings = collectRestoreOwnershipWarnings({
      document: currentState.document,
      author,
      force: options.force,
      enforcement: settings.governance.ownership_enforcement,
      resolvedId,
    });

    const serializedRestore = serializeItemDocument(restoredDocument, {
      format: itemFormat,
      schema: settings.schema,
    });
    /* c8 ignore next -- restored item path typing is exercised in restore integration workflows. */
    const restoredItemPath = getItemPath(
      pmRoot,
      restoredDocument.metadata.type,
      resolvedId,
      itemFormat,
      typeRegistry.type_to_folder,
    );
    const releaseDerivedIndexLock = await acquireItemMetadataDerivedIndexLock(
      pmRoot,
      author,
    );
    let derivedIndexWarnings: string[] = [];
    try {
      await writeFileAtomic(restoredItemPath, serializedRestore);
      if (existingItemPath && restoredItemPath !== existingItemPath) {
        await fs.rm(existingItemPath);
      }

      const historyEntry = createHistoryEntry({
        nowIso: nowIso(),
        author,
        op: "restore",
        before: currentState.document,
        after: restoredDocument,
        message: options.message,
      });
      try {
        await appendHistoryEntry(subject.historyPath, historyEntry);
      } catch (error: unknown) {
        await restorePreviousItemAfterHistoryFailure({
          existingItemPath,
          resolvedOriginalRaw: currentState.originalRaw,
          restoredItemPath,
        });
        throw error;
      }
      derivedIndexWarnings = await refreshItemMetadataDerivedIndex({
        pmRoot,
        preferredFormat: settings.item_format,
        typeToFolder: typeRegistry.type_to_folder,
        schema: settings.schema,
        itemPath: restoredItemPath,
        previousItemPath: existingItemPath ?? undefined,
        document: restoredDocument,
      });
    } finally {
      await releaseDerivedIndexLock();
    }
    const restoreChangedFields = changedFields(
      currentState.document,
      restoredDocument,
    );
    const hookWarnings = await runRestoreWriteHooks({
      restoredItemPath,
      historyPath: subject.historyPath,
      before: currentState.document,
      after: restoredDocument,
    });
    recordAfterCommandAffectedItem({
      id: restoredDocument.metadata.id,
      op: "restore",
      item_type: restoredDocument.metadata.type,
      previous_status: currentState.document.metadata.status,
      status: restoredDocument.metadata.status,
      previous: projectAfterCommandItemSnapshot(
        currentState.document.metadata,
        restoreChangedFields,
      ),
      current: projectAfterCommandItemSnapshot(
        restoredDocument.metadata,
        restoreChangedFields,
      ),
      changed_fields: restoreChangedFields,
    });

    const targetEntry = history[resolvedTarget.historyIndex];
    return {
      item: restoredDocument.metadata,
      restored_from: {
        kind: resolvedTarget.kind,
        target: resolvedTarget.raw,
        history_index: resolvedTarget.historyIndex + 1,
        entry_ts: targetEntry.ts,
        entry_op: targetEntry.op,
      },
      changed_fields: restoreChangedFields,
      warnings: [
        ...subject.historyPolicyWarnings,
        ...ownershipWarnings,
        ...derivedIndexWarnings,
        ...hookWarnings,
      ],
    };
  } finally {
    await releaseLock();
  }
}

/** Public contract for test only restore command, shared by SDK and presentation-layer consumers. */
export const _testOnlyRestoreCommand = {
  applyHistoryPatch,
  changedFields,
  ensureMaterializedRestoreTarget,
  ensureReplayTarget,
  extractPatchFailureContext,
  replayCurrentDocument,
  replayToTarget,
  resolveRestoreSubject,
};
