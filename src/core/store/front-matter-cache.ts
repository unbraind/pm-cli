/**
 * @module core/store/front-matter-cache
 *
 * Reads and writes tracker storage with format-aware helpers for Front Matter Cache.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { getActiveExtensionRegistrations, hasActiveOnReadHooks, runActiveOnReadHooks } from "../extensions/index.js";
import { collectRegisteredItemFieldNames } from "../extensions/item-fields.js";
import { parseItemDocument } from "../item/item-format.js";
import { writeFileAtomic } from "../fs/fs-utils.js";
import { ITEM_FILE_EXTENSIONS, getItemFormatFromPath } from "./paths.js";
import type { ItemDocument, ItemFormat, ItemMetadata, ItemType, RuntimeSchemaSettings } from "../../types/index.js";

const CACHE_VERSION = 6;
const CACHE_FILENAME = "metadata-cache.json";
const BODY_CACHE_FILENAME = "metadata-cache-bodies.json";
const COLLECTIONS_CACHE_FILENAME = "metadata-cache-collections.json";

/**
 * Heavy "collection" front-matter fields. These arrays dominate the on-disk cache
 * (e.g. a single item's comment thread can be hundreds of KB) yet the hot list path
 * (`pm list`, stats, deps, activity, calendar, close) never reads them. They are
 * stored in a separate collections cache that is parsed only when a caller opts in
 * (`includeCollections`), keeping the always-loaded light cache an order of magnitude
 * smaller and its JSON.parse correspondingly cheaper.
 */
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

interface CacheEnvelope {
  version: number;
  context_fingerprint: string;
  entries: Record<string, CachedEntry>;
}

interface BodyCacheEnvelope {
  version: number;
  context_fingerprint: string;
  bodies: Record<string, CachedBody>;
}

interface CollectionsCacheEnvelope {
  version: number;
  context_fingerprint: string;
  collections: Record<string, CachedCollections>;
}

/**
 * Split parsed front-matter into the light scalar/small fields (everything except the
 * heavy collection arrays) and the heavy collection fields. Only keys that are actually
 * present are moved, so an item without comments stays without comments in both tiers.
 */
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

/**
 * Recombine light metadata with cached heavy collection fields. Key order differs from
 * the on-disk document, but every downstream hash/serialization canonicalizes and
 * sorts keys (`stableStringify`), so the merged record is byte-identical once hashed.
 */
function mergeHeavyMetadata(light: ItemMetadata, heavy: Record<string, unknown> | undefined): ItemMetadata {
  if (!heavy || Object.keys(heavy).length === 0) {
    return light;
  }
  return { ...light, ...heavy } as ItemMetadata;
}

/**
 * Documents the cached document candidate payload exchanged by command, SDK, and package integrations.
 */
export interface CachedDocumentCandidate {
  metadata: ItemMetadata;
  body?: string;
  item_format: ItemFormat;
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

async function loadCache(pmRoot: string): Promise<CacheEnvelope | null> {
  try {
    const raw = await fs.readFile(getCachePath(pmRoot), "utf8");
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (parsed.version !== CACHE_VERSION || typeof parsed.entries !== "object" || parsed.entries === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function loadBodyCache(pmRoot: string): Promise<BodyCacheEnvelope | null> {
  try {
    const raw = await fs.readFile(getBodyCachePath(pmRoot), "utf8");
    const parsed = JSON.parse(raw) as BodyCacheEnvelope;
    if (parsed.version !== CACHE_VERSION || typeof parsed.bodies !== "object" || parsed.bodies === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function loadCollectionsCache(pmRoot: string): Promise<CollectionsCacheEnvelope | null> {
  try {
    const raw = await fs.readFile(getCollectionsCachePath(pmRoot), "utf8");
    const parsed = JSON.parse(raw) as CollectionsCacheEnvelope;
    if (parsed.version !== CACHE_VERSION || typeof parsed.collections !== "object" || parsed.collections === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function persistCache(
  cachePath: string,
  envelope: CacheEnvelope | BodyCacheEnvelope | CollectionsCacheEnvelope,
): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await writeFileAtomic(cachePath, JSON.stringify(envelope));
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
    return candidateFormat === preferredFormat && existingFormat !== preferredFormat;
  }
  return candidateFormat === "toon" && existingFormat !== "toon";
}

function appendWarning(warnings: string[] | undefined, warning: string): void {
  if (warnings && !warnings.includes(warning)) {
    warnings.push(warning);
  }
}

function statMatches(signature: StatSignature, mtimeMs: number, ctimeMs: number, size: number): boolean {
  return signature.mtime_ms === mtimeMs && signature.ctime_ms === ctimeMs && signature.size === size;
}

/**
 * Documents the list cache options payload exchanged by command, SDK, and package integrations.
 */
export interface ListCacheOptions {
  /**
   * When false, item bodies are neither loaded from nor written to the separate
   * body cache. Metadata-only callers (`pm list`, stats, deps, activity, …) skip
   * the large body cache entirely; only body consumers (search/reindex) pay for it.
   */
  includeBody?: boolean;
  /**
   * When false, heavy collection fields (comments/notes/learnings/files/tests/
   * test_runs/docs) are neither loaded from nor written to the separate collections
   * cache, and are absent from the returned metadata. Light-only callers (`pm list`
   * compact, stats, deps, activity, calendar, close) skip the large collections cache
   * entirely. Defaults to true so any caller that does read those fields stays correct.
   */
  includeCollections?: boolean;
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
  const contextFingerprint = computeContextFingerprint(preferredFormat, typeToFolder, schema, extensionFieldNames);

  const existingCache = await loadCache(pmRoot);
  const previousEntries: Record<string, CachedEntry> =
    existingCache && existingCache.context_fingerprint === contextFingerprint ? existingCache.entries : {};

  const existingBodyCache = includeBody ? await loadBodyCache(pmRoot) : null;
  const previousBodies: Record<string, CachedBody> =
    existingBodyCache && existingBodyCache.context_fingerprint === contextFingerprint ? existingBodyCache.bodies : {};

  const existingCollectionsCache = includeCollections ? await loadCollectionsCache(pmRoot) : null;
  const previousCollections: Record<string, CachedCollections> =
    existingCollectionsCache && existingCollectionsCache.context_fingerprint === contextFingerprint
      ? existingCollectionsCache.collections
      : {};

  const entries = Object.entries(typeToFolder) as Array<[ItemType, string]>;
  const dirResults = await Promise.all(
    entries.map(async ([, folder]) => {
      const dirPath = path.join(pmRoot, folder);
      try {
        const files = await fs.readdir(dirPath);
        return { folder, dirPath, files };
      } catch (error: unknown) {
        if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code !== "ENOENT") {
          appendWarning(warnings, `item_list_directory_read_failed:${folder}`);
        }
        return { folder, dirPath, files: [] as string[] };
      }
    }),
  );

  const dispatchReadHooks = hasActiveOnReadHooks();
  const newEntries: Record<string, CachedEntry> = {};
  const newBodies: Record<string, CachedBody> = {};
  const newCollections: Record<string, CachedCollections> = {};
  const documentsById = new Map<string, { candidate: CachedDocumentCandidate; itemFormat: ItemFormat }>();
  let metadataMiss = false;
  let bodyMiss = false;
  let collectionsMiss = false;

  const parseTasks: Array<Promise<void>> = [];

  for (const { folder, dirPath, files } of dirResults) {
    for (const file of files) {
      if (!ITEM_FILE_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext))) {
        continue;
      }
      const filePath = path.join(dirPath, file);
      const relativePath = path.relative(pmRoot, filePath);

      parseTasks.push(
        (async () => {
          try {
            const stat = await fs.stat(filePath);
            const mtimeMs = stat.mtimeMs;
            const ctimeMs = stat.ctimeMs;
            const { size } = stat;
            const itemFormat = getItemFormatFromPath(filePath) as ItemFormat;

            // Preserve onRead hook semantics even when served from cache, but only
            // when an extension actually observes reads. Surface hook warnings so
            // read-hook failures are not silently hidden.
            if (dispatchReadHooks) {
              for (const warning of await runActiveOnReadHooks({ path: filePath, scope: "project" })) {
                appendWarning(warnings, warning);
              }
            }

            const cachedEntry = previousEntries[relativePath];
            const metadataCached = cachedEntry !== undefined && statMatches(cachedEntry, mtimeMs, ctimeMs, size);
            const cachedBody = previousBodies[relativePath];
            const bodyCached = cachedBody !== undefined && statMatches(cachedBody, mtimeMs, ctimeMs, size);
            const cachedCollections = previousCollections[relativePath];
            const collectionsCached =
              cachedCollections !== undefined && statMatches(cachedCollections, mtimeMs, ctimeMs, size);

            const needRead =
              !metadataCached || (includeBody && !bodyCached) || (includeCollections && !collectionsCached);
            let lightMetadata: ItemMetadata;
            let heavyMetadata: Record<string, unknown> | undefined;
            let bodyLength: number;
            let body: string | undefined;

            if (needRead) {
            const raw = await fs.readFile(filePath, "utf8");
            const parsed = parseItemDocument(raw, {
              format: itemFormat,
              schema,
              extensionFieldNames,
              onWarning: (w) => appendWarning(warnings, w),
            });
              const split = splitHeavyMetadata(parsed.metadata);
              lightMetadata = metadataCached ? cachedEntry.metadata : split.light;
              bodyLength = metadataCached ? cachedEntry.body_length : parsed.body.length;
              body = includeBody ? parsed.body : undefined;
              if (includeCollections) {
                heavyMetadata = collectionsCached ? cachedCollections.collections : split.heavy;
              }
              if (!metadataCached) {
                metadataMiss = true;
              }
              if (includeBody && !bodyCached) {
                bodyMiss = true;
              }
              if (includeCollections && !collectionsCached) {
                collectionsMiss = true;
              }
            } else {
              lightMetadata = cachedEntry.metadata;
              bodyLength = cachedEntry.body_length;
              body = includeBody ? cachedBody.body : undefined;
              heavyMetadata = includeCollections && cachedCollections ? cachedCollections.collections : undefined;
            }

            newEntries[relativePath] = {
              mtime_ms: mtimeMs,
              ctime_ms: ctimeMs,
              size,
              metadata: lightMetadata,
              body_length: bodyLength,
            };
            if (includeBody && body !== undefined) {
              newBodies[relativePath] = { mtime_ms: mtimeMs, ctime_ms: ctimeMs, size, body };
            }
            if (includeCollections && heavyMetadata !== undefined) {
              newCollections[relativePath] = { mtime_ms: mtimeMs, ctime_ms: ctimeMs, size, collections: heavyMetadata };
            }

            const metadata = includeCollections ? mergeHeavyMetadata(lightMetadata, heavyMetadata) : lightMetadata;
            const existing = documentsById.get(metadata.id);
            const candidate: CachedDocumentCandidate = {
              metadata,
              body,
              item_format: itemFormat,
              item_path: filePath,
            };
            if (!existing || shouldReplaceCachedDocumentCandidate(existing.itemFormat, itemFormat, preferredFormat)) {
              documentsById.set(metadata.id, { candidate, itemFormat });
            }
          } catch {
            appendWarning(warnings, `item_list_item_read_failed:${folder}/${file}`);
          }
        })(),
      );
    }
  }

  await Promise.all(parseTasks);

  // Rewrite a cache file only when its contents changed: any re-parsed (missing or
  // stale) entry, or a different set of keys (additions/deletions).
  const metadataDirty = metadataMiss || Object.keys(previousEntries).length !== Object.keys(newEntries).length;
  if (metadataDirty || existingCache === null || existingCache.context_fingerprint !== contextFingerprint) {
    await persistCache(getCachePath(pmRoot), {
      version: CACHE_VERSION,
      context_fingerprint: contextFingerprint,
      entries: newEntries,
    }).catch(() => {});
  }

  if (includeBody) {
    const bodyDirty = bodyMiss || Object.keys(previousBodies).length !== Object.keys(newBodies).length;
    if (bodyDirty || existingBodyCache === null || existingBodyCache.context_fingerprint !== contextFingerprint) {
      await persistCache(getBodyCachePath(pmRoot), {
        version: CACHE_VERSION,
        context_fingerprint: contextFingerprint,
        bodies: newBodies,
      }).catch(() => {});
    }
  }

  if (includeCollections) {
    const collectionsDirty =
      collectionsMiss || Object.keys(previousCollections).length !== Object.keys(newCollections).length;
    if (
      collectionsDirty ||
      existingCollectionsCache === null ||
      existingCollectionsCache.context_fingerprint !== contextFingerprint
    ) {
      await persistCache(getCollectionsCachePath(pmRoot), {
        version: CACHE_VERSION,
        context_fingerprint: contextFingerprint,
        collections: newCollections,
      }).catch(() => {});
    }
  }

  return [...documentsById.values()]
    .sort((left, right) => left.candidate.metadata.id.localeCompare(right.candidate.metadata.id))
    .map((entry) => entry.candidate);
}

/**
 * Implements list all documents cached for the public runtime surface of this module.
 */
export async function listAllDocumentsCached(
  pmRoot: string,
  preferredFormat: ItemFormat | undefined,
  typeToFolder: Record<string, string>,
  warnings: string[] | undefined,
  schema: RuntimeSchemaSettings | undefined,
): Promise<ItemDocument[]> {
  const candidates = await listAllDocumentCandidatesCached(pmRoot, preferredFormat, typeToFolder, warnings, schema, {
    includeBody: false,
  });
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
  const candidates = await listAllDocumentCandidatesCached(pmRoot, preferredFormat, typeToFolder, warnings, schema, {
    includeBody: false,
    includeCollections: false,
  });
  return candidates.map((candidate) => ({
    metadata: candidate.metadata,
    body: candidate.body ?? "",
  }));
}
