/**
 * @module core/store/item-format-migration
 *
 * Reads and writes tracker storage with format-aware helpers for Item Format Migration.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { runActiveOnWriteHooks } from "../extensions/index.js";
import { readFileIfExists, removeFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";
import { parseItemDocument, serializeItemDocument } from "../item/item-format.js";
import { TYPE_TO_FOLDER } from "../shared/constants.js";
import { getItemFormatFromPath, getItemPath } from "./paths.js";
import type { ItemFormat, ItemType, RuntimeSchemaSettings } from "../../types/index.js";

interface ItemPathVariants {
  json_markdown?: string;
  toon?: string;
}

/**
 * Documents the item format migration result payload exchanged by command, SDK, and package integrations.
 */
export interface ItemFormatMigrationResult {
  target_format: ItemFormat;
  scanned: number;
  migrated: string[];
  removed: string[];
  warnings: string[];
}

function alternateItemFormat(_targetFormat: ItemFormat): ItemFormat {
  return "json_markdown";
}

function normalizeRelativePath(pmRoot: string, absolutePath: string): string {
  return path.relative(pmRoot, absolutePath).replaceAll("\\", "/");
}

function errorSummary(error: unknown): string {
  return String(error).replaceAll(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

/**
 * Implements migrate item files to format for the public runtime surface of this module.
 */
export async function migrateItemFilesToFormat(
  pmRoot: string,
  targetFormat: ItemFormat,
  op = "item_format:migrate",
  typeToFolder: Record<string, string> = TYPE_TO_FOLDER,
  schema?: RuntimeSchemaSettings,
): Promise<ItemFormatMigrationResult> {
  if (targetFormat !== "toon") {
    throw new Error("Only toon item-format migration targets are supported. Markdown item files are legacy read-only input.");
  }
  const migratedIds = new Set<string>();
  const removedPaths = new Set<string>();
  const warnings: string[] = [];
  let scanned = 0;
  const alternateFormat = alternateItemFormat(targetFormat);
  const typeEntries = Object.entries(typeToFolder) as Array<[ItemType, string]>;

  for (const [itemType, folder] of typeEntries) {
    const directoryPath = path.join(pmRoot, folder);
    let files: string[] = [];
    try {
      files = await fs.readdir(directoryPath);
    } catch {
      continue;
    }

    const variantsById = new Map<string, ItemPathVariants>();
    for (const file of files) {
      const absolutePath = path.join(directoryPath, file);
      const itemFormat = getItemFormatFromPath(absolutePath);
      if (!itemFormat) {
        continue;
      }
      const extension = path.extname(file);
      const itemId = file.slice(0, file.length - extension.length).trim();
      if (itemId.length === 0) {
        continue;
      }
      const entry = variantsById.get(itemId) ?? {};
      entry[itemFormat] = absolutePath;
      variantsById.set(itemId, entry);
    }

    const itemIds = [...variantsById.keys()].sort((left, right) => left.localeCompare(right));
    for (const itemId of itemIds) {
      const variants = variantsById.get(itemId) as ItemPathVariants;
      scanned += 1;
      // Items already present only in the target format need no migration: there
      // is no legacy alternate-format file to convert or remove. Skip the
      // read/parse/serialize/compare round-trip for them. This is the dominant
      // cost of the pre-mutation format sync, which runs on every mutation and
      // would otherwise re-parse the entire corpus (O(items)) each time.
      const alternatePath = variants[alternateFormat];
      if (!alternatePath) {
        continue;
      }
      const sourcePath = variants[targetFormat] ?? alternatePath;
      const sourceFormat = sourcePath === variants[targetFormat] ? targetFormat : alternateFormat;
      try {
        const sourceRaw = await fs.readFile(sourcePath, "utf8");
        const parsedDocument = parseItemDocument(sourceRaw, {
          format: sourceFormat,
          schema,
          onWarning: (warning) => warnings.push(`item_format_migration_parse_warning:${itemId}:${warning}`),
        });
        const targetPath = getItemPath(pmRoot, itemType, itemId, targetFormat, typeToFolder);
        const serializedTarget = serializeItemDocument(parsedDocument, { format: targetFormat, schema });
        const existingTargetRaw = await readFileIfExists(targetPath);
        if (existingTargetRaw !== serializedTarget) {
          await writeFileAtomic(targetPath, serializedTarget);
          warnings.push(
            ...(await runActiveOnWriteHooks({
              path: targetPath,
              scope: "project",
              op,
            })),
          );
          migratedIds.add(itemId);
        }

        // The legacy alternate (.md) was enumerated from disk above and is always
        // a distinct path from the .toon target, so once the parse succeeds we
        // remove it unconditionally. removeFileIfExists tolerates a concurrently
        // removed file, so no pre-check is needed.
        await removeFileIfExists(alternatePath);
        removedPaths.add(normalizeRelativePath(pmRoot, alternatePath));
        warnings.push(
          ...(await runActiveOnWriteHooks({
            path: alternatePath,
            scope: "project",
            op: `${op}:remove`,
          })),
        );
        migratedIds.add(itemId);
      } catch (error) {
        warnings.push(
          `item_format_migration_skipped:${normalizeRelativePath(pmRoot, sourcePath)}:${errorSummary(error)}`,
        );
      }
    }
  }

  return {
    target_format: targetFormat,
    scanned,
    migrated: [...migratedIds].sort((left, right) => left.localeCompare(right)),
    removed: [...removedPaths].sort((left, right) => left.localeCompare(right)),
    warnings,
  };
}
