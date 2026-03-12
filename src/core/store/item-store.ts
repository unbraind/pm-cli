import fs from "node:fs/promises";
import path from "node:path";
import { runActiveOnReadHooks, runActiveOnWriteHooks } from "../extensions/index.js";
import { EMPTY_CANONICAL_DOCUMENT, EXIT_CODE, TYPE_TO_FOLDER } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { appendHistoryEntry, createHistoryEntry } from "../history/history.js";
import { canonicalDocument, parseItemDocument, serializeItemDocument } from "../item/item-format.js";
import { acquireLock } from "../lock/lock.js";
import { writeFileAtomic } from "../fs/fs-utils.js";
import { normalizeItemId, normalizeRawItemId } from "../item/id.js";
import { getHistoryPath } from "./paths.js";
import { nowIso } from "../shared/time.js";
import type { ItemDocument, ItemFrontMatter, ItemType, PmSettings } from "../../types/index.js";

export interface LocatedItem {
  id: string;
  type: ItemType;
  itemPath: string;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function locateItem(pmRoot: string, rawId: string, idPrefix: string): Promise<LocatedItem | null> {
  const normalizedId = normalizeItemId(rawId, idPrefix);
  const rawNormalizedId = normalizeRawItemId(rawId);
  const candidateIds = normalizedId === rawNormalizedId ? [normalizedId] : [normalizedId, rawNormalizedId];
  const entries = Object.entries(TYPE_TO_FOLDER) as Array<[ItemType, string]>;
  for (const candidateId of candidateIds) {
    for (const [type, folder] of entries) {
      const itemPath = path.join(pmRoot, folder, `${candidateId}.md`);
      if (await fileExists(itemPath)) {
        return {
          id: candidateId,
          type,
          itemPath,
        };
      }
    }
  }
  return null;
}

export async function readLocatedItem(item: LocatedItem): Promise<{ raw: string; document: ItemDocument }> {
  const raw = await fs.readFile(item.itemPath, "utf8");
  await runActiveOnReadHooks({
    path: item.itemPath,
    scope: "project",
  });
  const document = parseItemDocument(raw);
  return { raw, document };
}

export async function listAllFrontMatter(pmRoot: string): Promise<ItemFrontMatter[]> {
  const entries = Object.values(TYPE_TO_FOLDER);
  const items: ItemFrontMatter[] = [];
  for (const folder of entries) {
    const dirPath = path.join(pmRoot, folder);
    let files: string[] = [];
    try {
      files = await fs.readdir(dirPath);
    } catch {
      continue;
    }
    for (const file of files.filter((entry) => entry.endsWith(".md"))) {
      try {
        const itemPath = path.join(dirPath, file);
        const raw = await fs.readFile(itemPath, "utf8");
        await runActiveOnReadHooks({
          path: itemPath,
          scope: "project",
        });
        const parsed = parseItemDocument(raw);
        items.push(parsed.front_matter);
      } catch {
        // skip unreadable items
      }
    }
  }
  return items;
}

export async function mutateItem(params: {
  pmRoot: string;
  settings: PmSettings;
  id: string;
  op: string;
  author: string;
  message?: string;
  force?: boolean;
  mutate: (document: ItemDocument) => { changedFields: string[]; warnings?: string[] };
}): Promise<{ item: ItemFrontMatter; body: string; changedFields: string[]; warnings: string[] }> {
  const located = await locateItem(params.pmRoot, params.id, params.settings.id_prefix);
  if (!located) {
    throw new PmCliError(`Item ${params.id} not found`, EXIT_CODE.NOT_FOUND);
  }

  const releaseLock = await acquireLock(
    params.pmRoot,
    located.id,
    params.settings.locks.ttl_seconds,
    params.author,
    Boolean(params.force),
  );

  try {
    const { raw: originalRaw, document } = await readLocatedItem(located);

    const assigned = document.front_matter.assignee?.trim();
    if (assigned && assigned !== params.author && !params.force) {
      throw new PmCliError(
        `Item ${located.id} is assigned to ${assigned}. Use --force to override.`,
        EXIT_CODE.CONFLICT,
      );
    }

    const beforeDocument = canonicalDocument(document);
    const mutableDocument = canonicalDocument(structuredClone(document));
    const mutation = params.mutate(mutableDocument);
    mutableDocument.front_matter.updated_at = nowIso();
    const afterDocument = canonicalDocument(mutableDocument);
    const serializedAfter = serializeItemDocument(afterDocument);

    await writeFileAtomic(located.itemPath, serializedAfter);
    const entry = createHistoryEntry({
      nowIso: afterDocument.front_matter.updated_at,
      author: params.author,
      op: params.op,
      before: beforeDocument,
      after: afterDocument,
      message: params.message,
    });

    try {
      await appendHistoryEntry(getHistoryPath(params.pmRoot, located.id), entry);
    } catch (error: unknown) {
      await writeFileAtomic(located.itemPath, originalRaw);
      throw error;
    }
    const hookWarnings = [
      ...(await runActiveOnWriteHooks({
        path: located.itemPath,
        scope: "project",
        op: params.op,
      })),
      ...(await runActiveOnWriteHooks({
        path: getHistoryPath(params.pmRoot, located.id),
        scope: "project",
        op: `${params.op}:history`,
      })),
    ];

    return {
      item: afterDocument.front_matter,
      body: afterDocument.body,
      changedFields: mutation.changedFields,
      warnings: [...(mutation.warnings ?? []), ...hookWarnings],
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
  const located = await locateItem(params.pmRoot, params.id, params.settings.id_prefix);
  if (!located) {
    throw new PmCliError(`Item ${params.id} not found`, EXIT_CODE.NOT_FOUND);
  }

  const releaseLock = await acquireLock(
    params.pmRoot,
    located.id,
    params.settings.locks.ttl_seconds,
    params.author,
    Boolean(params.force),
  );

  try {
    const { raw: originalRaw, document } = await readLocatedItem(located);

    const assigned = document.front_matter.assignee?.trim();
    if (assigned && assigned !== params.author && !params.force) {
      throw new PmCliError(
        `Item ${located.id} is assigned to ${assigned}. Use --force to override.`,
        EXIT_CODE.CONFLICT,
      );
    }

    const beforeDocument = canonicalDocument(document);
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

    await fs.rm(located.itemPath);
    try {
      await appendHistoryEntry(getHistoryPath(params.pmRoot, located.id), historyEntry);
    } catch (error: unknown) {
      await writeFileAtomic(located.itemPath, originalRaw);
      throw error;
    }

    const hookWarnings = [
      ...(await runActiveOnWriteHooks({
        path: located.itemPath,
        scope: "project",
        op: "delete",
      })),
      ...(await runActiveOnWriteHooks({
        path: getHistoryPath(params.pmRoot, located.id),
        scope: "project",
        op: "delete:history",
      })),
    ];

    return {
      item: beforeDocument.front_matter,
      changedFields: ["deleted"],
      warnings: hookWarnings,
    };
  } finally {
    await releaseLock();
  }
}
