/**
 * @module core/store/item-store
 *
 * Reads and writes tracker storage with format-aware helpers for Item Store.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  getActiveExtensionRegistrations,
  projectAfterCommandItemSnapshot,
  recordAfterCommandAffectedItem,
  runActiveOnReadHooks,
  runActiveBeforeMutationHooks,
  runActiveOnWriteHooks,
  runActiveServiceOverride,
  type ExtensionMutationGuardSdk,
} from "../extensions/index.js";
import { collectRegisteredItemFieldNames } from "../extensions/item-fields.js";
import {
  EMPTY_CANONICAL_DOCUMENT,
  EXIT_CODE,
  TYPE_TO_FOLDER,
} from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { levenshteinDistanceWithinLimit } from "../shared/levenshtein.js";
import { appendHistoryEntry, createHistoryEntry } from "../history/history.js";
import { enforceHistoryStreamPolicyForItem } from "../history/history-stream-policy.js";
import {
  canonicalDocument,
  parseItemDocument,
  serializeItemDocument,
} from "../item/item-format.js";
import { resolveItemTypeRegistry } from "../item/type-registry.js";
import { acquireLock } from "../lock/lock.js";
import { writeFileAtomic } from "../fs/fs-utils.js";
import { isUtf8 } from "node:buffer";
import { normalizeItemId, normalizeRawItemId } from "../item/id.js";
import {
  acquireItemMetadataDerivedIndexLock,
  listAllDocumentCandidatesCached,
  listAllDocumentsCached,
  listAllDocumentsCachedLight,
  refreshItemMetadataDerivedIndex,
} from "./item-metadata-cache.js";
import { getHistoryPath, getItemPath, ITEM_FILE_EXTENSIONS } from "./paths.js";
import { resolveGovernanceKnobs } from "./settings.js";
import { assertReadableTrackerRoot } from "./tracker-preflight.js";
import { resolveClaimPrincipal } from "../shared/author.js";
import { nowIso } from "../shared/time.js";
import type {
  ItemDocument,
  ItemFormat,
  ItemMetadata,
  ItemType,
  PmSettings,
  RuntimeSchemaSettings,
} from "../../types/index.js";

/** Documents the located item payload exchanged by command, SDK, and package integrations. */
export interface LocatedItem {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type: ItemType;
  /** Filesystem path used for item resolution. */
  itemPath: string;
  /** Value that configures or reports item format for this contract. */
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
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

function appendWarning(warnings: string[] | undefined, warning: string): void {
  if (!warnings) {
    return;
  }
  if (!warnings.includes(warning)) {
    warnings.push(warning);
  }
}

function resolveActiveExtensionFieldNames(
  explicit: readonly string[] | undefined,
): readonly string[] {
  return (
    explicit ??
    collectRegisteredItemFieldNames(getActiveExtensionRegistrations())
  );
}

function resolveItemFormatSearchOrder(
  preferredFormat?: ItemFormat,
): ItemFormat[] {
  if (preferredFormat === "toon") {
    return ["toon", "json_markdown"];
  }
  if (preferredFormat === "json_markdown") {
    return ["json_markdown", "toon"];
  }
  return ["toon", "json_markdown"];
}

/** Implements locate item for the public runtime surface of this module. */
export async function locateItem(
  pmRoot: string,
  rawId: string,
  idPrefix = "pm-",
  preferredFormat?: ItemFormat,
  typeToFolder: Record<string, string> = TYPE_TO_FOLDER,
): Promise<LocatedItem | null> {
  const trimmedRawId = rawId.trim();
  const exactRawId = trimmedRawId.startsWith("#")
    ? trimmedRawId.slice(1)
    : trimmedRawId;
  if (exactRawId.length === 0) {
    return null;
  }
  const normalizedId = normalizeItemId(rawId, idPrefix);
  const rawNormalizedId = normalizeRawItemId(rawId);
  const candidateIds = [
    ...new Set([exactRawId, normalizedId, rawNormalizedId]),
  ].filter((candidateId) => candidateId.length > 0);
  const entries = Object.entries(typeToFolder) as Array<[ItemType, string]>;
  const searchOrder = resolveItemFormatSearchOrder(preferredFormat);
  for (const candidateId of candidateIds) {
    for (const [type] of entries) {
      for (const itemFormat of searchOrder) {
        const itemPath = getItemPath(
          pmRoot,
          type,
          candidateId,
          itemFormat,
          typeToFolder,
        );
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

/** Implements read located item for the public runtime surface of this module. */
export async function readLocatedItem(
  item: LocatedItem,
  options: {
    schema?: RuntimeSchemaSettings;
    extensionFieldNames?: readonly string[];
    warnings?: string[];
  } = {},
): Promise<{ raw: string; document: ItemDocument }> {
  const snapshot = await readLocatedItemSnapshot(item, options);
  if (snapshot.error !== null) throw snapshot.error;
  return { raw: snapshot.raw, document: snapshot.document };
}

/**
 * Read once and retain a recoverable parse failure beside its exact text snapshot.
 * Filesystem and merge-conflict errors still throw; callers must explicitly
 * reconstruct an invalid document before performing any mutation.
 */
export async function readLocatedItemSnapshot(
  item: LocatedItem,
  options: Parameters<typeof readLocatedItem>[1] = {},
): Promise<
  | { raw: string; document: ItemDocument; error: null }
  | { raw: string; document: null; error: PmCliError }
> {
  const bytes = await fs.readFile(item.itemPath);
  if (!isUtf8(bytes)) {
    throw new PmCliError("Item contains invalid UTF-8; preserve a binary backup before recovering it.", EXIT_CODE.CONFLICT, { code: "item_document_encoding_invalid" });
  }
  const raw = bytes.toString("utf8");
  await runActiveOnReadHooks({
    path: item.itemPath,
    scope: "project",
  });
  let document: ItemDocument;
  try {
    document = parseItemDocument(raw, {
      format: item.item_format,
      schema: options.schema,
      extensionFieldNames: resolveActiveExtensionFieldNames(
        options.extensionFieldNames,
      ),
      onWarning: (warning) => appendWarning(options.warnings, warning),
    });
  } catch (error) {
    if (error instanceof PmCliError && error.code === "item_document_invalid") {
      return { raw, document: null, error: new PmCliError(error.message, error.exitCode, {
          ...error.context,
          nextSteps: [`Run pm history ${item.id} --full, then pm restore ${item.id} <version> to recover a recorded state.`],
        }) };
    }
    throw error;
  }
  return { raw, document, error: null };
}

/** Implements list all item metadata for the public runtime surface of this module. */
export async function listAllItemMetadata(
  pmRoot: string,
  preferredFormat?: ItemFormat,
  typeToFolder: Record<string, string> = TYPE_TO_FOLDER,
  warnings?: string[],
  schema?: RuntimeSchemaSettings,
): Promise<ItemMetadata[]> {
  await assertReadableTrackerRoot(pmRoot);
  const documents = await listAllDocumentsCached(
    pmRoot,
    preferredFormat,
    typeToFolder,
    warnings,
    schema,
  );
  return documents.map((document) => document.metadata);
}

/**
 * Light variant of {@link listAllItemMetadata}: returns item-metadata WITHOUT the heavy
 * collection fields (comments/notes/learnings/files/tests/test_runs/docs). Skips the
 * large collections cache so the hot list path stays cheap. Only use for callers that
 * read just the light scalar/small fields — see {@link listAllDocumentsCachedLight}.
 */
export async function listAllItemMetadataLight(
  pmRoot: string,
  preferredFormat?: ItemFormat,
  typeToFolder: Record<string, string> = TYPE_TO_FOLDER,
  warnings?: string[],
  schema?: RuntimeSchemaSettings,
): Promise<ItemMetadata[]> {
  await assertReadableTrackerRoot(pmRoot);
  const documents = await listAllDocumentsCachedLight(
    pmRoot,
    preferredFormat,
    typeToFolder,
    warnings,
    schema,
  );
  return documents.map((document) => document.metadata);
}

/** List item metadata with bodies, optionally bypassing the derived-index fast path when an integrity workflow must re-read authoritative files. */
export async function listAllItemMetadataWithBody(
  pmRoot: string,
  preferredFormat?: ItemFormat,
  typeToFolder: Record<string, string> = TYPE_TO_FOLDER,
  warnings?: string[],
  schema?: RuntimeSchemaSettings,
  options: { forceSourceScan?: boolean } = {},
): Promise<Array<ItemMetadata & { body: string }>> {
  await assertReadableTrackerRoot(pmRoot);
  const candidates = await listAllDocumentCandidatesCached(
    pmRoot,
    preferredFormat,
    typeToFolder,
    warnings,
    schema,
    {
      includeBody: true,
      forceSourceScan: options.forceSourceScan,
    },
  );
  return candidates.map((candidate) => ({
    ...candidate.metadata,
    // includeBody:true guarantees candidate bodies are materialized.
    body: candidate.body!,
  }));
}

/** Build the minimal host-bound read-only SDK exposed to transactional extension guards. */
export function createMutationGuardSdk(params: {
  pmRoot: string;
  settings: PmSettings;
  typeToFolder: Record<string, string>;
}): ExtensionMutationGuardSdk {
  return {
    async get(id) {
      const located = await locateItem(
        params.pmRoot,
        id,
        params.settings.id_prefix,
        params.settings.item_format,
        params.typeToFolder,
      );
      if (!located) return null;
      const { document } = await readLocatedItem(located, {
        schema: params.settings.schema,
      });
      return { item: document.metadata, body: document.body };
    },
    list: () =>
      listAllItemMetadata(
        params.pmRoot,
        params.settings.item_format,
        params.typeToFolder,
        undefined,
        params.settings.schema,
      ),
  };
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
    .map((id) => ({
      id,
      distance: levenshteinDistanceWithinLimit(id, normalized, limit),
    }))
    .filter(
      (entry): entry is { id: string; distance: number } =>
        entry.distance !== null,
    )
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 3)
    .map((entry) => entry.id);
  return scored;
}

/** Implements build item not found error for the public runtime surface of this module. */
export async function buildItemNotFoundError(
  pmRoot: string,
  badId: string,
  idPrefix: string,
  typeToFolder: Record<string, string>,
): Promise<PmCliError> {
  const suggestions = await buildDidYouMeanSuggestions(
    pmRoot,
    badId,
    idPrefix,
    typeToFolder,
  );
  const nextSteps: string[] = [
    "Confirm the active --path/PM_PATH scope, then retry with a valid id.",
  ];
  if (suggestions.length > 0) {
    nextSteps.unshift(`Did you mean one of: ${suggestions.join(", ")}?`);
  }
  return new PmCliError(`Item ${badId} not found`, EXIT_CODE.NOT_FOUND, {
    nextSteps,
  });
}

function bypassesAssigneeConflict(
  op: string,
  bypassAssigneeConflict?: boolean,
): boolean {
  return (
    op === "claim" ||
    (bypassAssigneeConflict === true &&
      (op === "comment_add" ||
        op === "comment_edit" ||
        op === "comment_delete" ||
        op === "note_add" ||
        op === "learning_add" ||
        op === "release" ||
        op === "update" ||
        op === "update_ownership_bypass" ||
        // Historical compatibility for streams written before the optional
        // governance package moved its ownership workflow out of core.
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
    params.settings.locks.wait_ms,
  );

  try {
    const warnings: string[] = [];
    const { raw: originalRaw, document } = await readLocatedItem(located, {
      schema: params.settings.schema,
      extensionFieldNames: params.extensionFieldNames,
      warnings,
    });

    const assigned = document.metadata.assignee?.trim();
    const assignedPrincipal =
      document.metadata.claim_principal?.trim() || assigned;
    const callerPrincipal = resolveClaimPrincipal(params.author);
    const governance = resolveGovernanceKnobs(params.settings);
    const hasOwnershipConflict =
      assigned &&
      assignedPrincipal !== callerPrincipal &&
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

function resolveItemStoreWriteOverride(
  serviceWriteOverride: { handled: boolean; result?: unknown },
  targetItemPath: string,
  serializedAfter: string,
): {
  effectiveTargetItemPath: string;
  effectiveSerializedAfter: string;
  skipItemWrite: boolean;
} {
  if (
    !serviceWriteOverride.handled ||
    typeof serviceWriteOverride.result !== "object" ||
    serviceWriteOverride.result === null
  ) {
    return {
      effectiveTargetItemPath: targetItemPath,
      effectiveSerializedAfter: serializedAfter,
      skipItemWrite: false,
    };
  }
  const overrideRecord = serviceWriteOverride.result as {
    target_item_path?: unknown;
    contents?: unknown;
    skip_write?: unknown;
  };
  return {
    effectiveTargetItemPath:
      typeof overrideRecord.target_item_path === "string" &&
      overrideRecord.target_item_path.trim().length > 0
        ? overrideRecord.target_item_path
        : targetItemPath,
    effectiveSerializedAfter:
      typeof overrideRecord.contents === "string"
        ? overrideRecord.contents
        : serializedAfter,
    skipItemWrite: overrideRecord.skip_write === true,
  };
}

async function rollbackMutatedItemWrite(params: {
  skipItemWrite: boolean;
  effectiveTargetItemPath: string;
  originalItemPath: string;
  originalRaw: string;
}): Promise<void> {
  if (params.skipItemWrite) {
    return;
  }
  if (params.effectiveTargetItemPath !== params.originalItemPath) {
    await writeFileAtomic(params.originalItemPath, params.originalRaw);
    await fs.rm(params.effectiveTargetItemPath, { force: true });
    return;
  }
  await writeFileAtomic(params.originalItemPath, params.originalRaw);
}

interface ItemMutationResult {
  item: ItemMetadata;
  body: string;
  changedFields: string[];
  warnings: string[];
}

interface ItemMutationParams {
  pmRoot: string;
  settings: PmSettings;
  id: string;
  op: string;
  author: string;
  message?: string;
  /** Structured immutable context attached to the appended history entry. */
  historyContext?: Record<string, unknown>;
  force?: boolean;
  bypassAssigneeConflict?: boolean;
  skipNoop?: boolean;
  extensionFieldNames?: readonly string[];
  typeToFolder?: Record<string, string>;
  mutate: (
    document: ItemDocument,
  ) =>
    | { changedFields: string[]; warnings?: string[] }
    | Promise<{ changedFields: string[]; warnings?: string[] }>;
}

type DeferredItemMutationParams = Omit<ItemMutationParams, "historyContext"> & {
  resolveHistoryContext?: () => Record<string, unknown> | undefined;
};

async function mutateItemWithDeferredHistoryContext(
  params: DeferredItemMutationParams,
): Promise<ItemMutationResult> {
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
    const beforeDocument = canonicalDocument(document, {
      schema: params.settings.schema,
      extensionFieldNames: params.extensionFieldNames,
    });
    const mutableDocument = canonicalDocument(structuredClone(document), {
      schema: params.settings.schema,
      extensionFieldNames: params.extensionFieldNames,
    });
    const mutation = await params.mutate(mutableDocument);
    if (params.skipNoop === true && mutation.changedFields.length === 0) {
      return {
        item: beforeDocument.metadata,
        body: beforeDocument.body,
        changedFields: [],
        warnings: [...parseWarnings, ...(mutation.warnings ?? [])],
      };
    }
    const historyContext = params.resolveHistoryContext?.();
    mutableDocument.metadata.updated_at = nowIso();
    const afterDocument = canonicalDocument(mutableDocument, {
      schema: params.settings.schema,
      extensionFieldNames: params.extensionFieldNames,
    });
    await runActiveBeforeMutationHooks({
      pm_root: params.pmRoot,
      operation: params.op,
      before: beforeDocument,
      after: afterDocument,
      changed_fields: mutation.changedFields,
      sdk: createMutationGuardSdk({
        pmRoot: params.pmRoot,
        settings: params.settings,
        typeToFolder,
      }),
    });
    const historyPolicy = await enforceHistoryStreamPolicyForItem({
      pmRoot: params.pmRoot,
      settings: params.settings,
      itemId: located.id,
      commandLabel: params.op,
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
    const serviceWriteOverride = await runActiveServiceOverride(
      "item_store_write",
      {
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
      },
    );
    const { effectiveTargetItemPath, effectiveSerializedAfter, skipItemWrite } =
      resolveItemStoreWriteOverride(
        serviceWriteOverride,
        targetItemPath,
        serializedAfter,
      );

    const releaseDerivedIndexLock = await acquireItemMetadataDerivedIndexLock(
      params.pmRoot,
      params.author,
    );
    let derivedIndexWarnings: string[] = [];
    try {
      if (!skipItemWrite) {
        await writeFileAtomic(
          effectiveTargetItemPath,
          effectiveSerializedAfter,
        );
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
        context: historyContext,
      });
      try {
        await appendHistoryEntry(historyPath, entry);
      } catch (error: unknown) {
        await rollbackMutatedItemWrite({
          skipItemWrite,
          effectiveTargetItemPath,
          originalItemPath: located.itemPath,
          originalRaw,
        });
        throw error;
      }
      if (!skipItemWrite) {
        derivedIndexWarnings = await refreshItemMetadataDerivedIndex({
          pmRoot: params.pmRoot,
          preferredFormat: params.settings.item_format,
          typeToFolder,
          schema: params.settings.schema,
          itemPath: effectiveTargetItemPath,
          previousItemPath: located.itemPath,
          document: afterDocument,
        });
      }
    } finally {
      await releaseDerivedIndexLock();
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
      previous: projectAfterCommandItemSnapshot(
        beforeDocument.metadata,
        mutation.changedFields,
      ),
      current: projectAfterCommandItemSnapshot(
        afterDocument.metadata,
        mutation.changedFields,
      ),
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
        ...derivedIndexWarnings,
        ...hookWarnings,
      ],
    };
  } finally {
    await releaseLock();
  }
}

/** Mutate one item while attaching structured context to its immutable history event. */
export async function mutateItemWithHistoryContext(params: {
  pmRoot: string;
  settings: PmSettings;
  id: string;
  op: string;
  author: string;
  message?: string;
  /** Structured immutable context attached to the appended history entry. */
  historyContext?: Record<string, unknown>;
  force?: boolean;
  bypassAssigneeConflict?: boolean;
  skipNoop?: boolean;
  extensionFieldNames?: readonly string[];
  typeToFolder?: Record<string, string>;
  mutate: (
    document: ItemDocument,
  ) =>
    | { changedFields: string[]; warnings?: string[] }
    | Promise<{ changedFields: string[]; warnings?: string[] }>;
}): Promise<{
  item: ItemMetadata;
  body: string;
  changedFields: string[];
  warnings: string[];
}> {
  const { historyContext, ...mutationParams } = params;
  return mutateItemWithDeferredHistoryContext({
    ...mutationParams,
    resolveHistoryContext: () => historyContext,
  });
}

/** Mutate one item while resolving structured history context after its locked mutation. */
export async function mutateItemWithHistoryContextResolver(
  params: Omit<ItemMutationParams, "historyContext"> & {
    resolveHistoryContext: () => Record<string, unknown> | undefined;
  },
): Promise<ItemMutationResult> {
  return mutateItemWithDeferredHistoryContext(params);
}

/** Implements mutate item for the public runtime surface of this module. */
export function mutateItem(params: {
  pmRoot: string;
  settings: PmSettings;
  id: string;
  op: string;
  author: string;
  message?: string;
  force?: boolean;
  bypassAssigneeConflict?: boolean;
  skipNoop?: boolean;
  extensionFieldNames?: readonly string[];
  typeToFolder?: Record<string, string>;
  mutate: (
    document: ItemDocument,
  ) =>
    | { changedFields: string[]; warnings?: string[] }
    | Promise<{ changedFields: string[]; warnings?: string[] }>;
}): Promise<{
  item: ItemMetadata;
  body: string;
  changedFields: string[];
  warnings: string[];
}>;
/** Mutate one item through the compatibility overload while preserving transactional storage and immutable history semantics. */
export async function mutateItem(
  params: Omit<
    Parameters<typeof mutateItemWithHistoryContext>[0],
    "historyContext"
  >,
): Promise<ItemMutationResult> {
  return mutateItemWithDeferredHistoryContext(params);
}

/** Public contract for item store test only, shared by SDK and presentation-layer consumers. */
export const itemStoreTestOnly = {
  appendWarning,
  bypassesAssigneeConflict,
  buildDidYouMeanSuggestions,
  isErrno,
};

/** Implements delete item for the public runtime surface of this module. */
export async function deleteItem(params: {
  pmRoot: string;
  settings: PmSettings;
  id: string;
  author: string;
  message?: string;
  force?: boolean;
  dryRun?: boolean;
}): Promise<{
  item: ItemMetadata;
  changedFields: string[];
  warnings: string[];
  targetPath?: string;
}> {
  const prepared = await prepareLockedItem({
    pmRoot: params.pmRoot,
    settings: params.settings,
    id: params.id,
    op: "delete",
    author: params.author,
    force: params.force,
  });
  const {
    located,
    originalRaw,
    document,
    warnings: parseWarnings,
    releaseLock,
  } = prepared;

  try {
    const extensionFieldNames = resolveActiveExtensionFieldNames(undefined);
    const beforeDocument = canonicalDocument(document, {
      schema: params.settings.schema,
      extensionFieldNames,
    });
    await runActiveBeforeMutationHooks({
      pm_root: params.pmRoot,
      operation: "delete",
      before: beforeDocument,
      after: null,
      changed_fields: ["deleted"],
      sdk: createMutationGuardSdk({
        pmRoot: params.pmRoot,
        settings: params.settings,
        typeToFolder: prepared.typeToFolder,
      }),
    });
    const historyPolicy = await enforceHistoryStreamPolicyForItem({
      pmRoot: params.pmRoot,
      settings: params.settings,
      itemId: located.id,
      commandLabel: "delete",
    });
    const deletionTimestamp = nowIso();
    const tombstoneDocument =
      EMPTY_CANONICAL_DOCUMENT as unknown as ItemDocument;
    const historyEntry = createHistoryEntry({
      nowIso: deletionTimestamp,
      author: params.author,
      op: "delete",
      before: beforeDocument,
      after: tombstoneDocument,
      message: params.message,
    });
    const historyPath = getHistoryPath(params.pmRoot, located.id);
    const serviceDeleteOverride = await runActiveServiceOverride(
      "item_store_delete",
      {
        op: "delete",
        pm_root: params.pmRoot,
        item_id: located.id,
        item_path: located.itemPath,
        history_path: historyPath,
        before: beforeDocument,
      },
    );
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
      if (
        typeof overrideRecord.item_path === "string" &&
        overrideRecord.item_path.trim().length > 0
      ) {
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
        warnings: [
          ...parseWarnings,
          ...historyPolicy.warnings,
          ...serviceDeleteOverride.warnings,
        ],
      };
    }

    const releaseDerivedIndexLock = await acquireItemMetadataDerivedIndexLock(
      params.pmRoot,
      params.author,
    );
    let derivedIndexWarnings: string[] = [];
    try {
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
      if (!skipDelete) {
        derivedIndexWarnings = await refreshItemMetadataDerivedIndex({
          pmRoot: params.pmRoot,
          preferredFormat: params.settings.item_format,
          typeToFolder: prepared.typeToFolder,
          schema: params.settings.schema,
          itemPath: effectiveItemPath,
          document: null,
        });
      }
    } finally {
      await releaseDerivedIndexLock();
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
      previous: projectAfterCommandItemSnapshot(
        beforeDocument.metadata,
        Object.keys(beforeDocument.metadata),
      ),
      changed_fields: ["deleted"],
    });

    return {
      item: beforeDocument.metadata,
      changedFields: ["deleted"],
      warnings: [
        ...parseWarnings,
        ...historyPolicy.warnings,
        ...serviceDeleteOverride.warnings,
        ...derivedIndexWarnings,
        ...hookWarnings,
      ],
    };
  } finally {
    await releaseLock();
  }
}
