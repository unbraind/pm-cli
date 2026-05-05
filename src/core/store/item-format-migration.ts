import fs from "node:fs/promises";
import path from "node:path";
import { runActiveOnWriteHooks } from "../extensions/index.js";
import { pathExists, readFileIfExists, removeFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";
import { parseItemDocument, serializeItemDocument } from "../item/item-format.js";
import { TYPE_TO_FOLDER } from "../shared/constants.js";
import { getItemFormatFromPath, getItemPath } from "./paths.js";
import type { ItemFormat, ItemType, RuntimeSchemaSettings } from "../../types/index.js";

interface ItemPathVariants {
  json_markdown?: string;
  toon?: string;
}

export interface ItemFormatMigrationResult {
  target_format: ItemFormat;
  scanned: number;
  migrated: string[];
  removed: string[];
  warnings: string[];
}

function alternateItemFormat(targetFormat: ItemFormat): ItemFormat {
  return targetFormat === "toon" ? "json_markdown" : "toon";
}

function normalizeRelativePath(pmRoot: string, absolutePath: string): string {
  return path.relative(pmRoot, absolutePath).replaceAll("\\", "/");
}

function errorSummary(error: unknown): string {
  return String(error).replaceAll(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

export async function migrateItemFilesToFormat(
  pmRoot: string,
  targetFormat: ItemFormat,
  op = "item_format:migrate",
  typeToFolder: Record<string, string> = TYPE_TO_FOLDER,
  schema?: RuntimeSchemaSettings,
): Promise<ItemFormatMigrationResult> {
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
      const sourcePath = (variants[targetFormat] ?? variants[alternateFormat]) as string;
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

        const alternatePath = variants[alternateFormat];
        if (alternatePath && alternatePath !== targetPath && (await pathExists(alternatePath))) {
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
        }
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
