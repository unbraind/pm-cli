/**
 * @module core/store/item-metadata-cache
 *
 * Reads and writes tracker storage with format-aware helpers for the item metadata cache.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  getActiveExtensionRegistrations,
  hasActiveOnReadHooks,
  runActiveOnReadHooks,
} from "../extensions/index.js";
import { collectRegisteredItemFieldNames } from "../extensions/item-fields.js";
import { parseItemDocument } from "../item/item-format.js";
import { evictOldestMemoEntries } from "../shared/memo.js";
import { writeFileAtomic } from "../fs/fs-utils.js";
import { acquireLock } from "../lock/lock.js";
import { ITEM_FILE_EXTENSIONS, getItemFormatFromPath } from "./paths.js";
import {
  rebuildItemMetadataQueryIndex,
  removeItemMetadataQueryIndex,
  updateItemMetadataQueryIndex,
} from "./item-metadata-query-index.js";
import type {
  ItemDocument,
  ItemFormat,
  ItemMetadata,
  RuntimeSchemaSettings,
} from "../../types/index.js";

const CACHE_VERSION = 8;
/** Minimum item count at which derived-index mutations use cross-process locking. */
export const DEFAULT_DERIVED_INDEX_MINIMUM_ITEMS = 500;
const DERIVED_INDEX_LOCK_ID = "metadata-derived-index";
const CACHE_FILENAME = "metadata-cache.json";
const BODY_CACHE_FILENAME = "metadata-cache-bodies.json";
const COLLECTIONS_CACHE_FILENAME = "metadata-cache-collections.json";
const DELTA_CACHE_FILENAME = "metadata-cache-delta.json";
const MANIFEST_CACHE_FILENAME = "metadata-cache-manifest.json";

/** Heavy "collection" item-metadata fields. These arrays dominate the on-disk cache (e.g. a single item's comment thread can be hundreds of KB) yet the hot list path (`pm list`, stats, deps, activity, calendar, close) never reads them. They are stored in a separate collections cache that is parsed only when a caller opts in (`includeCollections`), keeping the always-loaded light cache an order of magnitude smaller and its JSON.parse correspondingly cheaper. */
export const HEAVY_METADATA_KEYS = [
  "comments",
  "notes",
  "learnings",
  "files",
  "tests",
  "test_runs",
  "docs",
] as const;

function resolveActiveExtensionFieldNames(): readonly string[] {
  return collectRegisteredItemFieldNames(getActiveExtensionRegistrations());
}

interface StatSignature {
  mtime_ms: number;
  ctime_ms: number;
  size: number;
}

interface CachedEntry extends StatSignature {
  metadata: ItemMetadata;
  body_length: number;
}

interface CachedBody extends StatSignature {
  body: string;
}

interface CachedCollections extends StatSignature {
  collections: Record<string, unknown>;
}

interface DirectorySignature extends StatSignature {
  exists: boolean;
}

type DirectorySignatures = Record<string, DirectorySignature>;

interface CacheEnvelope {
  version: number;
  context_fingerprint: string;
  source_cursor: string;
  directory_signatures: DirectorySignatures;
  entries: Record<string, CachedEntry>;
}

interface BodyCacheEnvelope {
  version: number;
  context_fingerprint: string;
  source_cursor: string;
  bodies: Record<string, CachedBody>;
}

interface CollectionsCacheEnvelope {
  version: number;
  context_fingerprint: string;
  source_cursor: string;
  collections: Record<string, CachedCollections>;
}

interface DerivedIndexDeltaChange {
  entry: CachedEntry | null;
  body: CachedBody | null;
  collections: CachedCollections | null;
}

interface DerivedIndexDeltaEnvelope {
  version: number;
  context_fingerprint: string;
  base_source_cursor: string;
  source_cursor: string;
  directory_signatures: DirectorySignatures;
  changes: Record<string, DerivedIndexDeltaChange>;
}

interface DerivedIndexManifest {
  version: number;
  context_fingerprint: string;
  source_cursor: string;
  entry_count: number;
  directory_signatures: DirectorySignatures;
}

/** Split parsed item-metadata into the light scalar/small fields (everything except the heavy collection arrays) and the heavy collection fields. Only keys that are actually present are moved, so an item without comments stays without comments in both tiers. */
function splitHeavyMetadata(metadata: ItemMetadata): {
  light: ItemMetadata;
  heavy: Record<string, unknown>;
} {
  const light = { ...metadata } as Record<string, unknown>;
  const heavy: Record<string, unknown> = {};
  for (const key of HEAVY_METADATA_KEYS) {
    if (key in light) {
      heavy[key] = light[key];
      delete light[key];
    }
  }
  return { light: light as ItemMetadata, heavy };
}

/** Recombine light metadata with cached heavy collection fields. Key order differs from the on-disk document, but every downstream hash/serialization canonicalizes and sorts keys (`stableStringify`), so the merged record is byte-identical once hashed. */
function mergeHeavyMetadata(
  light: ItemMetadata,
  heavy: Record<string, unknown> | undefined,
): ItemMetadata {
  if (!heavy || Object.keys(heavy).length === 0) {
    return light;
  }
  return { ...light, ...heavy } as ItemMetadata;
}

/** Documents the cached document candidate payload exchanged by command, SDK, and package integrations. */
export interface CachedDocumentCandidate {
  /** Value that configures or reports metadata for this contract. */
  metadata: ItemMetadata;
  /** Value that configures or reports body for this contract. */
  body?: string;
  /** Value that configures or reports item format for this contract. */
  item_format: ItemFormat;
  /** Filesystem path used for item resolution. */
  item_path: string;
}

function computeContextFingerprint(
  preferredFormat: ItemFormat | undefined,
  typeToFolder: Record<string, string>,
  schema: RuntimeSchemaSettings | undefined,
  extensionFieldNames: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update(`format:${preferredFormat ?? "default"}`);
  const sortedTypes = Object.entries(typeToFolder)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, folder]) => `${type}=${folder}`)
    .join(",");
  hash.update(`|types:${sortedTypes}`);
  if (schema) {
    hash.update(`|schema:${JSON.stringify(schema)}`);
  }
  if (extensionFieldNames.length > 0) {
    hash.update(`|extension_fields:${extensionFieldNames.join(",")}`);
  }
  return hash.digest("hex").slice(0, 16);
}

function getCachePath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", CACHE_FILENAME);
}

function getBodyCachePath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", BODY_CACHE_FILENAME);
}

function getCollectionsCachePath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", COLLECTIONS_CACHE_FILENAME);
}

function getDeltaCachePath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", DELTA_CACHE_FILENAME);
}

function getManifestCachePath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", MANIFEST_CACHE_FILENAME);
}

interface MemoizedEnvelope {
  signature: StatSignature;
  envelope:
    | CacheEnvelope
    | BodyCacheEnvelope
    | CollectionsCacheEnvelope
    | DerivedIndexDeltaEnvelope
    | DerivedIndexManifest
    | null;
}

/**
 * In-process memo of parsed cache envelopes keyed by cache file path and validated
 * against the file's stat signature on every load. Commands that scan the corpus more
 * than once per invocation (`pm next`, `pm context`) and long-lived in-process hosts
 * (the MCP server) would otherwise re-read and re-parse multi-megabyte JSON on every
 * scan. Envelopes handed out from the memo are shared, so they must be treated as
 * read-only — the write path always goes through `mutateItem` on a `structuredClone`d
 * document parsed fresh from the item file, never through listed cache metadata.
 *
 * The cap bounds memory when one long-lived process serves many project roots
 * (3 envelopes per root). Hits re-insert their entry so Map insertion order tracks
 * recency, making the half-eviction drop the least-recently-used roots.
 */
const ENVELOPE_MEMO_MAX_ENTRIES = 24;
const envelopeMemo = new Map<string, MemoizedEnvelope>();
const projectedBaseCursor = new WeakMap<object, string>();

function baseCursorFor(
  envelope: CacheEnvelope | BodyCacheEnvelope | CollectionsCacheEnvelope,
): string {
  return projectedBaseCursor.get(envelope) ?? envelope.source_cursor;
}

function applyMetadataDelta(
  envelope: CacheEnvelope,
  delta: DerivedIndexDeltaEnvelope,
): void {
  const baseCursor = baseCursorFor(envelope);
  if (
    delta.base_source_cursor !== baseCursor ||
    envelope.source_cursor === delta.source_cursor
  ) {
    return;
  }
  projectedBaseCursor.set(envelope, baseCursor);
  for (const [relativePath, change] of Object.entries(delta.changes)) {
    if (change.entry) envelope.entries[relativePath] = change.entry;
    else delete envelope.entries[relativePath];
  }
  envelope.directory_signatures = delta.directory_signatures;
  envelope.source_cursor = delta.source_cursor;
}

function applyBodyDelta(
  envelope: BodyCacheEnvelope | null,
  delta: DerivedIndexDeltaEnvelope,
): void {
  if (!envelope) return;
  const baseCursor = baseCursorFor(envelope);
  if (
    delta.base_source_cursor !== baseCursor ||
    envelope.source_cursor === delta.source_cursor
  ) {
    return;
  }
  projectedBaseCursor.set(envelope, baseCursor);
  for (const [relativePath, change] of Object.entries(delta.changes)) {
    if (change.body) envelope.bodies[relativePath] = change.body;
    else delete envelope.bodies[relativePath];
  }
  envelope.source_cursor = delta.source_cursor;
}

function applyCollectionsDelta(
  envelope: CollectionsCacheEnvelope | null,
  delta: DerivedIndexDeltaEnvelope,
): void {
  if (!envelope) return;
  const baseCursor = baseCursorFor(envelope);
  if (
    delta.base_source_cursor !== baseCursor ||
    envelope.source_cursor === delta.source_cursor
  ) {
    return;
  }
  projectedBaseCursor.set(envelope, baseCursor);
  for (const [relativePath, change] of Object.entries(delta.changes)) {
    if (change.collections)
      envelope.collections[relativePath] = change.collections;
    else delete envelope.collections[relativePath];
  }
  envelope.source_cursor = delta.source_cursor;
}

function applyDerivedIndexDelta(
  metadata: CacheEnvelope | null,
  bodies: BodyCacheEnvelope | null,
  collections: CollectionsCacheEnvelope | null,
  delta: DerivedIndexDeltaEnvelope | null,
): void {
  if (
    !metadata ||
    !delta ||
    metadata.context_fingerprint !== delta.context_fingerprint
  ) {
    return;
  }
  applyMetadataDelta(metadata, delta);
  applyBodyDelta(bodies, delta);
  applyCollectionsDelta(collections, delta);
}

function memoizeEnvelope(cachePath: string, entry: MemoizedEnvelope): void {
  if (
    envelopeMemo.size >= ENVELOPE_MEMO_MAX_ENTRIES &&
    !envelopeMemo.has(cachePath)
  ) {
    evictOldestMemoEntries(envelopeMemo);
  }
  envelopeMemo.set(cachePath, entry);
}

async function loadEnvelopeMemoized<T extends MemoizedEnvelope["envelope"]>(
  cachePath: string,
  parse: (raw: string) => T,
): Promise<T> {
  let stat;
  try {
    stat = await fs.stat(cachePath);
  } catch {
    envelopeMemo.delete(cachePath);
    return null as T;
  }
  const memoized = envelopeMemo.get(cachePath);
  if (
    memoized &&
    statMatches(memoized.signature, stat.mtimeMs, stat.ctimeMs, stat.size)
  ) {
    // Re-insert on hit so insertion order tracks recency for the LRU half-eviction.
    envelopeMemo.delete(cachePath);
    envelopeMemo.set(cachePath, memoized);
    return memoized.envelope as T;
  }
  let envelope: T;
  try {
    envelope = parse(await fs.readFile(cachePath, "utf8"));
  } catch {
    envelope = null as T;
  }
  memoizeEnvelope(cachePath, {
    signature: {
      mtime_ms: stat.mtimeMs,
      ctime_ms: stat.ctimeMs,
      size: stat.size,
    },
    envelope,
  });
  return envelope;
}

/**
 * Drop memoized envelopes. Exposed for tests; production invalidation is stat-driven
 * plus the explicit delete in {@link persistCache} after a rewrite.
 */
export function clearItemMetadataEnvelopeMemo(): void {
  envelopeMemo.clear();
}

async function loadCache(pmRoot: string): Promise<CacheEnvelope | null> {
  return await loadEnvelopeMemoized(getCachePath(pmRoot), (raw) => {
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (
      parsed.version !== CACHE_VERSION ||
      typeof parsed.source_cursor !== "string" ||
      typeof parsed.entries !== "object" ||
      parsed.entries === null
    ) {
      return null;
    }
    return parsed;
  });
}

async function loadBodyCache(
  pmRoot: string,
): Promise<BodyCacheEnvelope | null> {
  return await loadEnvelopeMemoized(getBodyCachePath(pmRoot), (raw) => {
    const parsed = JSON.parse(raw) as BodyCacheEnvelope;
    if (
      parsed.version !== CACHE_VERSION ||
      typeof parsed.source_cursor !== "string" ||
      typeof parsed.bodies !== "object" ||
      parsed.bodies === null
    ) {
      return null;
    }
    return parsed;
  });
}

async function loadCollectionsCache(
  pmRoot: string,
): Promise<CollectionsCacheEnvelope | null> {
  return await loadEnvelopeMemoized(getCollectionsCachePath(pmRoot), (raw) => {
    const parsed = JSON.parse(raw) as CollectionsCacheEnvelope;
    if (
      parsed.version !== CACHE_VERSION ||
      typeof parsed.source_cursor !== "string" ||
      typeof parsed.collections !== "object" ||
      parsed.collections === null
    ) {
      return null;
    }
    return parsed;
  });
}

async function loadDerivedIndexDelta(pmRoot: string): Promise<{
  envelope: DerivedIndexDeltaEnvelope | null;
  invalid: boolean;
}> {
  const deltaPath = getDeltaCachePath(pmRoot);
  const envelope = await loadEnvelopeMemoized(deltaPath, (raw) => {
    const parsed = JSON.parse(raw) as DerivedIndexDeltaEnvelope;
    if (
      parsed.version !== CACHE_VERSION ||
      typeof parsed.base_source_cursor !== "string" ||
      typeof parsed.source_cursor !== "string" ||
      typeof parsed.changes !== "object" ||
      parsed.changes === null
    ) {
      return null;
    }
    return parsed;
  });
  if (envelope) return { envelope, invalid: false };
  try {
    await fs.stat(deltaPath);
    return { envelope: null, invalid: true };
  } catch {
    return { envelope: null, invalid: false };
  }
}

async function loadDerivedIndexManifest(
  pmRoot: string,
): Promise<DerivedIndexManifest | null> {
  const manifestPath = getManifestCachePath(pmRoot);
  const manifest = await loadEnvelopeMemoized(manifestPath, (raw) => {
    const parsed = JSON.parse(raw) as DerivedIndexManifest;
    if (
      parsed.version !== CACHE_VERSION ||
      typeof parsed.context_fingerprint !== "string" ||
      typeof parsed.source_cursor !== "string" ||
      !Number.isInteger(parsed.entry_count) ||
      parsed.entry_count < 0 ||
      typeof parsed.directory_signatures !== "object" ||
      parsed.directory_signatures === null
    ) {
      return null;
    }
    return parsed;
  });
  if (manifest) return manifest;
  try {
    await fs.stat(manifestPath);
    await removeDerivedIndexFiles(pmRoot);
  } catch {
    // Missing manifests are the normal pre-index and small-workspace state.
  }
  return null;
}

async function persistCache(
  cachePath: string,
  envelope:
    | CacheEnvelope
    | BodyCacheEnvelope
    | CollectionsCacheEnvelope
    | DerivedIndexDeltaEnvelope
    | DerivedIndexManifest,
): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await writeFileAtomic(cachePath, JSON.stringify(envelope));
  // Repopulate the memo with the just-written envelope so the next read after a
  // write skips the cold re-read; fall back to plain invalidation when the fresh
  // stat signature cannot be captured.
  try {
    const stat = await fs.stat(cachePath);
    memoizeEnvelope(cachePath, {
      signature: {
        mtime_ms: stat.mtimeMs,
        ctime_ms: stat.ctimeMs,
        size: stat.size,
      },
      envelope,
    });
  } catch {
    envelopeMemo.delete(cachePath);
  }
}

/**
 * Decide whether a freshly parsed document candidate should replace the one
 * already recorded for the same item id when both an explicit-format file and a
 * fallback-format file exist (e.g. `pm-x.toon` and `pm-x.md`). An explicit
 * `preferredFormat` wins; otherwise `toon` wins over any non-toon format.
 *
 * This is a pure decision so the winner is fully deterministic regardless of the
 * order in which the concurrent per-file reads resolve — the inline call site
 * populates the map as each async read completes, so without a pure rule the
 * branch taken (and thus its coverage) would race. Keep this exported and
 * unit-tested across every format combination.
 */
export function shouldReplaceCachedDocumentCandidate(
  existingFormat: ItemFormat,
  candidateFormat: ItemFormat,
  preferredFormat: ItemFormat | undefined,
): boolean {
  if (preferredFormat) {
    return (
      candidateFormat === preferredFormat && existingFormat !== preferredFormat
    );
  }
  return candidateFormat === "toon" && existingFormat !== "toon";
}

/** Decide whether a scanned candidate should be recorded for its item id. An unseen id is always recorded; duplicate ids delegate to the deterministic cross-format preference rule. Keeping the short-circuit in this pure helper makes both outcomes testable without relying on filesystem enumeration or concurrent read completion order. */
export function shouldRecordCachedDocumentCandidate(
  existingFormat: ItemFormat | undefined,
  candidateFormat: ItemFormat,
  preferredFormat: ItemFormat | undefined,
): boolean {
  return (
    existingFormat === undefined ||
    shouldReplaceCachedDocumentCandidate(
      existingFormat,
      candidateFormat,
      preferredFormat,
    )
  );
}

function appendWarning(warnings: string[] | undefined, warning: string): void {
  if (warnings && !warnings.includes(warning)) {
    warnings.push(warning);
  }
}

function statMatches(
  signature: StatSignature,
  mtimeMs: number,
  ctimeMs: number,
  size: number,
): boolean {
  return (
    signature.mtime_ms === mtimeMs &&
    signature.ctime_ms === ctimeMs &&
    signature.size === size
  );
}

interface DocumentCacheMissState {
  metadata: boolean;
  body: boolean;
  collections: boolean;
}

interface DocumentCacheMutableState {
  newEntries: Record<string, CachedEntry>;
  newBodies: Record<string, CachedBody>;
  newCollections: Record<string, CachedCollections>;
  documentsById: Map<
    string,
    { candidate: CachedDocumentCandidate; itemFormat: ItemFormat }
  >;
  misses: DocumentCacheMissState;
}

interface DocumentCacheReadContext {
  pmRoot: string;
  preferredFormat: ItemFormat | undefined;
  warnings: string[] | undefined;
  schema: RuntimeSchemaSettings | undefined;
  extensionFieldNames: readonly string[];
  includeBody: boolean;
  includeCollections: boolean;
  dispatchReadHooks: boolean;
  previousEntries: Record<string, CachedEntry>;
  previousBodies: Record<string, CachedBody>;
  previousCollections: Record<string, CachedCollections>;
  state: DocumentCacheMutableState;
}

interface CachedDocumentReadParts {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  itemFormat: ItemFormat;
  lightMetadata: ItemMetadata;
  heavyMetadata: Record<string, unknown> | undefined;
  bodyLength: number;
  body: string | undefined;
}

async function readItemDirectoryFiles(
  pmRoot: string,
  folder: string,
  warnings: string[] | undefined,
): Promise<{ folder: string; dirPath: string; files: string[] }> {
  const dirPath = path.join(pmRoot, folder);
  try {
    const files = await fs.readdir(dirPath);
    return { folder, dirPath, files };
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code !== "ENOENT"
    ) {
      appendWarning(warnings, `item_list_directory_read_failed:${folder}`);
    }
    return { folder, dirPath, files: [] };
  }
}

async function readDirectorySignature(
  pmRoot: string,
  folder: string,
): Promise<[string, DirectorySignature]> {
  try {
    const stat = await fs.stat(path.join(pmRoot, folder));
    return [
      folder,
      {
        exists: true,
        mtime_ms: stat.mtimeMs,
        ctime_ms: stat.ctimeMs,
        size: stat.size,
      },
    ];
  } catch {
    return [folder, { exists: false, mtime_ms: 0, ctime_ms: 0, size: 0 }];
  }
}

async function readDirectorySignatures(
  pmRoot: string,
  folders: readonly string[],
): Promise<DirectorySignatures> {
  return Object.fromEntries(
    await Promise.all(
      folders.map(
        async (folder) => await readDirectorySignature(pmRoot, folder),
      ),
    ),
  );
}

function directorySignaturesMatch(
  left: DirectorySignatures | undefined,
  right: DirectorySignatures,
): boolean {
  if (!left || Object.keys(left).length !== Object.keys(right).length) {
    return false;
  }
  return Object.entries(right).every(([folder, signature]) => {
    const previous = left[folder];
    return (
      previous !== undefined &&
      previous.exists === signature.exists &&
      statMatches(
        previous,
        signature.mtime_ms,
        signature.ctime_ms,
        signature.size,
      )
    );
  });
}

function isItemDocumentFile(file: string): boolean {
  return ITEM_FILE_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext));
}

function markDocumentCacheMisses(
  misses: DocumentCacheMissState,
  includeBody: boolean,
  includeCollections: boolean,
  metadataCached: boolean,
  bodyCached: boolean,
  collectionsCached: boolean,
): void {
  if (!metadataCached) {
    misses.metadata = true;
  }
  if (includeBody && !bodyCached) {
    misses.body = true;
  }
  if (includeCollections && !collectionsCached) {
    misses.collections = true;
  }
}

async function dispatchCachedDocumentReadHooks(
  filePath: string,
  warnings: string[] | undefined,
  dispatchReadHooks: boolean,
): Promise<void> {
  if (!dispatchReadHooks) {
    return;
  }
  for (const warning of await runActiveOnReadHooks({
    path: filePath,
    scope: "project",
  })) {
    appendWarning(warnings, warning);
  }
}

function selectHeavyMetadata(
  includeCollections: boolean,
  collectionsCached: boolean,
  cachedCollections: CachedCollections | undefined,
  parsedCollections: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!includeCollections) {
    return undefined;
  }
  return collectionsCached && cachedCollections
    ? cachedCollections.collections
    : parsedCollections;
}

async function readCachedDocumentParts(
  filePath: string,
  relativePath: string,
  context: DocumentCacheReadContext,
): Promise<CachedDocumentReadParts> {
  const stat = await fs.stat(filePath);
  const mtimeMs = stat.mtimeMs;
  const ctimeMs = stat.ctimeMs;
  const { size } = stat;
  const itemFormat = getItemFormatFromPath(filePath) as ItemFormat;

  await dispatchCachedDocumentReadHooks(
    filePath,
    context.warnings,
    context.dispatchReadHooks,
  );

  const cachedEntry = context.previousEntries[relativePath];
  const metadataCached =
    cachedEntry !== undefined &&
    statMatches(cachedEntry, mtimeMs, ctimeMs, size);
  const cachedBody = context.previousBodies[relativePath];
  const bodyCached =
    cachedBody !== undefined && statMatches(cachedBody, mtimeMs, ctimeMs, size);
  const cachedCollections = context.previousCollections[relativePath];
  const collectionsCached =
    cachedCollections !== undefined &&
    statMatches(cachedCollections, mtimeMs, ctimeMs, size);
  const needRead =
    !metadataCached ||
    (context.includeBody && !bodyCached) ||
    (context.includeCollections && !collectionsCached);

  if (!needRead) {
    return {
      mtimeMs,
      ctimeMs,
      size,
      itemFormat,
      lightMetadata: cachedEntry.metadata,
      heavyMetadata: selectHeavyMetadata(
        context.includeCollections,
        collectionsCached,
        cachedCollections,
        undefined,
      ),
      bodyLength: cachedEntry.body_length,
      body: context.includeBody ? cachedBody.body : undefined,
    };
  }

  const raw = await fs.readFile(filePath, "utf8");
  const parsed = parseItemDocument(raw, {
    format: itemFormat,
    schema: context.schema,
    extensionFieldNames: context.extensionFieldNames,
    onWarning: (warning) => appendWarning(context.warnings, warning),
  });
  const split = splitHeavyMetadata(parsed.metadata);
  markDocumentCacheMisses(
    context.state.misses,
    context.includeBody,
    context.includeCollections,
    metadataCached,
    bodyCached,
    collectionsCached,
  );
  return {
    mtimeMs,
    ctimeMs,
    size,
    itemFormat,
    lightMetadata: metadataCached ? cachedEntry.metadata : split.light,
    heavyMetadata: selectHeavyMetadata(
      context.includeCollections,
      collectionsCached,
      cachedCollections,
      split.heavy,
    ),
    bodyLength: metadataCached ? cachedEntry.body_length : parsed.body.length,
    body: context.includeBody ? parsed.body : undefined,
  };
}

function recordCachedDocumentCandidate(
  filePath: string,
  relativePath: string,
  context: DocumentCacheReadContext,
  parts: CachedDocumentReadParts,
): void {
  context.state.newEntries[relativePath] = {
    mtime_ms: parts.mtimeMs,
    ctime_ms: parts.ctimeMs,
    size: parts.size,
    metadata: parts.lightMetadata,
    body_length: parts.bodyLength,
  };
  if (context.includeBody && parts.body !== undefined) {
    context.state.newBodies[relativePath] = {
      mtime_ms: parts.mtimeMs,
      ctime_ms: parts.ctimeMs,
      size: parts.size,
      body: parts.body,
    };
  }
  if (context.includeCollections && parts.heavyMetadata !== undefined) {
    context.state.newCollections[relativePath] = {
      mtime_ms: parts.mtimeMs,
      ctime_ms: parts.ctimeMs,
      size: parts.size,
      collections: parts.heavyMetadata,
    };
  }

  const metadata = context.includeCollections
    ? mergeHeavyMetadata(parts.lightMetadata, parts.heavyMetadata)
    : parts.lightMetadata;
  const existing = context.state.documentsById.get(metadata.id);
  const candidate: CachedDocumentCandidate = {
    metadata,
    body: parts.body,
    item_format: parts.itemFormat,
    item_path: filePath,
  };
  if (
    shouldRecordCachedDocumentCandidate(
      existing?.itemFormat,
      parts.itemFormat,
      context.preferredFormat,
    )
  ) {
    context.state.documentsById.set(metadata.id, {
      candidate,
      itemFormat: parts.itemFormat,
    });
  }
}

async function processCachedDocumentFile(
  folder: string,
  filePath: string,
  relativePath: string,
  context: DocumentCacheReadContext,
): Promise<void> {
  try {
    const parts = await readCachedDocumentParts(
      filePath,
      relativePath,
      context,
    );
    recordCachedDocumentCandidate(filePath, relativePath, context, parts);
  } catch {
    appendWarning(
      context.warnings,
      `item_list_item_read_failed:${folder}/${path.basename(filePath)}`,
    );
  }
}

function selectPreviousMetadataEntries(
  existingCache: CacheEnvelope | null,
  contextFingerprint: string,
): Record<string, CachedEntry> {
  return existingCache &&
    existingCache.context_fingerprint === contextFingerprint
    ? existingCache.entries
    : {};
}

function selectPreviousBodyEntries(
  existingBodyCache: BodyCacheEnvelope | null,
  contextFingerprint: string,
): Record<string, CachedBody> {
  return existingBodyCache &&
    existingBodyCache.context_fingerprint === contextFingerprint
    ? existingBodyCache.bodies
    : {};
}

function selectPreviousCollectionEntries(
  existingCollectionsCache: CollectionsCacheEnvelope | null,
  contextFingerprint: string,
): Record<string, CachedCollections> {
  return existingCollectionsCache &&
    existingCollectionsCache.context_fingerprint === contextFingerprint
    ? existingCollectionsCache.collections
    : {};
}

function createDocumentCacheMutableState(): DocumentCacheMutableState {
  return {
    newEntries: {},
    newBodies: {},
    newCollections: {},
    documentsById: new Map<
      string,
      { candidate: CachedDocumentCandidate; itemFormat: ItemFormat }
    >(),
    misses: {
      metadata: false,
      body: false,
      collections: false,
    },
  };
}

function collectCachedDocumentParseTasks(
  dirResults: Array<{ folder: string; dirPath: string; files: string[] }>,
  context: DocumentCacheReadContext,
): Array<Promise<void>> {
  const parseTasks: Array<Promise<void>> = [];
  for (const { folder, dirPath, files } of dirResults) {
    for (const file of files) {
      if (!isItemDocumentFile(file)) {
        continue;
      }
      const filePath = path.join(dirPath, file);
      const relativePath = path.relative(context.pmRoot, filePath);
      parseTasks.push(
        processCachedDocumentFile(folder, filePath, relativePath, context),
      );
    }
  }
  return parseTasks;
}

async function persistMetadataCacheIfNeeded(params: {
  pmRoot: string;
  contextFingerprint: string;
  sourceCursor: string;
  existingCache: CacheEnvelope | null;
  previousEntries: Record<string, CachedEntry>;
  directorySignatures: DirectorySignatures;
  state: DocumentCacheMutableState;
  minimumIndexedItems: number;
}): Promise<void> {
  const metadataDirty =
    params.state.misses.metadata ||
    Object.keys(params.previousEntries).length !==
      Object.keys(params.state.newEntries).length ||
    !directorySignaturesMatch(
      params.existingCache?.directory_signatures,
      params.directorySignatures,
    );
  if (
    !metadataDirty &&
    params.existingCache !== null &&
    params.existingCache.context_fingerprint === params.contextFingerprint
  ) {
    return;
  }
  try {
    await persistCache(getCachePath(params.pmRoot), {
      version: CACHE_VERSION,
      context_fingerprint: params.contextFingerprint,
      source_cursor: params.sourceCursor,
      directory_signatures: params.directorySignatures,
      entries: params.state.newEntries,
    });
    await persistCache(getManifestCachePath(params.pmRoot), {
      version: CACHE_VERSION,
      context_fingerprint: params.contextFingerprint,
      source_cursor: params.sourceCursor,
      entry_count: Object.keys(params.state.newEntries).length,
      directory_signatures: params.directorySignatures,
    });
    const rows = [...params.state.documentsById.values()].map(
      ({ candidate }) => ({
        relativePath: path.relative(params.pmRoot, candidate.item_path),
        metadata: splitHeavyMetadata(candidate.metadata).light,
      }),
    );
    if (rows.length >= params.minimumIndexedItems) {
      await rebuildItemMetadataQueryIndex({
        pmRoot: params.pmRoot,
        contextFingerprint: params.contextFingerprint,
        sourceCursor: params.sourceCursor,
        rows,
      });
    } else {
      await removeItemMetadataQueryIndex(params.pmRoot);
    }
  } catch {
    // Cache persistence is best-effort; authoritative item reads rebuild it.
  }
}

async function persistBodyCacheIfNeeded(params: {
  pmRoot: string;
  contextFingerprint: string;
  sourceCursor: string;
  existingBodyCache: BodyCacheEnvelope | null;
  previousBodies: Record<string, CachedBody>;
  state: DocumentCacheMutableState;
}): Promise<void> {
  const bodyDirty =
    params.state.misses.body ||
    Object.keys(params.previousBodies).length !==
      Object.keys(params.state.newBodies).length;
  if (
    !bodyDirty &&
    params.existingBodyCache !== null &&
    params.existingBodyCache.context_fingerprint === params.contextFingerprint
  ) {
    return;
  }
  await persistCache(getBodyCachePath(params.pmRoot), {
    version: CACHE_VERSION,
    context_fingerprint: params.contextFingerprint,
    source_cursor: params.sourceCursor,
    bodies: params.state.newBodies,
  }).catch(() => {});
}

async function persistCollectionsCacheIfNeeded(params: {
  pmRoot: string;
  contextFingerprint: string;
  sourceCursor: string;
  existingCollectionsCache: CollectionsCacheEnvelope | null;
  previousCollections: Record<string, CachedCollections>;
  state: DocumentCacheMutableState;
}): Promise<void> {
  const collectionsDirty =
    params.state.misses.collections ||
    Object.keys(params.previousCollections).length !==
      Object.keys(params.state.newCollections).length;
  if (
    !collectionsDirty &&
    params.existingCollectionsCache !== null &&
    params.existingCollectionsCache.context_fingerprint ===
      params.contextFingerprint
  ) {
    return;
  }
  await persistCache(getCollectionsCachePath(params.pmRoot), {
    version: CACHE_VERSION,
    context_fingerprint: params.contextFingerprint,
    source_cursor: params.sourceCursor,
    collections: params.state.newCollections,
  }).catch(() => {});
}

/** Acquire the cross-process derived-index writer lock when an index exists. */
export async function acquireItemMetadataDerivedIndexLock(
  pmRoot: string,
  author: string,
): Promise<() => Promise<void>> {
  const cache = await loadDerivedIndexManifest(pmRoot);
  if (
    cache === null ||
    cache.entry_count < DEFAULT_DERIVED_INDEX_MINIMUM_ITEMS
  ) {
    return async () => {};
  }
  return acquireLock(
    pmRoot,
    DERIVED_INDEX_LOCK_ID,
    30,
    author,
    false,
    false,
    3_000,
  );
}

/** One authoritative item commit projected into the rebuildable index. */
export interface ItemMetadataDerivedIndexMutation {
  /** Tracker root containing the derived cache. */
  pmRoot: string;
  /** Preferred item format folded into the cache schema fingerprint. */
  preferredFormat: ItemFormat | undefined;
  /** Runtime item-type folder mapping. */
  typeToFolder: Record<string, string>;
  /** Runtime schema folded into the cache schema fingerprint. */
  schema: RuntimeSchemaSettings | undefined;
  /** Committed item path, or deleted item path when document is null. */
  itemPath: string;
  /** Previous path removed by a format or type migration. */
  previousItemPath?: string;
  /** Committed document, or null for deletion. */
  document: ItemDocument | null;
}

/** Read-only identity of the effective rebuildable metadata projection. */
export interface ItemMetadataDerivedIndexState {
  /** Cursor shared by the base manifest and its collapsed mutation delta. */
  source_cursor: string;
  /** Number of authoritative rows recorded when the base manifest was built. */
  entry_count: number;
}

/** Read the effective derived-index cursor without exposing cache file layout. */
export async function readItemMetadataDerivedIndexState(
  pmRoot: string,
  folders?: readonly string[],
): Promise<ItemMetadataDerivedIndexState | null> {
  const manifest = await loadDerivedIndexManifest(pmRoot);
  if (manifest === null) return null;
  const delta = await loadDerivedIndexDelta(pmRoot);
  if (delta.invalid) {
    await removeDerivedIndexFiles(pmRoot);
    return null;
  }
  const effectiveCursor =
    delta.envelope?.context_fingerprint === manifest.context_fingerprint &&
    delta.envelope.base_source_cursor === manifest.source_cursor
      ? delta.envelope.source_cursor
      : manifest.source_cursor;
  const effectiveDirectorySignatures =
    delta.envelope?.context_fingerprint === manifest.context_fingerprint &&
    delta.envelope.base_source_cursor === manifest.source_cursor
      ? delta.envelope.directory_signatures
      : manifest.directory_signatures;
  if (
    folders &&
    !directorySignaturesMatch(
      effectiveDirectorySignatures,
      await readDirectorySignatures(pmRoot, folders),
    )
  ) {
    return null;
  }
  return { source_cursor: effectiveCursor, entry_count: manifest.entry_count };
}

function relativeIndexPath(pmRoot: string, itemPath: string): string | null {
  const relative = path.relative(pmRoot, itemPath);
  return relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
    ? null
    : relative;
}

async function removeDerivedIndexFiles(pmRoot: string): Promise<void> {
  await Promise.all(
    [
      getCachePath(pmRoot),
      getBodyCachePath(pmRoot),
      getCollectionsCachePath(pmRoot),
      getDeltaCachePath(pmRoot),
      getManifestCachePath(pmRoot),
    ].map(async (cachePath) => {
      await fs.rm(cachePath, { force: true });
      envelopeMemo.delete(cachePath);
    }),
  );
  await removeItemMetadataQueryIndex(pmRoot);
}

async function createDerivedIndexDeltaChange(params: {
  mutation: ItemMetadataDerivedIndexMutation;
}): Promise<DerivedIndexDeltaChange> {
  if (params.mutation.document === null) {
    return { entry: null, body: null, collections: null };
  }
  const stat = await fs.stat(params.mutation.itemPath);
  const split = splitHeavyMetadata(params.mutation.document.metadata);
  const signature = {
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    size: stat.size,
  };
  return {
    entry: {
      ...signature,
      metadata: split.light,
      body_length: params.mutation.document.body.length,
    },
    body: { ...signature, body: params.mutation.document.body },
    collections: {
      ...signature,
      collections: split.heavy,
    },
  };
}

function selectDerivedIndexDeltaChanges(
  delta: DerivedIndexDeltaEnvelope | null,
  contextFingerprint: string,
  baseSourceCursor: string,
): Record<string, DerivedIndexDeltaChange> {
  return delta?.context_fingerprint === contextFingerprint &&
    delta.base_source_cursor === baseSourceCursor
    ? structuredClone(delta.changes)
    : {};
}

/**
 * Project one already-committed authoritative item write into every compatible
 * derived-index tier. Callers hold {@link acquireItemMetadataDerivedIndexLock}
 * from before the item write until this function finishes, so independent pm
 * mutations cannot publish a cursor that omits a concurrent write. One small
 * atomic delta carries the shared source cursor and all tier projections, so
 * mutation cost is bounded by changed items instead of total workspace size.
 * Any refresh failure deletes the rebuildable cache so the next read scans.
 */
export async function refreshItemMetadataDerivedIndex(
  mutation: ItemMetadataDerivedIndexMutation,
): Promise<string[]> {
  const relativePath = relativeIndexPath(mutation.pmRoot, mutation.itemPath);
  const previousRelativePath = mutation.previousItemPath
    ? relativeIndexPath(mutation.pmRoot, mutation.previousItemPath)
    : undefined;
  if (relativePath === null || previousRelativePath === null) {
    await removeDerivedIndexFiles(mutation.pmRoot);
    return ["metadata_derived_index_path_invalidated"];
  }
  try {
    const contextFingerprint = computeContextFingerprint(
      mutation.preferredFormat,
      mutation.typeToFolder,
      mutation.schema,
      resolveActiveExtensionFieldNames(),
    );
    const existingCache = await loadDerivedIndexManifest(mutation.pmRoot);
    if (
      existingCache === null ||
      existingCache.context_fingerprint !== contextFingerprint
    ) {
      return [];
    }
    const baseSourceCursor = existingCache.source_cursor;
    const delta = await loadDerivedIndexDelta(mutation.pmRoot);
    if (delta.invalid) {
      await removeDerivedIndexFiles(mutation.pmRoot);
      return ["metadata_derived_index_refresh_failed"];
    }
    const changes = selectDerivedIndexDeltaChanges(
      delta.envelope,
      contextFingerprint,
      baseSourceCursor,
    );
    const expectedSourceCursor =
      delta.envelope?.context_fingerprint === contextFingerprint &&
      delta.envelope.base_source_cursor === baseSourceCursor
        ? delta.envelope.source_cursor
        : baseSourceCursor;
    if (previousRelativePath !== undefined) {
      changes[previousRelativePath] = {
        entry: null,
        body: null,
        collections: null,
      };
    }
    changes[relativePath] = await createDerivedIndexDeltaChange({ mutation });
    const sourceCursor = randomUUID();
    await persistCache(getDeltaCachePath(mutation.pmRoot), {
      version: CACHE_VERSION,
      context_fingerprint: contextFingerprint,
      base_source_cursor: baseSourceCursor,
      source_cursor: sourceCursor,
      directory_signatures: await readDirectorySignatures(mutation.pmRoot, [
        ...new Set(Object.values(mutation.typeToFolder)),
      ]),
      changes,
    });
    const queryIndexUpdated = await updateItemMetadataQueryIndex({
      pmRoot: mutation.pmRoot,
      contextFingerprint,
      expectedSourceCursor,
      sourceCursor,
      row:
        mutation.document === null
          ? null
          : {
              relativePath,
              metadata: splitHeavyMetadata(mutation.document.metadata).light,
            },
      deletedRelativePaths: [
        ...(previousRelativePath === undefined ? [] : [previousRelativePath]),
        ...(mutation.document === null ? [relativePath] : []),
      ],
    });
    if (!queryIndexUpdated) {
      await removeItemMetadataQueryIndex(mutation.pmRoot);
    }
    return [];
  } catch {
    await removeDerivedIndexFiles(mutation.pmRoot).catch(() => {});
    return ["metadata_derived_index_refresh_failed"];
  }
}

function sortedCachedDocumentCandidates(
  state: DocumentCacheMutableState,
): CachedDocumentCandidate[] {
  return [...state.documentsById.values()]
    .sort((left, right) =>
      left.candidate.metadata.id.localeCompare(right.candidate.metadata.id),
    )
    .map((entry) => entry.candidate);
}

/** Documents the list cache options payload exchanged by command, SDK, and package integrations. */
export interface ListCacheOptions {
  /** When false, item bodies are neither loaded from nor written to the separate body cache. Metadata-only callers (`pm list`, stats, deps, activity, …) skip the large body cache entirely; only body consumers (search/reindex) pay for it. */
  includeBody?: boolean;
  /** When false, heavy collection fields (comments/notes/learnings/files/tests/ test_runs/docs) are neither loaded from nor written to the separate collections cache, and are absent from the returned metadata. Light-only callers (`pm list` compact, stats, deps, activity, calendar, close) skip the large collections cache entirely. Defaults to true so any caller that does read those fields stays correct. */
  includeCollections?: boolean;
  /** Force canonical item enumeration and stat validation even when a fresh derived index is available. Validation, repair, migration, and equivalence tests use this correctness path. */
  forceSourceScan?: boolean;
  /** Minimum item count required before the directory-signature derived-index fast path is used. Defaults to 500 so small workspaces preserve per-file external-edit detection; tests and specialized SDK hosts may lower it explicitly. */
  derivedIndexMinimumItems?: number;
}

function cacheTierMatchesContext(
  envelope: BodyCacheEnvelope | CollectionsCacheEnvelope | null,
  contextFingerprint: string,
  sourceCursor: string,
): boolean {
  return (
    envelope?.context_fingerprint === contextFingerprint &&
    envelope.source_cursor === sourceCursor
  );
}

function hasEveryDerivedIndexPart(
  keys: readonly string[],
  includeBody: boolean,
  includeCollections: boolean,
  previousBodies: Record<string, CachedBody>,
  previousCollections: Record<string, CachedCollections>,
): boolean {
  return keys.every(
    (key) =>
      (!includeBody || previousBodies[key] !== undefined) &&
      (!includeCollections || previousCollections[key] !== undefined),
  );
}

function candidatesFromDerivedIndex(params: {
  pmRoot: string;
  preferredFormat: ItemFormat | undefined;
  includeBody: boolean;
  includeCollections: boolean;
  previousEntries: Record<string, CachedEntry>;
  previousBodies: Record<string, CachedBody>;
  previousCollections: Record<string, CachedCollections>;
}): CachedDocumentCandidate[] {
  const candidatesById = new Map<
    string,
    { candidate: CachedDocumentCandidate; itemFormat: ItemFormat }
  >();
  for (const [relativePath, entry] of Object.entries(params.previousEntries)) {
    const itemFormat = getItemFormatFromPath(relativePath);
    if (!itemFormat) {
      continue;
    }
    const metadata = params.includeCollections
      ? mergeHeavyMetadata(
          entry.metadata,
          params.previousCollections[relativePath]?.collections,
        )
      : entry.metadata;
    const existing = candidatesById.get(metadata.id);
    if (
      shouldRecordCachedDocumentCandidate(
        existing?.itemFormat,
        itemFormat,
        params.preferredFormat,
      )
    ) {
      candidatesById.set(metadata.id, {
        itemFormat,
        candidate: {
          metadata,
          body: params.includeBody
            ? params.previousBodies[relativePath]?.body
            : undefined,
          item_format: itemFormat,
          item_path: path.join(params.pmRoot, relativePath),
        },
      });
    }
  }
  return [...candidatesById.values()]
    .sort((left, right) =>
      left.candidate.metadata.id.localeCompare(right.candidate.metadata.id),
    )
    .map((entry) => entry.candidate);
}

function canUseDerivedIndex(params: {
  forceSourceScan: boolean;
  contextFingerprint: string;
  existingCache: CacheEnvelope | null;
  existingBodyCache: BodyCacheEnvelope | null;
  existingCollectionsCache: CollectionsCacheEnvelope | null;
  directorySignatures: DirectorySignatures;
  entryKeys: readonly string[];
  minimumIndexedItems: number;
  includeBody: boolean;
  includeCollections: boolean;
  previousBodies: Record<string, CachedBody>;
  previousCollections: Record<string, CachedCollections>;
}): boolean {
  if (
    params.forceSourceScan ||
    hasActiveOnReadHooks() ||
    params.existingCache?.context_fingerprint !== params.contextFingerprint ||
    params.entryKeys.length < params.minimumIndexedItems ||
    !directorySignaturesMatch(
      params.existingCache?.directory_signatures,
      params.directorySignatures,
    )
  ) {
    return false;
  }
  const requiredTiersMatch = [
    !params.includeBody ||
      cacheTierMatchesContext(
        params.existingBodyCache,
        params.contextFingerprint,
        params.existingCache.source_cursor,
      ),
    !params.includeCollections ||
      cacheTierMatchesContext(
        params.existingCollectionsCache,
        params.contextFingerprint,
        params.existingCache.source_cursor,
      ),
  ];
  return (
    requiredTiersMatch.every(Boolean) &&
    hasEveryDerivedIndexPart(
      params.entryKeys,
      params.includeBody,
      params.includeCollections,
      params.previousBodies,
      params.previousCollections,
    )
  );
}

/**
 * List all item documents using a persistent on-disk metadata cache.
 *
 * Metadata and bodies are stored in two separate cache files so the hot path
 * (`pm list` and friends, which discard bodies) never loads or rewrites the much
 * larger body payload. Each file is rewritten only when its contents actually
 * change, and per-file onRead hooks are dispatched only when an extension
 * registers one. Only files whose mtime/ctime/size changed since the last run are
 * re-parsed.
 */
export async function listAllDocumentCandidatesCached(
  pmRoot: string,
  preferredFormat: ItemFormat | undefined,
  typeToFolder: Record<string, string>,
  warnings: string[] | undefined,
  schema: RuntimeSchemaSettings | undefined,
  options: ListCacheOptions = {},
): Promise<CachedDocumentCandidate[]> {
  const includeBody = options.includeBody !== false;
  const includeCollections = options.includeCollections !== false;
  const extensionFieldNames = resolveActiveExtensionFieldNames();
  const contextFingerprint = computeContextFingerprint(
    preferredFormat,
    typeToFolder,
    schema,
    extensionFieldNames,
  );

  const delta = await loadDerivedIndexDelta(pmRoot);
  if (delta.invalid) await removeDerivedIndexFiles(pmRoot);
  const existingCache = await loadCache(pmRoot);
  const existingBodyCache = includeBody ? await loadBodyCache(pmRoot) : null;
  const existingCollectionsCache = includeCollections
    ? await loadCollectionsCache(pmRoot)
    : null;
  applyDerivedIndexDelta(
    existingCache,
    existingBodyCache,
    existingCollectionsCache,
    delta.envelope,
  );
  const previousEntries = selectPreviousMetadataEntries(
    existingCache,
    contextFingerprint,
  );
  const previousBodies = selectPreviousBodyEntries(
    existingBodyCache,
    contextFingerprint,
  );
  const previousCollections = selectPreviousCollectionEntries(
    existingCollectionsCache,
    contextFingerprint,
  );

  const folders = [...new Set(Object.values(typeToFolder))];
  const directorySignaturesBefore = await readDirectorySignatures(
    pmRoot,
    folders,
  );
  const entryKeys = Object.keys(previousEntries);
  const minimumIndexedItems = Math.max(
    1,
    Math.floor(
      options.derivedIndexMinimumItems ?? DEFAULT_DERIVED_INDEX_MINIMUM_ITEMS,
    ),
  );
  if (
    canUseDerivedIndex({
      forceSourceScan: options.forceSourceScan === true,
      contextFingerprint,
      existingCache,
      existingBodyCache,
      existingCollectionsCache,
      directorySignatures: directorySignaturesBefore,
      entryKeys,
      minimumIndexedItems,
      includeBody,
      includeCollections,
      previousBodies,
      previousCollections,
    })
  ) {
    return candidatesFromDerivedIndex({
      pmRoot,
      preferredFormat,
      includeBody,
      includeCollections,
      previousEntries,
      previousBodies,
      previousCollections,
    });
  }

  const dirResults = await Promise.all(
    folders.map((folder) => readItemDirectoryFiles(pmRoot, folder, warnings)),
  );

  const dispatchReadHooks = hasActiveOnReadHooks();
  const state = createDocumentCacheMutableState();
  const context: DocumentCacheReadContext = {
    pmRoot,
    preferredFormat,
    warnings,
    schema,
    extensionFieldNames,
    includeBody,
    includeCollections,
    dispatchReadHooks,
    previousEntries,
    previousBodies,
    previousCollections,
    state,
  };

  await Promise.all(collectCachedDocumentParseTasks(dirResults, context));

  const directorySignaturesAfter = await readDirectorySignatures(
    pmRoot,
    folders,
  );
  const stableDirectorySignatures = directorySignaturesMatch(
    directorySignaturesBefore,
    directorySignaturesAfter,
  )
    ? directorySignaturesAfter
    : {};
  const metadataChanged =
    state.misses.metadata ||
    Object.keys(previousEntries).length !==
      Object.keys(state.newEntries).length ||
    !directorySignaturesMatch(
      existingCache?.directory_signatures,
      stableDirectorySignatures,
    );
  const sourceCursor =
    metadataChanged || existingCache === null
      ? randomUUID()
      : existingCache.source_cursor;

  // Rewrite a cache file only when its contents changed: any re-parsed (missing or
  // stale) entry, or a different set of keys (additions/deletions).
  await persistMetadataCacheIfNeeded({
    pmRoot,
    contextFingerprint,
    sourceCursor,
    existingCache,
    previousEntries,
    directorySignatures: stableDirectorySignatures,
    state,
    minimumIndexedItems,
  });

  if (includeBody) {
    await persistBodyCacheIfNeeded({
      pmRoot,
      contextFingerprint,
      sourceCursor,
      existingBodyCache,
      previousBodies,
      state,
    });
  }

  if (includeCollections) {
    await persistCollectionsCacheIfNeeded({
      pmRoot,
      contextFingerprint,
      sourceCursor,
      existingCollectionsCache,
      previousCollections,
      state,
    });
  }

  return sortedCachedDocumentCandidates(state);
}

/** Implements list all documents cached for the public runtime surface of this module. */
export async function listAllDocumentsCached(
  pmRoot: string,
  preferredFormat: ItemFormat | undefined,
  typeToFolder: Record<string, string>,
  warnings: string[] | undefined,
  schema: RuntimeSchemaSettings | undefined,
): Promise<ItemDocument[]> {
  const candidates = await listAllDocumentCandidatesCached(
    pmRoot,
    preferredFormat,
    typeToFolder,
    warnings,
    schema,
    {
      includeBody: false,
    },
  );
  return candidates.map((candidate) => ({
    metadata: candidate.metadata,
    body: candidate.body ?? "",
  }));
}

/**
 * Light variant of {@link listAllDocumentsCached}: returns metadata WITHOUT the heavy
 * collection fields (comments/notes/learnings/files/tests/test_runs/docs), skipping the
 * large collections cache entirely. Only safe for callers that read just the light
 * scalar/small fields (id/title/status/type/priority/parent/tags/dates/dependencies/…).
 */
export async function listAllDocumentsCachedLight(
  pmRoot: string,
  preferredFormat: ItemFormat | undefined,
  typeToFolder: Record<string, string>,
  warnings: string[] | undefined,
  schema: RuntimeSchemaSettings | undefined,
): Promise<ItemDocument[]> {
  const candidates = await listAllDocumentCandidatesCached(
    pmRoot,
    preferredFormat,
    typeToFolder,
    warnings,
    schema,
    {
      includeBody: false,
      includeCollections: false,
    },
  );
  return candidates.map((candidate) => ({
    metadata: candidate.metadata,
    body: candidate.body ?? "",
  }));
}
