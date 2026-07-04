/**
 * @module cli/commands/copy
 *
 * Implements the pm copy command surface and its agent-facing runtime behavior.
 */
import { pathExists, removeFileIfExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { appendHistoryEntry, createHistoryEntry } from "../../core/history/history.js";
import { generateItemId } from "../../core/item/id.js";
import { canonicalDocument, serializeItemDocument } from "../../core/item/item-format.js";
import { acquireLock } from "../../core/lock/lock.js";
import {
  getActiveExtensionRegistrations,
  projectAfterCommandItemSnapshot,
  recordAfterCommandAffectedItem,
  runActiveOnWriteHooks,
} from "../../core/extensions/index.js";
import { collectRegisteredItemFieldNames } from "../../core/extensions/item-fields.js";
import { resolveRuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { EXIT_CODE, FRONT_MATTER_KEY_ORDER } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { nowIso } from "../../core/shared/time.js";
import { PmCliError } from "../../core/shared/errors.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { buildItemNotFoundError, locateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getHistoryPath, getItemPath, getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemDocument, ItemMetadata } from "../../types/index.js";

/**
 * Documents the copy options payload exchanged by command, SDK, and package integrations.
 */
export interface CopyOptions {
  title?: string;
  author?: string;
  message?: string;
}

/**
 * Documents the copy result payload exchanged by command, SDK, and package integrations.
 */
export interface CopyResult {
  source_id: string;
  item: ItemMetadata;
  changed_fields: string[];
  warnings: string[];
}

function selectAuthor(explicitAuthor: string | undefined, settingsAuthor: string): string {
  const candidate = explicitAuthor ?? process.env.PM_AUTHOR ?? settingsAuthor;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

function buildChangedFields(frontMatter: ItemMetadata, body: string): string[] {
  const changed = [
    ...new Set([
      ...FRONT_MATTER_KEY_ORDER.filter((key) => frontMatter[key] !== undefined),
      ...Object.keys(frontMatter).filter((key) => frontMatter[key] !== undefined),
      ...(body.length > 0 ? ["body"] : []),
    ]),
  ];
  return changed.sort((left, right) => left.localeCompare(right));
}

function buildCopyMessage(sourceId: string, message: string | undefined): string {
  const suffix = `copied_from=${sourceId}`;
  if (!message) {
    return suffix;
  }
  const trimmed = message.trim();
  return trimmed.length > 0 ? `${trimmed} | ${suffix}` : suffix;
}

/**
 * Implements run copy for the public runtime surface of this module.
 */
export async function runCopy(sourceId: string, options: CopyOptions, global: GlobalOptions): Promise<CopyResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const located = await locateItem(pmRoot, sourceId, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
  if (!located) {
    throw await buildItemNotFoundError(pmRoot, sourceId, settings.id_prefix, typeRegistry.type_to_folder);
  }
  const sourceLoaded = await readLocatedItem(located, { schema: settings.schema });
  const sourceMetadata = sourceLoaded.document.metadata;
  const copiedAt = nowIso();
  const author = selectAuthor(options.author, settings.author_default);
  const newId = await generateItemId(pmRoot, settings.id_prefix);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const titleOverride = options.title?.trim();
  if (titleOverride !== undefined && titleOverride.length === 0) {
    throw new PmCliError("Copy --title must not be empty", EXIT_CODE.USAGE);
  }

  const copiedMetadata: ItemMetadata = {
    ...(sourceMetadata as Record<string, unknown>),
    id: newId,
    title: titleOverride ?? sourceMetadata.title,
    status: statusRegistry.open_status,
    created_at: copiedAt,
    updated_at: copiedAt,
  } as ItemMetadata;
  delete copiedMetadata.closed_at;
  delete copiedMetadata.close_reason;
  delete copiedMetadata.test_runs;

  const extensionFieldNames = collectRegisteredItemFieldNames(getActiveExtensionRegistrations());
  const copiedDocument = canonicalDocument(
    {
      metadata: copiedMetadata,
      body: sourceLoaded.document.body,
    },
    {
      schema: settings.schema,
      extensionFieldNames,
    },
  );
  const changedFields = buildChangedFields(copiedDocument.metadata, copiedDocument.body);
  const itemPath = getItemPath(pmRoot, copiedDocument.metadata.type, newId, settings.item_format, typeRegistry.type_to_folder);
  const historyPath = getHistoryPath(pmRoot, newId);
  const lockRelease = await acquireLock(
    pmRoot,
    newId,
    settings.locks.ttl_seconds,
    author,
    false,
    settings.governance.force_required_for_stale_lock,
    settings.locks.wait_ms,
  );
  const beforeDocument: ItemDocument = {
    metadata: {} as ItemMetadata,
    body: "",
  };

  let hookWarnings: string[] = [];
  try {
    await writeFileAtomic(
      itemPath,
      serializeItemDocument(copiedDocument, {
        format: settings.item_format,
        schema: settings.schema,
        extensionFieldNames,
      }),
    );
    try {
      const historyEntry = createHistoryEntry({
        nowIso: copiedAt,
        author,
        op: "create",
        before: beforeDocument,
        after: copiedDocument,
        message: buildCopyMessage(located.id, options.message),
      });
      await appendHistoryEntry(historyPath, historyEntry);
    } catch (error: unknown) {
      await removeFileIfExists(itemPath);
      throw error;
    }

    hookWarnings = [
      ...(await runActiveOnWriteHooks({
        path: itemPath,
        scope: "project",
        op: "create",
        item_id: copiedDocument.metadata.id,
        item_type: copiedDocument.metadata.type,
        before: beforeDocument,
        after: copiedDocument,
        changed_fields: changedFields,
      })),
      ...(await runActiveOnWriteHooks({
        path: historyPath,
        scope: "project",
        op: "create:history",
        item_id: copiedDocument.metadata.id,
        item_type: copiedDocument.metadata.type,
        before: beforeDocument,
        after: copiedDocument,
        changed_fields: changedFields,
      })),
    ];
    recordAfterCommandAffectedItem({
      id: copiedDocument.metadata.id,
      op: "create",
      item_type: copiedDocument.metadata.type,
      status: copiedDocument.metadata.status,
      current: projectAfterCommandItemSnapshot(copiedDocument.metadata, changedFields),
      changed_fields: changedFields,
    });
  } finally {
    await lockRelease();
  }

  return {
    source_id: located.id,
    item: structuredClone(copiedDocument.metadata),
    changed_fields: changedFields,
    warnings: hookWarnings,
  };
}
