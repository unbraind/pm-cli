import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { hasActiveOnReadHooks, runActiveOnReadHooks } from "../extensions/index.js";
import { parseItemDocument } from "../item/item-format.js";
import { writeFileAtomic } from "../fs/fs-utils.js";
import { ITEM_FILE_EXTENSIONS, getItemFormatFromPath } from "./paths.js";
import type { ItemDocument, ItemFormat, ItemMetadata, ItemType, RuntimeSchemaSettings } from "../../types/index.js";

const CACHE_VERSION = 5;
const CACHE_FILENAME = "metadata-cache.json";
const BODY_CACHE_FILENAME = "metadata-cache-bodies.json";

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
  return hash.digest("hex").slice(0, 16);
}

function getCachePath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", CACHE_FILENAME);
}

function getBodyCachePath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", BODY_CACHE_FILENAME);
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

async function persistCache(cachePath: string, envelope: CacheEnvelope | BodyCacheEnvelope): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await writeFileAtomic(cachePath, JSON.stringify(envelope));
}

function appendWarning(warnings: string[] | undefined, warning: string): void {
  if (warnings && !warnings.includes(warning)) {
    warnings.push(warning);
  }
}

function statMatches(signature: StatSignature, mtimeMs: number, ctimeMs: number, size: number): boolean {
  return signature.mtime_ms === mtimeMs && signature.ctime_ms === ctimeMs && signature.size === size;
}

export interface ListCacheOptions {
  /**
   * When false, item bodies are neither loaded from nor written to the separate
   * body cache. Metadata-only callers (`pm list`, stats, deps, activity, …) skip
   * the large body cache entirely; only body consumers (search/reindex) pay for it.
   */
  includeBody?: boolean;
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
  const contextFingerprint = computeContextFingerprint(preferredFormat, typeToFolder, schema);

  const existingCache = await loadCache(pmRoot);
  const previousEntries: Record<string, CachedEntry> =
    existingCache && existingCache.context_fingerprint === contextFingerprint ? existingCache.entries : {};

  const existingBodyCache = includeBody ? await loadBodyCache(pmRoot) : null;
  const previousBodies: Record<string, CachedBody> =
    existingBodyCache && existingBodyCache.context_fingerprint === contextFingerprint ? existingBodyCache.bodies : {};

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
  const documentsById = new Map<string, { candidate: CachedDocumentCandidate; itemFormat: ItemFormat }>();
  let metadataMiss = false;
  let bodyMiss = false;

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
            // when an extension actually observes reads.
            if (dispatchReadHooks) {
              await runActiveOnReadHooks({ path: filePath, scope: "project" });
            }

            const cachedEntry = previousEntries[relativePath];
            const metadataCached = cachedEntry !== undefined && statMatches(cachedEntry, mtimeMs, ctimeMs, size);
            const cachedBody = previousBodies[relativePath];
            const bodyCached = cachedBody !== undefined && statMatches(cachedBody, mtimeMs, ctimeMs, size);

            const needRead = !metadataCached || (includeBody && !bodyCached);
            let metadata: ItemMetadata;
            let bodyLength: number;
            let body: string | undefined;

            if (needRead) {
              const raw = await fs.readFile(filePath, "utf8");
              const parsed = parseItemDocument(raw, {
                format: itemFormat,
                schema,
                onWarning: (w) => appendWarning(warnings, w),
              });
              metadata = metadataCached ? cachedEntry.metadata : parsed.metadata;
              bodyLength = metadataCached ? cachedEntry.body_length : parsed.body.length;
              body = includeBody ? parsed.body : undefined;
              if (!metadataCached) {
                metadataMiss = true;
              }
              if (includeBody && !bodyCached) {
                bodyMiss = true;
              }
            } else {
              metadata = cachedEntry.metadata;
              bodyLength = cachedEntry.body_length;
              body = includeBody ? cachedBody.body : undefined;
            }

            newEntries[relativePath] = {
              mtime_ms: mtimeMs,
              ctime_ms: ctimeMs,
              size,
              metadata,
              body_length: bodyLength,
            };
            if (includeBody && body !== undefined) {
              newBodies[relativePath] = { mtime_ms: mtimeMs, ctime_ms: ctimeMs, size, body };
            }

            const existing = documentsById.get(metadata.id);
            const candidate: CachedDocumentCandidate = {
              metadata,
              body,
              item_format: itemFormat,
              item_path: filePath,
            };
            if (!existing) {
              documentsById.set(metadata.id, { candidate, itemFormat });
            } else {
              const shouldReplace = preferredFormat
                ? itemFormat === preferredFormat && existing.itemFormat !== preferredFormat
                : itemFormat === "toon" && existing.itemFormat !== "toon";
              if (shouldReplace) {
                documentsById.set(metadata.id, { candidate, itemFormat });
              }
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

  return [...documentsById.values()]
    .sort((left, right) => left.candidate.metadata.id.localeCompare(right.candidate.metadata.id))
    .map((entry) => entry.candidate);
}

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
