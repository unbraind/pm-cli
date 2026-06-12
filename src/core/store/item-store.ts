import fs from "node:fs/promises";
import path from "node:path";
import {
  getActiveExtensionRegistrations,
  projectAfterCommandItemSnapshot,
  recordAfterCommandAffectedItem,
  runActiveOnReadHooks,
  runActiveOnWriteHooks,
  runActiveServiceOverride,
} from "../extensions/index.js";
import { collectRegisteredItemFieldNames } from "../extensions/item-fields.js";
import { EMPTY_CANONICAL_DOCUMENT, EXIT_CODE, TYPE_TO_FOLDER } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { levenshteinDistanceWithinLimit } from "../shared/levenshtein.js";
import { appendHistoryEntry, createHistoryEntry } from "../history/history.js";
import { enforceHistoryStreamPolicyForItem } from "../history/history-stream-policy.js";
import { canonicalDocument, parseItemDocument, serializeItemDocument } from "../item/item-format.js";
import { resolveItemTypeRegistry } from "../item/type-registry.js";
import { acquireLock } from "../lock/lock.js";
import { writeFileAtomic } from "../fs/fs-utils.js";
import { normalizeItemId, normalizeRawItemId } from "../item/id.js";
import { listAllDocumentCandidatesCached, listAllDocumentsCached, listAllDocumentsCachedLight } from "./front-matter-cache.js";
import { getHistoryPath, getItemFormatFromPath, getItemPath, ITEM_FILE_EXTENSIONS } from "./paths.js";
import { resolveGovernanceKnobs } from "./settings.js";
import { nowIso } from "../shared/time.js";
import type { ItemDocument, ItemFormat, ItemFrontMatter, ItemType, PmSettings, RuntimeSchemaSettings } from "../../types/index.js";

export interface LocatedItem {
  id: string;
  type: ItemType;
  itemPath: string;
  item_format: ItemFormat;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}

function appendWarning(warnings: string[] | undefined, warning: string): void {
  if (!warnings) {
    return;
  }
  if (!warnings.includes(warning)) {
    warnings.push(warning);
  }
}

function resolveActiveExtensionFieldNames(explicit: readonly string[] | undefined): readonly string[] {
  return explicit ?? collectRegisteredItemFieldNames(getActiveExtensionRegistrations());
}

function resolveItemFormatSearchOrder(preferredFormat?: ItemFormat): ItemFormat[] {
  if (preferredFormat === "toon") {
    return ["toon", "json_markdown"];
  }
  if (preferredFormat === "json_markdown") {
    return ["json_markdown", "toon"];
  }
  return ["toon", "json_markdown"];
}

export async function locateItem(
  pmRoot: string,
  rawId: string,
  idPrefix = "pm-",
  preferredFormat?: ItemFormat,
  typeToFolder: Record<string, string> = TYPE_TO_FOLDER,
): Promise<LocatedItem | null> {
  const normalizedId = normalizeItemId(rawId, idPrefix);
  const rawNormalizedId = normalizeRawItemId(rawId);
  const candidateIds = normalizedId === rawNormalizedId ? [normalizedId] : [normalizedId, rawNormalizedId];
  const entries = Object.entries(typeToFolder) as Array<[ItemType, string]>;
  const searchOrder = resolveItemFormatSearchOrder(preferredFormat);
  for (const candidateId of candidateIds) {
    for (const [type] of entries) {
      for (const itemFormat of searchOrder) {
        const itemPath = getItemPath(pmRoot, type, candidateId, itemFormat, typeToFolder);
        if (await fileExists(itemPath)) {
          return {
            id: candidateId,
            type,
            itemPath,
            item_format: itemFormat,
          };
        }
      }
    }
  }
  return null;
}

export async function readLocatedItem(
  item: LocatedItem,
  options: { schema?: RuntimeSchemaSettings; extensionFieldNames?: readonly string[]; warnings?: string[] } = {},
): Promise<{ raw: string; document: ItemDocument }> {
  const raw = await fs.readFile(item.itemPath, "utf8");
  await runActiveOnReadHooks({
    path: item.itemPath,
    scope: "project",
  });
  const document = parseItemDocument(raw, {
    format: item.item_format,
    schema: options.schema,
    extensionFieldNames: resolveActiveExtensionFieldNames(options.extensionFieldNames),
    onWarning: (warning) => appendWarning(options.warnings, warning),
  });
  return { raw, document };
}

export async function listAllFrontMatter(
  pmRoot: string,
  preferredFormat?: ItemFormat,
  typeToFolder: Record<string, string> = TYPE_TO_FOLDER,
  warnings?: string[],
  schema?: RuntimeSchemaSettings,
): Promise<ItemFrontMatter[]> {
  const documents = await listAllDocumentsCached(pmRoot, preferredFormat, typeToFolder, warnings, schema);
  return documents.map((document) => document.metadata);
}

/**
 * Light variant of {@link listAllFrontMatter}: returns front-matter WITHOUT the heavy
 * collection fields (comments/notes/learnings/files/tests/test_runs/docs). Skips the
 * large collections cache so the hot list path stays cheap. Only use for callers that
 * read just the light scalar/small fields — see {@link listAllDocumentsCachedLight}.
 */
export async function listAllFrontMatterLight(
  pmRoot: string,
  preferredFormat?: ItemFormat,
  typeToFolder: Record<string, string> = TYPE_TO_FOLDER,
  warnings?: string[],
  schema?: RuntimeSchemaSettings,
): Promise<ItemFrontMatter[]> {
  const documents = await listAllDocumentsCachedLight(pmRoot, preferredFormat, typeToFolder, warnings, schema);
  return documents.map((document) => document.metadata);
}

export async function listAllFrontMatterWithBody(
  pmRoot: string,
  preferredFormat?: ItemFormat,
  typeToFolder: Record<string, string> = TYPE_TO_FOLDER,
  warnings?: string[],
  schema?: RuntimeSchemaSettings,
): Promise<Array<ItemFrontMatter & { body: string }>> {
  const candidates = await listAllDocumentCandidatesCached(
    pmRoot,
    preferredFormat,
    typeToFolder,
    warnings,
    schema,
    { includeBody: true },
  );
  return candidates.map((candidate) => ({
    ...candidate.metadata,
    body: candidate.body ?? "",
  }));
}

async function listKnownItemIds(
  pmRoot: string,
  typeToFolder: Record<string, string>,
): Promise<string[]> {
  const folders = new Set(Object.values(typeToFolder));
  const allIds: string[] = [];
  await Promise.all(
    [...folders].map(async (folder) => {
      try {
        const entries = await fs.readdir(path.join(pmRoot, folder));
        for (const entry of entries) {
          for (const ext of ITEM_FILE_EXTENSIONS) {
            if (entry.toLowerCase().endsWith(ext)) {
              allIds.push(entry.slice(0, -ext.length));
              break;
            }
          }
        }
      } catch {
        // ignore missing folders
      }
    }),
  );
  return allIds;
}

async function buildDidYouMeanSuggestions(
  pmRoot: string,
  badId: string,
  idPrefix: string,
  typeToFolder: Record<string, string>,
): Promise<string[]> {
  const normalized = normalizeItemId(badId, idPrefix);
  const ids = await listKnownItemIds(pmRoot, typeToFolder);
  if (ids.length === 0) return [];
  const limit = Math.max(3, Math.floor(normalized.length / 2));
  const scored = ids
    .map((id) => ({ id, distance: levenshteinDistanceWithinLimit(id, normalized, limit) }))
    .filter((entry): entry is { id: string; distance: number } => entry.distance !== null)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 3)
    .map((entry) => entry.id);
  return scored;
}

export async function buildItemNotFoundError(
  pmRoot: string,
  badId: string,
  idPrefix: string,
  typeToFolder: Record<string, string>,
): Promise<PmCliError> {
  const suggestions = await buildDidYouMeanSuggestions(pmRoot, badId, idPrefix, typeToFolder);
  const nextSteps: string[] = ["Confirm the active --path/PM_PATH scope, then retry with a valid id."];
  if (suggestions.length > 0) {
    nextSteps.unshift(`Did you mean one of: ${suggestions.join(", ")}?`);
  }
  return new PmCliError(`Item ${badId} not found`, EXIT_CODE.NOT_FOUND, { nextSteps });
}

function bypassesAssigneeConflict(
  op: string,
  bypassAssigneeConflict?: boolean,
): boolean {
  return (
    op === "claim" ||
    (bypassAssigneeConflict === true &&
      (op === "comment_add" ||
        op === "note_add" ||
        op === "learning_add" ||
        op === "release" ||
        op === "update" ||
        op === "update_audit"))
  );
}

async function prepareLockedItem(params: {
  pmRoot: string;
  settings: PmSettings;
  id: string;
  op: string;
  author: string;
  force?: boolean;
  bypassAssigneeConflict?: boolean;
  extensionFieldNames?: readonly string[];
  typeToFolder?: Record<string, string>;
}): Promise<{
  typeToFolder: Record<string, string>;
  located: LocatedItem;
  originalRaw: string;
  document: ItemDocument;
  warnings: string[];
  releaseLock: () => Promise<void>;
}> {
  const typeToFolder =
    params.typeToFolder ??
    resolveItemTypeRegistry(params.settings, getActiveExtensionRegistrations())
      .type_to_folder;
  const located = await locateItem(
    params.pmRoot,
    params.id,
    params.settings.id_prefix,
    params.settings.item_format,
    typeToFolder,
  );
  if (!located) {
    throw await buildItemNotFoundError(
      params.pmRoot,
      params.id,
      params.settings.id_prefix,
      typeToFolder,
    );
  }

  const releaseLock = await acquireLock(
    params.pmRoot,
    located.id,
    params.settings.locks.ttl_seconds,
    params.author,
    Boolean(params.force),
    params.settings.governance.force_required_for_stale_lock,
  );

  try {
    const warnings: string[] = [];
    const { raw: originalRaw, document } = await readLocatedItem(located, {
      schema: params.settings.schema,
      extensionFieldNames: params.extensionFieldNames,
      warnings,
    });

    const assigned = document.metadata.assignee?.trim();
    const governance = resolveGovernanceKnobs(params.settings);
    const hasOwnershipConflict =
      assigned &&
      assigned !== params.author &&
      !params.force &&
      !bypassesAssigneeConflict(params.op, params.bypassAssigneeConflict);
    if (hasOwnershipConflict) {
      if (governance.ownership_enforcement === "strict") {
        throw new PmCliError(
          `Item ${located.id} is assigned to ${assigned}. Use --force to override.`,
          EXIT_CODE.CONFLICT,
        );
      }
      if (governance.ownership_enforcement === "warn") {
        warnings.push(
          `ownership_warning:assignee_conflict:${located.id}:${assigned}`,
        );
      }
    }

    return {
      typeToFolder,
      located,
      originalRaw,
      document,
      warnings,
      releaseLock,
    };
  } catch (error: unknown) {
    await releaseLock();
    throw error;
  }
}

export async function mutateItem(params: {
  pmRoot: string;
  settings: PmSettings;
  id: string;
  op: string;
  author: string;
  message?: string;
  force?: boolean;
  bypassAssigneeConflict?: boolean;
  extensionFieldNames?: readonly string[];
  typeToFolder?: Record<string, string>;
  mutate: (document: ItemDocument) => {
    changedFields: string[];
    warnings?: string[];
  };
}): Promise<{
  item: ItemFrontMatter;
  body: string;
  changedFields: string[];
  warnings: string[];
}> {
  const prepared = await prepareLockedItem({
    pmRoot: params.pmRoot,
    settings: params.settings,
    id: params.id,
    op: params.op,
    author: params.author,
    force: params.force,
    bypassAssigneeConflict: params.bypassAssigneeConflict,
    extensionFieldNames: params.extensionFieldNames,
    typeToFolder: params.typeToFolder,
  });
  const {
    typeToFolder,
    located,
    originalRaw,
    document,
    warnings: parseWarnings,
    releaseLock,
  } = prepared;

  try {
    const historyPolicy = await enforceHistoryStreamPolicyForItem({
      pmRoot: params.pmRoot,
      settings: params.settings,
      itemId: located.id,
      commandLabel: params.op,
    });

    const beforeDocument = canonicalDocument(document, {
      schema: params.settings.schema,
      extensionFieldNames: params.extensionFieldNames,
    });
    const mutableDocument = canonicalDocument(structuredClone(document), {
      schema: params.settings.schema,
      extensionFieldNames: params.extensionFieldNames,
    });
    const mutation = params.mutate(mutableDocument);
    mutableDocument.metadata.updated_at = nowIso();
    const afterDocument = canonicalDocument(mutableDocument, {
      schema: params.settings.schema,
      extensionFieldNames: params.extensionFieldNames,
    });
    const targetItemFormat: ItemFormat = "toon";
    const serializedAfter = serializeItemDocument(afterDocument, {
      format: targetItemFormat,
      schema: params.settings.schema,
      extensionFieldNames: params.extensionFieldNames,
    });
    const targetItemPath = getItemPath(
      params.pmRoot,
      afterDocument.metadata.type,
      located.id,
      targetItemFormat,
      typeToFolder,
    );
    const historyPath = getHistoryPath(params.pmRoot, located.id);
    const serviceWriteOverride = await runActiveServiceOverride("item_store_write", {
      op: params.op,
      pm_root: params.pmRoot,
      item_id: located.id,
      source_item_path: located.itemPath,
      target_item_path: targetItemPath,
      history_path: historyPath,
      item_format: targetItemFormat,
      before: beforeDocument,
      after: afterDocument,
      contents: serializedAfter,
    });
    let effectiveTargetItemPath = targetItemPath;
    let effectiveSerializedAfter = serializedAfter;
    let skipItemWrite = false;
    if (
      serviceWriteOverride.handled &&
      typeof serviceWriteOverride.result === "object" &&
      serviceWriteOverride.result !== null
    ) {
      const overrideRecord = serviceWriteOverride.result as {
        target_item_path?: unknown;
        contents?: unknown;
        skip_write?: unknown;
      };
      if (typeof overrideRecord.target_item_path === "string" && overrideRecord.target_item_path.trim().length > 0) {
        effectiveTargetItemPath = overrideRecord.target_item_path;
      }
      if (typeof overrideRecord.contents === "string") {
        effectiveSerializedAfter = overrideRecord.contents;
      }
      if (overrideRecord.skip_write === true) {
        skipItemWrite = true;
      }
    }

    if (!skipItemWrite) {
      await writeFileAtomic(effectiveTargetItemPath, effectiveSerializedAfter);
    }
    if (!skipItemWrite && effectiveTargetItemPath !== located.itemPath) {
      await fs.rm(located.itemPath);
    }
    const entry = createHistoryEntry({
      nowIso: afterDocument.metadata.updated_at,
      author: params.author,
      op: params.op,
      before: beforeDocument,
      after: afterDocument,
      message: params.message,
    });

    try {
      await appendHistoryEntry(historyPath, entry);
    } catch (error: unknown) {
      if (!skipItemWrite && effectiveTargetItemPath !== located.itemPath) {
        await writeFileAtomic(located.itemPath, originalRaw);
        await fs.rm(effectiveTargetItemPath, { force: true });
      } else if (!skipItemWrite) {
        await writeFileAtomic(located.itemPath, originalRaw);
      }
      throw error;
    }
    const hookWarnings = [
      ...(await runActiveOnWriteHooks({
        path: effectiveTargetItemPath,
        scope: "project",
        op: params.op,
        item_id: afterDocument.metadata.id,
        item_type: afterDocument.metadata.type,
        before: beforeDocument,
        after: afterDocument,
        changed_fields: mutation.changedFields,
      })),
      ...(await runActiveOnWriteHooks({
        path: historyPath,
        scope: "project",
        op: `${params.op}:history`,
        item_id: afterDocument.metadata.id,
        item_type: afterDocument.metadata.type,
        before: beforeDocument,
        after: afterDocument,
        changed_fields: mutation.changedFields,
      })),
    ];

    recordAfterCommandAffectedItem({
      id: afterDocument.metadata.id,
      op: params.op,
      item_type: afterDocument.metadata.type,
      previous_status: beforeDocument.metadata.status,
      status: afterDocument.metadata.status,
      previous: projectAfterCommandItemSnapshot(beforeDocument.metadata, mutation.changedFields),
      current: projectAfterCommandItemSnapshot(afterDocument.metadata, mutation.changedFields),
      changed_fields: mutation.changedFields,
    });

    return {
      item: afterDocument.metadata,
      body: afterDocument.body,
      changedFields: mutation.changedFields,
      warnings: [
        ...parseWarnings,
        ...(mutation.warnings ?? []),
        ...historyPolicy.warnings,
        ...serviceWriteOverride.warnings,
        ...hookWarnings,
      ],
    };
  } finally {
    await releaseLock();
  }
}

export async function deleteItem(params: {
  pmRoot: string;
  settings: PmSettings;
  id: string;
  author: string;
  message?: string;
  force?: boolean;
  dryRun?: boolean;
}): Promise<{ item: ItemFrontMatter; changedFields: string[]; warnings: string[]; targetPath?: string }> {
  const prepared = await prepareLockedItem({
    pmRoot: params.pmRoot,
    settings: params.settings,
    id: params.id,
    op: "delete",
    author: params.author,
    force: params.force,
  });
  const { located, originalRaw, document, warnings: parseWarnings, releaseLock } = prepared;

  try {
    const historyPolicy = await enforceHistoryStreamPolicyForItem({
      pmRoot: params.pmRoot,
      settings: params.settings,
      itemId: located.id,
      commandLabel: "delete",
    });

    const beforeDocument = canonicalDocument(document, { schema: params.settings.schema });
    const deletionTimestamp = nowIso();
    const tombstoneDocument = EMPTY_CANONICAL_DOCUMENT as unknown as ItemDocument;
    const historyEntry = createHistoryEntry({
      nowIso: deletionTimestamp,
      author: params.author,
      op: "delete",
      before: beforeDocument,
      after: tombstoneDocument,
      message: params.message,
    });
    const historyPath = getHistoryPath(params.pmRoot, located.id);
    const serviceDeleteOverride = await runActiveServiceOverride("item_store_delete", {
      op: "delete",
      pm_root: params.pmRoot,
      item_id: located.id,
      item_path: located.itemPath,
      history_path: historyPath,
      before: beforeDocument,
    });
    let effectiveItemPath = located.itemPath;
    let skipDelete = false;
    if (
      serviceDeleteOverride.handled &&
      typeof serviceDeleteOverride.result === "object" &&
      serviceDeleteOverride.result !== null
    ) {
      const overrideRecord = serviceDeleteOverride.result as {
        item_path?: unknown;
        skip_delete?: unknown;
      };
      if (typeof overrideRecord.item_path === "string" && overrideRecord.item_path.trim().length > 0) {
        effectiveItemPath = overrideRecord.item_path;
      }
      if (overrideRecord.skip_delete === true) {
        skipDelete = true;
      }
    }

    if (params.dryRun === true) {
      return {
        item: beforeDocument.metadata,
        changedFields: ["deleted"],
        targetPath: effectiveItemPath,
        warnings: [...parseWarnings, ...historyPolicy.warnings, ...serviceDeleteOverride.warnings],
      };
    }

    if (!skipDelete) {
      await fs.rm(effectiveItemPath);
    }
    try {
      await appendHistoryEntry(historyPath, historyEntry);
    } catch (error: unknown) {
      if (!skipDelete) {
        await writeFileAtomic(effectiveItemPath, originalRaw);
      }
      throw error;
    }

    const hookWarnings = [
      ...(await runActiveOnWriteHooks({
        path: effectiveItemPath,
        scope: "project",
        op: "delete",
        item_id: beforeDocument.metadata.id,
        item_type: beforeDocument.metadata.type,
        before: beforeDocument,
        after: tombstoneDocument,
        changed_fields: ["deleted"],
      })),
      ...(await runActiveOnWriteHooks({
        path: historyPath,
        scope: "project",
        op: "delete:history",
        item_id: beforeDocument.metadata.id,
        item_type: beforeDocument.metadata.type,
        before: beforeDocument,
        after: tombstoneDocument,
        changed_fields: ["deleted"],
      })),
    ];

    recordAfterCommandAffectedItem({
      id: beforeDocument.metadata.id,
      op: "delete",
      item_type: beforeDocument.metadata.type,
      previous_status: beforeDocument.metadata.status,
      previous: projectAfterCommandItemSnapshot(beforeDocument.metadata, Object.keys(beforeDocument.metadata)),
      changed_fields: ["deleted"],
    });

    return {
      item: beforeDocument.metadata,
      changedFields: ["deleted"],
      warnings: [...parseWarnings, ...historyPolicy.warnings, ...serviceDeleteOverride.warnings, ...hookWarnings],
    };
  } finally {
    await releaseLock();
  }
}
