import jsonPatch from "fast-json-patch";
import fs from "node:fs/promises";
import { pathExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { appendHistoryEntry, createHistoryEntry } from "../../core/history/history.js";
import {
  EMPTY_REPLAY_DOCUMENT,
  normalizeReplayPatchOps,
  replayHash,
  toReplayDocument,
  type ReplayDocument as CanonicalReplayDocument,
} from "../../core/history/replay.js";
import { enforceHistoryStreamPolicyForItem } from "../../core/history/history-stream-policy.js";
import { normalizeItemId, normalizeRawItemId } from "../../core/item/id.js";
import { canonicalDocument, serializeItemDocument } from "../../core/item/item-format.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { acquireLock } from "../../core/lock/lock.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { getActiveExtensionRegistrations, runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { locateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getHistoryPath, getItemPath, getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { HistoryEntry, HistoryPatchOp, ItemDocument, ItemMetadata } from "../../types/index.js";
import { readHistoryEntries } from "./history.js";

interface ResolvedRestoreTarget {
  kind: "version" | "timestamp";
  raw: string;
  historyIndex: number;
}

interface ResolvedRestoreSubject {
  id: string;
  historyPath: string;
  located: Awaited<ReturnType<typeof locateItem>>;
  historyPolicyWarnings: string[];
}

export interface RestoreCommandOptions {
  author?: string;
  message?: string;
  force?: boolean;
}

export interface RestoreResult {
  item: ItemMetadata;
  restored_from: {
    kind: "version" | "timestamp";
    target: string;
    history_index: number;
    entry_ts: string;
    entry_op: string;
  };
  changed_fields: string[];
  warnings: string[];
}

function toAuthor(candidate: string | undefined, defaultAuthor: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? defaultAuthor;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

function ensureReplayTarget(target: string, history: HistoryEntry[]): ResolvedRestoreTarget {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new PmCliError("Missing restore target. Use a timestamp or version number.", EXIT_CODE.USAGE);
  }

  if (/^\d+$/.test(trimmed)) {
    const version = Number(trimmed);
    if (!Number.isSafeInteger(version) || version < 1 || version > history.length) {
      throw new PmCliError(
        `Restore version must be between 1 and ${history.length} for this item.`,
        EXIT_CODE.USAGE,
      );
    }
    return {
      kind: "version",
      raw: trimmed,
      historyIndex: version - 1,
    };
  }

  const parsedTarget = Date.parse(trimmed);
  if (!Number.isFinite(parsedTarget)) {
    throw new PmCliError(
      `Invalid restore target "${target}". Use a positive version number or ISO timestamp.`,
      EXIT_CODE.USAGE,
    );
  }

  let index = -1;
  for (let i = 0; i < history.length; i += 1) {
    const entryTimestamp = Date.parse(history[i].ts);
    if (!Number.isFinite(entryTimestamp)) {
      throw new PmCliError(
        `History for this item contains invalid timestamp at entry ${i + 1}.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    if (entryTimestamp <= parsedTarget) {
      index = i;
    }
  }

  if (index < 0) {
    throw new PmCliError(`No history entries exist at or before timestamp ${trimmed}.`, EXIT_CODE.USAGE);
  }

  return {
    kind: "timestamp",
    raw: trimmed,
    historyIndex: index,
  };
}

function extractPatchFailureContext(
  patch: HistoryPatchOp[],
  error: unknown,
): { patchIndex?: number; op?: string; path?: string; from?: string; reason?: string } {
  const context: { patchIndex?: number; op?: string; path?: string; from?: string; reason?: string } = {};
  if (error instanceof Error && error.message.trim().length > 0) {
    context.reason = error.message.trim();
  }
  if (typeof error !== "object" || error === null) {
    return context;
  }
  const candidate = error as {
    index?: unknown;
    operation?: unknown;
  };
  if (typeof candidate.index === "number" && Number.isInteger(candidate.index) && candidate.index >= 0) {
    context.patchIndex = candidate.index;
  }
  const operationRecord =
    typeof candidate.operation === "object" && candidate.operation !== null
      ? (candidate.operation as { op?: unknown; path?: unknown; from?: unknown })
      : null;
  if (operationRecord && typeof operationRecord.op === "string") {
    context.op = operationRecord.op;
  }
  if (operationRecord && typeof operationRecord.path === "string") {
    context.path = operationRecord.path;
  }
  if (operationRecord && typeof operationRecord.from === "string") {
    context.from = operationRecord.from;
  }
  if ((context.op === undefined || context.path === undefined) && context.patchIndex !== undefined) {
    const fallback = patch[context.patchIndex];
    if (fallback) {
      context.op = context.op ?? fallback.op;
      context.path = context.path ?? fallback.path;
      context.from = context.from ?? fallback.from;
    }
  }
  return context;
}

function applyHistoryPatch(
  current: CanonicalReplayDocument,
  patch: HistoryPatchOp[],
  entryNumber: number,
  entryOp: string,
): CanonicalReplayDocument {
  try {
    const normalizedPatch = normalizeReplayPatchOps(patch);
    const applied = jsonPatch.applyPatch(
      structuredClone(current),
      normalizedPatch as jsonPatch.Operation[],
      true,
      false,
    ).newDocument as unknown;
    if (
      typeof applied !== "object" ||
      applied === null ||
      !("metadata" in applied) ||
      !("body" in applied) ||
      typeof (applied as { body: unknown }).body !== "string" ||
      typeof (applied as { metadata: unknown }).metadata !== "object" ||
      (applied as { metadata: unknown }).metadata === null
    ) {
      throw new PmCliError(
        `History replay produced an invalid document shape at entry ${entryNumber}.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    const replay = applied as { metadata: Record<string, unknown>; body: string };
    return {
      metadata: replay.metadata,
      body: replay.body,
    };
  } catch (error: unknown) {
    if (error instanceof PmCliError) {
      throw error;
    }
    const failureContext = extractPatchFailureContext(patch, error);
    const contextTokens = [
      `history_op=${entryOp}`,
      failureContext.patchIndex !== undefined ? `patch_index=${failureContext.patchIndex}` : null,
      failureContext.op ? `op=${failureContext.op}` : null,
      failureContext.path ? `path=${failureContext.path}` : null,
      failureContext.from ? `from=${failureContext.from}` : null,
    ].filter((token): token is string => token !== null);
    const reasonSuffix = failureContext.reason ? ` ${failureContext.reason}` : "";
    throw new PmCliError(
      `Failed to apply history patch at entry ${entryNumber} (${contextTokens.join(", ")}).${reasonSuffix}`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
}

function replayToTarget(history: HistoryEntry[], targetIndex: number): CanonicalReplayDocument {
  let document: CanonicalReplayDocument = structuredClone(EMPTY_REPLAY_DOCUMENT);

  for (let i = 0; i <= targetIndex; i += 1) {
    const entry = history[i];
    const beforeHash = replayHash(document);
    if (beforeHash !== entry.before_hash) {
      throw new PmCliError(
        `History hash mismatch before replay at entry ${i + 1}.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }

    document = applyHistoryPatch(document, entry.patch, i + 1, entry.op);

    const afterHash = replayHash(document);
    if (afterHash !== entry.after_hash) {
      throw new PmCliError(
        `History hash mismatch after replay at entry ${i + 1}.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
  }

  return document;
}

function ensureMaterializedRestoreTarget(
  replayDocument: CanonicalReplayDocument,
  target: ResolvedRestoreTarget,
): CanonicalReplayDocument {
  if (Object.keys(replayDocument.metadata).length > 0) {
    return replayDocument;
  }
  throw new PmCliError(
    `Restore target ${target.raw} resolves to a deleted state; choose a version or timestamp where the item exists.`,
    EXIT_CODE.USAGE,
  );
}

function replayCurrentDocument(history: HistoryEntry[]): ItemDocument {
  const currentReplay = replayToTarget(history, history.length - 1);
  if (Object.keys(currentReplay.metadata).length === 0) {
    return {
      metadata: {} as ItemMetadata,
      body: currentReplay.body,
    };
  }
  return canonicalDocument({
    metadata: currentReplay.metadata as unknown as ItemMetadata,
    body: currentReplay.body,
  });
}

async function resolveRestoreSubject(
  pmRoot: string,
  id: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  typeToFolder: Record<string, string>,
): Promise<ResolvedRestoreSubject> {
  const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeToFolder);
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
  const candidateIds = normalizedId === rawNormalizedId ? [normalizedId] : [normalizedId, rawNormalizedId];
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

function changedFields(beforeDocument: ItemDocument, afterDocument: ItemDocument): string[] {
  const beforeReplay = toReplayDocument(beforeDocument);
  const afterReplay = toReplayDocument(afterDocument);
  const patch = jsonPatch.compare(beforeReplay, afterReplay) as HistoryPatchOp[];
  const fields = new Set<string>();

  for (const op of patch) {
    if (op.path === "/body" || op.path.startsWith("/body/")) {
      fields.add("body");
      continue;
    }
    const segment = op.path.replace(/^\/(?:metadata|front_matter)\/?/, "").split("/")[0];
    fields.add(segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  }

  return Array.from(fields).sort((a, b) => a.localeCompare(b));
}

export async function runRestore(
  id: string,
  target: string,
  options: RestoreCommandOptions,
  global: GlobalOptions,
): Promise<RestoreResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const subject = await resolveRestoreSubject(pmRoot, id, settings, typeRegistry.type_to_folder);
  const resolvedId = subject.id;
  const history = await readHistoryEntries(subject.historyPath, resolvedId);
  if (history.length === 0) {
    throw new PmCliError(`No history exists for ${resolvedId}; restore is unavailable.`, EXIT_CODE.NOT_FOUND);
  }

  const resolvedTarget = ensureReplayTarget(target, history);
  const replayDocument = ensureMaterializedRestoreTarget(replayToTarget(history, resolvedTarget.historyIndex), resolvedTarget);
  const restoredDocument = canonicalDocument(
    {
      metadata: replayDocument.metadata as unknown as ItemMetadata,
      body: replayDocument.body,
    },
    { schema: settings.schema },
  );

  if (restoredDocument.metadata.id !== resolvedId) {
    throw new PmCliError(
      `Restore target resolved to item ${restoredDocument.metadata.id}, expected ${resolvedId}.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }

  const author = toAuthor(options.author, settings.author_default);
  const releaseLock = await acquireLock(
    pmRoot,
    resolvedId,
    settings.locks.ttl_seconds,
    author,
    Boolean(options.force),
    settings.governance.force_required_for_stale_lock,
  );

  try {
    const existingItemPath = subject.located?.itemPath ?? null;
    const itemFormat = "toon";
    let resolvedCurrentDocument: ItemDocument;
    let resolvedOriginalRaw: string | null = null;
    if (subject.located) {
      const loaded = await readLocatedItem(subject.located, { schema: settings.schema });
      resolvedCurrentDocument = loaded.document;
      resolvedOriginalRaw = loaded.raw;
    } else {
      resolvedCurrentDocument = replayCurrentDocument(history);
    }
    const assigned = resolvedCurrentDocument.metadata.assignee?.trim();
    const ownershipWarnings: string[] = [];
    const hasOwnershipConflict = assigned && assigned !== author && !options.force;
    if (hasOwnershipConflict) {
      if (settings.governance.ownership_enforcement === "strict") {
        throw new PmCliError(
          `Item ${resolvedId} is assigned to ${assigned}. Use --force to override.`,
          EXIT_CODE.CONFLICT,
        );
      }
      if (settings.governance.ownership_enforcement === "warn") {
        ownershipWarnings.push(`ownership_warning:assignee_conflict:${resolvedId}:${assigned}`);
      }
    }

    const serializedRestore = serializeItemDocument(restoredDocument, { format: itemFormat, schema: settings.schema });
    const restoredItemPath = getItemPath(
      pmRoot,
      restoredDocument.metadata.type,
      resolvedId,
      itemFormat,
      typeRegistry.type_to_folder,
    );
    await writeFileAtomic(restoredItemPath, serializedRestore);
    if (existingItemPath && restoredItemPath !== existingItemPath) {
      await fs.rm(existingItemPath);
    }

    const historyEntry = createHistoryEntry({
      nowIso: nowIso(),
      author,
      op: "restore",
      before: resolvedCurrentDocument,
      after: restoredDocument,
      message: options.message,
    });

    try {
      await appendHistoryEntry(subject.historyPath, historyEntry);
    } catch (error: unknown) {
      if (existingItemPath && resolvedOriginalRaw !== null && restoredItemPath !== existingItemPath) {
        await writeFileAtomic(existingItemPath, resolvedOriginalRaw);
        await fs.rm(restoredItemPath, { force: true });
      } else if (existingItemPath && resolvedOriginalRaw !== null) {
        await writeFileAtomic(existingItemPath, resolvedOriginalRaw);
      } else {
        await fs.rm(restoredItemPath, { force: true });
      }
      throw error;
    }
    const hookWarnings = [
      ...(await runActiveOnWriteHooks({
        path: restoredItemPath,
        scope: "project",
        op: "restore",
      })),
      ...(await runActiveOnWriteHooks({
        path: subject.historyPath,
        scope: "project",
        op: "restore:history",
      })),
    ];

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
      changed_fields: changedFields(resolvedCurrentDocument, restoredDocument),
      warnings: [...subject.historyPolicyWarnings, ...ownershipWarnings, ...hookWarnings],
    };
  } finally {
    await releaseLock();
  }
}
