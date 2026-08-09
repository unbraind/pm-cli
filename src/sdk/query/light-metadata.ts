/**
 * @module sdk/query/light-metadata
 *
 * Resolves workspace settings for the host-bound lightweight metadata reader.
 */
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { listAllItemMetadataLight } from "../../core/store/item-store.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemMetadata } from "../../types/index.js";

/** Read scalar-only metadata using client workspace defaults and custom type folders. */
export async function listClientItemMetadataLight(
  pmRootOverride: string | undefined,
  cwdOverride: string | undefined,
): Promise<ItemMetadata[]> {
  const pmRoot = resolvePmRoot(cwdOverride ?? process.cwd(), pmRootOverride);
  const settings = await readSettings(pmRoot);
  return listAllItemMetadataLight(
    pmRoot,
    settings.item_format,
    resolveItemTypeRegistry(settings, null).type_to_folder,
    undefined,
    settings.schema,
  );
}
