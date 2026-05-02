import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { runActiveOnReadHooks } from "../extensions/index.js";
import { parseItemDocument } from "../item/item-format.js";
import { ITEM_FILE_EXTENSIONS, getItemFormatFromPath } from "./paths.js";
import type { ItemDocument, ItemFormat, ItemFrontMatter, ItemType, RuntimeSchemaSettings } from "../../types/index.js";

const CACHE_VERSION = 2;
const CACHE_FILENAME = "front-matter-cache.json";

interface CachedEntry {
  mtime_ms: number;
  ctime_ms: number;
  size: number;
  front_matter: ItemFrontMatter;
  body_length: number;
}

interface CacheEnvelope {
  version: number;
  context_fingerprint: string;
  entries: Record<string, CachedEntry>;
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

async function loadCache(pmRoot: string): Promise<CacheEnvelope | null> {
  try {
    const raw = await fs.readFile(getCachePath(pmRoot), "utf8");
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (parsed.version !== CACHE_VERSION || typeof parsed.entries !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function persistCache(pmRoot: string, envelope: CacheEnvelope): Promise<void> {
  const cachePath = getCachePath(pmRoot);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(envelope), "utf8");
}

function appendWarning(warnings: string[] | undefined, warning: string): void {
  if (warnings && !warnings.includes(warning)) {
    warnings.push(warning);
  }
}

/**
 * List all item documents using a persistent on-disk front-matter cache.
 * Only parses files whose mtime/size have changed since the last cached run.
 */
export async function listAllDocumentsCached(
  pmRoot: string,
  preferredFormat: ItemFormat | undefined,
  typeToFolder: Record<string, string>,
  warnings: string[] | undefined,
  schema: RuntimeSchemaSettings | undefined,
): Promise<ItemDocument[]> {
  const contextFingerprint = computeContextFingerprint(preferredFormat, typeToFolder, schema);
  const existingCache = await loadCache(pmRoot);

  const previousEntries: Record<string, CachedEntry> =
    existingCache && existingCache.context_fingerprint === contextFingerprint
      ? existingCache.entries
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

  const newEntries: Record<string, CachedEntry> = {};
  const documentsById = new Map<string, { document: ItemDocument; itemFormat: ItemFormat }>();

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
            const cached = previousEntries[relativePath];

            let frontMatter: ItemFrontMatter;
            let bodyLength: number;
            const itemFormat = getItemFormatFromPath(filePath) as ItemFormat;

            // Preserve onRead hook semantics even when metadata is served from cache.
            await runActiveOnReadHooks({ path: filePath, scope: "project" });

            if (cached && cached.mtime_ms === mtimeMs && cached.ctime_ms === ctimeMs && cached.size === size) {
              frontMatter = cached.front_matter;
              bodyLength = cached.body_length;
            } else {
              const raw = await fs.readFile(filePath, "utf8");
              const parsed = parseItemDocument(raw, {
                format: itemFormat,
                schema,
                onWarning: (w) => appendWarning(warnings, w),
              });
              frontMatter = parsed.front_matter;
              bodyLength = parsed.body.length;
            }

            newEntries[relativePath] = {
              mtime_ms: mtimeMs,
              ctime_ms: ctimeMs,
              size,
              front_matter: frontMatter,
              body_length: bodyLength,
            };

            const existing = documentsById.get(frontMatter.id);
            if (!existing) {
              documentsById.set(frontMatter.id, {
                document: { front_matter: frontMatter, body: "" },
                itemFormat,
              });
            } else {
              const shouldReplace = preferredFormat
                ? itemFormat === preferredFormat && existing.itemFormat !== preferredFormat
                : itemFormat === "toon" && existing.itemFormat !== "toon";
              if (shouldReplace) {
                documentsById.set(frontMatter.id, {
                  document: { front_matter: frontMatter, body: "" },
                  itemFormat,
                });
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

  persistCache(pmRoot, {
    version: CACHE_VERSION,
    context_fingerprint: contextFingerprint,
    entries: newEntries,
  }).catch(() => {});

  return [...documentsById.values()]
    .sort((left, right) => left.document.front_matter.id.localeCompare(right.document.front_matter.id))
    .map((entry) => entry.document);
}
