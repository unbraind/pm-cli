import fs from "node:fs/promises";
import path from "node:path";
import {
  getActiveExtensionRegistrations,
  runActiveOnReadHooks,
  runActiveOnWriteHooks,
  runActiveServiceOverride,
} from "../extensions/index.js";
import { EMPTY_CANONICAL_DOCUMENT, EXIT_CODE, TYPE_TO_FOLDER } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { appendHistoryEntry, createHistoryEntry } from "../history/history.js";
import { enforceHistoryStreamPolicyForItem } from "../history/history-stream-policy.js";
import { canonicalDocument, parseItemDocument, serializeItemDocument } from "../item/item-format.js";
import { resolveItemTypeRegistry } from "../item/type-registry.js";
import { acquireLock } from "../lock/lock.js";
import { writeFileAtomic } from "../fs/fs-utils.js";
import { normalizeItemId, normalizeRawItemId } from "../item/id.js";
import { listAllDocumentsCached } from "./front-matter-cache.js";
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
  idPrefix: string,
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
  options: { schema?: RuntimeSchemaSettings; warnings?: string[] } = {},
): Promise<{ raw: string; document: ItemDocument }> {
  const raw = await fs.readFile(item.itemPath, "utf8");
  await runActiveOnReadHooks({
    path: item.itemPath,
    scope: "project",
  });
  const document = parseItemDocument(raw, {
    format: item.item_format,
    schema: options.schema,
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

export async function listAllFrontMatterWithBody(
  pmRoot: string,
  preferredFormat?: ItemFormat,
  typeToFolder: Record<string, string> = TYPE_TO_FOLDER,
  warnings?: string[],
  schema?: RuntimeSchemaSettings,
): Promise<Array<ItemFrontMatter & { body: string }>> {
  const documents = await listAllDocuments(pmRoot, preferredFormat, typeToFolder, warnings, schema);
  return documents.map((document) => ({
    ...document.metadata,
    body: document.body,
  }));
}

async function listAllDocuments(
  pmRoot: string,
  preferredFormat?: ItemFormat,
  typeToFolder: Record<string, string> = TYPE_TO_FOLDER,
  warnings?: string[],
  schema?: RuntimeSchemaSettings,
): Promise<ItemDocument[]> {
  const entries = Object.entries(typeToFolder) as Array<[ItemType, string]>;
  const documentsById = new Map<string, { document: ItemDocument; itemFormat: ItemFormat }>();

  const dirResults = await Promise.all(
    entries.map(async ([, folder]) => {
      const dirPath = path.join(pmRoot, folder);
      try {
        return { folder, files: await fs.readdir(dirPath) };
      } catch (error: unknown) {
        if (!isErrno(error, "ENOENT")) {
          appendWarning(warnings, `item_list_directory_read_failed:${folder}`);
        }
        return { folder, files: [] as string[] };
      }
    }),
  );

  const readTasks: Array<Promise<{ folder: string; file: string; document: ItemDocument; itemFormat: ItemFormat } | null>> = [];
  for (const { folder, files } of dirResults) {
    const dirPath = path.join(pmRoot, folder);
    for (const file of files.filter((entry) => ITEM_FILE_EXTENSIONS.some((ext) => entry.toLowerCase().endsWith(ext)))) {
      readTasks.push(
        (async () => {
          try {
            const itemPath = path.join(dirPath, file);
            const itemFormat = getItemFormatFromPath(itemPath) as ItemFormat;
            const raw = await fs.readFile(itemPath, "utf8");
            await runActiveOnReadHooks({ path: itemPath, scope: "project" });
            const parsed = parseItemDocument(raw, {
              format: itemFormat,
              schema,
              onWarning: (warning) => appendWarning(warnings, warning),
            });
            return { folder, file, document: parsed, itemFormat };
          } catch {
            appendWarning(warnings, `item_list_item_read_failed:${folder}/${file}`);
            return null;
          }
        })(),
      );
    }
  }

  const results = await Promise.all(readTasks);
  for (const result of results) {
    if (!result) continue;
    const existing = documentsById.get(result.document.metadata.id);
    if (!existing) {
      documentsById.set(result.document.metadata.id, {
        document: result.document,
        itemFormat: result.itemFormat,
      });
      continue;
    }
    const shouldReplace = preferredFormat
      ? result.itemFormat === preferredFormat && existing.itemFormat !== preferredFormat
      : result.itemFormat === "toon" && existing.itemFormat !== "toon";
    if (shouldReplace) {
      documentsById.set(result.document.metadata.id, {
        document: result.document,
        itemFormat: result.itemFormat,
      });
    }
  }
  return [...documentsById.values()]
    .sort((left, right) => left.document.metadata.id.localeCompare(right.document.metadata.id))
    .map((entry) => entry.document);
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

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr.push(Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost));
    }
    prev = curr;
  }
  return prev[b.length];
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
  const scored = ids
    .map((id) => ({ id, distance: levenshtein(id, normalized) }))
    .filter((entry) => entry.distance <= Math.max(3, Math.floor(normalized.length / 2)))
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

export async function mutateItem(params: {
  pmRoot: string;
  settings: PmSettings;
  id: string;
  op: string;
  author: string;
  message?: string;
  force?: boolean;
  bypassAssigneeConflict?: boolean;
  typeToFolder?: Record<string, string>;
  mutate: (document: ItemDocument) => { changedFields: string[]; warnings?: string[] };
}): Promise<{ item: ItemFrontMatter; body: string; changedFields: string[]; warnings: string[] }> {
  const typeToFolder =
    params.typeToFolder ?? resolveItemTypeRegistry(params.settings, getActiveExtensionRegistrations()).type_to_folder;
  const located = await locateItem(params.pmRoot, params.id, params.settings.id_prefix, params.settings.item_format, typeToFolder);
  if (!located) {
    throw await buildItemNotFoundError(params.pmRoot, params.id, params.settings.id_prefix, typeToFolder);
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
    const parseWarnings: string[] = [];
    const { raw: originalRaw, document } = await readLocatedItem(located, {
      schema: params.settings.schema,
      warnings: parseWarnings,
    });

    const assigned = document.metadata.assignee?.trim();
    const governance = resolveGovernanceKnobs(params.settings);
    const bypassAssigneeConflict =
      params.op === "claim" ||
      ((
        params.op === "comment_add" ||
        params.op === "note_add" ||
        params.op === "learning_add" ||
        params.op === "release" ||
        params.op === "update" ||
        params.op === "update_audit"
      ) &&
        params.bypassAssigneeConflict === true);
    const hasOwnershipConflict = assigned && assigned !== params.author && !params.force && !bypassAssigneeConflict;
    if (hasOwnershipConflict) {
      if (governance.ownership_enforcement === "strict") {
        throw new PmCliError(
          `Item ${located.id} is assigned to ${assigned}. Use --force to override.`,
          EXIT_CODE.CONFLICT,
        );
      }
      if (governance.ownership_enforcement === "warn") {
        parseWarnings.push(`ownership_warning:assignee_conflict:${located.id}:${assigned}`);
      }
    }
    const historyPolicy = await enforceHistoryStreamPolicyForItem({
      pmRoot: params.pmRoot,
      settings: params.settings,
      itemId: located.id,
      commandLabel: params.op,
    });

    const beforeDocument = canonicalDocument(document, { schema: params.settings.schema });
    const mutableDocument = canonicalDocument(structuredClone(document), { schema: params.settings.schema });
    const mutation = params.mutate(mutableDocument);
    mutableDocument.metadata.updated_at = nowIso();
    const afterDocument = canonicalDocument(mutableDocument, { schema: params.settings.schema });
    const targetItemFormat: ItemFormat = "toon";
    const serializedAfter = serializeItemDocument(afterDocument, {
      format: targetItemFormat,
      schema: params.settings.schema,
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
    if (serviceWriteOverride.handled && typeof serviceWriteOverride.result === "object" && serviceWriteOverride.result !== null) {
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
      })),
      ...(await runActiveOnWriteHooks({
        path: historyPath,
        scope: "project",
        op: `${params.op}:history`,
      })),
    ];

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
}): Promise<{ item: ItemFrontMatter; changedFields: string[]; warnings: string[] }> {
  const typeToFolder = resolveItemTypeRegistry(params.settings, getActiveExtensionRegistrations()).type_to_folder;
  const located = await locateItem(params.pmRoot, params.id, params.settings.id_prefix, params.settings.item_format, typeToFolder);
  if (!located) {
    throw await buildItemNotFoundError(params.pmRoot, params.id, params.settings.id_prefix, typeToFolder);
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
    const parseWarnings: string[] = [];
    const { raw: originalRaw, document } = await readLocatedItem(located, {
      schema: params.settings.schema,
      warnings: parseWarnings,
    });

    const assigned = document.metadata.assignee?.trim();
    const governance = resolveGovernanceKnobs(params.settings);
    const hasOwnershipConflict = assigned && assigned !== params.author && !params.force;
    if (hasOwnershipConflict) {
      if (governance.ownership_enforcement === "strict") {
        throw new PmCliError(
          `Item ${located.id} is assigned to ${assigned}. Use --force to override.`,
          EXIT_CODE.CONFLICT,
        );
      }
      if (governance.ownership_enforcement === "warn") {
        parseWarnings.push(`ownership_warning:assignee_conflict:${located.id}:${assigned}`);
      }
    }
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
      })),
      ...(await runActiveOnWriteHooks({
        path: historyPath,
        scope: "project",
        op: "delete:history",
      })),
    ];

    return {
      item: beforeDocument.metadata,
      changedFields: ["deleted"],
      warnings: [...parseWarnings, ...historyPolicy.warnings, ...serviceDeleteOverride.warnings, ...hookWarnings],
    };
  } finally {
    await releaseLock();
  }
}
