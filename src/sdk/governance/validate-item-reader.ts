/**
 * @module sdk/governance/validate-item-reader
 *
 * Selects the least expensive authoritative item projection required by a
 * validation run.
 */
import {
  listAllItemMetadata,
  listAllItemMetadataWithBody,
} from "../../core/store/item-store.js";
import type { ItemMetadata, PmSettings } from "../../types/index.js";

/** Item projection accepted by validate checks; body is read only for strict drift verification. */
export type ValidateItem = ItemMetadata & { body: string };

/** Load collections for normal checks and add bodies only when history hashes must be verified. */
export async function readValidateItems(params: {
  includeBody: boolean;
  pmRoot: string;
  settings: PmSettings;
  typeToFolder: Record<string, string>;
  warnings: string[];
}): Promise<ValidateItem[]> {
  if (params.includeBody) {
    return listAllItemMetadataWithBody(
      params.pmRoot,
      params.settings.item_format,
      params.typeToFolder,
      params.warnings,
      params.settings.schema,
    );
  }
  return listAllItemMetadata(
    params.pmRoot,
    params.settings.item_format,
    params.typeToFolder,
    params.warnings,
    params.settings.schema,
  ) as Promise<ValidateItem[]>;
}
